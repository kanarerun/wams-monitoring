export default async function run(page, ui) {
  // Navigate to professor login
  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-log-in.html');
  await page.waitForTimeout(1000);

  // Login as professor (FAC-2026-455)
  await page.fill('#profEmail', 'FAC-2026-455');
  await page.fill('#profPassword', 'R38U-RTZK');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/wams-professor-dashboard.html', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // Navigate to Monitoring Logs
  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-monitoring-logs.html');
  await page.waitForTimeout(4000);

  const result = await page.evaluate(() => {
    const grid = document.getElementById('examGrid');
    return {
      gridHtml: grid ? grid.innerHTML.substring(0, 600) : 'NO GRID',
      hasExamCard: grid ? grid.innerHTML.includes('exam-card') : false,
      hasTstTitle: grid ? grid.innerHTML.includes('tst') : false,
      consoleErrors: window.__errors || []
    };
  });

  return result;
}