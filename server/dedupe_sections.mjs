// One-time cleanup: merge duplicate sections (same name + course) into a single row.
// Moves students/exams/enrollments references to the kept section, then deletes duplicates.
import { db } from '../db.js';

const rows = async (sql, args = []) => (await db.execute({ sql, args })).rows;

const dupGroups = await rows(`
  SELECT name, course, COUNT(*) AS c, MIN(id) AS keepId
  FROM sections
  GROUP BY name, course
  HAVING c > 1
`);

if (dupGroups.length === 0) {
  console.log('✅ No duplicate sections found.');
} else {
  for (const g of dupGroups) {
    const dupes = await rows(
      'SELECT id FROM sections WHERE name = ? AND course = ? AND id != ?',
      [g.name, g.course, g.keepId]
    );

    for (const d of dupes) {
      // Move all references onto the kept section
      await db.execute({ sql: 'UPDATE students SET section_id = ? WHERE section_id = ?', args: [g.keepId, d.id] });
      await db.execute({ sql: 'UPDATE exams SET section_id = ? WHERE section_id = ?', args: [g.keepId, d.id] });
      await db.execute({
        sql: `DELETE FROM exam_enrollments WHERE student_id IN (SELECT id FROM students WHERE section_id = ?)
              AND exam_id NOT IN (SELECT id FROM exams WHERE section_id = ?)`,
        args: [d.id, g.keepId]
      });
      await db.execute({ sql: 'DELETE FROM sections WHERE id = ?', args: [d.id] });
      console.log(`🔁 Merged section #${d.id} into #${g.keepId} ("${g.name}" / "${g.course}")`);
    }
  }
}

// Now that data is clean, enforce uniqueness at the DB level
try {
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_name_course ON sections(name, course);`);
  console.log('🔒 Unique index on sections(name, course) is active.');
} catch (e) {
  console.warn('⚠️ Could not create unique index:', e.message);
}

process.exit(0);