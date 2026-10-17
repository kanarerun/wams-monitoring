import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db, schemaReady } from "../db.js";
import { computeEffectiveStatus, getRemainingExamSeconds } from "./exam-lifecycle.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "administratorSecretKey";

// Cap the number of stored captures per session (camera/screen/audio) so
// Turso doesn't accumulate too much base64 image/audio payload.
const MAX_CAPTURES_PER_SESSION = 10;

// ── Query helpers (mimic better-sqlite3 ergonomics on top of Turso) ──
const exec = (sql, args = []) => db.execute({ sql, args });
const all = async (sql, args = []) => (await exec(sql, args)).rows;
const get = async (sql, args = []) => (await exec(sql, args)).rows[0];
const lastId = (result) => Number(result.lastInsertRowid);

app.use(cors());
app.use(express.json());

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
// Persist lifecycle transitions so dashboards and student access agree.
async function syncExamStatus(exam){
    if (!exam) return exam;
    const eff = computeEffectiveStatus(exam);
    if (eff === 'live' && exam.status !== 'live') {
        const scheduledStart = exam.schedule && Number.isFinite(new Date(exam.schedule).getTime())
            ? exam.schedule
            : new Date().toISOString();
        await exec(`
            UPDATE exams
            SET status = 'live', live_started_at = COALESCE(live_started_at, ?)
            WHERE id = ? AND status = ?
        `, [scheduledStart, exam.id, exam.status]);
        exam.live_started_at = exam.live_started_at || scheduledStart;
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
    const timeRemainingCalculatedAt = Date.now();
    const timeRemainingSeconds = getRemainingExamSeconds(exam, timeRemainingCalculatedAt);
    if (timeRemainingSeconds <= 0) {
        exam = await syncExamStatus(exam);
        return res.status(401).json({
            error: 'This exam has ended. You can no longer enter or submit answers.',
            status: 'ended'
        });
    }

    // Create exam session
    const sessionResult = await exec(`
    INSERT INTO exam_sessions (exam_id, student_id) VALUES (?, ?)
  `, [exam.id, student.id]);

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
        exam: {
            ...exam,
            time_remaining_seconds: timeRemainingSeconds,
            session_id: lastId(sessionResult)
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
    const { name, course } = req.body;
    // Reuse an identical section instead of creating a duplicate
    const existing = await get('SELECT * FROM sections WHERE name = ? AND course = ?', [name, course]);
    if (existing) {
        return res.json(existing);
    }
    const result = await exec('INSERT INTO sections (name, course, created_by) VALUES (?, ?, ?)', [name, course, req.user.id]);
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
        section_id ?? student.section_id;

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
    const feedbacks = await all(`
    SELECT f.*, u.name as professor_name
    FROM feedbacks f
    JOIN users u ON f.professor_id = u.id
    ORDER BY f.created_at DESC
  `);
    res.json(feedbacks);
});

app.post('/api/feedbacks', requireAuth, async (req, res) => {
    const { category, subject, message, contact, module } = req.body;
    const result = await exec(`
    INSERT INTO feedbacks (professor_id, category, subject, message, contact, module)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [req.user.id, category, subject, message, contact, module]);

    const feedback = await get('SELECT * FROM feedbacks WHERE id = ?', [lastId(result)]);
    res.json(feedback);
});

app.put('/api/feedbacks/:id', requireAuth, async (req, res) => {
    const { status } = req.body;
    await exec('UPDATE feedbacks SET status = ? WHERE id = ?', [status, req.params.id]);
    res.json({ success: true });
});

app.delete('/api/feedbacks/:id', requireAuth, async (req, res) => {
    await exec('DELETE FROM feedbacks WHERE id = ?', [req.params.id]);
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
            SELECT es.id, es.submitted_at
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
                time_remaining_seconds: getRemainingExamSeconds(exam)
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
    exam.time_remaining_seconds = getRemainingExamSeconds(exam);

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
    access_code
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
app.post('/api/camera/capture', requireAuth, async (req, res) => {
    const { session_id, image } = req.body;
    if (!session_id || !image) return res.status(400).json({ error: 'Missing session_id or image' });

    const session = await getSessionOwner(session_id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'student' && !await requireLiveExamForSession(session, res)) return;

    // Enforce the per-session camera capture cap
    const camCap = await get(`
        SELECT COUNT(*) AS total FROM camera_captures
        WHERE session_id = ? AND (capture_type = 'camera' OR capture_type IS NULL)
    `, [session_id]);
    if (Number(camCap.total) >= MAX_CAPTURES_PER_SESSION) {
        return res.json({ success: true, limited: true, id: null, face_count: 0, flagged: false });
    }

    const faceCount = req.body.face_count || 0;
    const skinPixels = req.body.skin_pixels || 0;
    const flagged = req.body.flagged ? 1 : 0;
    const detectionData = req.body.detection_data && typeof req.body.detection_data === 'object'
        ? JSON.stringify(req.body.detection_data)
        : null;
    const result = await exec("INSERT INTO camera_captures (session_id, image_data, capture_type, face_count, skin_pixels, flagged, detection_data) VALUES (?, ?, 'camera', ?, ?, ?, ?)", [session_id, image, faceCount, skinPixels, flagged, detectionData]);
    res.json({ id: lastId(result), face_count: faceCount, flagged: Boolean(flagged), success: true });
});

app.get('/api/sessions/:sessionId/captures', requireAuth, async (req, res) => {
    const captures = await all("SELECT * FROM camera_captures WHERE session_id = ? AND (capture_type = 'camera' OR capture_type IS NULL) ORDER BY captured_at DESC", [req.params.sessionId]);
    res.json(captures);
});

// Screen captures
app.post('/api/sessions/:sessionId/screen-capture', requireAuth, async (req, res) => {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'Missing image data' });

    const session = await getSessionOwner(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'student' && !await requireLiveExamForSession(session, res)) return;

    // Enforce the per-session screen capture cap
    const screenCap = await get(`
        SELECT COUNT(*) AS total FROM camera_captures
        WHERE session_id = ? AND capture_type = 'screen'
    `, [req.params.sessionId]);
    if (Number(screenCap.total) >= MAX_CAPTURES_PER_SESSION) {
        return res.json({ success: true, limited: true, id: null });
    }

    const result = await exec('INSERT INTO camera_captures (session_id, image_data, capture_type) VALUES (?, ?, ?)', [req.params.sessionId, image, 'screen']);
    res.json({ id: lastId(result), success: true });
});

app.get('/api/sessions/:sessionId/screen-captures', requireAuth, async (req, res) => {
    const captures = await all('SELECT * FROM camera_captures WHERE session_id = ? AND capture_type = ? ORDER BY captured_at DESC', [req.params.sessionId, 'screen']);
    res.json(captures);
});

// Audio captures/anomalies
app.post('/api/sessions/:sessionId/audio-capture', requireAuth, async (req, res) => {
    const { audio_data, audio_clip, level, flagged } = req.body;

    const session = await getSessionOwner(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'student' && !await requireLiveExamForSession(session, res)) return;

    // Enforce the per-session audio capture cap
    const audioCap = await get(`
        SELECT COUNT(*) AS total FROM camera_captures
        WHERE session_id = ? AND capture_type = 'audio'
    `, [req.params.sessionId]);
    if (Number(audioCap.total) >= MAX_CAPTURES_PER_SESSION) {
        return res.json({ success: true, limited: true, id: null });
    }

    let payload = '';
    if (typeof audio_data === 'string') {
        try {
            const obj = JSON.parse(audio_data);
            if (audio_clip && !obj.audio_clip) obj.audio_clip = audio_clip;
            payload = JSON.stringify(obj);
        } catch (e) {
            payload = audio_data;
        }
    } else {
        payload = JSON.stringify({ level: level || 0, audio_clip: audio_clip || null, flagged: !!flagged });
    }

    const result = await exec("INSERT INTO camera_captures (session_id, image_data, capture_type, flagged) VALUES (?, ?, 'audio', ?)", [
        req.params.sessionId,
        payload,
        flagged ? 1 : 0
    ]);
    res.json({ id: lastId(result), success: true });
});

app.get('/api/sessions/:sessionId/audio-captures', requireAuth, async (req, res) => {
    const captures = await all('SELECT * FROM camera_captures WHERE session_id = ? AND capture_type = ? ORDER BY captured_at DESC', [req.params.sessionId, 'audio']);
    res.json(captures);
});

// Exam submission
app.post('/api/sessions/:sessionId/submit', requireAuth, async (req, res) => {
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
});

// Tab switches
app.post('/api/sessions/:sessionId/tab-switches', requireAuth, async (req, res) => {
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
    const result = await exec('INSERT INTO tab_switches (session_id) VALUES (?)', [req.params.sessionId]);
    res.json({ id: lastId(result) });
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