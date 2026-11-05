import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { db, schemaReady } from "../db.js";
import { computeEffectiveStatus, getRemainingExamSeconds } from "./exam-lifecycle.js";
import { MediaWriteQueue, retryTransientWrite } from "./media-upload-queue.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "administratorSecretKey";

// Cap the number of stored captures per session so media BLOB storage remains bounded.
const MAX_CAPTURES_PER_SESSION = 10;
// Screen snapshots are ONLY taken when a tab switch is detected, so a session
// stores exactly this many (no early/manual captures).
const MAX_SCREEN_CAPTURES_PER_SESSION = 5;
const positiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const MEDIA_WRITE_CONCURRENCY = positiveInt(process.env.MEDIA_WRITE_CONCURRENCY, 4);
const MAX_IMAGE_UPLOAD_BYTES = positiveInt(process.env.MAX_IMAGE_UPLOAD_BYTES, 2 * 1024 * 1024);
const MAX_AUDIO_UPLOAD_BYTES = positiveInt(process.env.MAX_AUDIO_UPLOAD_BYTES, 2 * 1024 * 1024);
const mediaWriteQueue = new MediaWriteQueue(MEDIA_WRITE_CONCURRENCY);
const mediaUploadStats = {
    writes: 0,
    duplicateWrites: 0,
    limitedWrites: 0,
    busyRetries: 0,
    transientRetries: 0,
    failedWrites: 0,
    maxConcurrentWrites: 0
};

function recordDatabaseRetry(error) {
    mediaUploadStats.transientRetries++;
    const code = String(error && (error.code || error.cause?.code) || '').toUpperCase();
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ||
        /database is locked|database is busy/i.test(String(error && error.message || ''))) {
        mediaUploadStats.busyRetries++;
    }
}

// A switch is either a plain tab switch (exam tab hidden/blurred) or an OS
// window switch such as Alt+Tab, where the exam tab stayed visible.
const SWITCH_SOURCES = new Set(['tab-switch', 'alt-tab']);
const normalizeSwitchSource = (value) =>
    SWITCH_SOURCES.has(String(value || '')) ? String(value) : 'tab-switch';

// ── Query helpers (mimic better-sqlite3 ergonomics on top of Turso) ──
const exec = (sql, args = []) => db.execute({ sql, args });
const all = async (sql, args = []) => (await exec(sql, args)).rows;
const get = async (sql, args = []) => (await exec(sql, args)).rows[0];
const lastId = (result) => Number(result.lastInsertRowid);

function mediaError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function parseCaptureMetadata(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
    if (typeof value !== 'string' || value.length > 16000) {
        throw mediaError(400, 'Capture metadata is invalid or too large');
    }
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Expected object metadata');
        }
        return parsed;
    } catch {
        throw mediaError(400, 'Capture metadata must be valid JSON');
    }
}

function decodeDataUrl(value, defaultMimeType) {
    if (typeof value !== 'string') throw mediaError(400, 'Media data is required');
    const match = value.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
    if (match) {
        return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1].toLowerCase() };
    }
    if (!/^[a-z0-9+/=\r\n]+$/i.test(value)) throw mediaError(400, 'Media data must be base64 encoded');
    return { buffer: Buffer.from(value, 'base64'), mimeType: defaultMimeType };
}

function parseMediaUpload(req, type) {
    const isBinary = Buffer.isBuffer(req.body);
    let metadata = {};
    let buffer = null;
    let mimeType = '';
    let captureId = req.get('x-capture-id') || '';
    let captureTrigger = req.get('x-capture-trigger') || '';

    if (isBinary) {
        mimeType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
        buffer = req.body;
        metadata = parseCaptureMetadata(req.get('x-capture-metadata'));
    } else {
        const body = req.body || {};
        captureId = body.capture_id || captureId;
        captureTrigger = body.capture_trigger || captureTrigger;
        if (type === 'camera') {
            const decoded = decodeDataUrl(body.image, 'image/jpeg');
            buffer = decoded.buffer;
            mimeType = decoded.mimeType;
            metadata = {
                face_count: body.face_count,
                skin_pixels: body.skin_pixels,
                flagged: body.flagged,
                detection_data: body.detection_data
            };
        } else if (type === 'screen') {
            const decoded = decodeDataUrl(body.image, 'image/jpeg');
            buffer = decoded.buffer;
            mimeType = decoded.mimeType;
        } else {
            let audioMetadata = body.audio_data || {};
            if (typeof audioMetadata === 'string') {
                try {
                    audioMetadata = JSON.parse(audioMetadata);
                } catch {
                    throw mediaError(400, 'Audio metadata must be valid JSON');
                }
            }
            if (!audioMetadata || typeof audioMetadata !== 'object' || Array.isArray(audioMetadata)) {
                throw mediaError(400, 'Audio metadata must be an object');
            }
            metadata = { ...audioMetadata, flagged: body.flagged ?? audioMetadata.flagged ?? false };
            const audioValue = body.audio_clip || audioMetadata.audio_clip;
            if (audioValue) {
                const decoded = decodeDataUrl(audioValue, 'audio/webm');
                buffer = decoded.buffer;
                mimeType = decoded.mimeType;
            }
        }
    }

    if (!captureId) captureId = randomUUID();
    if (typeof captureId !== 'string' || !/^[a-z0-9._:-]{8,100}$/i.test(captureId)) {
        throw mediaError(400, 'Capture ID is invalid');
    }
    if (type === 'screen' && captureTrigger !== 'tab-switch') {
        return { limited: true, reason: 'tab_switch_only', captureId };
    }
    if (type !== 'audio' && !Buffer.isBuffer(buffer)) {
        throw mediaError(400, 'Media data is required');
    }
    if (buffer && buffer.length === 0) throw mediaError(400, 'Media data is empty');

    if (buffer) {
        const maxBytes = type === 'audio' ? MAX_AUDIO_UPLOAD_BYTES : MAX_IMAGE_UPLOAD_BYTES;
        if (buffer.length > maxBytes) {
            throw mediaError(413, `Media exceeds the ${maxBytes}-byte upload limit`);
        }
        if (type === 'camera' || type === 'screen') {
            if (mimeType !== 'image/jpeg' || buffer.length < 3 ||
                buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
                throw mediaError(415, 'Screenshots must be valid JPEG images');
            }
        } else if (!(
            (mimeType === 'audio/webm' && buffer.length >= 4 &&
                buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) ||
            (mimeType === 'audio/ogg' && buffer.length >= 4 &&
                buffer.subarray(0, 4).toString('ascii') === 'OggS') ||
            (mimeType === 'audio/mp4' && buffer.length >= 12 &&
                buffer.subarray(4, 8).toString('ascii') === 'ftyp')
        )) {
            throw mediaError(415, 'Audio recordings must be valid WebM, Ogg, or MP4 audio');
        }
    }

    const faceCount = Number(metadata.face_count || 0);
    const skinPixels = Number(metadata.skin_pixels || 0);
    if (type === 'camera' && (!Number.isInteger(faceCount) || faceCount < 0 ||
        !Number.isFinite(skinPixels) || skinPixels < 0)) {
        throw mediaError(400, 'Camera detection metadata is invalid');
    }

    const detectionData = type === 'camera' && metadata.detection_data &&
        typeof metadata.detection_data === 'object' && !Array.isArray(metadata.detection_data)
        ? JSON.stringify(metadata.detection_data)
        : null;
    if (detectionData && detectionData.length > 16000) {
        throw mediaError(400, 'Camera detection metadata is too large');
    }
    const storedMetadata = type === 'audio'
        ? { ...metadata, audio_clip: undefined }
        : null;

    return {
        captureId,
        type,
        buffer,
        mimeType: mimeType || null,
        fileSize: buffer ? buffer.length : 0,
        metadataJson: storedMetadata ? JSON.stringify(storedMetadata) : null,
        detectionData,
        faceCount: type === 'camera' ? faceCount : 0,
        skinPixels: type === 'camera' ? skinPixels : 0,
        flagged: metadata.flagged ? 1 : 0,
        captureTrigger: type === 'screen' ? captureTrigger : null
    };
}

async function persistMediaCapture(sessionId, upload) {
    const limits = {
        camera: MAX_CAPTURES_PER_SESSION,
        screen: MAX_SCREEN_CAPTURES_PER_SESSION,
        audio: MAX_CAPTURES_PER_SESSION
    };
    const captureCountCondition = upload.type === 'camera'
        ? "(capture_type = 'camera' OR capture_type IS NULL)"
        : 'capture_type = ?';
    const countArgs = upload.type === 'camera'
        ? [sessionId, limits[upload.type]]
        : [sessionId, upload.type, limits[upload.type]];

    return retryTransientWrite(() => mediaWriteQueue.run(async () => {
        mediaUploadStats.maxConcurrentWrites = Math.max(
            mediaUploadStats.maxConcurrentWrites,
            mediaWriteQueue.active
        );
        const inserted = await exec(`INSERT INTO camera_captures
            (session_id, image_data, media_data, capture_id, file_size, mime_type,
             metadata_json, capture_type, face_count, skin_pixels, flagged,
             detection_data, capture_trigger)
            SELECT ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM camera_captures WHERE capture_id = ?
            )
            AND (
                SELECT COUNT(*) FROM camera_captures
                WHERE session_id = ? AND ${captureCountCondition}
            ) < ?
            ON CONFLICT(capture_id) DO NOTHING`, [
            sessionId,
            upload.buffer,
            upload.captureId,
            upload.fileSize,
            upload.mimeType,
            upload.metadataJson,
            upload.type,
            upload.faceCount,
            upload.skinPixels,
            upload.flagged,
            upload.detectionData,
            upload.captureTrigger,
            upload.captureId,
            ...countArgs
        ]);
        const existing = await get(
            'SELECT id, session_id, capture_type FROM camera_captures WHERE capture_id = ?',
            [upload.captureId]
        );
        if (!existing) {
            mediaUploadStats.limitedWrites++;
            return { id: null, capture_id: upload.captureId, limited: true };
        }

        if (String(existing.session_id) !== String(sessionId) || existing.capture_type !== upload.type) {
            throw mediaError(409, 'Capture ID was already used for a different upload');
        }
        await exec(
            'UPDATE media_upload_failures SET resolved_at = CURRENT_TIMESTAMP WHERE capture_id = ?',
            [upload.captureId]
        );
        if (Number(inserted.rowsAffected) > 0) {
            mediaUploadStats.writes++;
            return { id: Number(existing.id), capture_id: upload.captureId, duplicate: false };
        }
        mediaUploadStats.duplicateWrites++;
        return { id: Number(existing.id), capture_id: upload.captureId, duplicate: true };
    }), {
        attempts: 4,
        onRetry: recordDatabaseRetry
    }).catch(error => {
        mediaUploadStats.failedWrites++;
        throw error;
    });
}

function mediaCaptureResponse(row) {
    return {
        ...row,
        media_url: Number(row.file_size) > 0 || !row.capture_id
            ? `/api/sessions/${row.session_id}/capture-rows/${row.id}/media`
            : null
    };
}

async function sendCaptureMedia(res, capture) {
    if (!capture) return res.status(404).json({ error: 'Capture not found' });
    let media = capture.media_data ? Buffer.from(capture.media_data) : null;
    let mimeType = capture.mime_type || (capture.capture_type === 'audio' ? 'audio/webm' : 'image/jpeg');
    if (!media && typeof capture.image_data === 'string') {
        let legacyData = capture.image_data;
        if (capture.capture_type === 'audio') {
            try {
                const parsed = JSON.parse(legacyData);
                legacyData = parsed.audio_clip || '';
            } catch {
                legacyData = '';
            }
        }
        if (legacyData) {
            const decoded = decodeDataUrl(legacyData, mimeType);
            media = decoded.buffer;
            mimeType = decoded.mimeType;
        }
    }
    if (!media || !media.length) return res.status(404).json({ error: 'Capture has no media payload' });
    res.set('Cache-Control', 'private, max-age=300');
    return res.type(mimeType).send(media);
}

async function canReadSessionMedia(req, res, sessionId) {
    const session = await getSessionOwner(sessionId);
    if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return null;
    }
    if (req.user.role === 'admin' ||
        (req.user.role === 'professor' && String(session.professor_id) === String(req.user.id)) ||
        (req.user.role === 'student' && String(session.student_user_id) === String(req.user.id))) {
        return session;
    }
    res.status(403).json({ error: 'Forbidden' });
    return null;
}

app.use(cors());
app.use(express.json({ limit: '8mb' }));

app.use((req, res, next) => {
    const pathLower = req.path.toLowerCase();
    const blocked = pathLower.endsWith('.db') ||
        pathLower.endsWith('wams.db') ||
        pathLower.startsWith('/server/') ||
        pathLower.startsWith('/node_modules/') ||
        pathLower.startsWith('/.git') ||
        pathLower === '/package.json' ||
        pathLower === '/package-lock.json' ||
        pathLower.includes('..') ||
        pathLower === '/.env';
    if (blocked) {
        return res.status(404).end();
    }
    next();
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "index.html"));
});

app.use(express.static(path.join(__dirname, "..")));

function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth)
        return res.status(401).json({
            error: "Unauthorized"
        });
    const token = auth.replace("Bearer ", "");
    try {
        const decoded = jwt.verify(
            token,
            JWT_SECRET
        );
        get(`
          SELECT
              id,
              username,
              role,
              name
          FROM users
          WHERE id=?
      `, [decoded.id]).then(user => {
            if (!user)
                return res.status(401).json({
                    error: "Invalid Token"
                });

            req.user = user;

            next();
        }).catch(() => {
            return res.status(500).json({
                error: "Unable to verify authentication"
            });
        });

    } catch {
        return res.status(401).json({
            error: "Invalid Token"
        });
    }
}

async function getSessionOwner(sessionId) {
    return await get(`
      SELECT
        es.*,
        s.user_id AS student_user_id,
        e.professor_id
      FROM exam_sessions es
      JOIN students s ON es.student_id = s.id
      JOIN exams e ON es.exam_id = e.id
      WHERE es.id = ?
    `, [sessionId]);
}

async function requireLiveExamForSession(session, res){
    const exam = await get('SELECT * FROM exams WHERE id = ?', [session.exam_id]);
    if (!exam) {
        res.status(404).json({ error: 'Exam not found' });
        return false;
    }
    const currentExam = await syncExamStatus(exam);
    if (currentExam.status !== 'live') {
        const message = currentExam.status === 'ended'
            ? 'This exam has ended. Answers can no longer be submitted.'
            : 'This exam has not started yet.';
        res.status(409).json({ error: message, status: currentExam.status });
        return false;
    }
    return true;
}

// ── Dynamic exam status ──
// Timestamps are stored as SQLite DATETIME text without a zone ("YYYY-MM-DD HH:MM:SS",
// UTC). `new Date("2026-10-29 04:08:01")` is parsed as *local* time, which shifted
// every countdown by the server's UTC offset (e.g. +8h in Manila) and made a fresh
// 45-minute exam open with 0-3 minutes left. Normalize before any Date math.
function parseDbDate(value){
    if(!value) return NaN;
    if(value instanceof Date) return value.getTime();
    const text = String(value).trim();
    if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)){
        return new Date(text.replace(' ', 'T') + 'Z').getTime();
    }
    return new Date(text).getTime();
}

async function syncExamStatus(exam){
    if (!exam) return exam;
    const eff = computeEffectiveStatus(exam, Date.now(), parseDbDate);
    if (eff === 'live' && exam.status !== 'live') {
        await exec(`
            UPDATE exams
            SET status = 'live', live_started_at = COALESCE(live_started_at, ?)
            WHERE id = ? AND status = ?
        `, [new Date().toISOString(), exam.id, exam.status]);
        if (!exam.live_started_at) exam.live_started_at = new Date().toISOString();
        exam.status = 'live';
    } else if (eff === 'ended' && exam.status !== 'ended') {
        await exec("UPDATE exams SET status = 'ended' WHERE id = ? AND status = 'live'", [exam.id]);
        exam.status = 'ended';
    } else if (eff === 'live' && !exam.live_started_at) {
        const liveStartedAt = new Date().toISOString();
        await exec("UPDATE exams SET live_started_at = ? WHERE id = ? AND live_started_at IS NULL", [liveStartedAt, exam.id]);
        exam.live_started_at = liveStartedAt;
    }
    return exam;
}

let examLifecycleSyncRunning = false;
async function syncScheduledExamLifecycle(){
    if (examLifecycleSyncRunning) return;
    examLifecycleSyncRunning = true;
    try {
        const exams = await all("SELECT * FROM exams WHERE status IN ('scheduled', 'live')");
        for (const exam of exams) {
            await syncExamStatus(exam);
        }
    } catch (error) {
        console.warn('Failed to sync scheduled exam lifecycle:', error && error.message ? error.message : error);
    } finally {
        examLifecycleSyncRunning = false;
    }
}

const EXAM_LIFECYCLE_SYNC_INTERVAL_MS = 5000;

// Auth endpoints
app.post('/api/auth/login', async (req, res) => {

    const { username, password } = req.body;

    const user = await get(`
        SELECT *
        FROM users
        WHERE username = ?
    `, [username]);

    if (!user)
        return res.status(401).json({
            error: "Invalid credentials"
        });

    const match = await bcrypt.compare(
        password,
        user.password
    );

    if (!match)
        return res.status(401).json({
            error: "Invalid credentials"
        });

    if (user.role !== "admin") {
        return res.status(403).json({
            error: "Admin access only"
        });
    }

    const token = jwt.sign(
        {
            id: user.id,
            role: user.role
        },
        JWT_SECRET,
        {
            expiresIn: "24h"
        }
    );

    res.json({
        token,
        user: {
            id: user.id,
            name: user.name,
            username: user.username,
            role: user.role
        }
    });

});

app.post('/api/auth/register', async (req, res) => {

    const {
        username,
        password,
        name,
        inviteCode
    } = req.body;

    // Invite codes are reusable — any code that exists in the table is valid.
    const invite = await get(`
        SELECT *
        FROM admin_invites
        WHERE code=?
    `, [inviteCode]);

    if (!invite) {
        return res.status(400).json({
            error: "Invalid invitation code"
        });
    }

    const hashed = await bcrypt.hash(password, 10);

    try {
        const result = await exec(`
            INSERT INTO users
            (role,name,username,password)
            VALUES (?,?,?,?)
        `, ["admin", name, username, hashed]);

        // Invite code is intentionally NOT marked as used, so it can be
        // reused for future admin registrations.

        res.json({
            success: true,
            id: lastId(result)
        });

    } catch (err) {
        res.status(400).json({
            error: err.message
        });
    }

});

app.post('/api/auth/student-login', async (req, res) => {
    const { student_id, access_code } = req.body;

    // Find student by student_id (active status only)
    const student = await get(`
    SELECT s.*, u.name, sec.name as section_name, sec.course
    FROM students s
    JOIN users u ON s.user_id = u.id
    JOIN sections sec ON s.section_id = sec.id
    WHERE s.student_id = ? AND s.status = 'active'
    `, [student_id]);

    if (!student) return res.status(401).json({ error: 'Invalid student number or account suspended' });

    // Validate the exam access code
    if (!access_code) {
        return res.status(401).json({ error: 'Exam access code is required' });
    }

    // Match the exact code shared by the instructor, including ended exams
    // so a correct code can receive the appropriate lifecycle message.
    let exam = await get(`
    SELECT e.*, sec.name as section_name
    FROM exams e
    JOIN sections sec ON e.section_id = sec.id
    WHERE e.section_id = ?
      AND (e.year_level IS NULL OR e.year_level = ?)
      AND e.status IN ('scheduled', 'live', 'ended')
      AND TRIM(COALESCE(e.access_code, '')) = ?
    ORDER BY CASE WHEN e.status = 'ended' THEN 1 ELSE 0 END, e.created_at DESC
    LIMIT 1
  `, [student.section_id, student.year_level, String(access_code).trim()]);

    // Fall back by section name for legacy duplicate section rows.
    if (!exam) {
        exam = await get(`
    SELECT e.*, sec.name as section_name
    FROM exams e
    JOIN sections sec ON e.section_id = sec.id
    WHERE sec.name = (SELECT name FROM sections WHERE id = ?)
      AND (e.year_level IS NULL OR e.year_level = ?)
      AND e.status IN ('scheduled', 'live', 'ended')
      AND TRIM(COALESCE(e.access_code, '')) = ?
    ORDER BY CASE WHEN e.status = 'ended' THEN 1 ELSE 0 END, e.created_at DESC
    LIMIT 1
  `, [student.section_id, student.year_level, String(access_code).trim()]);
    }

    if (!exam) return res.status(401).json({ error: 'Invalid exam access code' });

    // Sync scheduled/live status before deciding whether the student may enter.
    exam = await syncExamStatus(exam);

    if (exam.status === 'ended') {
        return res.status(401).json({
            error: 'This exam has ended. You can no longer enter or submit answers.',
            status: 'ended'
        });
    }
    if (exam.status !== 'live') {
        return res.status(401).json({
            error: 'This exam has not started yet. Please wait until its scheduled start time.',
            status: 'scheduled'
        });
    }
    // Reuse the student's session for this exam instead of stacking a new one
    // every time they re-enter (closing the page and logging in again).
    // A submitted session means the exam is done for this student.
    const existingSession = await get(`
        SELECT * FROM exam_sessions
        WHERE exam_id = ? AND student_id = ?
        ORDER BY id DESC
        LIMIT 1
    `, [exam.id, student.id]).catch(err => {
        console.error('Unable to look up existing session:', err);
        return null;
    });

    // The student's own clock: full duration from the moment their session
    // began, so minutes between go-live and entry (or a page reload) are not
    // silently subtracted, plus the exam window as the outer limit.
    const timeRemainingCalculatedAt = Date.now();
    const timeRemainingSeconds = getRemainingExamSeconds(
        exam, timeRemainingCalculatedAt, existingSession ? existingSession.started_at : null, parseDbDate);
    if (timeRemainingSeconds <= 0) {
        const syncedExam = await syncExamStatus(exam);
        if (syncedExam.status === 'ended') {
            return res.status(401).json({
                error: 'This exam has ended. You can no longer enter or submit answers.',
                status: 'ended'
            });
        }
    }

    if (existingSession && existingSession.submitted_at) {
        return res.status(401).json({
            error: 'You have already submitted this exam.',
            status: 'submitted'
        });
    }

    let sessionId;
    let resumed = false;

    if (existingSession) {
        sessionId = existingSession.id;
        resumed = true;
    } else {
        try {
            const sessionResult = await exec(`
                INSERT INTO exam_sessions (exam_id, student_id) VALUES (?, ?)
            `, [exam.id, student.id]);
            sessionId = lastId(sessionResult);
        } catch (insertErr) {
            // Never let a session-creation failure take down the server.
            console.error('Unable to create exam session:', insertErr);
            // Another request may have created it in the meantime.
            const raced = await get(`
                SELECT * FROM exam_sessions WHERE exam_id = ? AND student_id = ?
                ORDER BY id DESC LIMIT 1
            `, [exam.id, student.id]).catch(() => null);
            if (raced) {
                sessionId = raced.id;
                resumed = true;
            } else {
                return res.status(500).json({
                    error: 'Unable to start the exam session. Please try again.'
                });
            }
        }
    }

    const token = jwt.sign(
        {
            id: student.user_id,
            role: "student"
        },
        JWT_SECRET,
        {
            expiresIn: "24h"
        });

    res.json({
        token,
        student,
        resumed,
        session: existingSession ? {
            id: existingSession.id,
            started_at: existingSession.started_at,
            answers: existingSession.answers
        } : null,
        exam: {
            ...exam,
            time_remaining_seconds: timeRemainingSeconds,
            session_id: sessionId
        }
    });
});

app.post('/api/auth/professor-login', async (req, res) => {
    const { faculty_id, access_code } = req.body;

    const instructor = await get(`
    SELECT i.*, c.name AS course, u.id as user_id, u.name, u.role
    FROM instructors i
    JOIN users u ON i.user_id = u.id
    LEFT JOIN courses c ON c.id = i.course_id
    WHERE i.faculty_id = ? AND i.access_code = ? AND i.status = 'active'
  `, [faculty_id, access_code]);

    if (!instructor) return res.status(401).json({ error: 'Invalid Faculty ID or Access Code' });

    const token = jwt.sign(
        {
            id: instructor.user_id,
            role: instructor.role
        },
        JWT_SECRET,
        {
            expiresIn: "24h"
        });

    res.json({
        token,
        user: {
            id: instructor.user_id,
            name: instructor.name,
            role: instructor.role,
            department: instructor.department || 'Faculty',
            course: instructor.course || null,
            course_id: instructor.course_id || null
        }
    });
});

app.post('/api/auth/logout', (req, res) => {
    res.json({ success: true });
});

app.get("/api/me", requireAuth, async (req, res) => {
    const user = await get(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.username,
      u.role,
      s.student_id,
      s.year_level,
      s.status,
      sec.name AS section_name,
      sec.course,
      i.department,
      c.name AS instructor_course,
      i.faculty_id
    FROM users u
    LEFT JOIN students s ON u.id = s.user_id
    LEFT JOIN sections sec ON sec.id = s.section_id
    LEFT JOIN instructors i ON u.id = i.user_id
    LEFT JOIN courses c ON c.id = i.course_id
    WHERE u.id = ?
  `, [req.user.id]);
    res.json(user);
});

// Sections
app.get('/api/sections', requireAuth, async (req, res) => {
    if (req.user.role === 'professor') {
        const instructor = await get(`
          SELECT i.id, c.name AS course
          FROM instructors i
          LEFT JOIN courses c ON c.id = i.course_id
          WHERE i.user_id = ?
        `, [req.user.id]);
        if (instructor) {
            const assignedSections = await all(`
              SELECT s.id, s.name, s.course, ic.year_level
              FROM instructor_classes ic
              JOIN sections s ON s.id = ic.section_id
              WHERE ic.instructor_id = ?
              ORDER BY s.course, s.name, ic.year_level
            `, [instructor.id]);
            if (assignedSections.length) {
                return res.json(assignedSections);
            }
            if (instructor.course) {
                const legacySections = await all(`
                  SELECT s.*, NULL AS year_level
                  FROM sections s
                  WHERE s.course = ? COLLATE NOCASE
                  ORDER BY s.course, s.name
                `, [instructor.course]);
                return res.json(legacySections);
            }
        }
        return res.json([]);
    }
    const sections = await all('SELECT * FROM sections ORDER BY course, name');
    res.json(sections);
});

app.post('/api/sections', requireAuth, async (req, res) => {
    const { name, course, year_level } = req.body;
    // Reuse an identical section instead of creating a duplicate
    const existing = await get('SELECT * FROM sections WHERE name = ? AND course = ?', [name, course]);
    if (existing) {
        return res.json(existing);
    }
    const result = await exec('INSERT INTO sections (name, course, year_level, created_by) VALUES (?, ?, ?, ?)', [name, course, year_level, req.user.id]);
    const section = await get('SELECT * FROM sections WHERE id = ?', [lastId(result)]);
    res.json(section);
});

// Delete an entire course (all of its sections) and every student enrolled in it.
app.delete('/api/sections/course', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only administrators can delete a course' });
    }
    const course = typeof req.query.course === 'string' ? req.query.course.trim() : '';
    if (!course) {
        return res.status(400).json({ error: 'Course name is required' });
    }

    try {
        const sections = await all('SELECT id FROM sections WHERE course = ? COLLATE NOCASE', [course]);
        const sectionIds = sections.map(s => s.id);

        if (sectionIds.length) {
            const placeholders = sectionIds.map(() => '?').join(', ');

            // Delete all exams for these sections and their related session data
            const exams = await all(`SELECT id FROM exams WHERE section_id IN (${placeholders})`, sectionIds);
            const examIds = exams.map(e => e.id);
            if (examIds.length) {
                const examPlaceholders = examIds.map(() => '?').join(', ');
                const examSessions = await all(`SELECT id FROM exam_sessions WHERE exam_id IN (${examPlaceholders})`, examIds);
                const sessionIds = examSessions.map(s => s.id);
                if (sessionIds.length) {
                    const sessionPlaceholders = sessionIds.map(() => '?').join(', ');
                    await exec(`DELETE FROM tab_switches WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    await exec(`DELETE FROM camera_captures WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    await exec(`DELETE FROM question_activity WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                }
                await exec(`DELETE FROM exam_sessions WHERE exam_id IN (${examPlaceholders})`, examIds);
                await exec(`DELETE FROM exam_enrollments WHERE exam_id IN (${examPlaceholders})`, examIds);
                await exec(`DELETE FROM exams WHERE id IN (${examPlaceholders})`, examIds);
            }

            // Students enrolled in any of this course's sections
            const enrolled = await all(
                `SELECT id, user_id FROM students WHERE section_id IN (${placeholders})`,
                sectionIds
            );
            const studentIds = enrolled.map(s => s.id);

            if (studentIds.length) {
                const studentPlaceholders = studentIds.map(() => '?').join(', ');
                const sessionRows = await all(
                    `SELECT id FROM exam_sessions WHERE student_id IN (${studentPlaceholders})`,
                    studentIds
                );
                const sessionIds = sessionRows.map(s => s.id);
                if (sessionIds.length) {
                    const sessionPlaceholders = sessionIds.map(() => '?').join(', ');
                    await exec(`DELETE FROM tab_switches WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    await exec(`DELETE FROM camera_captures WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    await exec(`DELETE FROM question_activity WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    await exec(`DELETE FROM exam_sessions WHERE id IN (${sessionPlaceholders})`, sessionIds);
                }
                await exec(`DELETE FROM students WHERE id IN (${studentPlaceholders})`, studentIds);
                await exec(
                    `DELETE FROM users WHERE id IN (${enrolled.map(() => '?').join(', ')})`,
                    enrolled.map(s => s.user_id)
                );
            }

            // Remove instructor class assignments, then the sections themselves
            await exec(`DELETE FROM instructor_classes WHERE section_id IN (${placeholders})`, sectionIds);
            await exec(`DELETE FROM sections WHERE id IN (${placeholders})`, sectionIds);
        }

        // Unset course_id for instructors assigned to this course
        const courseRow = await get('SELECT id FROM courses WHERE name = ? COLLATE NOCASE', [course]);
        if (courseRow) {
            await exec('UPDATE instructors SET course_id = NULL WHERE course_id = ?', [courseRow.id]);
            await exec('DELETE FROM courses WHERE id = ?', [courseRow.id]);
        }

        res.json({ success: true, removedSections: sectionIds.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete a course (from the courses table) and all of its sections, with cascading cleanup.
app.delete('/api/admin/courses/:id', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only administrators can manage courses' });
    }
    const courseId = Number(req.params.id);
    if (!Number.isInteger(courseId) || courseId < 1) {
        return res.status(400).json({ error: 'Invalid course ID' });
    }
    try {
        const course = await get('SELECT * FROM courses WHERE id = ?', [courseId]);
        if (!course) {
            return res.status(404).json({ error: 'Course not found' });
        }

        // Delete all sections under this course (cascades to students, instructor_classes, exam data)
        const sections = await all('SELECT id FROM sections WHERE course = ? COLLATE NOCASE', [course.name]);
        const sectionIds = sections.map(s => s.id);

        if (sectionIds.length) {
            const placeholders = sectionIds.map(() => '?').join(', ');

            // Delete all exams for these sections and their related session data
            const exams = await all(`SELECT id FROM exams WHERE section_id IN (${placeholders})`, sectionIds);
            const examIds = exams.map(e => e.id);
            if (examIds.length) {
                const examPlaceholders = examIds.map(() => '?').join(', ');
                const examSessions = await all(`SELECT id FROM exam_sessions WHERE exam_id IN (${examPlaceholders})`, examIds);
                const sessionIds = examSessions.map(s => s.id);
                if (sessionIds.length) {
                    const sessionPlaceholders = sessionIds.map(() => '?').join(', ');
                    await exec(`DELETE FROM tab_switches WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    await exec(`DELETE FROM camera_captures WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    await exec(`DELETE FROM question_activity WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                }
                await exec(`DELETE FROM exam_sessions WHERE exam_id IN (${examPlaceholders})`, examIds);
                await exec(`DELETE FROM exam_enrollments WHERE exam_id IN (${examPlaceholders})`, examIds);
                await exec(`DELETE FROM exams WHERE id IN (${examPlaceholders})`, examIds);
            }

            // Students enrolled in any of this course's sections
            const enrolled = await all(
                `SELECT id, user_id FROM students WHERE section_id IN (${placeholders})`,
                sectionIds
            );
            const studentIds = enrolled.map(s => s.id);

            if (studentIds.length) {
                const studentPlaceholders = studentIds.map(() => '?').join(', ');
                const sessionRows = await all(
                    `SELECT id FROM exam_sessions WHERE student_id IN (${studentPlaceholders})`,
                    studentIds
                );
                const sessionIds = sessionRows.map(s => s.id);
                if (sessionIds.length) {
                    const sessionPlaceholders = sessionIds.map(() => '?').join(', ');
                    await exec(`DELETE FROM tab_switches WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    await exec(`DELETE FROM camera_captures WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    await exec(`DELETE FROM question_activity WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    await exec(`DELETE FROM exam_sessions WHERE id IN (${sessionPlaceholders})`, sessionIds);
                }
                await exec(`DELETE FROM students WHERE id IN (${studentPlaceholders})`, studentIds);
                await exec(
                    `DELETE FROM users WHERE id IN (${enrolled.map(() => '?').join(', ')})`,
                    enrolled.map(s => s.user_id)
                );
            }

            await exec(`DELETE FROM instructor_classes WHERE section_id IN (${placeholders})`, sectionIds);
            await exec(`DELETE FROM sections WHERE id IN (${placeholders})`, sectionIds);
        }

        // Unset course_id for instructors assigned to this course
        await exec('UPDATE instructors SET course_id = NULL WHERE course_id = ?', [courseId]);

        await exec('DELETE FROM courses WHERE id = ?', [courseId]);

        res.json({ success: true, removedSections: sectionIds.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/departments', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only administrators can manage departments' });
    }
    const departments = await all(`
      SELECT d.id, d.name, d.created_at, COUNT(i.id) AS instructor_count
      FROM departments d
      LEFT JOIN instructors i ON TRIM(i.department) = d.name COLLATE NOCASE
      GROUP BY d.id
      ORDER BY d.name COLLATE NOCASE
    `);
    res.json(departments);
});

app.post('/api/admin/departments', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only administrators can manage departments' });
    }
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
        return res.status(400).json({ error: 'Department name is required' });
    }
    if (name.length > 120) {
        return res.status(400).json({ error: 'Department name must be 120 characters or fewer' });
    }

    await exec('INSERT OR IGNORE INTO departments (name, created_by) VALUES (?, ?)', [name, req.user.id]);
    const department = await get(`
      SELECT id, name, created_at
      FROM departments
      WHERE name = ? COLLATE NOCASE
    `, [name]);
    res.json(department);
});

// Delete a department and all of its courses, with cascading cleanup.
app.delete('/api/admin/departments/:id', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only administrators can manage departments' });
    }
    const deptId = Number(req.params.id);
    if (!Number.isInteger(deptId) || deptId < 1) {
        return res.status(400).json({ error: 'Invalid department ID' });
    }
    try {
        const dept = await get('SELECT * FROM departments WHERE id = ?', [deptId]);
        if (!dept) {
            return res.status(404).json({ error: 'Department not found' });
        }

        // Get all courses in this department
        const courses = await all('SELECT id, name FROM courses WHERE department_id = ?', [deptId]);
        let totalRemovedSections = 0;

        for (const course of courses) {
            const sections = await all('SELECT id FROM sections WHERE course = ? COLLATE NOCASE', [course.name]);
            const sectionIds = sections.map(s => s.id);
            totalRemovedSections += sectionIds.length;

            if (sectionIds.length) {
                const placeholders = sectionIds.map(() => '?').join(', ');

                // Delete all exams for these sections and their related session data
                const exams = await all(`SELECT id FROM exams WHERE section_id IN (${placeholders})`, sectionIds);
                const examIds = exams.map(e => e.id);
                if (examIds.length) {
                    const examPlaceholders = examIds.map(() => '?').join(', ');
                    const examSessions = await all(`SELECT id FROM exam_sessions WHERE exam_id IN (${examPlaceholders})`, examIds);
                    const sessionIds = examSessions.map(s => s.id);
                    if (sessionIds.length) {
                        const sessionPlaceholders = sessionIds.map(() => '?').join(', ');
                        await exec(`DELETE FROM tab_switches WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                        await exec(`DELETE FROM camera_captures WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                        await exec(`DELETE FROM question_activity WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                    }
                    await exec(`DELETE FROM exam_sessions WHERE exam_id IN (${examPlaceholders})`, examIds);
                    await exec(`DELETE FROM exam_enrollments WHERE exam_id IN (${examPlaceholders})`, examIds);
                    await exec(`DELETE FROM exams WHERE id IN (${examPlaceholders})`, examIds);
                }

                // Students enrolled in any of this course's sections
                const enrolled = await all(
                    `SELECT id, user_id FROM students WHERE section_id IN (${placeholders})`,
                    sectionIds
                );
                const studentIds = enrolled.map(s => s.id);

                if (studentIds.length) {
                    const studentPlaceholders = studentIds.map(() => '?').join(', ');
                    const sessionRows = await all(
                        `SELECT id FROM exam_sessions WHERE student_id IN (${studentPlaceholders})`,
                        studentIds
                    );
                    const sessionIds = sessionRows.map(s => s.id);
                    if (sessionIds.length) {
                        const sessionPlaceholders = sessionIds.map(() => '?').join(', ');
                        await exec(`DELETE FROM tab_switches WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                        await exec(`DELETE FROM camera_captures WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                        await exec(`DELETE FROM question_activity WHERE session_id IN (${sessionPlaceholders})`, sessionIds);
                        await exec(`DELETE FROM exam_sessions WHERE id IN (${sessionPlaceholders})`, sessionIds);
                    }
                    await exec(`DELETE FROM students WHERE id IN (${studentPlaceholders})`, studentIds);
                    await exec(
                        `DELETE FROM users WHERE id IN (${enrolled.map(() => '?').join(', ')})`,
                        enrolled.map(s => s.user_id)
                    );
                }

                await exec(`DELETE FROM instructor_classes WHERE section_id IN (${placeholders})`, sectionIds);
                await exec(`DELETE FROM sections WHERE id IN (${placeholders})`, sectionIds);
            }

            // Unset course_id for instructors assigned to this course
            await exec('UPDATE instructors SET course_id = NULL WHERE course_id = ?', [course.id]);
        }

        // Delete all courses in this department
        await exec('DELETE FROM courses WHERE department_id = ?', [deptId]);

        // Unset department for instructors in this department
        await exec('UPDATE instructors SET department = NULL WHERE department = ? COLLATE NOCASE', [dept.name]);

        await exec('DELETE FROM departments WHERE id = ?', [deptId]);

        res.json({ success: true, removedCourses: courses.length, removedSections: totalRemovedSections });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/courses', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only administrators can manage courses' });
    }
    const courses = await all(`
      SELECT c.id, c.name, c.department_id, d.name AS department, c.created_at,
             COUNT(i.id) AS instructor_count
      FROM courses c
      JOIN departments d ON d.id = c.department_id
      LEFT JOIN instructors i ON i.course_id = c.id
      GROUP BY c.id
      ORDER BY d.name COLLATE NOCASE, c.name COLLATE NOCASE
    `);
    res.json(courses);
});

app.post('/api/admin/courses', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only administrators can manage courses' });
    }
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const departmentId = Number(req.body.department_id);
    if (!name) {
        return res.status(400).json({ error: 'Course name is required' });
    }
    if (name.length > 120) {
        return res.status(400).json({ error: 'Course name must be 120 characters or fewer' });
    }
    if (!Number.isInteger(departmentId) || departmentId < 1) {
        return res.status(400).json({ error: 'Select a valid department' });
    }
    const department = await get('SELECT id FROM departments WHERE id = ?', [departmentId]);
    if (!department) {
        return res.status(400).json({ error: 'Selected department does not exist' });
    }

    await exec(
        'INSERT OR IGNORE INTO courses (department_id, name, created_by) VALUES (?, ?, ?)',
        [departmentId, name, req.user.id]
    );
    const course = await get(`
      SELECT c.id, c.name, c.department_id, d.name AS department, c.created_at
      FROM courses c
      JOIN departments d ON d.id = c.department_id
      WHERE c.department_id = ? AND c.name = ? COLLATE NOCASE
    `, [departmentId, name]);
    res.json(course);
});

// Students
app.get('/api/students', requireAuth, async (req, res) => {
    const { section_id } = req.query;
    let query = `
    SELECT s.*, u.name, sec.name as section_name, sec.course
    FROM students s
    JOIN users u ON s.user_id = u.id
    JOIN sections sec ON s.section_id = sec.id
  `;
    const params = [];
    if (section_id) {
        query += ' WHERE s.section_id = ?';
        params.push(section_id);
    }
    query += ' ORDER BY sec.course, sec.name, s.student_id';
    const students = await all(query, params);
    res.json(students);
});

app.post('/api/students', requireAuth, async (req, res) => {
    const {
        name,
        dept,
        studentId,
        accessCode,
        year,
        section,
        course
    } = req.body;
    // Accept both naming conventions from frontend
    const resolvedStudentId = studentId || req.body.facultyId;
    const resolvedAccessCode = accessCode || req.body.code || '';
    // The student form allows picking several year-level/section groups at once
    // (e.g. "1st Year (BSIT - 1)" and "1st Year (BSIT - 2)"). Each becomes its
    // own student record; a single sectionId is just the one-element case.
    const requestedSectionIds = Array.isArray(req.body.sectionIds)
        ? req.body.sectionIds
        : [];
    if (req.body.sectionId) requestedSectionIds.push(req.body.sectionId);
    try {
        let sectionIds = [];

        if (requestedSectionIds.length) {
            // Use provided section ID(s)
            for (const rawId of requestedSectionIds) {
                const sid = parseInt(rawId);
                const sectionRow = await get("SELECT id FROM sections WHERE id = ?", [sid]);
                if (!sectionRow) {
                    return res.status(400).json({ error: 'Invalid section selected' });
                }
                if (!sectionIds.includes(sid)) sectionIds.push(sid);
            }
        } else if (req.body.section) {
            // Try to find existing section by name
            const sectionRow = await get(
                "SELECT id FROM sections WHERE name = ?",
                [req.body.section]
            );

            if (!sectionRow) {
                return res.status(400).json({ error: 'Section not found. Please create the section first.' });
            }

            sectionIds = [sectionRow.id];
        } else if (course) {
            // Section is optional. When none is chosen, place the student in an
            // "Unassigned" section under the given course so it still appears
            // in the course list.
            const courseName = String(course).trim();
            let placeholder = await get(
                "SELECT id FROM sections WHERE name = ? AND course = ?",
                ['Unassigned', courseName]
            );
            if (!placeholder) {
                const result = await exec(
                    'INSERT INTO sections (name, course, created_by) VALUES (?, ?, ?)',
                    ['Unassigned', courseName, req.user.id]
                );
                placeholder = { id: lastId(result) };
            }
            sectionIds = [placeholder.id];
        } else {
            return res.status(400).json({ error: 'Course is required' });
        }

        // Create user account
        const userResult = await exec(`
      INSERT INTO users (role, name)
      VALUES (?, ?)
      `, ["student", name]);

        // Create one student record per selected section
        const userId = lastId(userResult);
        const createdIds = [];
        const selectedYear = year || null;
        for (const sectionId of sectionIds) {
            const studentResult = await exec(
                `INSERT INTO students
      (user_id, student_id, section_id, year_level, access_code)
      VALUES (?, ?, ?, ?, ?)`,
                [userId, resolvedStudentId, sectionId, selectedYear, resolvedAccessCode]
            );
            createdIds.push(lastId(studentResult));
        }

        const placeholders = createdIds.map(() => '?').join(',');
        const students = await all(`
      SELECT
        s.*,
        u.name,
        sec.name AS section_name,
        sec.course
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN sections sec ON s.section_id = sec.id
      WHERE s.id IN (${placeholders})
    `, createdIds);

        res.json(students.length === 1 ? students[0] : students);

    } catch (e) {
        res.status(400).json({
            error: e.message
        });
    }
});

app.put('/api/students/:id', requireAuth, async (req, res) => {

    const {
        name,
        section_id,
        year_level,
        status,
        access_code
    } = req.body;

    const student = await get(
        'SELECT * FROM students WHERE id = ?',
        [req.params.id]
    );

    if (!student) {
        return res.status(404).json({
            error: 'Student not found'
        });
    }

    const updatedSection =
        section_id === null || section_id === undefined || section_id === ''
            ? student.section_id
            : section_id;

    if (updatedSection !== student.section_id) {
        const sectionRow = await get('SELECT id FROM sections WHERE id = ?', [updatedSection]);
        if (!sectionRow) {
            return res.status(400).json({ error: 'Invalid section selected' });
        }
    }

    const updatedYear =
        year_level ?? student.year_level;

    // Validate status against CHECK constraint
    let updatedStatus = student.status;
    if (status) {
        const validStatuses = ['active', 'flagged', 'suspended'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                error: 'Invalid status. Must be: active, flagged, or suspended'
            });
        }
        updatedStatus = status;
    }

    const updatedCode =
        access_code ?? student.access_code;

    await exec(`
    UPDATE students
    SET
      section_id = ?,
      year_level = ?,
      status = ?,
      access_code = ?
    WHERE id = ?
  `, [updatedSection, updatedYear, updatedStatus, updatedCode, req.params.id]);

    if (name) {
        await exec(`
      UPDATE users
      SET name = ?
      WHERE id = ?
    `, [name, student.user_id]);
    }

    const updated = await get(`
    SELECT
      s.*,
      u.name,
      sec.name AS section_name,
      sec.course
    FROM students s
    JOIN users u
      ON s.user_id = u.id
    JOIN sections sec
      ON s.section_id = sec.id
    WHERE s.id = ?
  `, [req.params.id]);

    res.json(updated);

});

app.delete('/api/students/:id', requireAuth, async (req, res) => {
    const student = await get('SELECT * FROM students WHERE id = ?', [req.params.id]);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    await exec('DELETE FROM tab_switches WHERE session_id IN (SELECT id FROM exam_sessions WHERE student_id = ?)', [student.id]);
    await exec('DELETE FROM camera_captures WHERE session_id IN (SELECT id FROM exam_sessions WHERE student_id = ?)', [student.id]);
    await exec('DELETE FROM question_activity WHERE session_id IN (SELECT id FROM exam_sessions WHERE student_id = ?)', [student.id]);
    await exec('DELETE FROM exam_sessions WHERE student_id = ?', [student.id]);
    await exec('DELETE FROM students WHERE id = ?', [student.id]);
    await exec('DELETE FROM users WHERE id = ?', [student.user_id]);
    res.json({ success: true });
});

// Instructors endpoints
app.get("/api/instructors", requireAuth, async (req, res) => {
    const instructors = await all(`
    SELECT
      i.*,
      c.name AS course,
      u.name
    FROM instructors i
    JOIN users u ON u.id=i.user_id
    LEFT JOIN courses c ON c.id=i.course_id
    ORDER BY u.name
  `);
  for (const instructor of instructors) {
      instructor.held_classes = await all(`
        SELECT ic.year_level, ic.section_id, s.name AS section_name
        FROM instructor_classes ic
        JOIN sections s ON s.id = ic.section_id
        WHERE ic.instructor_id = ?
        ORDER BY ic.year_level, s.name
      `, [instructor.id]);
  }
  res.json(instructors);
});

// Admin instructors endpoint (alias for admin panel)
app.get("/api/admin/instructors", requireAuth, async (req, res) => {
    const instructors = await all(`
    SELECT
      i.*,
      c.name AS course,
      u.name
    FROM instructors i
    JOIN users u ON u.id=i.user_id
    LEFT JOIN courses c ON c.id=i.course_id
    ORDER BY u.name
  `);
  for (const instructor of instructors) {
      instructor.held_classes = await all(`
        SELECT ic.year_level, ic.section_id, s.name AS section_name
        FROM instructor_classes ic
        JOIN sections s ON s.id = ic.section_id
        WHERE ic.instructor_id = ?
        ORDER BY ic.year_level, s.name
      `, [instructor.id]);
  }
  res.json(instructors);
});

app.post("/api/instructors", requireAuth, async (req, res) => {
    const {
        name,
        faculty_id,
        department,
        department_id,
        course_id,
        access_code,
        held_classes
    } = req.body;

    try {
        const departmentName = typeof department === 'string' ? department.trim() : '';
        const departmentId = Number(department_id);
        const selectedDepartment = Number.isInteger(departmentId) && departmentId > 0
            ? await get('SELECT id, name FROM departments WHERE id = ?', [departmentId])
            : departmentName
                ? await get('SELECT id, name FROM departments WHERE name = ? COLLATE NOCASE', [departmentName])
                : null;
        if (!selectedDepartment) {
            return res.status(400).json({ error: 'Department is required' });
        }
        const courseId = Number(course_id);
        if (!Number.isInteger(courseId) || courseId < 1) {
            return res.status(400).json({ error: 'Select a course' });
        }
        const selectedCourse = await get(
            'SELECT id FROM courses WHERE id = ? AND department_id = ?',
            [courseId, selectedDepartment.id]
        );
        if (!selectedCourse) {
            return res.status(400).json({ error: 'Select a course in the chosen department' });
        }
        // Sections are optional when adding an instructor: they can be assigned
        // later by editing the instructor, so an empty list is accepted.
        const classAssignments = Array.isArray(held_classes) ? held_classes : [];
        for (const assignment of classAssignments) {
            const sectionId = Number(assignment.section_id);
            const yearLevel = typeof assignment.year_level === 'string' ? assignment.year_level.trim() : '';
            const validSection = Number.isInteger(sectionId) && sectionId > 0
                ? await get('SELECT id FROM sections WHERE id = ? AND course = (SELECT name FROM courses WHERE id = ?) COLLATE NOCASE', [sectionId, courseId])
                : null;
            if (!validSection || !yearLevel) {
                return res.status(400).json({ error: 'Each held class must have a valid year level and section in the selected course' });
            }
        }

        const user = await exec(`
      INSERT INTO users (role,name)
      VALUES (?,?)
      `, ["professor", name]);

        const instructor = await exec(`
      INSERT INTO instructors(
        user_id,
        faculty_id,
        department,
        course_id,
        access_code
      )
      VALUES(?,?,?,?,?)
    `, [lastId(user), faculty_id, selectedDepartment.name, courseId, access_code]);

        for (const assignment of classAssignments) {
            await exec(`
              INSERT OR IGNORE INTO instructor_classes (instructor_id, section_id, year_level)
              VALUES (?, ?, ?)
            `, [lastId(instructor), Number(assignment.section_id), assignment.year_level.trim()]);
        }

        res.json({
            success: true,
            id: lastId(instructor)
        });

    } catch (err) {
        res.status(400).json({
            error: err.message
        });
    }
});

app.delete("/api/instructors/:id", requireAuth, async (req, res) => {
    const inst = await get(
        "SELECT * FROM instructors WHERE id=?",
        [req.params.id]
    );

    if (!inst) {
        return res.status(404).json({
            error: "Instructor not found"
        });
    }

    await exec(
        "DELETE FROM instructor_classes WHERE instructor_id=?",
        [req.params.id]
    );

    await exec(
        "DELETE FROM instructors WHERE id=?",
        [req.params.id]
    );

    await exec(
        "DELETE FROM users WHERE id=?",
        [inst.user_id]
    );

    res.json({
        success: true
    });
});

app.put("/api/instructors/:id", requireAuth, async (req, res) => {
    const {
        department,
        department_id,
        status,
        name,
        course_id,
        held_classes
    } = req.body;

    const inst = await get(
        "SELECT * FROM instructors WHERE id=?",
        [req.params.id]
    );

    if (!inst) {
        return res.status(404).json({
            error: "Instructor not found"
        });
    }

    const departmentId = department_id === undefined ? null : Number(department_id);
    const selectedDepartment = Number.isInteger(departmentId) && departmentId > 0
        ? await get('SELECT id, name FROM departments WHERE id = ?', [departmentId])
        : null;
    if (department_id !== undefined && !selectedDepartment) {
        return res.status(400).json({ error: 'Select a valid department' });
    }
    const updatedCourseId = course_id === undefined ? inst.course_id : Number(course_id);
    if (updatedCourseId !== null && updatedCourseId !== undefined) {
        if (!Number.isInteger(updatedCourseId) || updatedCourseId < 1) {
            return res.status(400).json({ error: 'Select a valid course' });
        }
        const selectedCourse = await get('SELECT id, name, department_id FROM courses WHERE id = ?', [updatedCourseId]);
        if (!selectedCourse) {
            return res.status(400).json({ error: 'Select a valid course' });
        }
        if (selectedDepartment && selectedCourse.department_id !== selectedDepartment.id) {
            return res.status(400).json({ error: 'Select a course in the chosen department' });
        }
    }
    const classAssignments = Array.isArray(held_classes) ? held_classes : null;
    if (classAssignments) {
        const selectedCourse = updatedCourseId
            ? await get('SELECT name FROM courses WHERE id = ?', [updatedCourseId])
            : null;
        for (const assignment of classAssignments) {
            const sectionId = Number(assignment.section_id);
            const yearLevel = typeof assignment.year_level === 'string' ? assignment.year_level.trim() : '';
            const validSection = selectedCourse && Number.isInteger(sectionId) && sectionId > 0
                ? await get('SELECT id FROM sections WHERE id = ? AND course = ? COLLATE NOCASE', [sectionId, selectedCourse.name])
                : null;
            if (!validSection || !yearLevel) {
                return res.status(400).json({ error: 'Each held class must have a valid year level and section in the selected course' });
            }
        }
    }

    const updatedDepartment =
        selectedDepartment?.name ?? department ?? inst.department;

    const updatedStatus =
        status ?? inst.status;

    await exec(`
    UPDATE instructors
    SET
      department = ?,
      course_id = ?,
      status = ?
    WHERE id = ?
`, [updatedDepartment, updatedCourseId, updatedStatus, req.params.id]);

    if (classAssignments) {
        await exec('DELETE FROM instructor_classes WHERE instructor_id = ?', [req.params.id]);
        for (const assignment of classAssignments) {
            await exec(`
              INSERT INTO instructor_classes (instructor_id, section_id, year_level)
              VALUES (?, ?, ?)
            `, [req.params.id, Number(assignment.section_id), assignment.year_level.trim()]);
        }
    }

    if (name) {
        await exec(`
      UPDATE users
      SET name=?
      WHERE id=?
    `, [name, inst.user_id]);
    }

    res.json({
        success: true
    });
});

// Profile endpoints
app.get('/api/profile', requireAuth, async (req, res) => {
    const user = await get(`
    SELECT u.id, u.name, u.role
    FROM users u
    WHERE u.id = ?
  `, [req.user.id]);
    res.json(user);
});

app.put('/api/profile', requireAuth, async (req, res) => {
    const { name, email } = req.body;

    await exec(`
        UPDATE users
        SET name = ?, email = ?
        WHERE id = ?
    `, [name, email || null, req.user.id]);

    const updated = await get(`
        SELECT
            id,
            name,
            email,
            role
        FROM users
        WHERE id = ?
    `, [req.user.id]);

    res.json(updated);
});

app.put('/api/profile/password', requireAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
        return res.status(400).json({ error: 'Current and new passwords are required' });
    }

    const user = await get('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(current_password, user.password || '');
    if (!valid) {
        return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await exec('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);
    res.json({ success: true });
});

// Feedback endpoints
app.get('/api/feedbacks', requireAuth, async (req, res) => {
    if (!['admin', 'professor'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Only professors and administrators can view feedback' });
    }

    const feedbacks = req.user.role === 'admin'
        ? await all(`
            SELECT f.*, u.name as professor_name
            FROM feedbacks f
            JOIN users u ON f.professor_id = u.id
            WHERE f.recipient_admin_id = ?
            ORDER BY f.created_at DESC
        `, [req.user.id])
        : await all(`
            SELECT f.*, u.name as professor_name
            FROM feedbacks f
            JOIN users u ON f.professor_id = u.id
            WHERE f.professor_id = ?
            ORDER BY f.created_at DESC
        `, [req.user.id]);
    res.json(feedbacks);
});

app.post('/api/feedbacks', requireAuth, async (req, res) => {
    if (req.user.role !== 'professor') {
        return res.status(403).json({ error: 'Only professors can submit feedback' });
    }

    const { category, subject, message, contact, module } = req.body;
    const allowedCategories = ['Bug Report', 'Feature Request', 'Performance', 'UX', 'General Feedback'];
    if (!allowedCategories.includes(category) ||
        typeof subject !== 'string' || !subject.trim() || subject.length > 120 ||
        typeof message !== 'string' || !message.trim() || message.length > 10000 ||
        typeof contact !== 'string' || !contact.trim() || contact.length > 254 ||
        typeof module !== 'string' || !module.trim() || module.length > 120) {
        return res.status(400).json({ error: 'Please provide valid feedback details' });
    }

    const admin = await get("SELECT id FROM users WHERE username = ? AND role = 'admin'", ['admin']);
    if (!admin) {
        return res.status(503).json({ error: 'The system administrator is unavailable' });
    }

    const result = await exec(`
    INSERT INTO feedbacks (professor_id, recipient_admin_id, category, subject, message, contact, module)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [req.user.id, admin.id, category, subject.trim(), message.trim(), contact.trim(), module.trim()]);

    const feedback = await get('SELECT * FROM feedbacks WHERE id = ?', [lastId(result)]);
    res.status(201).json(feedback);
});

app.put('/api/feedbacks/:id', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only administrators can update feedback' });
    }

    const { status } = req.body;
    if (!['New', 'Reviewed', 'Resolved'].includes(status)) {
        return res.status(400).json({ error: 'Invalid feedback status' });
    }

    const result = await exec(
        'UPDATE feedbacks SET status = ? WHERE id = ? AND recipient_admin_id = ?',
        [status, req.params.id, req.user.id]
    );
    if (result.rowsAffected === 0) {
        return res.status(404).json({ error: 'Feedback not found' });
    }
    res.json({ success: true });
});

app.delete('/api/feedbacks/:id', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only administrators can delete feedback' });
    }

    const result = await exec(
        'DELETE FROM feedbacks WHERE id = ? AND recipient_admin_id = ?',
        [req.params.id, req.user.id]
    );
    if (result.rowsAffected === 0) {
        return res.status(404).json({ error: 'Feedback not found' });
    }
    res.json({ success: true });
});

// Exams
// Exam Enrollments
app.get('/api/exams/:examId/enrollments', requireAuth, async (req, res) => {
    const enrollments = await all(`
    SELECT ee.*, s.student_id, u.name as student_name, sec.name as section_name
    FROM exam_enrollments ee
    JOIN students s ON ee.student_id = s.id
    JOIN users u ON s.user_id = u.id
    JOIN sections sec ON s.section_id = sec.id
    WHERE ee.exam_id = ?
    ORDER BY ee.enrolled_at DESC
  `, [req.params.examId]);
    res.json(enrollments);
});

app.post('/api/exams/:examId/enrollments', requireAuth, async (req, res) => {
    const { student_id } = req.body;

    // Verify exam exists
    const exam = await get('SELECT * FROM exams WHERE id = ?', [req.params.examId]);
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    // Verify student exists
    const student = await get('SELECT * FROM students WHERE id = ?', [student_id]);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (student.section_id !== exam.section_id ||
        (exam.year_level && student.year_level !== exam.year_level)) {
        return res.status(400).json({ error: 'Student is not in the exam year level and section' });
    }

    try {
        const result = await exec(`
      INSERT INTO exam_enrollments (exam_id, student_id) VALUES (?, ?)
    `, [req.params.examId, student_id]);

        res.json({ success: true, enrollmentId: lastId(result) });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint')) {
            return res.status(400).json({ error: 'Student already enrolled in this exam' });
        }
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/exams/:examId/enrollments/:studentId', requireAuth, async (req, res) => {
    const result = await exec(`
    DELETE FROM exam_enrollments WHERE exam_id = ? AND student_id = ?
  `, [req.params.examId, req.params.studentId]);

    if (result.rowsAffected === 0) {
        return res.status(404).json({ error: 'Enrollment not found' });
    }

    res.json({ success: true });
});

// Exams
app.get('/api/exams', requireAuth, async (req, res) => {
    const exams = await all(`
    SELECT e.*, s.name as section_name, s.course, u.name as professor_name
    FROM exams e
    JOIN sections s ON e.section_id = s.id
    JOIN users u ON e.professor_id = u.id
    ORDER BY e.created_at DESC
  `);
    res.json(exams);
});

// Get exams for the currently logged-in professor only
app.get('/api/my-exams', requireAuth, async (req, res) => {
    if (req.user.role !== 'professor') {
        return res.status(403).json({ error: 'Only professors can access this' });
    }
    const exams = await all(`
SELECT
    e.*,
    e.access_code AS accessCode,
    s.name AS section_name,
    s.course,

    (
        SELECT COUNT(*)
        FROM students st
        WHERE st.section_id = e.section_id
          AND (e.year_level IS NULL OR st.year_level = e.year_level)
    ) AS students,

    (
        SELECT COUNT(*)
        FROM tab_switches ts
        JOIN exam_sessions es
            ON es.id = ts.session_id
        WHERE es.exam_id = e.id
    ) AS flagged

FROM exams e
JOIN sections s
    ON e.section_id = s.id
WHERE e.professor_id = ?
ORDER BY e.created_at DESC
`, [req.user.id]);

    // Sync dynamic statuses (schedule/time-based transitions) so the
    // My Exams list, Live Monitor, badges and Monitoring Logs stay accurate.
    for (const e of exams) {
        await syncExamStatus(e);
    }

    res.json(exams);
});

// Get single exam by ID (for student exam tool)
app.get('/api/exams/:id', requireAuth, async (req, res) => {
    let exam = await get(`
    SELECT e.*, s.name as section_name, s.course
    FROM exams e
    JOIN sections s ON e.section_id = s.id
    WHERE e.id = ?
  `, [req.params.id]);
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    // Sync dynamic status (schedule/time-based transitions)
    exam = await syncExamStatus(exam);

    // Students may read lifecycle state for their section so the exam page can
    // show a clear scheduled/ended screen; answer writes are separately gated.
    if (req.user.role === 'student') {
        const student = await get(`
      SELECT s.section_id, s.year_level FROM students s WHERE s.user_id = ?
    `, [req.user.id]);
        if (!student || student.section_id !== exam.section_id ||
            (exam.year_level && student.year_level !== exam.year_level)) {
            return res.status(403).json({ error: 'Forbidden: You can only access exams for your year level and section' });
        }
        const session = await get(`
            SELECT es.id, es.submitted_at, es.started_at
            FROM exam_sessions es
            JOIN students st ON es.student_id = st.id
            WHERE es.exam_id = ? AND st.user_id = ?
            ORDER BY es.started_at DESC
            LIMIT 1
        `, [exam.id, req.user.id]);
        if (!session) {
            return res.status(403).json({ error: 'You must enter this exam with its access code first.' });
        }
        if (session.submitted_at && exam.status !== 'ended') {
            return res.status(403).json({ error: 'This exam session has already been submitted.' });
        }
        if (exam.status !== 'live') {
            return res.json({
                id: exam.id,
                title: exam.title,
                status: exam.status,
                schedule: exam.schedule,
                time_limit: exam.time_limit,
                time_remaining_seconds: getRemainingExamSeconds(exam, Date.now(), session.started_at, parseDbDate)
            });
        }
    }

    // Parse JSON fields
    exam.questions = exam.questions ? (typeof exam.questions === 'string' ? JSON.parse(exam.questions) : exam.questions) : [];
    exam.monitor_settings = exam.monitor_settings ? (typeof exam.monitor_settings === 'string' ? JSON.parse(exam.monitor_settings) : exam.monitor_settings) : {};
    exam.tools_settings = exam.tools_settings ? (typeof exam.tools_settings === 'string' ? JSON.parse(exam.tools_settings) : exam.tools_settings) : {};

    // Expose camelCase alias so clients reading `timeLimit` get the professor's
    // configured duration instead of falling back to a default.
    exam.timeLimit = exam.time_limit;
    // Students get their own session clock; staff see the exam-wide window.
    const viewerSession = req.user && req.user.role === 'student' ? await get(`
        SELECT es.started_at
        FROM exam_sessions es
        JOIN students st ON es.student_id = st.id
        WHERE es.exam_id = ? AND st.user_id = ?
        ORDER BY es.started_at DESC
        LIMIT 1
    `, [exam.id, req.user.id]).catch(() => null) : null;
    exam.time_remaining_seconds = getRemainingExamSeconds(exam, Date.now(), viewerSession ? viewerSession.started_at : null, parseDbDate);

    res.json(exam);
});

app.post('/api/exams', requireAuth, async (req, res) => {
    const { title, section_id, section, year_level, type, time_limit, link, questions, monitor_settings, tools_settings, accessCode } = req.body;

    // Input validation
    if (!title || title.trim().length < 3) {
        return res.status(400).json({ error: 'Exam title must be at least 3 characters' });
    }
    if (!type || !['gforms', 'wams-quiz'].includes(type)) {
        return res.status(400).json({ error: 'Invalid exam type' });
    }
    if (!time_limit || time_limit < 1 || time_limit > 480) {
        return res.status(400).json({ error: 'Time limit must be between 1 and 480 minutes' });
    }

    // Resolve section_id: if section name provided instead of id, look it up or create it
    let resolvedSectionId = section_id;
    if (!resolvedSectionId && section) {
        // Try to find existing section by name (avoid duplicates)
        const existing = await get("SELECT id FROM sections WHERE name = ? AND course = ?", [section, 'General']);
        if (existing) {
            resolvedSectionId = existing.id;
        } else {
            // Create new section
            const result = await exec("INSERT INTO sections (name, course, created_by) VALUES (?, ?, ?)", [section, 'General', req.user.id]);
            resolvedSectionId = lastId(result);
        }
    }

    if (!resolvedSectionId) {
        return res.status(400).json({ error: 'section_id is required' });
    }
    const yearLevel = typeof year_level === 'string' ? year_level.trim() : '';
    if (year_level !== undefined && !yearLevel) {
        return res.status(400).json({ error: 'Select a year level' });
    }
    if (yearLevel && req.user.role === 'professor') {
        const instructor = await get('SELECT id FROM instructors WHERE user_id = ?', [req.user.id]);
        if (instructor) {
            const assignedClassCount = await get(
                'SELECT COUNT(*) AS count FROM instructor_classes WHERE instructor_id = ?',
                [instructor.id]
            );
            if (assignedClassCount.count > 0) {
                const assignedClass = await get(`
                  SELECT section_id
                  FROM instructor_classes
                  WHERE instructor_id = ? AND section_id = ? AND year_level = ?
                `, [instructor.id, resolvedSectionId, yearLevel]);
                if (!assignedClass) {
                    return res.status(403).json({ error: 'This professor is not assigned to that year level and section' });
                }
            }
        }
    }

    // Validate questions for wams-quiz type
    if (type === 'wams-quiz') {
        const qArray = Array.isArray(questions) ? questions : (typeof questions === 'string' ? JSON.parse(questions) : []);
        if (qArray.length === 0) {
            return res.status(400).json({ error: 'At least one question is required for WAMS Quiz exams' });
        }
    }

    const result = await exec(`
    INSERT INTO exams (
    professor_id,
    title,
    section_id,
    year_level,
    schedule,
    type,
    time_limit,
    link,
    questions,
    monitor_settings,
    tools_settings,
    access_code,
    published_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
        req.user.id,
        title,
        resolvedSectionId,
        yearLevel || null,
        req.body.schedule || null,
        type,
        time_limit,
        // Turso rejects undefined bind values — default optional fields
        // so API clients omitting them don't crash the server process.
        link || '',
        questions ? JSON.stringify(questions) : null,
        monitor_settings ? JSON.stringify(monitor_settings) : null,
        tools_settings ? JSON.stringify(tools_settings) : null,
        accessCode || ''
    ]);

    const exam = await get(`
    SELECT
        id,
        professor_id,
        title,
        section_id,
        year_level,
        schedule,
        type,
        time_limit,
        link,
        questions,
        monitor_settings,
        tools_settings,
        access_code AS accessCode,
        status,
        flagged,
        live_started_at,
        published_at,
        created_at
    FROM exams
    WHERE id = ?
`, [lastId(result)]);

    res.json(exam);
});

app.put('/api/exams/:id', requireAuth, async (req, res) => {
    const {
        title,
        section_id,
        section,
        year_level,
        schedule,
        type,
        time_limit,
        link,
        questions,
        monitor_settings,
        tools_settings,
        accessCode,
        status
    } = req.body;
    const exam = await get('SELECT * FROM exams WHERE id = ?', [req.params.id]);
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    // Verify ownership - only professor who created exam can edit
    if (exam.professor_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'You can only edit your own exams' });
    }

    // Validate time_limit if provided
    if (time_limit !== undefined && (time_limit < 1 || time_limit > 480)) {
        return res.status(400).json({ error: 'Time limit must be between 1 and 480 minutes' });
    }
    if (year_level !== undefined && (typeof year_level !== 'string' || !year_level.trim())) {
        return res.status(400).json({ error: 'Select a year level' });
    }
    // Resolve section_id when frontend provides a section name instead of numeric id
    let resolvedSectionId = section_id;
    if ((!resolvedSectionId || resolvedSectionId === '') && section) {
        const existing = await get("SELECT id FROM sections WHERE name = ? AND course = ?", [section, 'General']);
        if (existing) {
            resolvedSectionId = existing.id;
        } else {
            const r = await exec("INSERT INTO sections (name, course, created_by) VALUES (?, ?, ?)", [section, 'General', req.user.id]);
            resolvedSectionId = lastId(r);
        }
    }

    // Fall back to the stored exam values for any field the client omitted —
    // undefined bind values crash the Turso driver, and partial updates
    // would otherwise wipe unset columns.
    if (status !== undefined && !['scheduled', 'upcoming', 'live', 'ended'].includes(status)) {
        return res.status(400).json({ error: 'Invalid exam status' });
    }
    const nextStatus = status === 'upcoming' ? 'scheduled' : (status ?? exam.status);
    await exec(`
    UPDATE exams
    SET title = ?, section_id = ?, year_level = ?, schedule = ?, time_limit = ?, link = ?, questions = ?, monitor_settings = ?, tools_settings = ?, status = ?,
        published_at = CASE
            WHEN ? <> 'live' AND status <> 'live' THEN CURRENT_TIMESTAMP
            ELSE published_at
        END,
        live_started_at = CASE
            WHEN ? = 'live' AND status <> 'live' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHEN ? <> 'live' THEN NULL
            ELSE live_started_at
        END
    WHERE id = ?
  `, [
        title ?? exam.title,
        resolvedSectionId ?? exam.section_id,
        year_level === undefined ? exam.year_level : year_level.trim(),
        schedule === undefined ? exam.schedule : schedule,
        time_limit ?? exam.time_limit,
        link ?? exam.link,
        questions ? (typeof questions === 'string' ? questions : JSON.stringify(questions)) : null,
        monitor_settings ? (typeof monitor_settings === 'string' ? monitor_settings : JSON.stringify(monitor_settings)) : null,
        tools_settings ? (typeof tools_settings === 'string' ? tools_settings : JSON.stringify(tools_settings)) : null,
        nextStatus,
        nextStatus,
        nextStatus,
        nextStatus,
        req.params.id
    ]);

    const updated = await get('SELECT * FROM exams WHERE id = ?', [req.params.id]);
    res.json(updated);
});

app.delete('/api/exams/:id', requireAuth, async (req, res) => {
    const exam = await get('SELECT * FROM exams WHERE id = ?', [req.params.id]);
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    // Verify ownership - only professor who created exam can delete
    if (exam.professor_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'You can only delete your own exams' });
    }
    try {
        // Atomic batch delete of exam and all related data
        await db.batch([
            { sql: 'DELETE FROM tab_switches WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)', args: [req.params.id] },
            { sql: 'DELETE FROM camera_captures WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)', args: [req.params.id] },
            { sql: 'DELETE FROM question_activity WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)', args: [req.params.id] },
            { sql: 'DELETE FROM exam_sessions WHERE exam_id = ?', args: [req.params.id] },
            { sql: 'DELETE FROM exam_enrollments WHERE exam_id = ?', args: [req.params.id] },
            { sql: 'DELETE FROM exams WHERE id = ?', args: [req.params.id] }
        ]);
        res.json({ success: true });
    } catch (err) {
        console.error('Failed to delete exam and related data:', err && err.message ? err.message : err);
        res.status(500).json({ error: 'Failed to delete exam. ' + (err && err.message ? err.message : '') });
    }
});

// Camera captures
app.post('/api/camera/capture', express.raw({ type: 'image/jpeg', limit: MAX_IMAGE_UPLOAD_BYTES }), requireAuth, async (req, res) => {
    try {
        const sessionId = req.get('x-session-id') || req.body?.session_id;
        if (!sessionId) return res.status(400).json({ error: 'Session ID is required' });
        if (req.user.role !== 'student') return res.status(403).json({ error: 'Only the assigned student can upload exam media' });
        const session = await getSessionOwner(sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (String(session.student_user_id) !== String(req.user.id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (!await requireLiveExamForSession(session, res)) return;

        const upload = parseMediaUpload(req, 'camera');
        const saved = await persistMediaCapture(sessionId, upload);
        if (saved.limited) {
            return res.json({ success: true, limited: true, id: null, capture_id: upload.captureId, face_count: 0, flagged: false });
        }
        res.status(saved.duplicate ? 200 : 201).json({
            ...saved,
            face_count: upload.faceCount,
            flagged: Boolean(upload.flagged),
            success: true
        });
    } catch (error) {
        console.error('Camera capture upload failed:', error);
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to save camera capture' });
    }
});

app.get('/api/sessions/:sessionId/captures', requireAuth, async (req, res) => {
    try {
        if (!await canReadSessionMedia(req, res, req.params.sessionId)) return;
        const captures = await all(`SELECT id, session_id, capture_type, face_count, skin_pixels,
            flagged, detection_data, capture_id, file_size, mime_type, metadata_json, captured_at
            FROM camera_captures
            WHERE session_id = ? AND (capture_type = 'camera' OR capture_type IS NULL)
            ORDER BY captured_at DESC`, [req.params.sessionId]);
        res.json(captures.map(mediaCaptureResponse));
    } catch (error) {
        console.error('Camera capture lookup failed:', error);
        res.status(500).json({ error: 'Unable to load camera captures' });
    }
});

// Screen captures
app.post('/api/sessions/:sessionId/screen-capture', express.raw({ type: 'image/jpeg', limit: MAX_IMAGE_UPLOAD_BYTES }), requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'student') return res.status(403).json({ error: 'Only the assigned student can upload exam media' });
        const session = await getSessionOwner(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (String(session.student_user_id) !== String(req.user.id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (!await requireLiveExamForSession(session, res)) return;

        const upload = parseMediaUpload(req, 'screen');
        if (upload.limited) {
            return res.json({ success: true, limited: true, id: null, capture_id: upload.captureId, reason: upload.reason });
        }
        const saved = await persistMediaCapture(req.params.sessionId, upload);
        if (saved.limited) {
            return res.json({ ...saved, success: true, reason: 'screen_cap', trigger: upload.captureTrigger });
        }
        res.status(saved.duplicate ? 200 : 201).json({ ...saved, success: true, limited: false, trigger: upload.captureTrigger });
    } catch (error) {
        console.error('Screen capture upload failed:', error);
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to save screen capture' });
    }
});

app.get('/api/sessions/:sessionId/screen-captures', requireAuth, async (req, res) => {
    try {
        if (!await canReadSessionMedia(req, res, req.params.sessionId)) return;
        const captures = await all(`SELECT id, session_id, capture_type, capture_trigger,
            capture_id, file_size, mime_type, metadata_json, captured_at
            FROM camera_captures WHERE session_id = ? AND capture_type = ? ORDER BY captured_at DESC`,
        [req.params.sessionId, 'screen']);
        res.json(captures.map(mediaCaptureResponse));
    } catch (error) {
        console.error('Screen capture lookup failed:', error);
        res.status(500).json({ error: 'Unable to load screen captures' });
    }
});

app.get('/api/sessions/:sessionId/captures/:captureId/media', requireAuth, async (req, res) => {
    try {
        if (!await canReadSessionMedia(req, res, req.params.sessionId)) return;
        const capture = await get(`SELECT media_data, image_data, capture_type, mime_type
            FROM camera_captures WHERE session_id = ? AND capture_id = ?`,
        [req.params.sessionId, req.params.captureId]);
        return await sendCaptureMedia(res, capture);
    } catch (error) {
        console.error('Capture media retrieval failed:', error);
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to load capture media' });
    }
});

app.get('/api/sessions/:sessionId/capture-rows/:captureRowId/media', requireAuth, async (req, res) => {
    try {
        if (!await canReadSessionMedia(req, res, req.params.sessionId)) return;
        const rowId = Number(req.params.captureRowId);
        if (!Number.isSafeInteger(rowId) || rowId < 1) return res.status(400).json({ error: 'Capture ID is invalid' });
        const capture = await get(`SELECT media_data, image_data, capture_type, mime_type
            FROM camera_captures WHERE session_id = ? AND id = ?`,
        [req.params.sessionId, rowId]);
        return await sendCaptureMedia(res, capture);
    } catch (error) {
        console.error('Capture media retrieval failed:', error);
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to load capture media' });
    }
});

// Audio captures/anomalies
app.post('/api/sessions/:sessionId/audio-capture', express.raw({
    type: ['audio/webm', 'audio/ogg', 'audio/mp4'],
    limit: MAX_AUDIO_UPLOAD_BYTES
}), requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'student') return res.status(403).json({ error: 'Only the assigned student can upload exam media' });
        const session = await getSessionOwner(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (String(session.student_user_id) !== String(req.user.id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (!await requireLiveExamForSession(session, res)) return;

        const upload = parseMediaUpload(req, 'audio');
        const saved = await persistMediaCapture(req.params.sessionId, upload);
        if (saved.limited) {
            return res.json({ success: true, limited: true, id: null, capture_id: upload.captureId });
        }
        res.status(saved.duplicate ? 200 : 201).json({ ...saved, success: true });
    } catch (error) {
        console.error('Audio capture upload failed:', error);
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to save audio capture' });
    }
});

app.get('/api/sessions/:sessionId/audio-captures', requireAuth, async (req, res) => {
    try {
        if (!await canReadSessionMedia(req, res, req.params.sessionId)) return;
        const captures = await all(`SELECT id, session_id, capture_type, flagged,
            capture_id, file_size, mime_type,
            CASE WHEN metadata_json IS NOT NULL THEN metadata_json
                 WHEN json_valid(image_data) THEN json_remove(image_data, '$.audio_clip')
                 ELSE NULL END AS metadata_json,
            captured_at
            FROM camera_captures WHERE session_id = ? AND capture_type = ? ORDER BY captured_at DESC`,
        [req.params.sessionId, 'audio']);
        res.json(captures.map(mediaCaptureResponse));
    } catch (error) {
        console.error('Audio capture lookup failed:', error);
        res.status(500).json({ error: 'Unable to load audio captures' });
    }
});

app.post('/api/sessions/:sessionId/media-upload-failures', requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'student') return res.status(403).json({ error: 'Only students can report their media upload failures' });
        const session = await getSessionOwner(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (String(session.student_user_id) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });

        const { capture_id, capture_type, message, attempts = 0 } = req.body || {};
        if (typeof capture_id !== 'string' || !/^[a-z0-9._:-]{8,100}$/i.test(capture_id) ||
            !['camera', 'screen', 'audio'].includes(capture_type) ||
            typeof message !== 'string' || !message.trim() ||
            !Number.isInteger(Number(attempts)) || Number(attempts) < 0 || Number(attempts) > 4) {
            return res.status(400).json({ error: 'Invalid media upload failure details' });
        }
        await retryTransientWrite(() => mediaWriteQueue.run(() => exec(`
            INSERT INTO media_upload_failures (capture_id, session_id, capture_type, message, attempts)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(capture_id) DO UPDATE SET
                message = excluded.message,
                attempts = excluded.attempts,
                resolved_at = NULL
        `, [capture_id, req.params.sessionId, capture_type, message.trim().slice(0, 500), Number(attempts)])), {
            attempts: 4,
            onRetry: recordDatabaseRetry
        });
        res.status(201).json({ success: true });
    } catch (error) {
        console.error('Media upload failure report failed:', error);
        res.status(500).json({ error: 'Unable to report media upload failure' });
    }
});

app.get('/api/exams/:examId/media-upload-failures', requireAuth, async (req, res) => {
    try {
        if (!['admin', 'professor'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
        const exam = await get('SELECT professor_id FROM exams WHERE id = ?', [req.params.examId]);
        if (!exam) return res.status(404).json({ error: 'Exam not found' });
        if (req.user.role === 'professor' && String(exam.professor_id) !== String(req.user.id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const failures = await all(`
            SELECT f.capture_id, f.session_id, f.capture_type, f.message, f.attempts, f.created_at,
                   u.name AS student_name, s.student_id
            FROM media_upload_failures f
            JOIN exam_sessions es ON es.id = f.session_id
            JOIN students s ON s.id = es.student_id
            JOIN users u ON u.id = s.user_id
            WHERE es.exam_id = ? AND f.resolved_at IS NULL
            ORDER BY f.created_at DESC
        `, [req.params.examId]);
        res.json(failures);
    } catch (error) {
        console.error('Media upload failure lookup failed:', error);
        res.status(500).json({ error: 'Unable to load media upload failures' });
    }
});

app.get('/api/admin/media-upload-stats', requireAuth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
    res.json({
        ...mediaUploadStats,
        activeWrites: mediaWriteQueue.active,
        queuedWrites: mediaWriteQueue.waiting.length,
        concurrencyLimit: MEDIA_WRITE_CONCURRENCY
    });
});

app.get('/api/sessions/:sessionId/answers', requireAuth, async (req, res) => {
    try {
    const session = await getSessionOwner(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'professor' && session.professor_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({
        sessionId: session.id,
        submitted_at: session.submitted_at || null,
        started_at: session.started_at || null,
        answers: session.answers || null
    });
    } catch (err) {
        console.error('Answers lookup error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Unable to load saved answers' });
    }
});

app.post('/api/sessions/:sessionId/answers', requireAuth, async (req, res) => {
    try {
        const session = await getSessionOwner(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (req.user.role !== 'student' || session.student_user_id !== req.user.id) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (session.submitted_at) {
            return res.status(409).json({ error: 'Exam session already submitted' });
        }
        if (!await requireLiveExamForSession(session, res)) return;

        const answers = req.body && req.body.answers;
        if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
            return res.status(400).json({ error: 'Answers must be an object' });
        }
        const result = await exec(
            'UPDATE exam_sessions SET answers = ? WHERE id = ? AND submitted_at IS NULL',
            [JSON.stringify(answers), req.params.sessionId]
        );
        if (result.rowsAffected === 0) {
            return res.status(409).json({ error: 'Exam session already submitted' });
        }
        res.json({ success: true, sessionId: req.params.sessionId });
    } catch (err) {
        console.error('Answer save error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Unable to save answers' });
    }
});

// Exam submission
app.post('/api/sessions/:sessionId/submit', requireAuth, async (req, res) => {
    try {
    const { time_used, answers } = req.body;
    const session = await getSessionOwner(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'professor' && session.professor_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (session.submitted_at) {
        return res.status(409).json({ error: 'Exam session already submitted' });
    }
    if (!await requireLiveExamForSession(session, res)) return;

    await exec('UPDATE exam_sessions SET submitted_at = CURRENT_TIMESTAMP, time_used = ?, answers = ? WHERE id = ?', [time_used, answers ? JSON.stringify(answers) : null, req.params.sessionId]);
    res.json({ success: true, sessionId: req.params.sessionId });
    } catch (err) {
        console.error('Exam submission error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Unable to submit the exam. Please try again.' });
    }
});

// Tab switches
app.post('/api/sessions/:sessionId/tab-switches', requireAuth, async (req, res) => {
    try {
        const session = await getSessionOwner(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (session.submitted_at) return res.status(409).json({ error: 'Exam session already submitted' });
        if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (req.user.role === 'professor' && session.professor_id !== req.user.id) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        if (req.user.role === 'student' && !await requireLiveExamForSession(session, res)) return;
        const source = normalizeSwitchSource(req.body && req.body.source);
        const result = await retryTransientWrite(() =>
            exec('INSERT INTO tab_switches (session_id, switch_source) VALUES (?, ?)', [req.params.sessionId, source]),
        { attempts: 4, onRetry: recordDatabaseRetry });
        res.json({ id: lastId(result), success: true, source });
    } catch (err) {
        console.error('Tab switch server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Lightweight keepalive fired from the hidden tab: arriving here proves the
// student is still on the exam page but no longer viewing it (a tab switch),
// and it can't be throttled because it's a keepalive fetch. Logs at most one
// switch per minute so a keepalive retry can't inflate the counter.
app.post('/api/sessions/:sessionId/tab-switch-ping', requireAuth, async (req, res) => {
    try {
        const session = await getSessionOwner(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (session.submitted_at) return res.status(409).json({ error: 'Exam session already submitted' });
        if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const exam = await get('SELECT * FROM exams WHERE id = ?', [session.exam_id]);
        const currentExam = exam ? await syncExamStatus(exam) : null;
        if (!currentExam || currentExam.status !== 'live') {
            return res.json({ success: true, ignored: true });
        }

        const recent = await get(`
            SELECT switched_at FROM tab_switches
            WHERE session_id = ?
            ORDER BY switched_at DESC
            LIMIT 1
        `, [req.params.sessionId]);
        const lastAt = recent && recent.switched_at ? new Date(String(recent.switched_at).replace(' ', 'T') + 'Z').getTime() : 0;
        if (lastAt && Date.now() - lastAt < 60000) {
            return res.json({ success: true, ignored: true, reason: 'duplicate' });
        }

        const source = normalizeSwitchSource(req.body && req.body.source);
        const result = await retryTransientWrite(() =>
            exec('INSERT INTO tab_switches (session_id, switch_source) VALUES (?, ?)', [req.params.sessionId, source]),
        { attempts: 4, onRetry: recordDatabaseRetry });
        res.json({ id: lastId(result), success: true, source });
    } catch (err) {
        console.error('Tab switch ping server error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/exams/:examId/sessions', requireAuth, async (req, res) => {
    const sessions = await all(`
    SELECT
      es.*,
      e.questions AS exam_questions,
      s.student_id,
      u.name as student_name,
      sec.name as section_name
    FROM exam_sessions es
    JOIN exams e ON es.exam_id = e.id
    JOIN students s ON es.student_id = s.id
    JOIN users u ON s.user_id = u.id
    JOIN sections sec ON s.section_id = sec.id
    WHERE es.exam_id = ?
    ORDER BY es.started_at DESC
  `, [req.params.examId]);
    res.json(sessions);
});

app.get('/api/exams/:examId/tab-switches', requireAuth, async (req, res) => {
    const switches = await all(`
    SELECT ts.*, s.student_id, u.name as student_name
    FROM tab_switches ts
    JOIN exam_sessions s ON ts.session_id = s.id
    JOIN students st ON s.student_id = st.id
    JOIN users u ON st.user_id = u.id
    WHERE s.exam_id = ?
    ORDER BY ts.switched_at DESC
  `, [req.params.examId]);
    res.json(switches);
});

// Question activity tracking
app.post('/api/sessions/:sessionId/question-activity', requireAuth, async (req, res) => {
    const { activity_type, question_number } = req.body;
    if (!activity_type || !question_number) {
        return res.status(400).json({ error: 'activity_type and question_number are required' });
    }
    const session = await getSessionOwner(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'professor' && session.professor_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (session.submitted_at) return res.status(409).json({ error: 'Exam session already submitted' });
    if (!await requireLiveExamForSession(session, res)) return;
    const result = await exec(`
    INSERT INTO question_activity (session_id, activity_type, question_number)
    VALUES (?, ?, ?)
  `, [req.params.sessionId, activity_type, question_number]);
    res.json({ id: lastId(result) });
});

app.get('/api/exams/:examId/question-activity', requireAuth, async (req, res) => {
    const activities = await all(`
    SELECT qa.*, s.student_id, u.name as student_name
    FROM question_activity qa
    JOIN exam_sessions s ON qa.session_id = s.id
    JOIN students st ON s.student_id = st.id
    JOIN users u ON st.user_id = u.id
    WHERE s.exam_id = ?
    ORDER BY qa.created_at DESC
  `, [req.params.examId]);
    res.json(activities);
});

function timeAgo(dateStr) {
    if (!dateStr) return 'unknown';
    const date = new Date(dateStr + 'Z');
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60) return `${diff} sec${diff === 1 ? '' : 's'} ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)} min${Math.floor(diff / 60) === 1 ? '' : 's'} ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hour${Math.floor(diff / 3600) === 1 ? '' : 's'} ago`;
    return `${Math.floor(diff / 86400)} day${Math.floor(diff / 86400) === 1 ? '' : 's'} ago`;
}

app.get("/api/dashboard", requireAuth, async (req, res) => {

    const totalUsers = (await get(`
        SELECT COUNT(*) AS total
        FROM users u
        WHERE u.role = 'admin'
            OR (u.role = 'student' AND EXISTS (
                SELECT 1 FROM students active_student WHERE active_student.user_id = u.id
            ))
            OR (u.role = 'professor' AND EXISTS (
                SELECT 1 FROM instructors active_instructor WHERE active_instructor.user_id = u.id
            ))
    `)).total;

    const totalStudents =
        (await get(`
            SELECT COUNT(*) AS total
            FROM students s
            JOIN users u ON u.id = s.user_id AND u.role = 'student'
        `)).total;

    const totalInstructors =
        (await get(`
            SELECT COUNT(*) AS total
            FROM instructors i
            JOIN users u ON u.id = i.user_id AND u.role = 'professor'
        `)).total;

    const totalExams =
        (await get("SELECT COUNT(*) total FROM exams")).total;

    const liveExams = (await get(`
    SELECT COUNT(*) total
    FROM exams
    WHERE status='live'
    `)).total;

    const endedExams = (await get(`
    SELECT COUNT(*) total
    FROM exams
    WHERE status='ended'
    `)).total;

    const scheduledExams = (await get(`
    SELECT COUNT(*) total
    FROM exams
    WHERE status='scheduled'
          `)).total;

    const flaggedSessions =
        (await get("SELECT COUNT(*) total FROM tab_switches")).total;

    const recentActivityRows = await all(`
        SELECT
            u.name AS user_name,
            u.role AS user_role,
            u.created_at,
            'registered' AS activity_type
        FROM users u
        WHERE u.id != 1
        ORDER BY u.created_at DESC
        LIMIT 5
    `);

    const recentActivity = recentActivityRows.map(row => ({
        message: `${row.user_name} (${row.user_role}) registered`,
        time: timeAgo(row.created_at)
    }));

    const activeExams = await all(`
SELECT
    e.id,
    e.title,
    e.status,

    (
        SELECT COUNT(*)
        FROM students st
        WHERE st.section_id = e.section_id
          AND (e.year_level IS NULL OR st.year_level = e.year_level)
    ) AS students,

    (
        SELECT COUNT(*)
        FROM tab_switches ts
        JOIN exam_sessions es
            ON es.id = ts.session_id
        WHERE es.exam_id = e.id
    ) AS flagged

FROM exams e
WHERE e.status='live'
LIMIT 5
`);

    const recentUsers = await all(`
    SELECT
        u.name,
        u.role,
        COALESCE(s.status, i.status, 'Active') AS status,
        u.created_at
    FROM users u
    LEFT JOIN students s ON s.user_id = u.id
    LEFT JOIN instructors i ON i.user_id = u.id
    WHERE u.role = 'admin'
        OR (u.role = 'student' AND EXISTS (
            SELECT 1 FROM students active_student WHERE active_student.user_id = u.id
        ))
        OR (u.role = 'professor' AND EXISTS (
            SELECT 1 FROM instructors active_instructor WHERE active_instructor.user_id = u.id
        ))
    ORDER BY u.created_at DESC
    LIMIT 5
`);

    const os = await import('os');
    const totalMem = os.totalmem() || 1;
    const freeMem = os.freemem() || 0;
    const memory = Math.min(100, Math.max(5, Math.round(((totalMem - freeMem) / totalMem) * 100)));

    let cpu = 12;
    try {
        if (!global._lastCpuUsage) {
            global._lastCpuUsage = process.cpuUsage();
            global._lastCpuTime = Date.now();
            cpu = 14;
        } else {
            const usageDiff = process.cpuUsage(global._lastCpuUsage);
            const timeDiff = (Date.now() - global._lastCpuTime) * 1000;
            global._lastCpuUsage = process.cpuUsage();
            global._lastCpuTime = Date.now();
            if (timeDiff > 0) {
                const rawCpu = ((usageDiff.user + usageDiff.system) / timeDiff) * 100;
                cpu = Math.min(95, Math.max(4, Math.round(rawCpu)));
            }
        }
    } catch { }

    // Cloud-hosted database — size metric is estimated from record counts
    const dbSizeKb = 64 + Math.round((totalUsers + totalStudents + totalInstructors + totalExams) * 0.5);
    const database = Math.min(100, Math.max(2, Math.round((dbSizeKb / 10240) * 100)));
    const network = Math.min(100, Math.max(5, Math.round((liveExams * 20) + (flaggedSessions * 5) + 8)));

    const memUsage = process.memoryUsage();
    const storage = Math.min(100, Math.max(5, Math.round((memUsage.heapUsed / Math.max(1, memUsage.heapTotal)) * 100)));

    const systemHealth = {
        cpu,
        memory,
        database,
        network,
        storage,
        dbSizeKb,
        heapUsedMb: Math.round(memUsage.heapUsed / (1024 * 1024))
    };

    res.json({
        totalUsers,
        totalStudents,
        totalInstructors,
        totalExams,
        liveExams,
        endedExams,
        scheduledExams,
        flaggedSessions,
        admin: req.user,
        recentUsers,
        recentActivity,
        activeExams,
        systemHealth
    });

});

// ── Boot: wait for schema, seed admin, then listen ──
(async () => {
    await schemaReady;

    // Seed the default admin account if it doesn't exist
    try {
        const adminExists = await get("SELECT id FROM users WHERE username=?", ["admin"]);
        if (!adminExists) {
            const hashed = bcrypt.hashSync("admin123", 10);
            const result = await exec(`
                INSERT INTO users
                (role,name,username,password)
                VALUES (?,?,?,?)
            `, ["admin", "System Administrator", "admin", hashed]);
            const adminId = lastId(result);
            await exec(`
                INSERT INTO admin_invites
                (code, created_by)
                VALUES (?,?)
            `, ["ADMIN2026", adminId]);
            console.log("Admin account created.");
        }
        const seededAdmin = await get("SELECT id FROM users WHERE username = ? AND role = 'admin'", ["admin"]);
        if (seededAdmin) {
            await exec('UPDATE feedbacks SET recipient_admin_id = ? WHERE recipient_admin_id IS NULL', [seededAdmin.id]);
        }
    } catch (e) {
        console.warn('Admin seeding skipped:', e && e.message ? e.message : e);
    }

    await syncScheduledExamLifecycle();
    setInterval(syncScheduledExamLifecycle, EXAM_LIFECYCLE_SYNC_INTERVAL_MS);

    app.listen(PORT, () => {
        console.log(`WAMS Server running on port ${PORT}`);
        (async () => {
            try {
                const adminRow = await get("SELECT id, username, name, created_at FROM users WHERE role='admin' ORDER BY id LIMIT 1");
                if (adminRow) {
                    console.log(`Admin account: ${adminRow.username} (${adminRow.name}) created at ${adminRow.created_at}`);
                }
                const inviteRow = await get('SELECT code, used, created_at FROM admin_invites ORDER BY id DESC LIMIT 1');
                if (inviteRow) {
                    console.log(`Invite code: ${inviteRow.code} (used: ${inviteRow.used}) created at ${inviteRow.created_at}`);
                }
            } catch (e) {
                console.log('Unable to read admin metadata:', e && e.message ? e.message : e);
            }
        })();
    });
})();