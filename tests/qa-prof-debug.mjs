export default async function run(page, ui) {
  // Navigate to professor login page
  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-log-in.html');
  await page.waitForTimeout(1000);

  // Login as professor
  await page.fill('#profEmail', 'FAC-2026-01');
  await page.fill('#profPassword', 'PROF-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/wams-professor-dashboard.html', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // Navigate to My Exams
  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-my-exam.html');
  await page.waitForTimeout(3000);

  const result = await page.evaluate(async () => {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    let apiResult = null;
    try {
      const res = await fetch('/api/my-exams', { headers: { 'Authorization': 'Bearer ' + token } });
      apiResult = { ok: res.ok, status: res.status, body: await res.text() };
    } catch (e) {
      apiResult = { error: e.message };
    }
    return {
      tokenPresent: !!token,
      apiResult,
      examData: typeof examData !== 'undefined' ? examData : 'undefined',
      tbodyHtml: document.getElementById('examTbody')?.innerHTML?.substring(0, 500)
    };
  });

  return result;
}
