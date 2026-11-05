import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scriptPaths = [
  'WAMS/student/wams-student-log-in.js',
  'WAMS/professor/wams-professor-log-in.js',
  'WAMS/admin/wams-admin-instructor-management.js'
];

function loadTrimHelper(path){
  const source = fs.readFileSync(path, 'utf8');
  const helper = source.match(/function trimAccessCodeInput\(input\)\{[\s\S]*?\r?\n\}/);
  assert.ok(helper, `${path} should trim access code input`);
  const context = vm.createContext({});
  vm.runInContext(`${helper[0]}; globalThis.trim = trimAccessCodeInput;`, context);
  return context.trim;
}

for(const path of scriptPaths){
  test(`${path} trims pasted leading/trailing whitespace only`, () => {
    const trimAccessCodeInput = loadTrimHelper(path);
    const input = {
      value: ' \tEXAM-2026 \n',
      selectionStart: 13,
      setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
      }
    };

    trimAccessCodeInput(input);
    assert.equal(input.value, 'EXAM-2026');

    input.value = 'EXAM CODE';
    input.selectionStart = input.value.length;
    trimAccessCodeInput(input);
    assert.equal(input.value, 'EXAM CODE', 'internal spaces remain unchanged');
  });
}

test('access-code fields are text inputs and do not request password generation', () => {
  const htmlPaths = [
    'WAMS/student/wams-student-log-in.html',
    'WAMS/professor/wams-professor-log-in.html',
    'WAMS/admin/wams-admin-instructor-management.html'
  ];

  for(const path of htmlPaths){
    const html = fs.readFileSync(path, 'utf8');
    assert.doesNotMatch(html, /autocomplete=["']new-password["']/i, path);
    const accessCodeInput = html.match(/<input\b[^>]*(?:access_code|Access Code)[^>]*>/i) ||
      html.match(/<input\b[^>]*id=["'](?:studentAccessCode|profAccessCode|codeInput)["'][^>]*>/i);
    assert.ok(accessCodeInput, `${path} should include an access-code input`);
    assert.match(accessCodeInput[0], /type=["']text["']/i, path);
    assert.match(accessCodeInput[0], /autocomplete=["']off["']/i, path);
  }
});
