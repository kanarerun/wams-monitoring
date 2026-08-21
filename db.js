import { createClient } from "@libsql/client";
import dotenv from "dotenv";

// Load local .env variables if testing on your computer
dotenv.config();

// Verify that the environment variables are present
if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error("❌ Critical Error: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set in your environment!");
}

// 1. Initialize the Turso SQLite Cloud Client
export const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// 2. Automatically set up your cloud schema on startup
async function setupDatabaseSchema() {
  try {
    console.log("🔄 Syncing database schema with Turso Cloud...");

    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('admin','professor','student')),
        name TEXT NOT NULL,
        username TEXT UNIQUE,
        password TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS admin_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        created_by INTEGER NOT NULL,
        used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(created_by) REFERENCES users(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        course TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(created_by) REFERENCES users(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        student_id TEXT UNIQUE NOT NULL,
        section_id INTEGER NOT NULL,
        year_level TEXT,
        access_code TEXT NOT NULL,
        status TEXT DEFAULT 'active' CHECK(status IN('active','flagged','suspended')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(section_id) REFERENCES sections(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS instructors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        faculty_id TEXT UNIQUE NOT NULL,
        department TEXT,
        access_code TEXT NOT NULL,
        status TEXT DEFAULT 'active' CHECK(status IN ('active','flagged','suspended')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS exams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        professor_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        section_id INTEGER NOT NULL,
        schedule TEXT,
        type TEXT NOT NULL CHECK(type IN ('gforms','wams-quiz')),
        time_limit INTEGER NOT NULL,
        link TEXT,
        questions TEXT,
        monitor_settings TEXT,
        tools_settings TEXT,
        access_code TEXT DEFAULT '',
        status TEXT DEFAULT 'scheduled' CHECK(status IN ('scheduled','live','ended')),
        flagged INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(professor_id) REFERENCES users(id),
        FOREIGN KEY(section_id) REFERENCES sections(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS exam_sessions (
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
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS exam_enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(exam_id) REFERENCES exams(id) ON DELETE CASCADE,
        FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE(exam_id, student_id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS tab_switches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        switched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES exam_sessions(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS camera_captures (
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
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS question_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        activity_type TEXT NOT NULL,
        question_number INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES exam_sessions(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS feedbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        professor_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        contact TEXT,
        module TEXT,
        status TEXT DEFAULT 'New' CHECK(status IN ('New','Reviewed','Resolved')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(professor_id) REFERENCES users(id)
      );
    `);

    // Performance indexes
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_students_section ON students(section_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_exams_professor ON exams(professor_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_exam ON exam_sessions(exam_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_students_student_id ON students(student_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_instructors_faculty_id ON instructors(faculty_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_exams_access_code ON exams(access_code);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_student ON exam_sessions(student_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_tabswitches_session ON tab_switches(session_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_captures_session ON camera_captures(session_id);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_question_activity_session ON question_activity(session_id);`);

    // Migration: add email column to users if it doesn't exist
    try {
      await db.execute(`ALTER TABLE users ADD COLUMN email TEXT`);
    } catch (e) {
      // Column already exists, ignore error
    }

    console.log("✅ Turso cloud tables are ready and synced!");
  } catch (error) {
    console.error("❌ Failed to initialize database schema:", error);
  }
}

// Run the schema setup immediately on application boot
export const schemaReady = setupDatabaseSchema();