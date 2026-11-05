import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const stylesheetPaths = [
  'WAMS/admin/wams-admin-feedbacks.css',
  'WAMS/admin/wams-admin-instructor-management.css',
  'WAMS/admin/wams-admin-log-in.css',
  'WAMS/admin/wams-admin-student-management.css',
  'WAMS/admin/wams-admin-user-profile.css',
  'WAMS/professor/wams-professor-create-exam.css',
  'WAMS/professor/wams-professor-feedback.css',
  'WAMS/professor/wams-professor-my-exam.css'
];

test('form dropdowns and department filters use the shared muted border', () => {
  for(const path of stylesheetPaths){
    const css = fs.readFileSync(path, 'utf8');
    if(css.includes('.field select{')){
      assert.match(css, /\.field select\{[^}]*border-color:var\(--border2\)/, path);
      assert.match(css, /\.field select:focus\{[^}]*border-color:var\(--border2\)/, path);
    } else {
      assert.match(css, /\.input-wrap select\{[^}]*border-color:var\(--border2\)/, path);
      assert.match(css, /\.input-wrap select:focus\{outline:none;border-color:var\(--border2\)/, path);
    }
    if(css.includes('.dept-filter{')){
      assert.match(css, /\.dept-filter\{[^}]*border:1px solid var\(--border2\)/, path);
    }
    if(css.includes('.qtype-select{')){
      assert.match(css, /\.qtype-select:focus\{outline:none;border-color:var\(--border2\)\}/, path);
    }
    if(css.includes('.bdg-select{')){
      assert.match(css, /\.bdg-select\{[^}]*border:1px solid var\(--border2\)/, path);
    }
  }
});

test('exam answer dropdown and media setup selectors use the shared muted border', () => {
  const examCss = fs.readFileSync('WAMS/student/wams-student-exam-tool.css', 'utf8');
  const examJs = fs.readFileSync('WAMS/student/wams-student-exam-tool.js', 'utf8');
  const consentCss = fs.readFileSync('WAMS/student/wams-media-consent.css', 'utf8');

  assert.match(examCss, /select\.short-answer-input\{border-color:var\(--border2\)\}/);
  assert.match(examCss, /select\.short-answer-input:focus\{border-color:var\(--border2\)\}/);
  assert.match(examJs, /<select class="short-answer-input exam-answer-select"/);
  assert.match(examCss, /select\.exam-answer-select\{[^}]*border:1px solid var\(--border2\)/);
  assert.match(consentCss, /\.media-consent-device-actions select\{[^}]*border:1px solid var\(--border2\)/);
  assert.match(consentCss, /\.media-consent-permission-button\{[^}]*border:1px solid var\(--border2\)/);
});

test('all native dropdown pages load one shared rounded, flush option-picker style', () => {
  const checkPages = directory => {
    for(const entry of fs.readdirSync(directory, { withFileTypes: true })){
      const path = `${directory}/${entry.name}`;
      if(entry.isDirectory()){
        checkPages(path);
      } else if(entry.isFile() && entry.name.endsWith('.html')){
        const html = fs.readFileSync(path, 'utf8');
        if(/<select\b/i.test(html)){
          assert.match(html, /href="\.\.\/wams-select-dropdowns\.css"/, path);
        }
      }
    }
  };
  checkPages('WAMS');

  const css = fs.readFileSync('WAMS/wams-select-dropdowns.css', 'utf8');
  assert.match(css, /@supports \(appearance:base-select\)/);
  assert.match(css, /select,\s*select::picker\(select\)\{appearance:base-select\}/);
  assert.match(css, /select:open\{\s*border-bottom-left-radius:0;\s*border-bottom-right-radius:0;/);
  assert.match(css, /select::picker\(select\)\{[^}]*margin-block-start:-1px[^}]*border:1px solid var\(--border2\);\s*border-top:0;\s*border-radius:0 0 8px 8px/s);
  assert.match(css, /select option\{[^}]*border-radius:5px/);
  assert.match(css, /select option:hover,[\s\S]*?select option:focus\{[^}]*background:var\(--surface2\)/);
  assert.match(css, /select option:checked\{[^}]*background:var\(--surface2\)/);
});

test('admin custom dropdowns connect their option panels and share muted borders', () => {
  for(const path of [
    'WAMS/admin/wams-admin-student-management.css',
    'WAMS/admin/wams-admin-instructor-management.css'
  ]){
    const css = fs.readFileSync(path, 'utf8');
    assert.match(css, /\.ms-toggle\{[^}]*border:1px solid var\(--border2\)/, path);
    assert.match(css, /\.ms\.open \.ms-toggle\{border-bottom-left-radius:0;border-bottom-right-radius:0\}/, path);
    assert.match(css, /\.ms-panel\{[^}]*top:calc\(100% - 1px\)[^}]*border:1px solid var\(--border2\);border-radius:0 0 8px 8px/, path);
    assert.match(css, /\.ms-box\{[^}]*border:1\.5px solid var\(--border2\)/, path);
  }
});
