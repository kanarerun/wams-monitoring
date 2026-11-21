// Review WAMS UI pages for excessive/cluttered content and nonsensical graph data.
const BASE = 'http://localhost:3000';
const out = {};

async function loginAdmin(page) {
  await page.goto(BASE + '/WAMS/admin/wams-admin-log-in.html');
  await page.fill('#signinUsername', 'admin');
  await page.fill('#signinPassword', 'admin123');
  await page.click('button[type=submit]');
  await page.waitForTimeout(2500);
}

export default async function run(page) {
  await loginAdmin(page);
  const pages = [
    '/WAMS/admin/wams-admin-dashboard.html',
    '/WAMS/admin/wams-admin-student-management.html',
    '/WAMS/admin/wams-admin-instructor-management.html',
    '/WAMS/admin/wams-admin-admin-list.html',
    '/WAMS/admin/wams-admin-feedbacks.html',
    '/WAMS/admin/wams-admin-monitoring-logs.html',
    '/WAMS/professor/wams-professor-log-in.html',
    '/index.html',
  ];
  for (const p of pages) {
    const r = { status: '' };
    try {
      const resp = await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 20000 }).catch(e => null);
      r.http = resp ? resp.status() : 'nav-fail';
      await page.waitForTimeout(1200);
      const info = await page.evaluate(() => {
        const texts = [...document.querySelectorAll('h1,h2,h3,h4,p,span,label,td,th,button')]
          .map(e => e.textContent.trim()).filter(t => t && t.length > 0);
        const long = texts.filter(t => t.length > 120);
        const dup = {};
        texts.forEach(t => { dup[t] = (dup[t] || 0) + 1; });
        const dups = Object.entries(dup).filter(([t, n]) => n > 4 && t.length > 5).map(([t, n]) => ({ text: t.slice(0, 60), count: n }));
        const charts = [...document.querySelectorAll('canvas')].length;
        const tables = [...document.querySelectorAll('table')].map(t => ({ rows: t.rows.length, cols: t.rows[0]?.cells.length || 0 }));
        return { bodyChars: document.body.innerText.length, nodeCount: document.querySelectorAll('*').length, longTexts: long.slice(0, 5), duplicated: dups.slice(0, 5), charts, tables, headingSample: texts.slice(0, 12) };
      });
      Object.assign(r, info);
      await page.screenshot({ path: 'shots/' + p.replace(/[^a-z0-9]+/gi, '_') + '.png', fullPage: true }).catch(() => { });
    } catch (e) { r.status = 'ERR: ' + e.message.slice(0, 120); }
    out[p] = r;
  }
  return out;
}
