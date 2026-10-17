/* Verifies the correlated Year Level / Section multi-selects on the
   admin student management modal.

   The page's own auth guard bounces a fresh browser to the login screen
   (pre-existing race: loadStudents() runs before verifyAdminAuth() resolves),
   so this drives the module's picker logic directly with stubbed data.

   Run: node <browser-automation>/browser.mjs \
        http://localhost:3000/WAMS/admin/wams-admin-student-management.html \
        --script ./tests/qa-student-pickers.mjs
*/
export default async function run(page) {
  // Shim fetch so the page's init calls resolve instead of 401-ing and
  // redirecting, and serve deterministic section data.
  await page.addInitScript(() => {
    const SECTIONS = [
      { id: 1, name: 'BSIT - 1', course: 'BS Information Technology' },
      { id: 2, name: 'BSIT - 2', course: 'BS Information Technology' },
      { id: 3, name: 'BSIT - 3', course: 'BS Information Technology' },
      { id: 4, name: 'BSOA - 1', course: 'BS Office Administration' }
    ];
    window.__SECTIONS = SECTIONS;
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const target = String(url);
      const json = (body) => new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
      if (target.includes('/api/me')) {
        return json({ id: 1, name: 'QA Admin', role: 'admin', username: 'admin' });
      }
      if (target.includes('/api/sections')) return json(SECTIONS);
      if (target.includes('/api/students')) return json([]);
      return realFetch(url, opts);
    };
    localStorage.setItem('adminToken', 'qa-token');
  });

  // addInitScript only applies to navigations AFTER it is registered, and the
  // runner already navigated once. Reload so the shim is in place first.
  await page.goto(page.url());
  await page.waitForTimeout(1500);

  const boot = await page.evaluate(() => ({
    url: location.href,
    hasOpenModal: typeof window.openModal === 'function',
    hasCreateMulti: typeof window.createMultiSelect,
    sectionCount: (window.allSections || []).length
  }));
  if (boot.hasOpenModal !== 'function') return { step: 'page not ready', boot };

  // Open the Add Student modal and type a course with two sections.
  await page.evaluate(() => {
    openModal();
    document.getElementById('courseInput').value = 'BS Information Technology';
    refreshYearPicker();
  });
  await page.waitForTimeout(300);

  const yearsOffered = await page.evaluate(() => ({
    options: [...document.querySelectorAll('#yearMultiselect .ms-opt')].map(o => o.textContent.trim()),
    toggle: document.querySelector('#yearMultiselect .ms-toggle .ms-text').textContent,
    hasPanel: !!document.querySelector('#yearMultiselect .ms-panel')
  }));

  // Pick the FIRST year level (1st Year) -> sections must show BSIT - 1/2 only.
  await page.click('#yearMultiselect .ms-opt');
  await page.waitForTimeout(300);

  const afterFirstYear = await page.evaluate(() => ({
    yearChecked: [...document.querySelectorAll('#yearMultiselect .ms-opt.checked')].map(o => o.textContent.trim()),
    sectionOptions: [...document.querySelectorAll('#sectionMultiselect .ms-opt')].map(o => o.textContent.trim()),
    sectionChecked: [...document.querySelectorAll('#sectionMultiselect .ms-opt.checked')].map(o => o.textContent.trim()),
    sectionToggle: document.querySelector('#sectionMultiselect .ms-toggle .ms-text').textContent
  }));

  // Pick the SECOND year level too -> BSIT - 3 joins the list (multi-select).
  await page.evaluate(() => {
    document.querySelectorAll('#yearMultiselect .ms-opt')[1].click();
  });
  await page.waitForTimeout(300);

  const afterSecondYear = await page.evaluate(() => ({
    yearChecked: [...document.querySelectorAll('#yearMultiselect .ms-opt.checked')].map(o => o.textContent.trim()),
    sectionOptions: [...document.querySelectorAll('#sectionMultiselect .ms-opt')].map(o => o.textContent.trim()),
    sectionToggle: document.querySelector('#sectionMultiselect .ms-toggle .ms-text').textContent
  }));

  // Select multiple sections and confirm the picker holds them all.
  await page.evaluate(() => {
    [...document.querySelectorAll('#sectionMultiselect .ms-opt')]
      .forEach(o => { if (!o.classList.contains('checked')) o.click(); });
  });
  await page.waitForTimeout(300);

  const multiPick = await page.evaluate(() => ({
    picked: sectionMs.getValues().map(Number),
    labels: sectionMs.getLabels(),
    toggle: document.querySelector('#sectionMultiselect .ms-toggle .ms-text').textContent
  }));

  // Single-section course must auto-default to that one section.
  await page.evaluate(() => {
    yearMs.clear();
    document.getElementById('courseInput').value = 'BS Office Administration';
    refreshYearPicker();
  });
  await page.waitForTimeout(300);
  await page.click('#yearMultiselect .ms-opt');
  await page.waitForTimeout(400);

  const singleSectionDefault = await page.evaluate(() => ({
    sectionOptions: [...document.querySelectorAll('#sectionMultiselect .ms-opt')].map(o => o.textContent.trim()),
    sectionChecked: [...document.querySelectorAll('#sectionMultiselect .ms-opt.checked')].map(o => o.textContent.trim()),
    autoPicked: sectionMs.getValues().map(Number),
    toggle: document.querySelector('#sectionMultiselect .ms-toggle .ms-text').textContent
  }));

  return {
    boot, yearsOffered, afterFirstYear, afterSecondYear, multiPick, singleSectionDefault
  };
}
