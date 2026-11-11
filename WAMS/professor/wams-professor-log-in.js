const loginForm = document.getElementById('loginForm');
const loginCodeForm = document.getElementById('loginCodeForm');
let loginEmail = '';

function showLoginCodeStep(show) {
  loginForm.hidden = show;
  loginCodeForm.hidden = !show;
  accountNote.hidden = show;
}

function backToNormalLogin() {
  showLoginCodeStep(false);
  document.getElementById('loginCode').value = '';
  document.getElementById('profPassword').value = '';
  authTitle.textContent = 'Professor Login';
  authSubtitle.textContent = 'Sign in to manage your exams and classes';
}

loginCodeForm.addEventListener('submit', async event => {
  event.preventDefault();
  const errorEl = document.getElementById('errorMsg');
  const code = document.getElementById('loginCode').value.trim();
  try {
    const data = await postJson('/api/auth/login-code/verify', { kind: 'professor', email: loginEmail, code });
    rememberProfessorAuthToken(data.token);
    localStorage.setItem('wamsProfessorName', data.user.name);
    localStorage.setItem('wamsCurrentUserId', data.user.id);
    if (data.user.department) localStorage.setItem('wamsProfessorDept', data.user.department);
    errorEl.classList.remove('show');
    window.location.href = 'wams-professor-dashboard.html';
  } catch (error) {
    errorEl.querySelector('span').textContent = error.message || 'The verification code is invalid or expired.';
    errorEl.classList.add('show');
  }
});

document.getElementById('loginCodeBack').addEventListener('click', backToNormalLogin);
const resetPanel = document.getElementById('passwordResetPanel');
const resetRequestForm = document.getElementById('resetRequestForm');
const resetCodeForm = document.getElementById('resetCodeForm');
const resetPasswordForm = document.getElementById('resetPasswordForm');
const resetError = document.getElementById('resetError');
const resetMessage = document.getElementById('resetMessage');
const authTitle = document.getElementById('authTitle');
const authSubtitle = document.getElementById('authSubtitle');
const accountNote = document.querySelector('.account-note');

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('profEmail').value = '';
  document.getElementById('profPassword').value = '';
});

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'The request could not be completed.');
    // The server includes the underlying mail-relay reason for delivery failures.
    if (data.reason) error.reason = data.reason;
    throw error;
  }
  return data;
}

function showResetError(message) {
  resetError.querySelector('span').textContent = message;
  resetError.classList.add('show');
}

function clearResetMessages() {
  resetError.classList.remove('show');
  resetMessage.textContent = '';
}

function showResetStep(step) {
  resetRequestForm.hidden = step !== 'request';
  resetCodeForm.hidden = step !== 'code';
  resetPasswordForm.hidden = step !== 'password';
  clearResetMessages();

  const copy = {
    request: ['Forgot password?', 'Enter the school email on your professor account.'],
    code: ['Check your email', 'Enter the verification code sent to your school inbox.'],
    password: ['Choose a new password', 'Your code is verified. Set a new password for your account.'],
    done: ['Password updated', 'You can now sign in with your new password.']
  }[step];
  authTitle.textContent = copy[0];
  authSubtitle.textContent = copy[1];
}

function openPasswordReset() {
  const loginEmail = document.getElementById('profEmail').value.trim();
  document.getElementById('resetEmail').value = loginEmail;
  loginForm.hidden = true;
  accountNote.hidden = true;
  document.getElementById('errorMsg').classList.remove('show');
  resetPanel.hidden = false;
  showResetStep('request');
  document.getElementById('resetEmail').focus();
}

function backToLogin() {
  resetPanel.hidden = true;
  loginForm.hidden = false;
  accountNote.hidden = false;
  authTitle.textContent = 'Professor Login';
  authSubtitle.textContent = 'Sign in to manage your exams and classes';
  document.getElementById('profEmail').value = document.getElementById('resetEmail').value;
  document.getElementById('profPassword').value = '';
  document.getElementById('resetCode').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
  document.getElementById('backToLogin').textContent = 'Back to login';
  clearResetMessages();
}

document.getElementById('forgotPasswordLink').addEventListener('click', event => {
  event.preventDefault();
  openPasswordReset();
});
document.getElementById('backToLogin').addEventListener('click', backToLogin);

async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById('profEmail').value.trim().toLowerCase();
  const password = document.getElementById('profPassword').value;
  const errorEl = document.getElementById('errorMsg');

  if (!email || !password) {
    errorEl.querySelector('span').textContent = 'Please enter your school email and password.';
    errorEl.classList.add('show');
    return false;
  }

  try {
    const data = await postJson('/api/auth/professor-login', { email, password });
    if (data.requiresEmailCode) {
      loginEmail = email;
      showLoginCodeStep(true);
      authTitle.textContent = 'Check your email';
      authSubtitle.textContent = `Enter the verification code sent to ${data.email}.`;
      errorEl.classList.remove('show');
      document.getElementById('loginCode').focus();
      return false;
    }
    rememberProfessorAuthToken(data.token);
    localStorage.setItem('wamsProfessorName', data.user.name);
    localStorage.setItem('wamsCurrentUserId', data.user.id);
    if (data.user.department) localStorage.setItem('wamsProfessorDept', data.user.department);
    errorEl.classList.remove('show');
    window.location.href = 'wams-professor-dashboard.html';
  } catch (error) {
    errorEl.querySelector('span').textContent = error.message === 'Invalid email or password'
      ? 'Invalid email or password. Please try again.'
      : 'Unable to sign in right now. Please try again later.';
    errorEl.classList.add('show');
  }
  return false;
}

resetRequestForm.addEventListener('submit', async event => {
  event.preventDefault();
  clearResetMessages();
  const email = document.getElementById('resetEmail').value.trim().toLowerCase();
  try {
    await postJson('/api/auth/professor-password-reset/request', { email });
    showResetStep('code');
    resetMessage.textContent = 'If an active professor account matches this email, a verification code has been sent to its school inbox.';
    document.getElementById('resetCode').focus();
  } catch (error) {
    showResetError(error.reason ? `${error.message} (${error.reason})` : error.message);
  }
});

resetCodeForm.addEventListener('submit', async event => {
  event.preventDefault();
  clearResetMessages();
  const email = document.getElementById('resetEmail').value.trim().toLowerCase();
  const code = document.getElementById('resetCode').value.trim();
  try {
    await postJson('/api/auth/professor-password-reset/verify', { email, code });
    showResetStep('password');
    document.getElementById('newPassword').focus();
  } catch (error) {
    showResetError(error.message);
  }
});

resetPasswordForm.addEventListener('submit', async event => {
  event.preventDefault();
  clearResetMessages();
  const email = document.getElementById('resetEmail').value.trim().toLowerCase();
  const password = document.getElementById('newPassword').value;
  const confirmation = document.getElementById('confirmPassword').value;
  if (password !== confirmation) {
    showResetError('The passwords do not match.');
    return;
  }
  try {
    await postJson('/api/auth/professor-password-reset/complete', { email, password });
    showResetStep('done');
    resetMessage.textContent = 'Your password has been updated. You can now sign in.';
    document.getElementById('backToLogin').textContent = 'Return to login';
  } catch (error) {
    showResetError(error.message);
  }
});
