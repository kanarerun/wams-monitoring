gexport default async function run(page, ui) {
  // Login as professor
  await page.waitForTimeout(500);
  await page.fill('#profEmail', 'FAC-2026-01');
  await page.fill('#profPassword', 'PROF-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/wams-professor-dashboard.html', { timeout: 10000 });

  // Navigate to Live Monitor
  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-live-monitor.html');
  await page.waitForSelector('.exam-card', { timeout: 10000 });

  const result = await page.evaluate(async () => {
    try {
      const exams = await getMonitoringExams();
      if (!exams.length) return { error: 'No monitoring exams' };
      await openExam(exams[0].id);
      const sessions = await getExamSessions(exams[0].id);
      if (!sessions.length) return { error: 'No sessions for exam ' + exams[0].id };
      await openStudent(exams[0].id, sessions[0].id);
      return {
        success: true,
        view3: document.getElementById('view3').classList.contains('show'),
        camImages: document.querySelectorAll('#liveCameraShots img').length,
        screenImages: document.querySelectorAll('#liveScreenShots img').length,
        audioItems: document.querySelectorAll('#liveAudioList .audio-item').length
      };
    } catch (err) {
      return { error: err.message, stack: err.stack };
    }
  });

  return result;
}
