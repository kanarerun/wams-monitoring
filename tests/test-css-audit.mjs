export default async function run(page, ui) {
  const issues = [];

  // Helper to audit current page DOM
  async function auditCurrentPage(pageName) {
    const data = await page.evaluate((name) => {
      const docW = document.documentElement.clientWidth;
      const scrollW = document.documentElement.scrollWidth;
      const pageEl = document.querySelector('.page') || document.querySelector('.exam-main') || document.body;
      const pageScrollW = pageEl ? pageEl.scrollWidth : 0;
      const pageClientW = pageEl ? pageEl.clientWidth : 0;

      const pageOverflow = pageScrollW > pageClientW + 2;

      // Check tables column count match
      const tableIssues = [];
      document.querySelectorAll('table.tbl').forEach((tbl, idx) => {
        const thCount = tbl.querySelectorAll('thead th').length;
        tbl.querySelectorAll('tbody tr').forEach((tr, rIdx) => {
          const tdCount = tr.querySelectorAll('td').length;
          // Ignore empty state colspan rows
          if (tdCount === 1 && tr.querySelector('td[colspan]')) return;
          if (tdCount !== thCount && thCount > 0) {
            tableIssues.push(`Table #${idx} row #${rIdx} has ${tdCount} cells but header has ${thCount} columns`);
          }
        });
      });

      // Check toolbar button / input vertical alignments
      const toolbarMisaligned = [];
      document.querySelectorAll('.toolbar, .search-wrap, .gen-row, .modal-ft').forEach(container => {
        const style = window.getComputedStyle(container);
        if (style.display === 'flex' && style.alignItems === 'normal') {
          toolbarMisaligned.push('Container has unaligned flex items');
        }
      });

      return {
        pageName: name,
        title: document.title,
        hasHorizontalScroll: scrollW > docW,
        pageOverflow,
        tableIssues,
        toolbarMisaligned
      };
    }, pageName);

    issues.push(data);
  }

  // 1. Landing
  await page.goto('http://localhost:3000/');
  await auditCurrentPage('Landing');

  // 2. Admin Portal
  await page.goto('http://localhost:3000/WAMS/admin/wams-admin-log-in.html');
  await page.fill('#signinUsername', 'admin');
  await page.fill('#signinPassword', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/wams-admin-dashboard.html', { timeout: 10000 });
  await auditCurrentPage('Admin Dashboard');

  await page.goto('http://localhost:3000/WAMS/admin/wams-admin-student-management.html');
  await page.waitForSelector('#deptTables', { timeout: 10000 });
  await auditCurrentPage('Admin Student Management');

  await page.goto('http://localhost:3000/WAMS/admin/wams-admin-instructor-management.html');
  await page.waitForSelector('#deptTables', { timeout: 10000 });
  await auditCurrentPage('Admin Instructor Management');

  await page.goto('http://localhost:3000/WAMS/admin/wams-admin-feedbacks.html');
  await page.waitForSelector('#feedbackList', { timeout: 10000 });
  await auditCurrentPage('Admin Feedbacks');

  await page.goto('http://localhost:3000/WAMS/admin/wams-admin-user-profile.html');
  await page.waitForSelector('#profileNameInput', { timeout: 10000 });
  await auditCurrentPage('Admin User Profile');

  // 3. Professor Portal
  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-log-in.html');
  await page.waitForTimeout(300);
  await page.fill('#profEmail', 'FAC-2026-01');
  await page.fill('#profPassword', 'PROF-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/wams-professor-dashboard.html', { timeout: 10000 });
  await auditCurrentPage('Professor Dashboard');

  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-create-exam.html');
  await page.waitForSelector('#step1', { timeout: 10000 });
  await auditCurrentPage('Professor Create Exam');

  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-my-exam.html');
  await page.waitForSelector('#examTbody', { timeout: 10000 });
  await auditCurrentPage('Professor My Exams');

  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-live-monitor.html');
  await page.waitForSelector('.exam-card', { timeout: 10000 });
  await auditCurrentPage('Professor Live Monitor');

  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-monitoring-logs.html');
  await page.waitForSelector('#examGrid', { timeout: 10000 });
  await auditCurrentPage('Professor Monitoring Logs');

  await page.goto('http://localhost:3000/WAMS/professor/wams-professor-feedback.html');
  await page.waitForSelector('#subject', { timeout: 10000 });
  await auditCurrentPage('Professor Feedback');

  return issues;
}
