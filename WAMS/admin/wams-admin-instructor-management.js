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
  const token = getAdminAuthToken();

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
    clearAdminAuthSession(token);
    window.location.href = "wams-admin-log-in.html";
    throw new Error("Unauthorized");
  }
    throw new Error(data.error || res.statusText);
  }
    return data;
}
// ── Instructors data
let instructors = [];
let departments = [];
let courses = [];
let sections = [];
let codeVisibility = {};
let heldClasses = [];
let editingInstructorId = null;

verifyAdminAuth();

async function loadInstructors() {
    try {
        [instructors, departments, courses, sections] = await Promise.all([
            api("/api/admin/instructors"),
            api("/api/admin/departments"),
            api("/api/admin/courses"),
            api("/api/sections")
        ]);
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
    return [...new Set([
        ...departments.map(department => department.name),
        ...instructors.map(i => i.department || "Unassigned")
    ])].sort((a, b) => a.localeCompare(b));
}

function refreshDeptFilterAndSuggestions(){
  const depts = departmentsList();
  const filter = document.getElementById('deptFilter');
  const current = filter.value;
  filter.innerHTML = '<option value="">All Departments</option>' +
    depts.map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  filter.value = depts.includes(current) ? current : '';

  const instructorDepartment = document.getElementById('deptInput');
  const selectedDepartmentId = instructorDepartment.value;
  const departmentOptions = departments
    .map(department=>`<option value="${department.id}">${escapeHtml(department.name)}</option>`).join('');
  instructorDepartment.innerHTML = '<option value="">-- Select a department --</option>' + departmentOptions;
  if(departments.some(department => String(department.id) === selectedDepartmentId)){
    instructorDepartment.value = selectedDepartmentId;
  }

  const courseDepartment = document.getElementById('courseDepartmentInput');
  const selectedCourseDepartmentId = courseDepartment.value;
  courseDepartment.innerHTML = '<option value="">-- Select a department --</option>' + departmentOptions;
  if(departments.some(department => String(department.id) === selectedCourseDepartmentId)){
    courseDepartment.value = selectedCourseDepartmentId;
  }
  refreshInstructorCourses();
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
    (i.course || "").toLowerCase().includes(q) ||
    (i.department || "").toLowerCase().includes(q);
    const matchesDept = !deptFilter || i.department === deptFilter;
    return matchesQ && matchesDept;
  });

  const visibleDepartments = departmentsList().filter(dept => !deptFilter || dept === deptFilter);
  if(filtered.length === 0 && (q || visibleDepartments.length === 0)){
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

  const depts = [...new Set([
    ...Object.keys(grouped),
    ...(q ? [] : visibleDepartments)
  ])].filter(dept => !deptFilter || dept === deptFilter).sort((a, b) => a.localeCompare(b));

  container.innerHTML = depts.map(dept=>{
    const rows = grouped[dept] || [];
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
              <th style="width:25%">Name</th>
              <th style="width:18%">Course</th>
              <th style="width:16%">Faculty ID</th>
              <th style="width:15%">Access Code</th>
              <th style="width:12%">Status</th>
              <th style="width:14%;text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length
              ? rows.map(i=>rowHtml(i)).join('')
              : '<tr><td colspan="6"><div class="empty-state">No instructors in this department yet. It will stay available when you are ready to add one.</div></td></tr>'}
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
      <td style="width:25%">
        <div class="uc">
          <div class="uav" style="background:${colorFor(i.id)}">${initials(i.name)}</div>
          <span class="user-name" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</span>
        </div>
      </td>
      <td style="width:18%">${escapeHtml(i.course || '—')}</td>
      <td style="width:16%"><span class="code-chip copyable" role="button" tabindex="0" aria-label="Copy Faculty ID" title="Copy Faculty ID" onclick="copyInstructorValue(${i.id}, 'faculty_id')" onkeydown="handleCopyKey(event, () => copyInstructorValue(${i.id}, 'faculty_id'))">${escapeHtml(i.faculty_id)}</span></td>
      <td style="width:15%">
        <span class="code-chip ${visible?'copyable':'code-mask'}" ${visible ? `role="button" tabindex="0" aria-label="Copy access code" title="Copy access code" onclick="copyInstructorValue(${i.id}, 'access_code')" onkeydown="handleCopyKey(event, () => copyInstructorValue(${i.id}, 'access_code'))"` : ''}>${visible ? escapeHtml(i.access_code) : '••••-••••'}</span>
        <span class="code-toggle" onclick="toggleCode(${i.id})" title="Show/hide access code">
          <svg viewBox="0 0 24 24">${visible
            ? '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.62 21.62 0 0 1 5.06-6.06M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a21.6 21.6 0 0 1-2.61 3.94M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
            : '<path d="M1 backward 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'}</svg>
        </span>
      </td>
      <td style="width:12%">${statusBdg}</td>
      <td style="width:14%;text-align:right">
        <div class="row-actions" style="justify-content:flex-end">
          <div class="act-icbtn edit" title="Edit instructor" aria-label="Edit instructor" onclick="openEditInstructor(${i.id})">
            <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
          </div>
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

function handleCopyKey(event, copy){
  if(event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  copy();
}

async function copyInstructorValue(id, field){
  const instructor = instructors.find(item => String(item.id) === String(id));
  const value = instructor && instructor[field];
  if(!value) return;

  try {
    await navigator.clipboard.writeText(String(value));
    showToast(`${field === 'faculty_id' ? 'Faculty ID' : 'Access code'} copied.`);
  } catch {
    showToast('Unable to copy. Clipboard access is unavailable.');
  }
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
  editingInstructorId = null;
  document.getElementById('modalOverlay').classList.add('show');
  document.getElementById('instructorForm').reset();
  document.getElementById('instructorModalTitle').textContent = 'Add Instructor';
  document.getElementById('instructorModalDescription').textContent = 'Create a new faculty account under a department';
  document.getElementById('instructorSubmitButton').innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Save Instructor';
  document.querySelectorAll('.create-only').forEach(field => { field.hidden = false; });
  ['f-dept','f-name','f-facid','f-code','f-course','f-class-year','f-class-section','f-held-classes'].forEach(id=>document.getElementById(id).classList.remove('invalid'));
  heldClasses = [];
  renderHeldClasses();
  refreshInstructorCourses();
  document.getElementById('deptInput').focus();
}

function openEditInstructor(id){
  const instructor = instructors.find(item => String(item.id) === String(id));
  if(!instructor) return;
  editingInstructorId = instructor.id;
  document.getElementById('instructorForm').reset();
  document.getElementById('modalOverlay').classList.add('show');
  document.getElementById('instructorModalTitle').textContent = 'Edit Instructor';
  document.getElementById('instructorModalDescription').textContent = 'Update the instructor profile and held classes';
  document.getElementById('instructorSubmitButton').innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Save Changes';
  document.querySelectorAll('.create-only').forEach(field => { field.hidden = true; });
  ['f-dept','f-name','f-course','f-class-year','f-class-section','f-held-classes'].forEach(fieldId => document.getElementById(fieldId).classList.remove('invalid'));
  document.getElementById('deptInput').value = String(departments.find(department => department.name === instructor.department)?.id || '');
  refreshInstructorCourses();
  document.getElementById('courseInput').value = String(instructor.course_id || '');
  document.getElementById('nameInput').value = instructor.name || '';
  heldClasses = Array.isArray(instructor.held_classes) ? instructor.held_classes.map(item => ({
    year_level: item.year_level,
    section_id: Number(item.section_id),
    section_name: item.section_name
  })) : [];
  renderHeldClasses();
  document.getElementById('deptInput').focus();
}

function refreshInstructorCourses(){
  const departmentId = document.getElementById('deptInput').value;
  const courseSelect = document.getElementById('courseInput');
  const currentCourseId = courseSelect.value;
  const availableCourses = courses.filter(course => String(course.department_id) === departmentId);
  courseSelect.innerHTML = availableCourses.length
    ? '<option value="">-- Select a course --</option>' +
      availableCourses.map(course=>`<option value="${course.id}">${escapeHtml(course.name)}</option>`).join('')
    : '<option value="">-- No courses for this department --</option>';
  courseSelect.disabled = !availableCourses.length;
  if(availableCourses.some(course => String(course.id) === currentCourseId)){
    courseSelect.value = currentCourseId;
  }
  syncHeldClassesToSelectedCourse();
  refreshHeldClassSections();
}

document.getElementById('deptInput').addEventListener('change', refreshInstructorCourses);
document.getElementById('deptInput').addEventListener('change', () => {
  document.getElementById('f-course').classList.remove('invalid');
});
document.getElementById('courseInput').addEventListener('change', () => {
  syncHeldClassesToSelectedCourse();
  refreshHeldClassSections();
});
document.getElementById('classYearInput').addEventListener('change', refreshHeldClassSections);

function syncHeldClassesToSelectedCourse(){
  const selectedCourse = courses.find(course => String(course.id) === document.getElementById('courseInput').value);
  heldClasses = selectedCourse
    ? heldClasses.filter(item => sections.some(section =>
        Number(section.id) === Number(item.section_id) &&
        String(section.course).toLowerCase() === selectedCourse.name.toLowerCase()))
    : [];
  renderHeldClasses();
}

function refreshHeldClassSections(){
  const courseId = document.getElementById('courseInput').value;
  const yearLevel = document.getElementById('classYearInput').value;
  const sectionSelect = document.getElementById('classSectionInput');
  const previousSectionId = sectionSelect.value;
  const selectedCourse = courses.find(course => String(course.id) === courseId);
  const availableSections = selectedCourse && yearLevel
    ? sections.filter(section => String(section.course).toLowerCase() === selectedCourse.name.toLowerCase())
    : [];
  sectionSelect.innerHTML = availableSections.length
    ? '<option value="">-- Select a section --</option>' +
      availableSections.map(section => `<option value="${section.id}">${escapeHtml(section.name)}</option>`).join('')
    : '<option value="">-- No sections for this course --</option>';
  sectionSelect.disabled = !availableSections.length;
  if(availableSections.some(section => String(section.id) === previousSectionId)){
    sectionSelect.value = previousSectionId;
  } else if(availableSections.length === 1){
    sectionSelect.value = String(availableSections[0].id);
  }
}

function addHeldClass(){
  const yearLevel = document.getElementById('classYearInput').value;
  const sectionId = Number(document.getElementById('classSectionInput').value);
  const section = sections.find(item => Number(item.id) === sectionId);
  if(!yearLevel || !sectionId || !section){
    showToast('Select a year level and section first.');
    return;
  }
  if(heldClasses.some(item => item.year_level === yearLevel && Number(item.section_id) === sectionId)){
    showToast('That held class is already added.');
    return;
  }
  heldClasses.push({ year_level: yearLevel, section_id: sectionId, section_name: section.name });
  renderHeldClasses();
  document.getElementById('classYearInput').value = '';
  refreshHeldClassSections();
}

function removeHeldClass(index){
  heldClasses.splice(index, 1);
  renderHeldClasses();
}

function renderHeldClasses(){
  const list = document.getElementById('heldClassList');
  if(!list) return;
  list.innerHTML = heldClasses.map((item, index) => `
    <span class="held-class-chip">
      ${escapeHtml(item.year_level)} · ${escapeHtml(item.section_name || sections.find(section => Number(section.id) === Number(item.section_id))?.name || 'Section')}
      <button type="button" aria-label="Remove held class" onclick="removeHeldClass(${index})">×</button>
    </span>
  `).join('');
}

function openDepartmentModal(){
  document.getElementById('departmentForm').reset();
  document.getElementById('f-new-department').classList.remove('invalid');
  document.getElementById('departmentModalOverlay').classList.add('show');
  document.getElementById('newDepartmentInput').focus();
}

function closeDepartmentModal(){
  document.getElementById('departmentModalOverlay').classList.remove('show');
}

document.getElementById('departmentModalOverlay').addEventListener('click', event=>{
  if(event.target.id === 'departmentModalOverlay') closeDepartmentModal();
});

async function saveDepartment(event){
  event.preventDefault();
  const input = document.getElementById('newDepartmentInput');
  const name = input.value.trim();
  if(!name){
    document.getElementById('f-new-department').classList.add('invalid');
    input.focus();
    return false;
  }
  document.getElementById('f-new-department').classList.remove('invalid');

  try {
    const department = await api('/api/admin/departments', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    if(!departments.some(item => item.name.toLowerCase() === department.name.toLowerCase())){
      departments.push(department);
    }
    closeDepartmentModal();
    renderTables();
    showToast(`${department.name} is ready to use.`);
  } catch(err) {
    showToast('Error: ' + err.message);
  }
  return false;
}

function openCourseModal(){
  document.getElementById('courseForm').reset();
  document.getElementById('f-course-department').classList.remove('invalid');
  document.getElementById('f-new-course').classList.remove('invalid');
  document.getElementById('courseModalOverlay').classList.add('show');
  document.getElementById('courseDepartmentInput').focus();
}

function closeCourseModal(){
  document.getElementById('courseModalOverlay').classList.remove('show');
}

document.getElementById('courseModalOverlay').addEventListener('click', event=>{
  if(event.target.id === 'courseModalOverlay') closeCourseModal();
});

async function saveCourse(event){
  event.preventDefault();
  const departmentId = document.getElementById('courseDepartmentInput').value;
  const nameInput = document.getElementById('newCourseInput');
  const name = nameInput.value.trim();
  const departmentField = document.getElementById('f-course-department');
  const courseField = document.getElementById('f-new-course');
  departmentField.classList.toggle('invalid', !departmentId);
  courseField.classList.toggle('invalid', !name);
  if(!departmentId || !name){
    return false;
  }

  try {
    const course = await api('/api/admin/courses', {
      method: 'POST',
      body: JSON.stringify({ department_id: Number(departmentId), name })
    });
    const existingIndex = courses.findIndex(item =>
      String(item.department_id) === String(course.department_id) &&
      item.name.toLowerCase() === course.name.toLowerCase()
    );
    const alreadyExists = existingIndex !== -1;
    if(existingIndex === -1) courses.push(course);
    else courses[existingIndex] = course;
    closeCourseModal();
    showToast(alreadyExists
      ? `${course.name} already exists under ${course.department}.`
      : `${course.name} added under ${course.department}.`);
  } catch(err) {
    showToast('Error: ' + err.message);
  }
  return false;
}

function closeModal(){
  document.getElementById('modalOverlay').classList.remove('show');
  editingInstructorId = null;
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




function submitInstructor(e){
  e.preventDefault();
  const departmentId = document.getElementById('deptInput').value;
  const courseId = document.getElementById('courseInput').value;
  const department = departments.find(item => String(item.id) === departmentId);
  const course = courses.find(item => String(item.id) === courseId);
  const dept = department?.name || '';
  const name = document.getElementById('nameInput').value.trim();
  const creating = editingInstructorId === null;
  const facultyId = creating ? document.getElementById('facIdInput').value.trim() : '';
  const code = creating ? document.getElementById('codeInput').value.trim() : '';

  let valid = true;
  const checks = [
    ['f-dept', departmentId],
    ['f-course', courseId],
    ['f-name', name]
  ];
  if(creating) checks.push(['f-facid', facultyId], ['f-code', code]);
  checks.forEach(([fid, val])=>{
    const el = document.getElementById(fid);
    if(!val){ el.classList.add('invalid'); valid = false; }
    else { el.classList.remove('invalid'); }
  });

  if(creating && instructors.some(i => uc(i.faculty_id) === uc(facultyId))){
    document.getElementById('f-facid').classList.add('invalid');
    document.querySelector('#f-facid .field-error').textContent = 'This Faculty ID already exists.';
    valid = false;
  }
  if(heldClasses.length === 0){
    document.getElementById('f-held-classes').classList.add('invalid');
    valid = false;
  } else {
    document.getElementById('f-held-classes').classList.remove('invalid');
  }

  if(!valid) return false;

  const payload = {
      name,
      department_id: Number(departmentId),
      course_id: Number(courseId),
      held_classes: heldClasses.map(({ year_level, section_id }) => ({ year_level, section_id }))
  };
  const request = creating
    ? api('/api/instructors', {
        method: 'POST',
        body: JSON.stringify({ ...payload, faculty_id: facultyId, access_code: code })
      })
    : api(`/api/instructors/${editingInstructorId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
  request.then(async () => {
    closeModal();
    await loadInstructors();
    showToast(creating
      ? `${name} added to ${course?.name || dept}.`
      : `${name}'s instructor details were updated.`);
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
// Populate top-right admin name from login session
(function populateAdminName(){
  const el = document.getElementById('topAvName');
  if(el){
    el.textContent = localStorage.getItem('adminName') || 'System Administrator';
  }
})();

function confirmLogout(event) {
    event.preventDefault();

    if (confirm("Are you sure you want to sign out?")) {
      clearAdminAuthSession();
        window.location.href = "wams-admin-log-in.html";
    }
}
