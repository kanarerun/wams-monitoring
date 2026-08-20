// ── Sidebar toggle
function toggleSb(){
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}
function nav(e,el){
  e.preventDefault();
  document.querySelectorAll('.sb-item').forEach(i=>i.classList.remove('active'));
  el.classList.add('active');
}

async function api(url, options = {}) {
    const token =
        localStorage.getItem("token") ||
        localStorage.getItem("wamsToken");

    const res = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
            ...(options.headers || {})
        }
    });

    let data = {};
    try {
        data = await res.json();
    } catch {
        data = {};
    }

    if (!res.ok) {
    const message = data.error || res.statusText;

    if (res.status === 401) {
    localStorage.removeItem("token");
    localStorage.removeItem("wamsToken");
    window.location.href = "wams-admin-log-in.html";
    throw new Error("Unauthorized");
  }
    throw new Error(data.error || res.statusText);
  }
    return data;
}
// ── Instructors data
let instructors = [];
let codeVisibility = {};

async function loadInstructors() {
    try {
        instructors = await api("/api/admin/instructors");
        renderTables();
    } catch (err) {
    if (err.message !== "Unauthorized") {
        showToast("Failed to load instructors: " + err.message);
    }
}
}
  loadInstructors();

const uc = s => (s||'').trim().toUpperCase();
const initials = name => {
    const parts = (name || "")
        .replace(/^prof\.?\s*/i, "")
        .trim()
        .split(/\s+/);

    return (
        (parts[0]?.[0] || "") +
        (parts[parts.length - 1]?.[0] || "")
    ).toUpperCase();
};
const avColors = ['#2563EB','#16A34A','#7C3AED','#D97706','#DC2626','#0EA5E9','#DB2777'];
const colorFor = id => avColors[id % avColors.length];

function departmentsList() {
    return [...new Set(instructors.map(i => i.department || "Unassigned"))].sort();
}

function refreshDeptFilterAndSuggestions(){
  const depts = departmentsList();
  const filter = document.getElementById('deptFilter');
  const current = filter.value;
  filter.innerHTML = '<option value="">All Departments</option>' +
    depts.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  filter.value = depts.includes(current) ? current : '';

  document.getElementById('deptSuggestions').innerHTML =
    depts.map(d=>`<option value="${escapeHtml(d)}">`).join('');
}

function escapeHtml(s){
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function updateStats(){
  document.getElementById('statTotal').textContent = instructors.length;
  document.getElementById('statDepts').textContent = departmentsList().length;
  document.getElementById('statActive').textContent = instructors.filter(i => (i.status || "").toLowerCase() === "active").length;
  document.getElementById('statSuspended').textContent = instructors.filter(i => (i.status || "").toLowerCase() === "suspended").length;
  document.getElementById('statTotalSub').textContent = `Across ${departmentsList().length} department${departmentsList().length===1?'':'s'}`;
}

function renderTables(){
  refreshDeptFilterAndSuggestions();
  updateStats();

  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const deptFilter = document.getElementById('deptFilter').value;
  const container = document.getElementById('deptTables');

  let filtered = instructors.filter(i=>{
    const matchesQ =
    !q ||
    (i.name || "").toLowerCase().includes(q) ||
    (i.faculty_id || "").toLowerCase().includes(q) ||
    (i.department || "").toLowerCase().includes(q);
    const matchesDept = !deptFilter || i.department === deptFilter;
    return matchesQ && matchesDept;
  });

  if(filtered.length === 0){
    container.innerHTML = `
      <div class="card">
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div>No instructors match your search.</div>
        </div>
      </div>`;
    return;
  }

    const grouped = {};
        filtered.forEach(i => {
        const dept = i.department || "Unassigned";

        if (!grouped[dept]) {
            grouped[dept] = [];
        }

        grouped[dept].push(i);
    });

  const depts = Object.keys(grouped).sort();

  container.innerHTML = depts.map(dept=>{
    const rows = grouped[dept];
    const deptInitials = dept.split(/\s+/).filter(w=>w.length>2 || /^[A-Z]/.test(w)).slice(0,3).map(w=>w[0]).join('').toUpperCase() || dept.slice(0,2).toUpperCase();
    return `
    <div class="card">
      <div class="card-hd">
        <div class="card-hd-l">
          <div class="dept-ic">${escapeHtml(deptInitials.slice(0,3))}</div>
          <div>
            <div class="ct">${escapeHtml(dept)}</div>
            <div class="cs">${rows.length} instructor${rows.length===1?'':'s'}</div>
          </div>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:32%">Name</th>
              <th style="width:22%">Faculty ID</th>
              <th style="width:22%">Access Code</th>
              <th style="width:14%">Status</th>
              <th style="width:10%;text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(i=>rowHtml(i)).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

function rowHtml(i){
  const visible = !!codeVisibility[i.id];
  const statusVal =
    (i.status || "").toLowerCase() === "active"
        ? "Active"
        : "Suspended";
  const statusBdg = statusVal === 'Active'
    ? '<span class="bdg bdg-green"><span class="bdg-dot"></span>Active</span>'
    : '<span class="bdg bdg-red"><span class="bdg-dot"></span>Suspended</span>';
  return `
    <tr>
      <td style="width:32%">
        <div class="uc">
          <div class="uav" style="background:${colorFor(i.id)}">${initials(i.name)}</div>
          <span class="user-name" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</span>
        </div>
      </td>
      <td style="width:22%"><span class="code-chip">${escapeHtml(i.faculty_id)}</span></td>
      <td style="width:22%">
        <span class="code-chip ${visible?'':'code-mask'}">${visible ? escapeHtml(i.access_code) : '••••-••••'}</span>
        <span class="code-toggle" onclick="toggleCode(${i.id})" title="Show/hide access code">
          <svg viewBox="0 0 24 24">${visible
            ? '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.62 21.62 0 0 1 5.06-6.06M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a21.6 21.6 0 0 1-2.61 3.94M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
            : '<path d="M1 backward 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'}</svg>
        </span>
      </td>
      <td style="width:14%">${statusBdg}</td>
      <td style="width:10%;text-align:right">
        <div class="row-actions" style="justify-content:flex-end">
          <div class="act-icbtn" title="Toggle status" onclick="toggleStatus(${i.id})">
            <svg viewBox="0 0 24 24"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          </div>
          <div class="act-icbtn del" title="Remove instructor" onclick="removeInstructor(${i.id})">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
          </div>
        </div>
      </td>
    </tr>`;
}

function toggleCode(id){
  codeVisibility[id] = !codeVisibility[id];
  renderTables();
}

function toggleStatus(id){
  const inst = instructors.find(i=>i.id===id);
  if(inst){
    const newStatus =
    (inst.status || "").toLowerCase() === "active"
    ? "suspended"
    : "active";
    api("/api/instructors/" + id, {
      method: "PUT",
      body: JSON.stringify({
        status: newStatus
      })
    }).then(async () => {
    await loadInstructors();
      showToast(`${inst.name} is now ${newStatus.toLowerCase()}.`);
    }).catch(err => {
      showToast('Error: ' + err.message);
    });
  }
}

function removeInstructor(id){
  const inst = instructors.find(i=>i.id===id);
  if(!inst) return;
  if(confirm(`Remove ${inst.name} from ${inst.department}?`)){
    api("/api/instructors/" + id, {
      method: "DELETE"
    }).then(async () => {
    await loadInstructors();
    showToast(`${inst.name} removed.`);
    }).catch(err => {
      showToast('Error: ' + err.message);
    });
  }
}

// ── Modal
function openModal(){
  document.getElementById('modalOverlay').classList.add('show');
  document.getElementById('instructorForm').reset();
  ['f-dept','f-name','f-facid','f-code'].forEach(id=>document.getElementById(id).classList.remove('invalid'));
  document.getElementById('deptInput').focus();
}
function closeModal(){
  document.getElementById('modalOverlay').classList.remove('show');
}
document.getElementById('modalOverlay').addEventListener('click', e=>{
  if(e.target.id === 'modalOverlay') closeModal();
});

function togglePw(){
  const input = document.getElementById('codeInput');
  const eye = document.getElementById('eyeIcon');
  if(input.type === 'password'){
    input.type = 'text';
    eye.innerHTML = '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.62 21.62 0 0 1 5.06-6.06M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a21.6 21.6 0 0 1-2.61 3.94M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
  } else {
    input.type = 'password';
    eye.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  }
}

function genFacultyId(){
  const year = new Date().getFullYear();
  const rand = Math.floor(100 + Math.random()*900);
  document.getElementById('facIdInput').value = `FAC-${year}-${rand}`;
}
function genAccessCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
  document.getElementById('codeInput').value = `${seg()}-${seg()}`;
}

function submitInstructor(e){
  e.preventDefault();
  const dept = document.getElementById('deptInput').value.trim();
  const name = document.getElementById('nameInput').value.trim();
  const facultyId = document.getElementById('facIdInput').value.trim();
  const code = document.getElementById('codeInput').value.trim();

  let valid = true;
  const checks = [
    ['f-dept', dept],
    ['f-name', name],
    ['f-facid', facultyId],
    ['f-code', code],
  ];
  checks.forEach(([fid, val])=>{
    const el = document.getElementById(fid);
    if(!val){ el.classList.add('invalid'); valid = false; }
    else { el.classList.remove('invalid'); }
  });

  if(instructors.some(i => uc(i.faculty_id) === uc(facultyId))){
    document.getElementById('f-facid').classList.add('invalid');
    document.querySelector('#f-facid .field-error').textContent = 'This Faculty ID already exists.';
    valid = false;
  }

  if(!valid) return false;

  api("/api/instructors", {
    method: "POST",
    body: JSON.stringify({
      name,
      faculty_id: facultyId,
      department: dept,
      access_code: code
    })
  }).then(async () => {
    closeModal();
    await loadInstructors();
    showToast(`${name} added to ${dept}.`);
  }).catch(err => {
    showToast('Error: ' + err.message);
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

// ── Init
function confirmLogout(event) {
    event.preventDefault();

    if (confirm("Are you sure you want to sign out?")) {
        localStorage.removeItem("token");
        localStorage.removeItem("wamsToken");
        window.location.href = "wams-admin-log-in.html";
    }
}
