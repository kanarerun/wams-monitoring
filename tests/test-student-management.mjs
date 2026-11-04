export default async function run(page, ui) {
  // Login as admin
  await page.fill('#signinUsername', 'admin');
  await page.fill('#signinPassword', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/wams-admin-dashboard.html', { timeout: 10000 });

  // Navigate to Student Management
  await page.goto('http://localhost:3000/WAMS/admin/wams-admin-student-management.html');
  await page.waitForSelector('#deptTables', { timeout: 10000 });

  // Check table headers
  const ths = await page.$$eval('.tbl th', els => els.map(e => e.textContent.trim()));
  const hasAccessCodeHeader = ths.includes('Access Code');
  const studentIdsNumericallySorted = await page.$$eval('.tbl tbody', bodies =>
    bodies.every(body => {
      const ids = Array.from(body.querySelectorAll('.code-chip'), chip => chip.textContent.trim());
      const expected = ids.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      return ids.every((id, index) => id === expected[index]);
    })
  );
  if (!studentIdsNumericallySorted) {
    throw new Error('Student IDs are not in natural numeric order.');
  }

  // Open Add Student Modal
  await page.click('button.btn-primary');
  await page.waitForSelector('#modalOverlay.show');

  // Check modal inputs
  const codeInputExists = await page.$('#codeInput');

  return {
    headers: ths.slice(0, 5),
    hasAccessCodeHeader,
    studentIdsNumericallySorted,
    codeInputInModal: !!codeInputExists
  };
}
