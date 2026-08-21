export default async function run(page, ui) {
  // Login as professor
  await page.fill('#profEmail', 'FAC-2026-01');
  await page.fill('#profPassword', 'PROF-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/wams-professor-dashboard.html', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // Navigate to My Exams
  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-my-exam.html');
  await page.waitForTimeout(2000);

  const result = await page.evaluate(async () => {
    const tbody = document.getElementById('examTbody');
    const rows = tbody ? tbody.querySelectorAll('tr') : [];
    const rowData = Array.from(rows).map(r => r.innerText);
    const counts = {
      all: document.getElementById('cntAll')?.textContent,
      live: document.getElementById('cntLive')?.textContent,
      upcoming: document.getElementById('cntUpcoming')?.textContent,
      scheduled: document.getElementById('cntScheduled')?.textContent,
      ended: document.getElementById('cntEnded')?.textContent
    };
    return { rowCount: rows.length, rowData, counts };
  });

  return result;
}
