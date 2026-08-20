const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "administratorSecretKey";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'wams.db');

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

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// Add missing columns if they don't exist (for existing databases)
try {
  db.exec(`ALTER TABLE camera_captures ADD COLUMN capture_type TEXT DEFAULT 'camera'`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE camera_captures ADD COLUMN face_count INTEGER DEFAULT 0`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE camera_captures ADD COLUMN skin_pixels INTEGER DEFAULT 0`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE camera_captures ADD COLUMN flagged INTEGER DEFAULT 0`);
} catch (e) {}

db.exec(`
CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK(role IN ('admin','professor','student')),
    name TEXT NOT NULL,
    username TEXT UNIQUE,
    password TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_invites(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(created_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS sections(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    course TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS students(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    student_id TEXT UNIQUE NOT NULL,
    section_id INTEGER NOT NULL,
    year_level TEXT,
    access_code TEXT NOT NULL,
    status TEXT DEFAULT 'active'
        CHECK(status IN('active','flagged','suspended')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS instructors(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    faculty_id TEXT UNIQUE NOT NULL,
    department TEXT,
    access_code TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','flagged','suspended')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS exams(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    section_id INTEGER NOT NULL,
    schedule TEXT,
    type TEXT NOT NULL
        CHECK(type IN ('gforms','wams-quiz')),
    time_limit INTEGER NOT NULL,
    link TEXT,
    questions TEXT,
    monitor_settings TEXT,
    tools_settings TEXT,
    access_code TEXT DEFAULT '',
    status TEXT DEFAULT 'scheduled'
        CHECK(status IN ('scheduled','live','ended')),
    flagged INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(professor_id) REFERENCES users(id),
    FOREIGN KEY(section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS exam_sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    submitted_at DATETIME,
    time_used INTEGER,
    answers TEXT,
    score INTEGER,
    graded_at DATETIME,
    ip_address TEXT,
    user_agent TEXT,

    FOREIGN KEY(exam_id) REFERENCES exams(id),
    FOREIGN KEY(student_id) REFERENCES students(id)
);

-- Enrollment tracking
CREATE TABLE IF NOT EXISTS exam_enrollments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
    UNIQUE(exam_id, student_id)
);

CREATE TABLE IF NOT EXISTS tab_switches(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    switched_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(session_id) REFERENCES exam_sessions(id)
);

CREATE TABLE IF NOT EXISTS camera_captures(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    image_data TEXT NOT NULL,
    capture_type TEXT DEFAULT 'camera',
    face_count INTEGER DEFAULT 0,
    skin_pixels INTEGER DEFAULT 0,
    flagged INTEGER DEFAULT 0,
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(session_id) REFERENCES exam_sessions(id)
);

CREATE TABLE IF NOT EXISTS question_activity(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    activity_type TEXT NOT NULL,
    question_number INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(session_id) REFERENCES exam_sessions(id)
);

CREATE TABLE IF NOT EXISTS feedbacks(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    contact TEXT,
    module TEXT,
    status TEXT DEFAULT 'New'
        CHECK(status IN ('New','Reviewed','Resolved')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(professor_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_students_section
ON students(section_id);

CREATE INDEX IF NOT EXISTS idx_exams_professor
ON exams(professor_id);

CREATE INDEX IF NOT EXISTS idx_sessions_exam
ON exam_sessions(exam_id);

-- Performance indexes for login and lookup queries
CREATE INDEX IF NOT EXISTS idx_users_username
ON users(username);

CREATE INDEX IF NOT EXISTS idx_students_student_id
ON students(student_id);

CREATE INDEX IF NOT EXISTS idx_instructors_faculty_id
ON instructors(faculty_id);

CREATE INDEX IF NOT EXISTS idx_exams_access_code
ON exams(access_code);

CREATE INDEX IF NOT EXISTS idx_exams_status
ON exams(status);

CREATE INDEX IF NOT EXISTS idx_sessions_student
ON exam_sessions(student_id);

CREATE INDEX IF NOT EXISTS idx_tabswitches_session
ON tab_switches(session_id);

CREATE INDEX IF NOT EXISTS idx_captures_session
ON camera_captures(session_id);

CREATE INDEX IF NOT EXISTS idx_question_activity_session
ON question_activity(session_id);
`);

// Add email column to users if it doesn't exist (for user profile)
try {
  db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
} catch (e) {
  // Column already exists, ignore error
}

const adminExists = db.prepare(
    "SELECT id FROM users WHERE username=?"
).get("admin");


if (!adminExists) {

  const hashed = bcrypt.hashSync("admin123",10);

  const result = db.prepare(`
    INSERT INTO users
    (role,name,username,password)
    VALUES (?,?,?,?)
  `).run(
    "admin",
    "System Administrator",
    "admin",
    hashed
  );

  const inviteResult = db.prepare(`
    INSERT INTO admin_invites
    (code, created_by)
    VALUES (?,?)
  `).run(
    "ADMIN2026",
    result.lastInsertRowid
  );

  const createdAdmin = db.prepare('SELECT id, username, name, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
  const createdInvite = db.prepare('SELECT code, used, created_at FROM admin_invites WHERE id = ?').get(inviteResult.lastInsertRowid);

  console.log("Admin account created.");
  if (createdAdmin) console.log(`Admin: ${createdAdmin.username} (${createdAdmin.name}) created at ${createdAdmin.created_at}`);
  if (createdInvite) console.log(`Invite code: ${createdInvite.code} (used: ${createdInvite.used}) created at ${createdInvite.created_at}`);
}

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
        const user = db.prepare(`
          SELECT
              id,
              username,
              role,
              name
          FROM users
          WHERE id=?
      `).get(decoded.id);
        if (!user)
            return res.status(401).json({
                error: "Invalid Token"
            });

        req.user = user;

        next();

    } catch {
        return res.status(401).json({
            error: "Invalid Token"
        });
    }
}

function getSessionOwner(sessionId) {
    return db.prepare(`
      SELECT
        es.*,
        s.user_id AS student_user_id,
        e.professor_id
      FROM exam_sessions es
      JOIN students s ON es.student_id = s.id
      JOIN exams e ON es.exam_id = e.id
      WHERE es.id = ?
    `).get(sessionId);
}
// Auth endpoints
app.post('/api/auth/login', async (req,res)=>{

    const { username, password } = req.body;

    const user = db.prepare(`
        SELECT *
        FROM users
        WHERE username = ?
    `).get(username);

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

        if(user.role !== "admin"){
    return res.status(403).json({
        error:"Admin access only"
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
app.post('/api/auth/register', async(req,res)=>{

    const {
        username,
        password,
        name,
        inviteCode
    } = req.body;


    const invite = db.prepare(`
        SELECT *
        FROM admin_invites
        WHERE code=? AND used=0
    `).get(inviteCode);


    if(!invite){
        return res.status(400).json({
            error:"Invalid invitation code"
        });
    }


    const hashed = await bcrypt.hash(password,10);


    try{

        const result = db.prepare(`
            INSERT INTO users
            (role,name,username,password)
            VALUES (?,?,?,?)
        `).run(
            "admin",
            name,
            username,
            hashed
        );


        db.prepare(`
            UPDATE admin_invites
            SET used=1
            WHERE id=?
        `).run(invite.id);



        res.json({
            success:true,
            id:result.lastInsertRowid
        });


    }catch(err){

        res.status(400).json({
            error:err.message
        });

    }

});

app.post('/api/auth/student-login', (req, res) => {
  const { student_id, access_code } = req.body;

  // Find student by student_id (active status only)
  const student = db.prepare(`
    SELECT s.*, u.name, sec.name as section_name, sec.course
    FROM students s
    JOIN users u ON s.user_id = u.id
    JOIN sections sec ON s.section_id = sec.id
    WHERE s.student_id = ? AND s.status = 'active'
    `)
    .get(student_id);

  if(!student) return res.status(401).json({ error: 'Invalid student number or account suspended' });

  // Validate the exam access code
  if(!access_code){
    return res.status(401).json({ error: 'Exam access code is required' });
  }

  // Find active exam for this student's section
  const exam = db.prepare(`
    SELECT e.*, sec.name as section_name
    FROM exams e
    JOIN sections sec ON e.section_id = sec.id
    WHERE e.section_id = ? AND e.status IN ('scheduled', 'live')
    ORDER BY e.created_at DESC
    LIMIT 1
  `).get(student.section_id);

  if(!exam) return res.status(401).json({ error: 'No active exam found for your section' });
  if(exam && exam.access_code && String(exam.access_code).trim() !== String(access_code).trim()){
    return res.status(401).json({ error: 'Invalid exam access code' });
  }

  // Create exam session
  const sessionResult = db.prepare(`
    INSERT INTO exam_sessions (exam_id, student_id) VALUES (?, ?)
  `).run(exam.id, student.id);

  const token = jwt.sign(
{
    id: student.user_id,
    role: "student"
},
JWT_SECRET,
{
    expiresIn:"24h"
});

res.json({
    token,
    student,
    exam:{
        ...exam,
        session_id: sessionResult.lastInsertRowid
    }
});
});

app.post('/api/auth/professor-login', (req, res) => {
  const { faculty_id, access_code } = req.body;

  const instructor = db.prepare(`
    SELECT i.*, u.id as user_id, u.name, u.role
    FROM instructors i
    JOIN users u ON i.user_id = u.id
    WHERE i.faculty_id = ? AND i.access_code = ? AND i.status = 'active'
  `).get(faculty_id, access_code);

  if (!instructor) return res.status(401).json({ error: 'Invalid Faculty ID or Access Code' });

    const token = jwt.sign(
{
    id: instructor.user_id,
    role: instructor.role
},
JWT_SECRET,
{
    expiresIn:"24h"
});

res.json({
    token,
    user:{
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

app.get("/api/me", requireAuth, (req, res) => {
  const user = db.prepare(`
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
  `).get(req.user.id);
  res.json(user);
});

// Sections
app.get('/api/sections', requireAuth, (req, res) => {
  const sections = db.prepare('SELECT * FROM sections ORDER BY course, name').all();
  res.json(sections);
});

app.post('/api/sections', requireAuth, (req, res) => {
  const { name, course } = req.body;
  const result = db.prepare('INSERT INTO sections (name, course, created_by) VALUES (?, ?, ?)').run(name, course, req.user.id);
  const section = db.prepare('SELECT * FROM sections WHERE id = ?').get(result.lastInsertRowid);
  res.json(section);
});

// Students
app.get('/api/students', requireAuth, (req, res) => {
  const { section_id } = req.query;
  let query = `
    SELECT s.*, u.name, sec.name as section_name, sec.course
    FROM students s
    JOIN users u ON s.user_id = u.id
    JOIN sections sec ON s.section_id = sec.id
  `;
  const params = [];
  if(section_id){
    query += ' WHERE s.section_id = ?';
    params.push(section_id);
  }
  query += ' ORDER BY sec.course, sec.name, s.student_id';
  const students = db.prepare(query).all(...params);
  res.json(students);
});

app.post('/api/students', requireAuth, (req, res) => {
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
      const sectionRow = db.prepare("SELECT id FROM sections WHERE id = ?").get(sectionId);
      if (!sectionRow) {
        return res.status(400).json({ error: 'Invalid section selected' });
      }
    } else if (req.body.section) {
      // Try to find existing section by name
      const sectionRow = db.prepare(
        "SELECT id FROM sections WHERE name = ?"
      ).get(req.body.section);

      if (!sectionRow) {
        return res.status(400).json({ error: 'Section not found. Please create the section first.' });
      }

      sectionId = sectionRow.id;
    } else {
      return res.status(400).json({ error: 'Section is required' });
    }

    // Create user account
    const userResult = db.prepare(`
      INSERT INTO users (role, name)
      VALUES (?, ?)
      `).run(
          "student",
          name
      );

    // Create student record
    const studentResult = db.prepare(
      `INSERT INTO students
      (user_id, student_id, section_id, year_level, access_code)
      VALUES (?, ?, ?, ?, ?)`
    ).run(
      userResult.lastInsertRowid,
      resolvedStudentId,
      sectionId,
      year,
      resolvedAccessCode
    );

    const student = db.prepare(`
      SELECT
        s.*,
        u.name,
        sec.name AS section_name,
        sec.course
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN sections sec ON s.section_id = sec.id
      WHERE s.id = ?
    `).get(studentResult.lastInsertRowid);

    res.json(student);

  } catch (e) {
    res.status(400).json({
      error: e.message
    });
  }
});

app.put('/api/students/:id', requireAuth, (req, res) => {

  const {
    name,
    section_id,
    year_level,
    status,
    access_code
  } = req.body;

  const student = db.prepare(
    'SELECT * FROM students WHERE id = ?'
  ).get(req.params.id);

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

  db.prepare(`
    UPDATE students
    SET
      section_id = ?,
      year_level = ?,
      status = ?,
      access_code = ?
    WHERE id = ?
  `).run(
    updatedSection,
    updatedYear,
    updatedStatus,
    updatedCode,
    req.params.id
  );

  if (name) {
    db.prepare(`
      UPDATE users
      SET name = ?
      WHERE id = ?
    `).run(
      name,
      student.user_id
    );
  }

  const updated = db.prepare(`
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
  `).get(req.params.id);

  res.json(updated);

});

app.delete('/api/students/:id', requireAuth, (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  db.prepare('DELETE FROM tab_switches WHERE session_id IN (SELECT id FROM exam_sessions WHERE student_id = ?)').run(student.id);
  db.prepare('DELETE FROM camera_captures WHERE session_id IN (SELECT id FROM exam_sessions WHERE student_id = ?)').run(student.id);
  db.prepare('DELETE FROM question_activity WHERE session_id IN (SELECT id FROM exam_sessions WHERE student_id = ?)').run(student.id);
  db.prepare('DELETE FROM exam_sessions WHERE student_id = ?').run(student.id);
  db.prepare('DELETE FROM students WHERE id = ?').run(student.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(student.user_id);
  res.json({ success: true });
});

// Instructors endpoints
app.get("/api/instructors", requireAuth, (req, res) => {
  const instructors = db.prepare(`
    SELECT
      i.*,
      u.name
    FROM instructors i
    JOIN users u ON u.id=i.user_id
    ORDER BY u.name
  `).all();
  res.json(instructors);
});

// Admin instructors endpoint (alias for admin panel)
app.get("/api/admin/instructors", requireAuth, (req, res) => {
  const instructors = db.prepare(`
    SELECT
      i.*,
      u.name
    FROM instructors i
    JOIN users u ON u.id=i.user_id
    ORDER BY u.name
  `).all();
  res.json(instructors);
});

app.post("/api/instructors", requireAuth, (req, res) => {
  const {
    name,
    faculty_id,
    department,
    access_code
  } = req.body;

  try {
    const user = db.prepare(`
      INSERT INTO users (role,name)
      VALUES (?,?)
      `).run(
          "professor",
          name
      );

    const instructor = db.prepare(`
      INSERT INTO instructors(
        user_id,
        faculty_id,
        department,
        access_code
      )
      VALUES(?,?,?,?)
    `).run(
      user.lastInsertRowid,
      faculty_id,
      department,
      access_code
    );

    res.json({
      success: true,
      id: instructor.lastInsertRowid
    });

  } catch (err) {
    res.status(400).json({
      error: err.message
    });
  }
});

app.delete("/api/instructors/:id", requireAuth, (req, res) => {
  const inst = db.prepare(
    "SELECT * FROM instructors WHERE id=?"
  ).get(req.params.id);

  if(!inst) {
    return res.status(404).json({
      error: "Instructor not found"
    });
  }

  db.prepare(
    "DELETE FROM instructors WHERE id=?"
  ).run(req.params.id);

  db.prepare(
    "DELETE FROM users WHERE id=?"
  ).run(inst.user_id);

  res.json({
    success: true
  });
});

app.put("/api/instructors/:id", requireAuth, (req, res) => {
  const {
    department,
    status,
    name
  } = req.body;

  const inst = db.prepare(
    "SELECT * FROM instructors WHERE id=?"
  ).get(req.params.id);

  if(!inst) {
    return res.status(404).json({
      error: "Instructor not found"
    });
  }

  const updatedDepartment =
    department ?? inst.department;

const updatedStatus =
    status ?? inst.status;

db.prepare(`
    UPDATE instructors
    SET
      department = ?,
      status = ?
    WHERE id = ?
`).run(
    updatedDepartment,
    updatedStatus,
    req.params.id
);

  if(name) {
    db.prepare(`
      UPDATE users
      SET name=?
      WHERE id=?
    `).run(
      name,
      inst.user_id
    );
  }

  res.json({
    success: true
  });
});

// Profile endpoints
app.get('/api/profile', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT u.id, u.name, u.role
    FROM users u
    WHERE u.id = ?
  `).get(req.user.id);
  res.json(user);
});

app.put('/api/profile', requireAuth, (req, res) => {
    const { name, email } = req.body;

    db.prepare(`
        UPDATE users
        SET name = ?, email = ?
        WHERE id = ?
    `).run(
        name,
        email || null,
        req.user.id
    );

    const updated = db.prepare(`
        SELECT
            id,
            name,
            email,
            role
        FROM users
        WHERE id = ?
    `).get(req.user.id);

    res.json(updated);
});

app.put('/api/profile/password', requireAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
        return res.status(400).json({ error: 'Current and new passwords are required' });
    }

    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(current_password, user.password || '');
    if (!valid) {
        return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.user.id);
    res.json({ success: true });
});

// Feedback endpoints
app.get('/api/feedbacks', requireAuth, (req, res) => {
  const feedbacks = db.prepare(`
    SELECT f.*, u.name as professor_name
    FROM feedbacks f
    JOIN users u ON f.professor_id = u.id
    ORDER BY f.created_at DESC
  `).all();
  res.json(feedbacks);
});

app.post('/api/feedbacks', requireAuth, (req, res) => {
  const { category, subject, message, contact, module } = req.body;
  const result = db.prepare(`
    INSERT INTO feedbacks (professor_id, category, subject, message, contact, module)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.id, category, subject, message, contact, module);

  const feedback = db.prepare('SELECT * FROM feedbacks WHERE id = ?').get(result.lastInsertRowid);
  res.json(feedback);
});

app.put('/api/feedbacks/:id', requireAuth, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE feedbacks SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

app.delete('/api/feedbacks/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM feedbacks WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Exams
// Exam Enrollments
app.get('/api/exams/:examId/enrollments', requireAuth, (req, res) => {
  const enrollments = db.prepare(`
    SELECT ee.*, s.student_id, u.name as student_name, sec.name as section_name
    FROM exam_enrollments ee
    JOIN students s ON ee.student_id = s.id
    JOIN users u ON s.user_id = u.id
    JOIN sections sec ON s.section_id = sec.id
    WHERE ee.exam_id = ?
    ORDER BY ee.enrolled_at DESC
  `).all(req.params.examId);
  res.json(enrollments);
});

app.post('/api/exams/:examId/enrollments', requireAuth, (req, res) => {
  const { student_id } = req.body;

  // Verify exam exists
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.examId);
  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  // Verify student exists
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(student_id);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  try {
    const result = db.prepare(`
      INSERT INTO exam_enrollments (exam_id, student_id) VALUES (?, ?)
    `).run(req.params.examId, student_id);

    res.json({ success: true, enrollmentId: result.lastInsertRowid });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ error: 'Student already enrolled in this exam' });
    }
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/exams/:examId/enrollments/:studentId', requireAuth, (req, res) => {
  const result = db.prepare(`
    DELETE FROM exam_enrollments WHERE exam_id = ? AND student_id = ?
  `).run(req.params.examId, req.params.studentId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Enrollment not found' });
  }

  res.json({ success: true });
});

// Exams
app.get('/api/exams', requireAuth, (req, res) => {
  const exams = db.prepare(`
    SELECT e.*, s.name as section_name, s.course, u.name as professor_name
    FROM exams e
    JOIN sections s ON e.section_id = s.id
    JOIN users u ON e.professor_id = u.id
    ORDER BY e.created_at DESC
  `).all();
  res.json(exams);
});

// Get exams for the currently logged-in professor only
app.get('/api/my-exams', requireAuth, (req, res) => {
  if (req.user.role !== 'professor') {
    return res.status(403).json({ error: 'Only professors can access this' });
  }
  const exams = db.prepare(`
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
`).all(req.user.id);

res.json(exams);
});

// Get single exam by ID (for student exam tool)
app.get('/api/exams/:id', requireAuth, (req, res) => {
  const exam = db.prepare(`
    SELECT e.*, s.name as section_name, s.course
    FROM exams e
    JOIN sections s ON e.section_id = s.id
    WHERE e.id = ?
  `).get(req.params.id);
  if(!exam) return res.status(404).json({ error: 'Exam not found' });

  // If a student is requesting, only allow access to exams for their own section and non-ended status
  if (req.user.role === 'student') {
    const student = db.prepare(`
      SELECT s.section_id FROM students s WHERE s.user_id = ?
    `).get(req.user.id);
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

app.post('/api/exams', requireAuth, (req, res) => {
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
    const existing = db.prepare("SELECT id FROM sections WHERE name = ?").get(section);
    if (existing) {
      resolvedSectionId = existing.id;
    } else {
      // Create new section
      const result = db.prepare("INSERT INTO sections (name, course, created_by) VALUES (?, ?, ?)").run(section, 'General', req.user.id);
      resolvedSectionId = result.lastInsertRowid;
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

  const result = db.prepare(`
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
  `).run(
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
);

  const exam = db.prepare(`
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
`).get(result.lastInsertRowid);

res.json(exam);
});

app.put('/api/exams/:id', requireAuth, (req, res) => {
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
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if(!exam) return res.status(404).json({ error: 'Exam not found' });

  // Verify ownership - only professor who created exam can edit
  if(exam.professor_id !== req.user.id && req.user.role !== 'admin'){
    return res.status(403).json({ error: 'You can only edit your own exams' });
  }

  // Validate time_limit if provided
  if (time_limit !== undefined && (time_limit < 1 || time_limit > 480)) {
    return res.status(400).json({ error: 'Time limit must be between 1 and 480 minutes' });
  }
  // Resolve section_id when frontend provides a section name instead of numeric id
  let resolvedSectionId = section_id;
  if ((!resolvedSectionId || resolvedSectionId === '') && section) {
    const existing = db.prepare("SELECT id FROM sections WHERE name = ?").get(section);
    if (existing) {
      resolvedSectionId = existing.id;
    } else {
      const r = db.prepare("INSERT INTO sections (name, course, created_by) VALUES (?, ?, ?)").run(section, 'General', req.user.id);
      resolvedSectionId = r.lastInsertRowid;
    }
  }

  db.prepare(`
    UPDATE exams SET title = ?, section_id = ?, time_limit = ?, link = ?, questions = ?, monitor_settings = ?, tools_settings = ?, status = ?
    WHERE id = ?
  `).run(
    title,
    resolvedSectionId,
    time_limit,
    link,
    questions ? (typeof questions === 'string' ? questions : JSON.stringify(questions)) : null,
    monitor_settings ? (typeof monitor_settings === 'string' ? monitor_settings : JSON.stringify(monitor_settings)) : null,
    tools_settings ? (typeof tools_settings === 'string' ? tools_settings : JSON.stringify(tools_settings)) : null,
    status,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/exams/:id', requireAuth, (req, res) => {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(req.params.id);
  if(!exam) return res.status(404).json({ error: 'Exam not found' });

  // Verify ownership - only professor who created exam can delete
  if(exam.professor_id !== req.user.id && req.user.role !== 'admin'){
    return res.status(403).json({ error: 'You can only delete your own exams' });
  }
  try {
    const deleteTx = db.transaction((examId) => {
      // remove tab switches, captures, and question activity for sessions belonging to this exam
      db.prepare('DELETE FROM tab_switches WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)').run(examId);
      db.prepare('DELETE FROM camera_captures WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)').run(examId);
      db.prepare('DELETE FROM question_activity WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)').run(examId);
      // remove exam sessions
      db.prepare('DELETE FROM exam_sessions WHERE exam_id = ?').run(examId);
      // remove enrollments (safe even if table has ON DELETE CASCADE)
      db.prepare('DELETE FROM exam_enrollments WHERE exam_id = ?').run(examId);
      // finally remove the exam
      db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
    });

    deleteTx(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete exam and related data:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to delete exam. ' + (err && err.message ? err.message : '') });
  }
});

// Camera captures
app.post('/api/camera/capture', requireAuth, (req, res) => {
  const { session_id, image } = req.body;
  if(!session_id || !image) return res.status(400).json({ error: 'Missing session_id or image' });

  const session = getSessionOwner(session_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const faceCount = req.body.face_count || 0;
  const skinPixels = req.body.skin_pixels || 0;
  const flagged = req.body.flagged ? 1 : 0;
  const result = db.prepare("INSERT INTO camera_captures (session_id, image_data, capture_type, face_count, skin_pixels, flagged) VALUES (?, ?, 'camera', ?, ?, ?)").run(session_id, image, faceCount, skinPixels, flagged);
  res.json({ id: result.lastInsertRowid, face_count: faceCount, flagged: Boolean(flagged), success: true });
});

app.get('/api/sessions/:sessionId/captures', requireAuth, (req, res) => {
  const captures = db.prepare("SELECT * FROM camera_captures WHERE session_id = ? AND (capture_type = 'camera' OR capture_type IS NULL) ORDER BY captured_at DESC").all(req.params.sessionId);
  res.json(captures);
});

// Screen captures
app.post('/api/sessions/:sessionId/screen-capture', requireAuth, (req, res) => {
  const { image } = req.body;
  if(!image) return res.status(400).json({ error: 'Missing image data' });

  const session = getSessionOwner(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const result = db.prepare('INSERT INTO camera_captures (session_id, image_data, capture_type) VALUES (?, ?, ?)').run(req.params.sessionId, image, 'screen');
  res.json({ id: result.lastInsertRowid, success: true });
});

app.get('/api/sessions/:sessionId/screen-captures', requireAuth, (req, res) => {
  const captures = db.prepare('SELECT * FROM camera_captures WHERE session_id = ? AND capture_type = ? ORDER BY captured_at DESC').all(req.params.sessionId, 'screen');
  res.json(captures);
});

// Audio captures/anomalies
app.post('/api/sessions/:sessionId/audio-capture', requireAuth, (req, res) => {
  const { audio_data, audio_clip, level, flagged } = req.body;

  const session = getSessionOwner(req.params.sessionId);
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
    } catch(e) {
      payload = audio_data;
    }
  } else {
    payload = JSON.stringify({ level: level || 0, audio_clip: audio_clip || null, flagged: !!flagged });
  }

  const result = db.prepare("INSERT INTO camera_captures (session_id, image_data, capture_type, flagged) VALUES (?, ?, 'audio', ?)").run(
    req.params.sessionId,
    payload,
    flagged ? 1 : 0
  );
  res.json({ id: result.lastInsertRowid, success: true });
});

app.get('/api/sessions/:sessionId/audio-captures', requireAuth, (req, res) => {
  const captures = db.prepare('SELECT * FROM camera_captures WHERE session_id = ? AND capture_type = ? ORDER BY captured_at DESC').all(req.params.sessionId, 'audio');
  res.json(captures);
});

// Exam submission
app.post('/api/sessions/:sessionId/submit', requireAuth, (req, res) => {
  const { time_used, answers } = req.body;
  const session = getSessionOwner(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role === 'professor' && session.professor_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare('UPDATE exam_sessions SET submitted_at = CURRENT_TIMESTAMP, time_used = ?, answers = ? WHERE id = ?')
    .run(time_used, answers ? JSON.stringify(answers) : null, req.params.sessionId);
  res.json({ success: true, sessionId: req.params.sessionId });
});

// Tab switches
app.post('/api/sessions/:sessionId/tab-switches', requireAuth, (req, res) => {
  const session = getSessionOwner(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role === 'professor' && session.professor_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const result = db.prepare('INSERT INTO tab_switches (session_id) VALUES (?)').run(req.params.sessionId);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/exams/:examId/sessions', requireAuth, (req, res) => {
  const sessions = db.prepare(`
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
  `).all(req.params.examId);
  res.json(sessions);
});

app.get('/api/exams/:examId/tab-switches', requireAuth, (req, res) => {
  const switches = db.prepare(`
    SELECT ts.*, s.student_id, u.name as student_name
    FROM tab_switches ts
    JOIN exam_sessions s ON ts.session_id = s.id
    JOIN students st ON s.student_id = st.id
    JOIN users u ON st.user_id = u.id
    WHERE s.exam_id = ?
    ORDER BY ts.switched_at DESC
  `).all(req.params.examId);
  res.json(switches);
});

// Question activity tracking
app.post('/api/sessions/:sessionId/question-activity', requireAuth, (req, res) => {
  const { activity_type, question_number } = req.body;
  if (!activity_type || !question_number) {
    return res.status(400).json({ error: 'activity_type and question_number are required' });
  }
  const session = getSessionOwner(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (req.user.role === 'student' && session.student_user_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role === 'professor' && session.professor_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const result = db.prepare(`
    INSERT INTO question_activity (session_id, activity_type, question_number)
    VALUES (?, ?, ?)
  `).run(req.params.sessionId, activity_type, question_number);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/exams/:examId/question-activity', requireAuth, (req, res) => {
  const activities = db.prepare(`
    SELECT qa.*, s.student_id, u.name as student_name
    FROM question_activity qa
    JOIN exam_sessions s ON qa.session_id = s.id
    JOIN students st ON s.student_id = st.id
    JOIN users u ON st.user_id = u.id
    WHERE s.exam_id = ?
    ORDER BY qa.created_at DESC
  `).all(req.params.examId);
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

app.get("/api/dashboard", requireAuth, (req, res) => {

    const totalUsers =
        db.prepare("SELECT COUNT(*) total FROM users").get().total;

    const totalStudents =
        db.prepare("SELECT COUNT(*) total FROM students").get().total;

    const totalInstructors =
        db.prepare("SELECT COUNT(*) total FROM instructors").get().total;

    const totalExams =
        db.prepare("SELECT COUNT(*) total FROM exams").get().total;

    const liveExams = db.prepare(`
    SELECT COUNT(*) total
    FROM exams
    WHERE status='live'
    `).get().total;

    const endedExams = db.prepare(`
    SELECT COUNT(*) total
    FROM exams
    WHERE status='ended'
    `).get().total;

    const scheduledExams = db.prepare(`
    SELECT COUNT(*) total
    FROM exams
    WHERE status='scheduled'
          `).get().total;

    const flaggedSessions =
        db.prepare("SELECT COUNT(*) total FROM tab_switches").get().total;

    const recentActivity = db.prepare(`
        SELECT
            u.name AS user_name,
            u.role AS user_role,
            u.created_at,
            'registered' AS activity_type
        FROM users u
        WHERE u.id != 1
        ORDER BY u.created_at DESC
        LIMIT 5
    `).all().map(row => ({
        message: `${row.user_name} (${row.user_role}) registered`,
        time: timeAgo(row.created_at)
    }));

    const activeExams = db.prepare(`
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
`).all();

   const recentUsers = db.prepare(`
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
`).all();

    const os = require('os');
    const totalMem = os.totalmem() || 1;
    const freeMem = os.freemem() || 0;
    const memory = Math.min(100, Math.max(5, Math.round(((totalMem - freeMem) / totalMem) * 100)));

    const cpus = os.cpus();
    const cpu = cpus && cpus.length > 0 ? Math.min(100, Math.max(8, Math.round((os.loadavg()[0] || 0.3) * 25))) : 12;

    let dbSizeKb = 64;
    try {
      const pageCount = db.pragma('page_count', { simple: true }) || 16;
      const pageSize = db.pragma('page_size', { simple: true }) || 4096;
      dbSizeKb = Math.round((pageCount * pageSize) / 1024);
    } catch(e) {}
    const database = Math.min(100, Math.max(8, Math.round((dbSizeKb / 512) * 15)));
    const network = liveExams > 0 ? Math.min(100, 25 + liveExams * 18) : 8;
    const storage = Math.min(100, Math.max(12, Math.round(memory * 0.7)));

    const systemHealth = {
      cpu,
      memory,
      database,
      network,
      storage
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

app.listen(PORT, () => {
  console.log(`WAMS Server running on http://localhost:${PORT}`);
  try {
    const adminRow = db.prepare("SELECT id, username, name, created_at FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
    if (adminRow) {
      console.log(`Admin account: ${adminRow.username} (${adminRow.name}) created at ${adminRow.created_at}`);
    }
    const inviteRow = db.prepare('SELECT code, used, created_at FROM admin_invites ORDER BY id DESC LIMIT 1').get();
    if (inviteRow) {
      console.log(`Invite code: ${inviteRow.code} (used: ${inviteRow.used}) created at ${inviteRow.created_at}`);
    }
  } catch (e) {
    console.log('Unable to read admin metadata:', e && e.message ? e.message : e);
  }
});