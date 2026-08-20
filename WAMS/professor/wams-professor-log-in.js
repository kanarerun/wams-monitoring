
function togglePw(){
  const pw = document.getElementById('profPassword');
  const btn = document.getElementById('togglePwBtn');
  if(pw.type === 'password'){
    pw.type = 'text';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  } else {
    pw.type = 'password';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  }
}

// Clear any browser-autofilled credentials on page load
// (prevents the admin account from being auto-filled into the professor form)
window.addEventListener('DOMContentLoaded', () => {
  const facultyInput = document.getElementById('profEmail');
  const codeInput = document.getElementById('profPassword');
  if(facultyInput) facultyInput.value = '';
  if(codeInput) codeInput.value = '';
  // Re-clear after a short delay to catch late autofill
  setTimeout(() => {
    if(facultyInput) facultyInput.value = '';
    if(codeInput) codeInput.value = '';
  }, 100);
});

function handleLogin(e){
  e.preventDefault();
  const facultyId = document.getElementById('profEmail').value.trim();
  const accessCode = document.getElementById('profPassword').value.trim();
  const errorEl = document.getElementById('errorMsg');

  if(facultyId.length === 0 || accessCode.length === 0){
    errorEl.querySelector('span').textContent = 'Please fill in both fields.';
    errorEl.classList.add('show');
    return false;
  }

  // Try professor-specific login endpoint
  fetch('/api/auth/professor-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ faculty_id: facultyId, access_code: accessCode })
  })
  .then(res => {
    if(!res.ok) throw new Error('Invalid credentials');
    return res.json();
  })
  .then(data => {
    // Save token and user info to localStorage
    localStorage.setItem('wamsToken', data.token);
    localStorage.setItem('wamsProfessorName', data.user.name);
    localStorage.setItem('wamsCurrentUserId', data.user.id);
    if(data.user.department) localStorage.setItem('wamsProfessorDept', data.user.department);
    errorEl.classList.remove('show');
    window.location.href = 'wams-professor-dashboard.html';
  })
  .catch(err => {
    errorEl.querySelector('span').textContent = 'Invalid Faculty ID or Access Code.';
    errorEl.classList.add('show');
  });
  
  return false;
}
