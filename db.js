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
        email TEXT,
        created_by INTEGER NOT NULL,
        used INTEGER DEFAULT 0,
        expires_at INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(created_by) REFERENCES users(id)
      );
    `);

    for (const [column, definition] of [
      ['email', 'TEXT'],
      ['expires_at', 'INTEGER']
    ]) {
      try {
        await db.execute(`ALTER TABLE admin_invites ADD COLUMN ${column} ${definition}`);
      } catch (e) {
        if (!/duplicate column name/i.test(e.message)) throw e;
      }
    }

    await db.execute(`
      UPDATE admin_invites
      SET used = 1
      WHERE email IS NULL OR expires_at IS NULL
    `);
    // The old shared ADMIN2026 seed code is plaintext and must never be usable.
    // Every invitation is now generated per-email and stored as a bcrypt hash.
    await db.execute(`
      DELETE FROM admin_invites
      WHERE email IS NULL AND code NOT LIKE '$2%'
    `);
    await db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_invites_pending_email
      ON admin_invites(lower(email))
      WHERE used = 0 AND email IS NOT NULL
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        course TEXT NOT NULL,
        year_level TEXT,
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
        FOREIGN KEY(section_id) REFERENCES sections(id) ON DELETE CASCADE
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS instructors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        faculty_id TEXT UNIQUE NOT NULL,
        email TEXT,
        department TEXT,
        access_code TEXT NOT NULL,
        status TEXT DEFAULT 'active' CHECK(status IN ('active','flagged','suspended')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS password_reset_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instructor_id INTEGER,
        admin_id INTEGER,
        code_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        verified_at INTEGER,
        consumed_at INTEGER,
        FOREIGN KEY(instructor_id) REFERENCES instructors(id) ON DELETE CASCADE,
        FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Migration for existing databases: make instructor_id nullable and add the
    // admin_id column so the same table stores reset codes for both professors
    // and administrators.
    try {
      const cols = (await db.execute(`PRAGMA table_info(password_reset_codes)`)).rows;
      const hasAdminId = cols.some((c) => c.name === 'admin_id');
      const instructorNotNull = cols.some(
        (c) => c.name === 'instructor_id' && c.notnull === 1
      );
      if (!hasAdminId || instructorNotNull) {
        // NOTE: libsql/Turso remote servers run each statement independently, so
        // explicit BEGIN/COMMIT transactions are not supported here.
        await db.execute(`DROP TABLE IF EXISTS password_reset_codes_new;`);
        await db.execute(`
          CREATE TABLE password_reset_codes_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instructor_id INTEGER,
            admin_id INTEGER,
            code_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            verified_at INTEGER,
            consumed_at INTEGER,
            FOREIGN KEY(instructor_id) REFERENCES instructors(id) ON DELETE CASCADE,
            FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);
        await db.execute(`
          INSERT INTO password_reset_codes_new
          SELECT id, instructor_id, NULL AS admin_id, code_hash, created_at, expires_at, attempts, verified_at, consumed_at
          FROM password_reset_codes;
        `);
        await db.execute(`DROP TABLE password_reset_codes;`);
        await db.execute(`ALTER TABLE password_reset_codes_new RENAME TO password_reset_codes;`);
      }
    } catch (migrationError) {
      try {
        await db.execute(`ROLLBACK`).catch(() => {});
      } catch (_) {}
      console.error(
        'Failed to migrate password_reset_codes for admin support:',
        migrationError
      );
    }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS instructor_classes (
        instructor_id INTEGER NOT NULL,
        section_id INTEGER NOT NULL,
        year_level TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(instructor_id, section_id, year_level),
        FOREIGN KEY(instructor_id) REFERENCES instructors(id) ON DELETE CASCADE,
        FOREIGN KEY(section_id) REFERENCES sections(id) ON DELETE CASCADE
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(created_by) REFERENCES users(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        department_id INTEGER NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(department_id) REFERENCES departments(id) ON DELETE CASCADE,
        FOREIGN KEY(created_by) REFERENCES users(id),
        UNIQUE(department_id, name)
      );
    `);

    try {
      await db.execute(`ALTER TABLE instructors ADD COLUMN course_id INTEGER REFERENCES courses(id)`);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }

    await db.execute(`
      INSERT OR IGNORE INTO departments (name)
      SELECT DISTINCT TRIM(department)
      FROM instructors
      WHERE department IS NOT NULL AND TRIM(department) <> '';
    `);
    await db.execute(`
      UPDATE instructors
      SET department = (
        SELECT name FROM departments
        WHERE name = TRIM(instructors.department) COLLATE NOCASE
      )
      WHERE department IS NOT NULL AND TRIM(department) <> '';
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
        live_started_at DATETIME,
        flagged INTEGER DEFAULT 0,
        published_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(professor_id) REFERENCES users(id),
        FOREIGN KEY(section_id) REFERENCES sections(id) ON DELETE CASCADE
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
        FOREIGN KEY(exam_id) REFERENCES exams(id) ON DELETE CASCADE,
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
        switch_source TEXT DEFAULT 'tab-switch',
        switched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS camera_captures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        image_data TEXT NOT NULL,
        media_data BLOB,
        capture_id TEXT,
        file_size INTEGER,
        mime_type TEXT,
        metadata_json TEXT,
        capture_type TEXT DEFAULT 'camera',
        face_count INTEGER DEFAULT 0,
        skin_pixels INTEGER DEFAULT 0,
        flagged INTEGER DEFAULT 0,
        detection_data TEXT,
        captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE
      );
    `);

      await db.execute(`
        CREATE TABLE IF NOT EXISTS media_upload_failures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          capture_id TEXT NOT NULL UNIQUE,
          session_id INTEGER NOT NULL,
          capture_type TEXT NOT NULL CHECK(capture_type IN ('camera','screen','audio')),
          message TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          resolved_at DATETIME,
          FOREIGN KEY(session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE
        );
      `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS question_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        activity_type TEXT NOT NULL,
        question_number INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS feedbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        professor_id INTEGER NOT NULL,
        recipient_admin_id INTEGER REFERENCES users(id),
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
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_media_failures_session ON media_upload_failures(session_id, resolved_at);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_question_activity_session ON question_activity(session_id);`);

    // Migration: add email column to users if it doesn't exist
    try {
      await db.execute(`ALTER TABLE users ADD COLUMN email TEXT`);
    } catch (e) {
      // Column already exists, ignore error
    }

    try {
      await db.execute(`ALTER TABLE instructors ADD COLUMN email TEXT`);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }

    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_instructors_email ON instructors(lower(trim(email))) WHERE email IS NOT NULL AND trim(email) <> '';`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_password_reset_codes_instructor_created ON password_reset_codes(instructor_id, created_at);`);
    try {
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_password_reset_codes_admin_created ON password_reset_codes(admin_id, created_at);`);
    } catch (e) {
      // Older databases where the admin_id migration could not run yet.
      if (!/no such column/i.test(e.message)) throw e;
      console.warn('Skipped admin reset-code index (admin_id column not present yet):', e.message);
    }

    try {
      await db.execute(`ALTER TABLE feedbacks ADD COLUMN recipient_admin_id INTEGER REFERENCES users(id)`);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }

    await db.execute(`CREATE INDEX IF NOT EXISTS idx_feedbacks_recipient ON feedbacks(recipient_admin_id);`);

    try {
      await db.execute(`ALTER TABLE camera_captures ADD COLUMN detection_data TEXT`);
    } catch (e) {
      // Column already exists, ignore error
    }

    try {
      await db.execute(`ALTER TABLE camera_captures ADD COLUMN capture_trigger TEXT DEFAULT 'manual'`);
    } catch (e) {
      // Column already exists, ignore error
    }

    for (const [column, definition] of [
      ['media_data', 'BLOB'],
      ['capture_id', 'TEXT'],
      ['file_size', 'INTEGER'],
      ['mime_type', 'TEXT'],
      ['metadata_json', 'TEXT']
    ]) {
      try {
        await db.execute(`ALTER TABLE camera_captures ADD COLUMN ${column} ${definition}`);
      } catch (e) {
        if (!/duplicate column name/i.test(e.message)) throw e;
      }
    }

    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_camera_captures_capture_id ON camera_captures(capture_id);`);

    // How the switch was detected: 'tab-switch' (exam tab hidden / blurred) or
    // 'alt-tab' (OS window switch while the exam tab stayed visible).
    try {
      await db.execute(`ALTER TABLE tab_switches ADD COLUMN switch_source TEXT DEFAULT 'tab-switch'`);
    } catch (e) {
      // Column already exists, ignore error
    }

    try {
      await db.execute(`ALTER TABLE exams ADD COLUMN live_started_at DATETIME`);
    } catch (e) {
      // Column already exists, ignore error
    }

    // When the exam was last scheduled / published. Exams used to start their
    // countdown here, which silently ate the minutes between publish and go-live.
    try {
      await db.execute(`ALTER TABLE exams ADD COLUMN published_at DATETIME`);
    } catch (e) {
      // Column already exists, ignore error
    }

    try {
      await db.execute(`ALTER TABLE exams ADD COLUMN year_level TEXT`);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }

    // Sections store their year level so the instructor picker can label them
    try {
      await db.execute(`ALTER TABLE sections ADD COLUMN year_level TEXT`);
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e;
    }

    // Prevent duplicate sections (same name + course) at the database level
    try {
      await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_name_course ON sections(name, course);`);
    } catch (e) {
      console.warn('⚠️ Section uniqueness index skipped — duplicate sections may still exist:', e.message);
    }

    console.log("✅ Turso cloud tables are ready and synced!");
  } catch (error) {
    console.error("❌ Failed to initialize database schema:", error);
  }
}

// Run the schema setup immediately on application boot
export const schemaReady = setupDatabaseSchema();