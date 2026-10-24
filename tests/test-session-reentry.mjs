// End-to-end check: re-entering the same exam must reuse the session row.
//
//   node tests/test-session-reentry.mjs                 (starts its own server)
//   BASE_URL=https://... node tests/test-session-reentry.mjs
//
// Seeds a throwaway student/exam in the configured Turso DB and removes them
// afterwards, so it is safe to run against a scratch database.
import { createClient } from '@libsql/client';
import 'dotenv/config';
import { spawn } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
let server = null;
if (!process.env.BASE_URL) {
  server = spawn(process.execPath, ['server/index.js'], { stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { up = (await fetch(BASE + '/')).ok; } catch (e) {}
    if (!up) await new Promise(r => setTimeout(r, 500));
  }
  if (!up) { console.log('FAIL - server did not start'); server.kill(); process.exit(1); }
}
const shutdown = code => { if (server) server.kill(); process.exit(code); };
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const stamp = Date.now().toString().slice(-6);
const code = 'RT' + stamp;
const q = s => "'" + String(s).replace(/'/g, "''") + "'";

const userId = Number((await db.execute({
  sql: 'INSERT INTO users (role, name, username) VALUES (' + q('student') + ', ' + q('Reentry ' + stamp) + ', ' + q('rt' + stamp) + ')',
  args: []
})).lastInsertRowid);

const studentId = Number((await db.execute({
  sql: 'INSERT INTO students (user_id, student_id, section_id, year_level, access_code, status) VALUES (' +
       [userId, q(code), 35, q('1st Year'), q(code), q('active')].join(', ') + ')',
  args: []
})).lastInsertRowid);

const questions = JSON.stringify([{ type: 'sa', text: 'Q1', points: 1 }, { type: 'sa', text: 'Q2', points: 1 }]);
const examId = Number((await db.execute({
  sql: 'INSERT INTO exams (professor_id, title, section_id, year_level, schedule, type, time_limit, link, questions, access_code, status, live_started_at) VALUES (' +
       [1, q('Reentry Test ' + stamp), 35, q('1st Year'), q(new Date().toISOString()),
        q('wams-quiz'), 30, q(''), q(questions), q(code), q('live'), q(new Date().toISOString())].join(', ') + ')',
  args: []
})).lastInsertRowid);

console.log('seeded student', studentId, 'exam', examId);

async function login() {
  const res = await fetch(BASE + '/api/auth/student-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ student_id: code, access_code: code })
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let pass = true;
try {
  const first = await login();
  const second = await login();
  const s1 = first.body && first.body.exam && first.body.exam.session_id;
  const s2 = second.body && second.body.exam && second.body.exam.session_id;
  console.log('login #1:', first.status, JSON.stringify(first.body && (first.body.error || { session: s1, resumed: first.body.resumed })));
  console.log('login #2:', second.status, JSON.stringify(second.body && (second.body.error || { session: s2, resumed: second.body.resumed })));

  if (!s1 || s1 !== s2) { console.log('FAIL - session stacked (' + s1 + ' vs ' + s2 + ')'); pass = false; }
  if (!(second.body && second.body.resumed === true)) { console.log('FAIL - second login not marked resumed'); pass = false; }

  const rows = await db.execute({ sql: 'SELECT id FROM exam_sessions WHERE exam_id = ' + Number(examId), args: [] });
  console.log('session rows for exam:', rows.rows.length);
  if (rows.rows.length !== 1) { console.log('FAIL - expected exactly 1 session row'); pass = false; }

  if (second.body && second.body.token) {
    const res = await fetch(BASE + '/api/sessions/' + s2 + '/answers', {
      headers: { Authorization: 'Bearer ' + second.body.token }
    });
    console.log('answers endpoint:', res.status, (await res.text()).slice(0, 120));
    if (res.status !== 200) pass = false;
  }

  // Once submitted, re-entry must be refused (not silently continue).
  await db.execute({
    sql: 'UPDATE exam_sessions SET submitted_at = CURRENT_TIMESTAMP WHERE id = ' + Number(s2),
    args: []
  });
  const third = await login();
  console.log('login after submit:', third.status, JSON.stringify(third.body && (third.body.error || third.body.status)));
  if (third.status !== 401 || !(third.body && third.body.status === 'submitted')) {
    console.log('FAIL - a submitted exam allowed re-entry');
    pass = false;
  }
  const rowsAfter = await db.execute({ sql: 'SELECT id FROM exam_sessions WHERE exam_id = ' + Number(examId), args: [] });
  if (rowsAfter.rows.length !== 1) { console.log('FAIL - submit path created another session'); pass = false; }
} finally {
  await db.execute({ sql: 'DELETE FROM exam_sessions WHERE exam_id = ' + Number(examId), args: [] });
  await db.execute({ sql: 'DELETE FROM exams WHERE id = ' + Number(examId), args: [] });
  await db.execute({ sql: 'DELETE FROM students WHERE id = ' + Number(studentId), args: [] });
  await db.execute({ sql: 'DELETE FROM users WHERE id = ' + Number(userId), args: [] });
  console.log('cleaned up');
}

console.log(pass ? 'PASS - re-entry reuses the same session (one row only)' : 'FAILED');
shutdown(pass ? 0 : 1);
