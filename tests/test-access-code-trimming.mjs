import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const scriptPaths = [
  'WAMS/student/wams-student-log-in.js'
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

test('student exam access code remains a text field and student login stays unchanged', () => {
  const html = fs.readFileSync('WAMS/student/wams-student-log-in.html', 'utf8');
  const accessCodeInput = html.match(/<input\b[^>]*id=["']studentAccessCode["'][^>]*>/i);
  assert.ok(accessCodeInput);
  assert.match(accessCodeInput[0], /type=["']text["']/i);
  assert.match(accessCodeInput[0], /autocomplete=["']off["']/i);
  assert.doesNotMatch(html, /password reset|forgot password/i);
});

test('professor sign-in uses school email and password with staged reset forms', () => {
  const html = fs.readFileSync('WAMS/professor/wams-professor-log-in.html', 'utf8');
  const inputById = id => html.match(new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`, 'i'));
  const email = inputById('profEmail');
  const password = inputById('profPassword');
  const newPassword = inputById('newPassword');
  assert.ok(email && password && newPassword);
  assert.match(email[0], /type="email"/i);
  assert.match(password[0], /type="password"[^>]*autocomplete="current-password"/i);
  assert.match(html, /id="resetRequestForm"/);
  assert.match(html, /id="resetCodeForm"/);
  assert.match(html, /id="resetPasswordForm"/);
  assert.match(newPassword[0], /minlength="8"/);
});
