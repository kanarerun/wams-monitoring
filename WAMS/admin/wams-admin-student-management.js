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
  const token = localStorage.getItem("token") || localStorage.getItem("wamsToken");

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("wamsToken");
      localStorage.removeItem("wamsCurrentUserId");
      window.location.href = "wams-admin-log-in.html";
      throw new Error("Unauthorized");
    }
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Request failed");
}

return response.json();
}

let students = [];

async function loadStudents() {
    try {

        const data = await api("/api/students");

        students = data.map(s => ({
            id: s.id,
            name: s.name,
            dept: s.course,
            studentId: s.student_id,
            status:
                s.status === "active"
                    ? "Active"
                    : s.status === "flagged"
                    ? "Flagged"
                    : "Suspended",
            year: s.year_level,
            section: s.section_name,
            section_id: s.section_id
        }));

        renderTables();

    } catch (err) {

        console.error(err);
        showToast(err.message);

    }
}

const uc = s => (s||'').trim().toUpperCase();
const initials = name => {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0]||'') + (parts[parts.length-1]?.[0]||'')).toUpperCase();
};
const avColors = ['#2563EB','#16A34A','#7C3AED','#D97706','#DC2626','#0EA5E9','#DB2777'];
const colorFor = id => avColors[id % avColors.length];

function departmentsList(){
  return [...new Set(students.map(i=>i.dept))].sort();
}

function refreshDeptFilterAndSuggestions(){
  const depts = departmentsList();
  const filter = document.getElementById('deptFilter');
  const current = filter.value;
  filter.innerHTML = '<option value="">All Programs</option>' +
    depts.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  filter.value = depts.includes(current) ? current : '';

  const deptSuggestions = document.getElementById('deptSuggestions');
  if (deptSuggestions) {
    deptSuggestions.innerHTML =
      depts.map(d=>`<option value="${escapeHtml(d)}">`).join('');
  }
}

function escapeHtml(s){
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function updateStats(){
  document.getElementById('statTotal').textContent = students.length;
  document.getElementById('statDepts').textContent = departmentsList().length;
  document.getElementById('statActive').textContent = students.filter(i=>i.status==='Active').length;
  document.getElementById('statSuspended').textContent = students.filter(i=>i.status==='Suspended').length;
  document.getElementById('statTotalSub').textContent = `Across ${departmentsList().length} program${departmentsList().length===1?'':'s'}`;
}

function renderTables(){
  refreshDeptFilterAndSuggestions();
  updateStats();

  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const deptFilter = document.getElementById('deptFilter').value;
  const container = document.getElementById('deptTables');

  let filtered = students.filter(i=>{
    const matchesQ = !q || i.name.toLowerCase().includes(q) || i.studentId.toLowerCase().includes(q) || i.dept.toLowerCase().includes(q);
    const matchesDept = !deptFilter || i.dept === deptFilter;
    return matchesQ && matchesDept;
  });

  if(filtered.length === 0){
    container.innerHTML = `
      <div class="card">
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div>No students match your search.</div>
        </div>
      </div>`;
    return;
  }

  const grouped = {};
  filtered.forEach(i=>{
    if(!grouped[i.dept]) grouped[i.dept] = [];
    grouped[i.dept].push(i);
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
            <div class="cs">${rows.length} student${rows.length===1?'':'s'}</div>
          </div>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:30%">Name</th>
              <th style="width:20%">Student ID</th>
              <th style="width:26%">Year & Section</th>
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

function statusBadge(status){
  if(status === 'Active') return '<span class="bdg bdg-green"><span class="bdg-dot"></span>Active</span>';
  if(status === 'Flagged') return '<span class="bdg bdg-red"><span class="bdg-dot"></span>Flagged</span>';
  if(status === 'Suspended') return '<span class="bdg bdg-gray"><span class="bdg-dot"></span>Suspended</span>';
  return `<span class="bdg bdg-amber"><span class="bdg-dot"></span>${escapeHtml(status)}</span>`;
}

function rowHtml(i){
  return `
    <tr>
      <td style="width:30%">
        <div class="uc">
          <div class="uav" style="background:${colorFor(i.id)}">${initials(i.name)}</div>
          <span class="user-name" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</span>
        </div>
      </td>
      <td style="width:20%"><span class="code-chip">${escapeHtml(i.studentId)}</span></td>
      <td style="width:26%">
        <div class="year-sec-cell">
          <span class="year-txt">${escapeHtml(i.year || '1st Year')}</span>
          ${i.section ? `<span class="sec-divider">·</span><span class="sec-txt">${escapeHtml(i.section)}</span>` : ''}
        </div>
      </td>
      <td style="width:14%">${statusBadge(i.status)}</td>
      <td style="width:10%;text-align:right">
        <div class="row-actions" style="justify-content:flex-end">
          <div class="act-icbtn" title="Toggle status" onclick="toggleStatus(${i.id})">
            <svg viewBox="0 0 24 24"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
          </div>
          <div class="act-icbtn del" title="Remove student" onclick="removeStudent(${i.id})">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
          </div>
        </div>
      </td>
    </tr>`;
}

function toggleStatus(id){
  const student = students.find(i=>i.id===id);
  if(student){
    const newStatus = student.status === 'Active' ? 'Suspended' : 'Active';
    api("/api/students/" + id, {
      method: "PUT",
      body: JSON.stringify({
        status: newStatus,
        section_id: student.section_id,
        year_level: student.year
      })
    }).then(() => {

    loadStudents();

    showToast(
        `${student.name} is now ${newStatus.toLowerCase()}.`
    );
})
.catch(err => {
    showToast(err.message);
});
  }
}

function removeStudent(id){
  const student = students.find(i=>i.id===id);
  if(!student) return;
  if(confirm(`Remove ${student.name} from ${student.dept}?`)){
    api("/api/students/" + id, {
      method: "DELETE"
    }).then(() => {
      loadStudents();
      showToast(`${student.name} removed.`);
    });
  }
}

// ── Modal
let availableSections = [];

async function loadSectionsForStudentForm() {
  try {
    const data = await api("/api/sections");
    availableSections = data;
    const select = document.getElementById('sectionSelect');
    if (select) {
      select.innerHTML = '<option value="">-- Select a section --</option>' +
        data.map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.course)})</option>`).join('');
    }
  } catch (err) {
    console.error(err);
  }
}

function openCreateSection() {
  document.getElementById('sectionModalOverlay').classList.add('show');
  document.getElementById('sectionCourseInput').value = '';
  document.getElementById('sectionNameInput').value = '';
  ['f-section-course', 'f-section-name'].forEach(id => document.getElementById(id).classList.remove('invalid'));
  document.getElementById('sectionCourseInput').focus();
}

function closeSectionModal() {
  document.getElementById('sectionModalOverlay').classList.remove('show');
}

document.getElementById('sectionModalOverlay').addEventListener('click', e => {
  if (e.target.id === 'sectionModalOverlay') closeSectionModal();
});

async function createSection(e) {
  e.preventDefault();
  const course = document.getElementById('sectionCourseInput').value.trim();
  const sectionName = document.getElementById('sectionNameInput').value.trim();

  let valid = true;
  const checks = [
    ['f-section-course', course],
    ['f-section-name', sectionName]
  ];

  checks.forEach(([fid, val]) => {
    const el = document.getElementById(fid);
    if (!val) {
      el.classList.add('invalid');
      valid = false;
    } else {
      el.classList.remove('invalid');
    }
  });

  if (!valid) return false;

  try {
    const section = await api("/api/sections", {
      method: "POST",
      body: JSON.stringify({
        name: sectionName,
        course: course
      })
    });

    await loadSectionsForStudentForm();
    document.getElementById('sectionSelect').value = section.id;
    closeSectionModal();
    showToast(`Section "${sectionName}" created.`);
  } catch (err) {
    showToast(err.message);
  }

  return false;
}

function openModal(){
  document.getElementById('modalOverlay').classList.add('show');
  document.getElementById('studentForm').reset();
  ['f-section','f-name','f-facid'].forEach(id=>document.getElementById(id).classList.remove('invalid'));
  loadSectionsForStudentForm();
  document.getElementById('sectionSelect').focus();
}
function closeModal(){
  document.getElementById('modalOverlay').classList.remove('show');
}
document.getElementById('modalOverlay').addEventListener('click', e=>{
  if(e.target.id === 'modalOverlay') closeModal();
});

function genFacultyId(){
  const year = new Date().getFullYear();
  const rand = Math.floor(10000 + Math.random()*90000);
  document.getElementById('facIdInput').value = `${year}-${rand}`;
}

function submitStudent(e){
  e.preventDefault();
  const sectionId = document.getElementById('sectionSelect').value;
  const name = document.getElementById('nameInput').value.trim();
  const studentId = document.getElementById("facIdInput").value.trim();
  const year = document.getElementById('yearInput').value;
  const section = document.getElementById('sectionInput').value.trim();

  let valid = true;
  const checks = [
    ['f-section', sectionId],
    ['f-name', name],
    ['f-facid', studentId],
  ];
  checks.forEach(([fid, val])=>{
    const el = document.getElementById(fid);
    if(!val){ el.classList.add('invalid'); valid = false; }
    else { el.classList.remove('invalid'); }
  });

  if(students.some(i => uc(i.studentId) === uc(studentId))){
    document.getElementById('f-facid').classList.add('invalid');
    document.querySelector('#f-facid .field-error').textContent = 'This Student ID already exists.';
    valid = false;
  }

  if(!valid) return false;

  api("/api/students", {
    method: "POST",
    body: JSON.stringify({
        sectionId: sectionId ? parseInt(sectionId) : undefined,
        section: section || undefined,
        name,
        studentId,
        year
      })
  }).then(async () => {
    closeModal();
    await loadStudents();
    showToast(`${name} added successfully.`);
})
.catch(err => {

    showToast(err.message);

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
})();

// ── Init
loadStudents();
loadSectionsForStudentForm();
function confirmLogout(event) {
    event.preventDefault();

    if (confirm("Are you sure you want to sign out?")) {
        localStorage.removeItem('token');
        localStorage.removeItem('wamsToken');
        localStorage.removeItem('wamsCurrentUserId');
        window.location.href = "wams-admin-log-in.html";
    }
}