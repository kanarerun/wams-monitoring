import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const adminLogin = fs.readFileSync('WAMS/admin/wams-admin-log-in.html', 'utf8');
const adminProfile = fs.readFileSync('WAMS/admin/wams-admin-user-profile.html', 'utf8');
const professorLogin = fs.readFileSync('WAMS/professor/wams-professor-log-in.html', 'utf8');

test('admin password fields are masked text inputs, not Google password-manager fields', () => {
  const allInputs = `${adminLogin}\n${adminProfile}`;
  const expectedIds = [
    'signinPassword',
    'suPassword',
    'suConfirmPassword',
    'curPwInput',
    'newPwInput',
    'confirmPwInput'
  ];

  for(const id of expectedIds){
    const input = allInputs.match(new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`, 'i'));
    assert.ok(input, `Missing ${id}`);
    assert.match(input[0], /type="text"/i, `${id} must not appear as a password input`);
    assert.match(input[0], /class="[^"]*wams-secret-field/i, `${id} should retain password masking`);
    assert.match(input[0], /autocomplete="off"/i, `${id} should disable browser autocomplete`);
    assert.doesNotMatch(input[0], /name=/i, `${id} should not advertise credential semantics`);
  }

  assert.doesNotMatch(allInputs, /<input\b[^>]*type="password"/i);
  assert.doesNotMatch(allInputs, /autocomplete=["'](?:new-password|current-password)["']/i);
  assert.match(fs.readFileSync('WAMS/admin/wams-admin-log-in.css', 'utf8'), /\.wams-secret-field\{-webkit-text-security:disc\}/);
  assert.match(fs.readFileSync('WAMS/admin/wams-admin-user-profile.css', 'utf8'), /\.wams-secret-field\{-webkit-text-security:disc\}/);
});

test('login and instructor access-code inputs remain autocomplete-disabled text fields', () => {
  const paths = [
    'WAMS/student/wams-student-log-in.html',
    'WAMS/professor/wams-professor-log-in.html',
    'WAMS/admin/wams-admin-instructor-management.html'
  ];
  for(const path of paths){
    const html = fs.readFileSync(path, 'utf8');
    assert.doesNotMatch(html, /<input\b[^>]*type="password"/i, path);
    for(const id of ['studentAccessCode', 'profAccessCode', 'codeInput']){
      const input = html.match(new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`, 'i'));
      if(!input) continue;
      assert.match(input[0], /type="text"/i, path);
      assert.match(input[0], /autocomplete="off"/i, path);
      assert.doesNotMatch(input[0], /name=/i, path);
    }
  }
});

test('professor access code is visually masked without using a password input', () => {
  const input = professorLogin.match(/<input\b[^>]*id="profAccessCode"[^>]*>/i);
  assert.ok(input);
  assert.match(input[0], /type="text"/i);
  assert.match(input[0], /class="[^"]*access-code-secret/i);
  assert.match(input[0], /autocomplete="off"/i);
  assert.match(
    fs.readFileSync('WAMS/professor/wams-professor-log-in.css', 'utf8'),
    /\.access-code-secret\{-webkit-text-security:disc\}/
  );
});
