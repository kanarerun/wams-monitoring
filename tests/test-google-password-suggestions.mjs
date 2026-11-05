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

test('student exam access code stays separate from professor password recovery', () => {
  const studentLogin = fs.readFileSync('WAMS/student/wams-student-log-in.html', 'utf8');
  const studentCode = studentLogin.match(/<input\b[^>]*id="studentAccessCode"[^>]*>/i);
  assert.ok(studentCode);
  assert.match(studentCode[0], /type="text"/i);
  assert.doesNotMatch(studentLogin, /forgot password|password reset/i);
});

test('professor login and reset fields use the matching browser credential semantics', () => {
  const inputById = id => professorLogin.match(new RegExp(`<input\\b[^>]*id="${id}"[^>]*>`, 'i'));
  const email = inputById('profEmail');
  const password = inputById('profPassword');
  const resetPassword = inputById('newPassword');
  const initialPassword = fs.readFileSync('WAMS/admin/wams-admin-instructor-management.html', 'utf8')
    .match(/<input\b[^>]*id="codeInput"[^>]*>/i);
  assert.ok(email && password && resetPassword && initialPassword);
  assert.match(email[0], /type="email"/i);
  assert.match(password[0], /type="password"/i);
  assert.match(password[0], /autocomplete="current-password"/i);
  assert.match(resetPassword[0], /autocomplete="new-password"/i);
  assert.match(initialPassword[0], /type="password"/i);
  assert.match(initialPassword[0], /autocomplete="new-password"/i);
});

test('admin registration accepts emailed invitation code tied to the invited email', () => {
  const inviteCode = adminLogin.match(/<input\b[^>]*id="suInviteCode"[^>]*>/i);
  const inviteEmail = adminLogin.match(/<input\b[^>]*id="suEmail"[^>]*>/i);
  assert.ok(inviteCode && inviteEmail);
  assert.match(inviteEmail[0], /type="email"/i);
  assert.match(adminLogin, /id="paneSignUp"/);
  assert.match(adminLogin, /registrationParams\.get\('tab'\) === 'signup'/);
  assert.match(adminLogin, /inviteCode/);
  assert.doesNotMatch(adminLogin, /ADMIN2026/);
});

test('Admin List is linked from every admin portal and provides invitation/list interfaces', () => {
  const adminPages = [
    'wams-admin-dashboard.html',
    'wams-admin-instructor-management.html',
    'wams-admin-student-management.html',
    'wams-admin-feedbacks.html',
    'wams-admin-user-profile.html'
  ];
  for(const filename of adminPages){
    const html = fs.readFileSync(`WAMS/admin/${filename}`, 'utf8');
    assert.match(html, /href="wams-admin-admin-list\.html"[^>]*data-tip="Admin List"/, filename);
  }

  const adminList = fs.readFileSync('WAMS/admin/wams-admin-admin-list.html', 'utf8');
  assert.match(adminList, /<title>WAMS — Admin List<\/title>/);
  assert.match(adminList, /id="inviteEmail"/);
  assert.match(adminList, /id="adminRows"/);
  assert.match(adminList, /id="invitationRows"/);
  assert.match(adminList, /Send Invitation/);
});
