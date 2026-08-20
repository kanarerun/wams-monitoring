function toggleSb(){
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}
function nav(e,el){
  e.preventDefault();
  document.querySelectorAll('.sb-item').forEach(i=>i.classList.remove('active'));
  el.classList.add('active');
}

function escapeHtml(s){
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

const initials = name => {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0]||'') + (parts[parts.length-1]?.[0]||'')).toUpperCase();
};

function toggleFieldPw(inputId, eyeId){
  const input = document.getElementById(inputId);
  const eye = document.getElementById(eyeId);
  if(input.type === 'password'){
    input.type = 'text';
    eye.innerHTML = '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.62 21.62 0 0 1 5.06-6.06M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a21.6 21.6 0 0 1-2.61 3.94M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
  } else {
    input.type = 'password';
    eye.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  }
}
function togglePw(){
  toggleFieldPw('curPwInput','eyeIcon1');
}

function showPw(){
  toggleFieldPw('newPwInput','eyeIcon2');
}

async function api(url, options = {}) {
  const token = localStorage.getItem("token") || localStorage.getItem("wamsToken");
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
      ...(options.headers || {})
    }
  });
  if(res.status === 401){
    localStorage.removeItem("token");
    localStorage.removeItem("wamsToken");
    window.location.href = "wams-admin-log-in.html";
    throw new Error("Unauthorized");
  }
  return res.json();
}

// ── User Profile
let adminProfile = { name: '', email: '', phone: '' };

async function loadProfile() {
  try {
    const data = await api("/api/me");
    adminProfile = {
      name: data.name || adminProfile.name,
      email: data.email || adminProfile.email,
      phone: data.phone || ''
    };
  } catch (e) {
    console.warn('Could not load profile from server, using defaults');
  }
  initProfileForm();
}

function initProfileForm(){
  document.getElementById('profileNameInput').value = adminProfile.name;
  document.getElementById('profileEmailInput').value = adminProfile.email;
  document.getElementById('profilePhoneInput').value = adminProfile.phone || '';
  updateProfileAvatar();
}

function updateProfileAvatar(){
  const av = document.getElementById('profileAvatar');
  av.textContent = initials(adminProfile.name);
  document.getElementById('profileHeadName').textContent = adminProfile.name;
  document.getElementById('topAvName').textContent = adminProfile.name;
}

function choosePhoto(){
  // Photo upload not currently supported via API - preview only
  const file = document.getElementById('photoInput').files[0];
  if(!file) return;
  if(!file.type.startsWith('image/')){
    showToast('Please choose an image file.');
    return;
  }
  showToast('Photo upload will be saved when you update your profile.');
}

function submitProfile(e){
  e.preventDefault();
  const name = document.getElementById('profileNameInput').value.trim();
  const email = document.getElementById('profileEmailInput').value.trim();
  const phone = document.getElementById('profilePhoneInput').value.trim();
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let valid = true;
  const nameField = document.getElementById('pf-name');
  const emailField = document.getElementById('pf-email');

  if(!name){ nameField.classList.add('invalid'); valid = false; } else nameField.classList.remove('invalid');
  if(!email || !emailRe.test(email)){ emailField.classList.add('invalid'); valid = false; } else emailField.classList.remove('invalid');

  if(!valid) return false;

  api("/api/profile", {
    method: "PUT",
    body: JSON.stringify({ name, email })
  }).then(() => {
    adminProfile.name = name;
    adminProfile.email = email;
    adminProfile.phone = phone;
    updateProfileAvatar();
    document.getElementById('topAvName').textContent = name;
    showToast('Profile updated successfully.');
  }).catch(() => {
    showToast('Could not update profile on server.');
  });
  return false;
}

function submitPasswordChange(e){
  e.preventDefault();
  const current = document.getElementById('curPwInput').value;
  const next = document.getElementById('newPwInput').value;
  const confirmVal = document.getElementById('confirmPwInput').value;

  const curField = document.getElementById('pf-curpw');
  const newField = document.getElementById('pf-newpw');
  const confirmField = document.getElementById('pf-confirmpw');
  [curField,newField,confirmField].forEach(f=>f.classList.remove('invalid'));

  let valid = true;

  if(!current){
    curField.classList.add('invalid');
    curField.querySelector('.field-error').textContent = 'Please enter your current password.';
    valid = false;
  }

  if(!next || next.length < 8){
    newField.classList.add('invalid');
    newField.querySelector('.field-error').textContent = 'New password must be at least 8 characters.';
    valid = false;
  }

  if(!confirmVal || confirmVal !== next){
    confirmField.classList.add('invalid');
    confirmField.querySelector('.field-error').textContent = 'Passwords do not match.';
    valid = false;
  }

  if(!valid) return false;

  api("/api/profile/password", {
    method: "PUT",
    body: JSON.stringify({ current_password: current, new_password: next })
  }).then((data) => {
    if(data.error){
      curField.classList.add('invalid');
      curField.querySelector('.field-error').textContent = data.error;
    } else {
      document.getElementById('passwordForm').reset();
      showToast('Password updated successfully.');
    }
  }).catch(() => {
    showToast('Could not update password.');
  });
  return false;
}


function showToast(msg){
  const toast = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  toast.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(()=>toast.classList.remove('show'), 2800);
}


// ── Auth Guard ──
(async function checkAdminAuth(){
  const token = localStorage.getItem("token") || localStorage.getItem("wamsToken");
  if(!token){
    window.location.href = "wams-admin-log-in.html";
    return;
  }
  try {
    const res = await fetch("/api/me", { headers: { "Authorization": "Bearer " + token } });
    if(!res.ok){
      localStorage.removeItem("token");
      localStorage.removeItem("wamsToken");
      window.location.href = "wams-admin-log-in.html";
      return;
    }
    const me = await res.json();
    if(me && me.role !== "admin"){ window.location.href = "wams-admin-log-in.html"; }
  } catch {}
})();

// ── Init
loadProfile();
function confirmLogout(event) {
    event.preventDefault();

    if (confirm("Are you sure you want to sign out?")) {
        localStorage.removeItem('token');
        localStorage.removeItem('wamsToken');
        localStorage.removeItem('wamsCurrentUserId');
        window.location.href = "wams-admin-log-in.html";
    }
}