import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db, schemaReady } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "administratorSecretKey";

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
            return res.status(401).json({
                error: "Invalid Token"
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

    const invite = await get(`
        SELECT *
        FROM admin_invites
        WHERE code=? AND used=0
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

        await exec(`
            UPDATE admin_invites
            SET used=1
            WHERE id=?
        `, [invite.id]);

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

    // Find active exam for this student's section
    const exam = await get(`
    SELECT e.*, sec.name as section_name
    FROM exams e
    JOIN sections sec ON e.section_id = sec.id
    WHERE e.section_id = ? AND e.status IN ('scheduled', 'live')
    ORDER BY e.created_at DESC
    LIMIT 1
  `, [student.section_id]);

    if (!exam) return res.status(401).json({ error: 'No active exam found for your section' });
    if (exam && exam.access_code && String(exam.access_code).trim() !== String(access_code).trim()) {
        return res.status(401).json({ error: 'Invalid exam access code' });
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
            session_id: lastId(sessionResult)
        }
    });
});

app.post('/api/auth/professor-login', async (req, res) => {
    const { faculty_id, access_code } = req.body;

    const instructor = await get(`
    SELECT i.*, u.id as user_id, u.name, u.role
    FROM instructors i
    JOIN users u ON i.user_id = u.id
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
            department: instructor.department || 'Faculty'
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
      i.faculty_id
    FROM users u
    LEFT JOIN students s ON u.id = s.user_id
    LEFT JOIN sections sec ON sec.id = s.section_id
    LEFT JOIN instructors i ON u.id = i.user_id
    WHERE u.id = ?
  `, [req.user.id]);
    res.json(user);
});

// Sections
app.get('/api/sections', requireAuth, async (req, res) => {
    const sections = await all('SELECT * FROM sections ORDER BY course, name');
    res.json(sections);
});

app.post('/api/sections', requireAuth, async (req, res) => {
    const { name, course } = req.body;
    const result = await exec('INSERT INTO sections (name, course, created_by) VALUES (?, ?, ?)', [name, course, req.user.id]);
    const section = await get('SELECT * FROM sections WHERE id = ?', [lastId(result)]);
    res.json(section);
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
        section
    } = req.body;
    // Accept both naming conventions from frontend
    const resolvedStudentId = studentId || req.body.facultyId;
    const resolvedAccessCode = accessCode || req.body.code || '';
    try {
        let sectionId = null;

        if (req.body.sectionId) {
            // Use provided section ID
            sectionId = parseInt(req.body.sectionId);
            const sectionRow = await get("SELECT id FROM sections WHERE id = ?", [sectionId]);
            if (!sectionRow) {
                return res.status(400).json({ error: 'Invalid section selected' });
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

            sectionId = sectionRow.id;
        } else {
            return res.status(400).json({ error: 'Section is required' });
        }

        // Create user account
        const userResult = await exec(`
      INSERT INTO users (role, name)
      VALUES (?, ?)
      `, ["student", name]);

        // Create student record
        const studentResult = await exec(
            `INSERT INTO students
      (user_id, student_id, section_id, year_level, access_code)
      VALUES (?, ?, ?, ?, ?)`,
            [lastId(userResult), resolvedStudentId, sectionId, year, resolvedAccessCode]
        );

        const student = await get(`
      SELECT
        s.*,
        u.name,
        sec.name AS section_name,
        sec.course
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN sections sec ON s.section_id = sec.id
      WHERE s.id = ?
    `, [lastId(studentResult)]);

        res.json(student);

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
      u.name
    FROM instructors i
    JOIN users u ON u.id=i.user_id
    ORDER BY u.name
  `);
    res.json(instructors);
});

// Admin instructors endpoint (alias for admin panel)
app.get("/api/admin/instructors", requireAuth, async (req, res) => {
    const instructors = await all(`
    SELECT
      i.*,
      u.name
    FROM instructors i
    JOIN users u ON u.id=i.user_id
    ORDER BY u.name
  `);
    res.json(instructors);
});

app.post("/api/instructors", requireAuth, async (req, res) => {
    const {
        name,
        faculty_id,
        department,
        access_code
    } = req.body;

    try {
        const user = await exec(`
      INSERT INTO users (role,name)
      VALUES (?,?)
      `, ["professor", name]);

        const instructor = await exec(`
      INSERT INTO instructors(
        user_id,
        faculty_id,
        department,
        access_code
      )
      VALUES(?,?,?,?)
    `, [lastId(user), faculty_id, department, access_code]);

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
        status,
        name
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

    const updatedDepartment =
        department ?? inst.department;

    const updatedStatus =
        status ?? inst.status;

    await exec(`
    UPDATE instructors
    SET
      department = ?,
      status = ?
    WHERE id = ?
`, [updatedDepartment, updatedStatus, req.params.id]);

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

    res.json(exams);
});

// Get single exam by ID (for student exam tool)
app.get('/api/exams/:id', requireAuth, async (req, res) => {
    const exam = await get(`
    SELECT e.*, s.name as section_name, s.course
    FROM exams e
    JOIN sections s ON e.section_id = s.id
    WHERE e.id = ?
  `, [req.params.id]);
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    // If a student is requesting, only allow access to exams for their own section and non-ended status
    if (req.user.role === 'student') {
        const student = await get(`
      SELECT s.section_id FROM students s WHERE s.user_id = ?
    `, [req.user.id]);
        if (!student || student.section_id !== exam.section_id) {
            return res.status(403).json({ error: 'Forbidden: You can only access exams for your section' });
        }
        if (exam.status === 'ended') {
            return res.status(403).json({ error: 'Forbidden: This exam has ended' });
        }
    }

    // Parse JSON fields
    exam.questions = exam.questions ? (typeof exam.questions === 'string' ? JSON.parse(exam.questions) : exam.questions) : [];
    exam.monitor_settings = exam.monitor_settings ? (typeof exam.monitor_settings === 'string' ? JSON.parse(exam.monitor_settings) : exam.monitor_settings) : {};
    exam.tools_settings = exam.tools_settings ? (typeof exam.tools_settings === 'string' ? JSON.parse(exam.tools_settings) : exam.tools_settings) : {};

    res.json(exam);
});

app.post('/api/exams', requireAuth, async (req, res) => {
    const { title, section_id, section, type, time_limit, link, questions, monitor_settings, tools_settings, accessCode } = req.body;

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
        // Try to find existing section by name
        const existing = await get("SELECT id FROM sections WHERE name = ?", [section]);
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
    schedule,
    type,
    time_limit,
    link,
    questions,
    monitor_settings,
    tools_settings,
    access_code
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
        req.user.id,
        title,
        resolvedSectionId,
        req.body.schedule || null,
        type,
        time_limit,
        link,
        questions ? JSON.stringify(questions) : null,
        monitor_settings ? JSON.stringify(monitor_settings) : null,
        tools_settings ? JSON.stringify(tools_settings) : null,
        accessCode
    ]);

    const exam = await get(`
    SELECT
        id,
        professor_id,
        title,
        section_id,
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
    // Resolve section_id when frontend provides a section name instead of numeric id
    let resolvedSectionId = section_id;
    if ((!resolvedSectionId || resolvedSectionId === '') && section) {
        const existing = await get("SELECT id FROM sections WHERE name = ?", [section]);
        if (existing) {
            resolvedSectionId = existing.id;
        } else {
            const r = await exec("INSERT INTO sections (name, course, created_by) VALUES (?, ?, ?)", [section, 'General', req.user.id]);
            resolvedSectionId = lastId(r);
        }
    }

    await exec(`
    UPDATE exams SET title = ?, section_id = ?, time_limit = ?, link = ?, questions = ?, monitor_settings = ?, tools_settings = ?, status = ?
    WHERE id = ?
  `, [
        title,
        resolvedSectionId,
        time_limit,
        link,
        questions ? (typeof questions === 'string' ? questions : JSON.stringify(questions)) : null,
        monitor_settings ? (typeof monitor_settings === 'string' ? monitor_settings : JSON.stringify(monitor_settings)) : null,
        tools_settings ? (typeof tools_settings === 'string' ? tools_settings : JSON.stringify(tools_settings)) : null,
        status,
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

    const faceCount = req.body.face_count || 0;
    const skinPixels = req.body.skin_pixels || 0;
    const flagged = req.body.flagged ? 1 : 0;
    const result = await exec("INSERT INTO camera_captures (session_id, image_data, capture_type, face_count, skin_pixels, flagged) VALUES (?, ?, 'camera', ?, ?, ?)", [session_id, image, faceCount, skinPixels, flagged]);
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

    await exec('UPDATE exam_sessions SET submitted_at = CURRENT_TIMESTAMP, time_used = ?, answers = ? WHERE id = ?', [time_used, answers ? JSON.stringify(answers) : null, req.params.sessionId]);
    res.json({ success: true, sessionId: req.params.sessionId });
});

// Tab switches
app.post('/api/sessions/:sessionId/tab-switches', requireAuth, async (req, res) => {
    const session = await getSessionOwner(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'professor' && session.professor_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
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

    const totalUsers =
        (await get("SELECT COUNT(*) total FROM users")).total;

    const totalStudents =
        (await get("SELECT COUNT(*) total FROM students")).total;

    const totalInstructors =
        (await get("SELECT COUNT(*) total FROM instructors")).total;

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