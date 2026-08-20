export default async function run(page, ui) {
  // Login as admin
  await page.goto('http://localhost:3000/WAMS/admin/wams-admin-log-in.html');
  await page.fill('#signinUsername', 'admin');
  await page.fill('#signinPassword', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/wams-admin-dashboard.html', { timeout: 10000 });

  await page.goto('http://localhost:3000/WAMS/admin/wams-admin-user-profile.html');
  await page.waitForSelector('#profileNameInput', { timeout: 10000 });

  const overflowInfo = await page.evaluate(() => {
    const docW = window.innerWidth;
    const overflowing = [];
    document.querySelectorAll('*').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.right > docW + 1) {
        overflowing.push({
          tag: el.tagName,
          id: el.id,
          className: el.className,
          right: rect.right,
          docW
        });
      }
    });
    return { docW, overflowing };
  });

  return overflowInfo;
}
