const BASE = 'http://localhost:3000';
export default async function run(page) {
  // login admin
  await page.goto(BASE + '/WAMS/admin/wams-admin-log-in.html');
  await page.fill('#signinUsername', 'admin');
  await page.fill('#signinPassword', 'admin123');
  await page.click('button[type=submit]');
  await page.waitForTimeout(2000);

  const out = {};
  // dashboard re-check
  await page.goto(BASE + '/WAMS/admin/wams-admin-dashboard.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  out.banner = await page.evaluate(() => document.getElementById('alertEl')?.innerText || 'missing');
  out.chartTitle = await page.evaluate(() => document.querySelector('.ct')?.textContent);
  out.chartLabels = await page.evaluate(() => { try { return window.Chart ? 'chart-exists' : 'none'; } catch { return '?'; } });
  await page.screenshot({ path: 'shots/fix_dashboard.png', fullPage: true });

  // instructor mgmt
  await page.goto(BASE + '/WAMS/admin/wams-admin-instructor-management.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  out.deptCard = await page.evaluate(() => document.querySelector('.stat-dl.nt')?.textContent);
  await page.screenshot({ path: 'shots/fix_instructor.png', fullPage: true });

  // monitoring logs (the dashboard alert links to professor page)
  const resp = await page.goto(BASE + '/WAMS/professor/wams-professor-monitoring-logs.html', { waitUntil: 'networkidle' }).catch(e => null);
  await page.waitForTimeout(2000);
  out.logsHttp = resp ? resp.status() : 'fail';
  out.logsChars = await page.evaluate(() => document.body.innerText.length);
  out.logsUrl = page.url();
  await page.screenshot({ path: 'shots/fix_logs.png', fullPage: true });
  return out;
}
