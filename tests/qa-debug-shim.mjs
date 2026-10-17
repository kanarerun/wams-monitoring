export default async function run(page) {
  const login = await page.evaluate(async () => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    return await res.json();
  });
  if (!login.token) return { step: 'login failed', login };

  // Seed the token, then reload so the guards read it on a fresh document.
  await page.evaluate((t) => localStorage.setItem('adminToken', t), login.token);
  await page.goto('http://localhost:3000/WAMS/admin/wams-admin-student-management.html');
  await page.waitForTimeout(3000);

  return await page.evaluate(() => ({
    url: location.href,
    token: (localStorage.getItem('adminToken') || '').slice(0, 12),
    hasOpenModal: typeof window.openModal,
    hasCreateMulti: typeof window.createMultiSelect,
    sectionCount: (window.allSections || []).length,
    yearHost: !!document.getElementById('yearMultiselect')
  }));
}
