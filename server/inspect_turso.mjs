// Quick inspection of the live Turso database
import { db } from '../db.js';

const rows = async (sql, args = []) => (await db.execute({ sql, args })).rows;

console.log('=== SECTIONS ===');
console.table(await rows('SELECT * FROM sections ORDER BY id'));

console.log('=== STUDENTS ===');
console.table(await rows(`
  SELECT s.id, s.student_id, s.section_id, sec.name AS section_name, sec.course, u.name AS user_name
  FROM students s
  JOIN users u ON s.user_id = u.id
  JOIN sections sec ON s.section_id = sec.id
  ORDER BY s.id
`));

console.log('=== EXAMS ===');
console.table(await rows(`
  SELECT e.id, e.title, e.section_id, sec.name AS section_name, e.status, e.access_code, e.professor_id
  FROM exams e
  JOIN sections sec ON e.section_id = sec.id
  ORDER BY e.id
`));

console.log('=== INSTRUCTORS ===');
console.table(await rows(`
  SELECT i.id, i.faculty_id, i.user_id, u.name, i.department
  FROM instructors i JOIN users u ON i.user_id = u.id
  ORDER BY i.id
`));

process.exit(0);