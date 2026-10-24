// Guards the student exam pages against the failure where a helper used at
// startup is missing (the question area renders blank / goes empty).
//
//   node tests/test-exam-script-stack.mjs            (against the local server)
//   BASE_URL=https://wams-76xp.onrender.com node tests/test-exam-script-stack.mjs
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const runner = 'C:/Users/Khelvin/.codegpt/skills/browser-automation/browser.mjs';

const script = `
export default async function run(page) {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('${BASE}/WAMS/student/_script-stack-check.html', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const html = await page.content();
  const m = html.match(/<pre id="result">([\\s\\S]*?)<\\/pre>/);
  return { errors, result: m ? m[1] : 'missing' };
}
`;

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'wams-stack-'));
const harnessScript = join(dir, 'run.mjs');
writeFileSync(harnessScript, script);

const raw = execFileSync(process.execPath, [runner, `${BASE}/WAMS/student/_script-stack-check.html`, '--script', harnessScript], { encoding: 'utf8' });
const match = raw.match(/"result":\s*"(\{[\s\S]*?\})"/) || raw.match(/\{"missing"[\s\S]*?\}/);
const parsed = match ? JSON.parse(match[1].replace(/\\"/g, '"')) : null;

if (!parsed) {
  console.error('Could not read the check result:\n' + raw);
  process.exit(1);
}
if (parsed.missing.length || parsed.initError) {
  console.error('FAIL — missing:', parsed.missing, 'initError:', parsed.initError);
  process.exit(1);
}
console.log('PASS — all exam-page helpers present, startup path runs.');
