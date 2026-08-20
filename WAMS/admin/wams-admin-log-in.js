function switchTab(tab){
  document.getElementById('tabSignIn').classList.toggle('active', tab==='signin');
  document.getElementById('tabSignUp').classList.toggle('active', tab==='signup');
  document.getElementById('paneSignIn').classList.toggle('active', tab==='signin');
  document.getElementById('paneSignUp').classList.toggle('active', tab==='signup');
}

function togglePw(id, btn){
  const input = document.getElementById(id);
  if(input.type === 'password'){
    input.type = 'text';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  } else {
    input.type = 'password';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  }
}

function handleSignIn(e){
  e.preventDefault();

  const username = document.getElementById('signinUsername').value.trim();
  const pw = document.getElementById('signinPassword').value.trim();
  const errorEl = document.getElementById('signinError');

  if(username.length === 0 || pw.length === 0){
    errorEl.querySelector('span').textContent =
      'Please fill in both fields.';
    errorEl.classList.add('show');
    return false;
  }

  fetch('/api/auth/login', {
    method:'POST',
    headers:{
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      username: username,
      password: pw
    })
  })
  .then(res=>{
    if(!res.ok){
      throw new Error("Invalid credentials");
    }
    return res.json();
  })
  .then(data=>{

    if(data.user.role !== "admin"){
      errorEl.querySelector('span').textContent =
        "Access denied. Admin account required.";
      errorEl.classList.add('show');
      return;
    }

    localStorage.setItem("token", data.token);
    localStorage.setItem("wamsToken", data.token);
    localStorage.setItem("adminName", data.user.name);

    errorEl.classList.remove('show');

    window.location.href =
      "wams-admin-dashboard.html";

  })
  .catch(()=>{
    errorEl.querySelector('span').textContent =
      "Invalid username or password.";

    errorEl.classList.add('show');
  });


  return false;
}

function handleSignUp(e){
  e.preventDefault();
  const errorEl = document.getElementById('signupError');
  const errorText = document.getElementById('signupErrorText');
  const successEl = document.getElementById('signupSuccess');
  successEl.classList.remove('show');

  const first = document.getElementById('suFirstName').value.trim();
  const last = document.getElementById('suLastName').value.trim();
  const username = document.getElementById('suUsername').value.trim();
  const name = `${first} ${last}`;
  const pw = document.getElementById('suPassword').value;
  const confirmPw = document.getElementById('suConfirmPassword').value;
  const inviteCode = document.getElementById('suInviteCode').value.trim();

  if(!username){
    errorText.textContent = 'Username is required.';
    errorEl.classList.add('show');
    return false;
  }
  if(pw !== confirmPw){
    errorText.textContent = 'Passwords do not match.';
    errorEl.classList.add('show');
    return false;
  }
  if(pw.length < 8){
    errorText.textContent = 'Password must be at least 8 characters.';
    errorEl.classList.add('show');
    return false;
  }
  if(inviteCode !== 'ADMIN2026'){
    errorText.textContent = 'Invalid invitation code.';
    errorEl.classList.add('show');
    return false;
  }

  fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: pw, name, inviteCode })
  })
  .then(res => {
    if(!res.ok) throw new Error('Registration failed');
    return res.json();
  })
  .then(() => {
    errorEl.classList.remove('show');
    successEl.classList.add('show');
    document.querySelector('#paneSignUp form').reset();
  })
  .catch(err => {
    errorText.textContent = 'Registration failed. Email may already exist.';
    errorEl.classList.add('show');
  });
  
  return false;
}