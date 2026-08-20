const path = require('path');
try {
  const Database = require('better-sqlite3');
  const dbPath = path.join(__dirname, '..', 'wams.db');
  const db = new Database(dbPath, { readonly: true });

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('tables:', JSON.stringify(tables, null, 2));

  // Show schema for key tables and sample rows (generic columns)
  const showTable = (table) => {
    try {
      const schema = db.prepare(`PRAGMA table_info('${table}')`).all();
      console.log(`\nschema:${table}:`, JSON.stringify(schema, null, 2));
      const rows = db.prepare(`SELECT * FROM ${table} LIMIT 5`).all();
      console.log(`${table} rows:`, JSON.stringify(rows, null, 2));
    } catch (e) {
      console.log(`skipping ${table}:`, e.message);
    }
  }

  ['exams','students','exam_sessions','users','tab_switches','camera_captures','question_activity'].forEach(showTable);

  db.close();
} catch (err) {
  console.error('ERROR', err && err.message ? err.message : err);
  process.exit(1);
}
