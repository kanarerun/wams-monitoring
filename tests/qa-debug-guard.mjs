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

  const probe = await page.evaluate(async (token) => {
    const res = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
    return { status: res.status, body: await res.text() };
  }, login.token);

  await page.addInitScript((token) => {
    localStorage.setItem('adminToken', token);
    window.__initTokenSeen = localStorage.getItem('adminToken');
    localStorage.setItem('adminName', 'QA Admin');
  }, login.token);
  await page.goto(page.url());
  await page.waitForTimeout(2500);

  const initSeen = await page.evaluate(() => window.__initTokenSeen || null);

  const after = await page.evaluate(() => ({
    url: location.href,
    token: (localStorage.getItem('adminToken') || '').slice(0, 20),
    hasOpenModal: typeof window.openModal,
    hasCreateMulti: typeof window.createMultiSelect,
    yearHost: !!document.getElementById('yearMultiselect')
  }));

  return { probe, initSeen, after };
}
