
// Clear any browser-autofilled credentials on page load
// (prevents the admin account from being auto-filled into the professor form)
window.addEventListener('DOMContentLoaded', () => {
  const facultyInput = document.getElementById('profEmail');
  const codeInput = document.getElementById('profAccessCode');
  if(facultyInput) facultyInput.value = '';
  if(codeInput) codeInput.value = '';
  // Re-clear after a short delay to catch late autofill
  setTimeout(() => {
    if(facultyInput) facultyInput.value = '';
    if(codeInput) codeInput.value = '';
  }, 100);
});

function trimAccessCodeInput(input){
  const value = input.value;
  const leadingWhitespace = value.length - value.trimStart().length;
  const trimmed = value.trim();
  if(trimmed === value) return;
  const cursor = Math.max(0, Math.min(trimmed.length, input.selectionStart - leadingWhitespace));
  input.value = trimmed;
  input.setSelectionRange(cursor, cursor);
}

document.getElementById('profAccessCode').addEventListener('input', event => {
  trimAccessCodeInput(event.currentTarget);
});

function handleLogin(e){
  e.preventDefault();
  const facultyId = document.getElementById('profEmail').value.trim();
  const accessCode = document.getElementById('profAccessCode').value.trim();
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
    rememberProfessorAuthToken(data.token);
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
