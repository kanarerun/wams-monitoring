export default async function run(page, ui) {
  // Login as admin
  await page.fill('#signinUsername', 'admin');
  await page.fill('#signinPassword', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/wams-admin-dashboard.html', { timeout: 10000 });

  // Navigate to Student Management
  await page.goto('http://localhost:3000/WAMS/admin/wams-admin-student-management.html');
  await page.waitForSelector('#deptTables table.tbl', { timeout: 10000 });

  const alignmentData = await page.evaluate(() => {
    const tables = document.querySelectorAll('#deptTables table.tbl');
    const results = [];
    tables.forEach((tbl, idx) => {
      const ths = Array.from(tbl.querySelectorAll('thead th')).map(th => ({
        text: th.textContent.trim(),
        widthStyle: th.style.width,
        renderedWidth: Math.round(th.getBoundingClientRect().width),
        left: Math.round(th.getBoundingClientRect().left)
      }));
      results.push({ tableIndex: idx, columns: ths });
    });
    return results;
  });

  return alignmentData;
}
