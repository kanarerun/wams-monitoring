export default async function run(page, ui) {
  // Login as professor
  await page.fill('#profEmail', 'FAC-2026-01');
  await page.fill('#profPassword', 'PROF-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/wams-professor-dashboard.html', { timeout: 10000 });

  // Navigate to Live Monitor
  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-live-monitor.html');
  await page.waitForSelector('.exam-card', { timeout: 10000 });
  await page.locator('.exam-card').first().click();
  
  await page.waitForSelector('#studentTbody tr', { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.locator('#studentTbody tr').first().click();
  
  await page.waitForSelector('#view3.show', { timeout: 10000 });

  const hasCamImg = await page.$$eval('#liveCameraShots img', els => els.length);
  const hasScreenImg = await page.$$eval('#liveScreenShots img', els => els.length);
  const hasAudioItems = await page.$$eval('#liveAudioList .audio-item', els => els.length);
  const studentName = await page.textContent('#studentName');

  return {
    studentName,
    hasCamImg,
    hasScreenImg,
    hasAudioItems
  };
}
