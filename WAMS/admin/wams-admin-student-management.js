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
      clearAdminAuthSession(token);
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
  const fromStudents = students.map(i=>i.dept);
  const fromSections = allSections.map(s=>s.course);
  return [...new Set([...fromStudents, ...fromSections].filter(Boolean))].sort();
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

  const grouped = {};
  // Seed every course/section (even those without students) so they still show up.
  // Only do this when not searching by text, and respect the program filter.
  if(!q){
    allSections.forEach(section=>{
      const course = section.course;
      if(!course) return;
      if(deptFilter && course !== deptFilter) return;
      if(!grouped[course]) grouped[course] = [];
    });
  }
  filtered.forEach(i=>{
    if(!grouped[i.dept]) grouped[i.dept] = [];
    grouped[i.dept].push(i);
  });

  const depts = Object.keys(grouped).sort();

  if(depts.length === 0){
    container.innerHTML = `
      <div class="card">
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div>No students match your search.</div>
        </div>
      </div>`;
    return;
  }

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
        <div class="row-actions">
          <div class="act-icbtn del" title="Delete this course" role="button" tabindex="0" aria-label="Delete course" onclick="deleteCourse('${escapeHtml(dept)}')" onkeydown="handleCopyKey(event, () => deleteCourse('${escapeHtml(dept)}'))">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
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
            ${rows.length
              ? rows.map(i=>rowHtml(i)).join('')
              : `<tr><td colspan="5"><div class="empty-state" style="padding:18px 0"><div>No students yet.</div></div></td></tr>`}
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
      <td style="width:20%"><span class="code-chip copyable" role="button" tabindex="0" aria-label="Copy Student ID" title="Copy Student ID" onclick="copyStudentId(${i.id})" onkeydown="handleCopyKey(event, () => copyStudentId(${i.id}))">${escapeHtml(i.studentId)}</span></td>
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

function handleCopyKey(event, copy){
  if(event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  copy();
}

async function copyStudentId(id){
  const student = students.find(item => String(item.id) === String(id));
  if(!student?.studentId) return;

  try {
    await navigator.clipboard.writeText(String(student.studentId));
    showToast('Student ID copied.');
  } catch {
    showToast('Unable to copy. Clipboard access is unavailable.');
  }
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

async function deleteCourse(course){
  const count = students.filter(i=>i.dept === course).length;
  openDeleteConfirmModal(
    `Delete Course "${course}"`,
    count
      ? `This will remove all ${count} student${count===1?'':'s'} enrolled in this course and all related data. This cannot be undone.`
      : `This will remove all data related to this course. This cannot be undone.`,
    course,
    async () => {
      try {
        await api("/api/sections/course?course=" + encodeURIComponent(course), { method: "DELETE" });
        await Promise.all([loadStudents(), loadSectionsForStudentForm()]);
        showToast(`Course "${course}" deleted.`);
      } catch (err) {
        showToast(err.message);
      }
    }
  );
}

// ── Delete Confirm Modal (type-to-confirm pattern) ──
let pendingDeleteConfirm = null; // { onConfirm, expectedValue }

function openDeleteConfirmModal(title, message, expectedValue, onConfirm){
  document.getElementById('deleteConfirmTitle').textContent = title;
  document.getElementById('deleteConfirmMessage').textContent = message;
  const input = document.getElementById('deleteConfirmInput');
  input.value = '';
  input.disabled = false;
  const btn = document.getElementById('deleteConfirmBtn');
  btn.disabled = true;
  pendingDeleteConfirm = { onConfirm, expectedValue };
  document.getElementById('deleteConfirmModalOverlay').classList.add('show');
  input.focus();
}

function closeDeleteConfirmModal(){
  document.getElementById('deleteConfirmModalOverlay').classList.remove('show');
  pendingDeleteConfirm = null;
  document.getElementById('deleteConfirmInput').value = '';
  document.getElementById('deleteConfirmBtn').disabled = true;
}

document.getElementById('deleteConfirmInput').addEventListener('input', function(){
  if(!pendingDeleteConfirm) return;
  const val = this.value.trim();
  const expected = pendingDeleteConfirm.expectedValue;
  document.getElementById('deleteConfirmBtn').disabled = !(val === 'DELETE' || val === expected);
});

document.getElementById('deleteConfirmModalOverlay').addEventListener('click', event=>{
  if(event.target.id === 'deleteConfirmModalOverlay') closeDeleteConfirmModal();
});

document.getElementById('deleteConfirmInput').addEventListener('keydown', function(event){
  if(event.key === 'Enter' && !document.getElementById('deleteConfirmBtn').disabled){
    event.preventDefault();
    executeDeleteConfirm();
  }
});

async function executeDeleteConfirm(){
  if(!pendingDeleteConfirm) return;
  const { onConfirm } = pendingDeleteConfirm;
  closeDeleteConfirmModal();
  await onConfirm();
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
let allSections = [];
let courses = [];
let createSectionCourse = '';

// Year Level <-> Section are correlated multi-selects.
// Choosing year level(s) narrows the section list to those year levels;
// if a year level has exactly one section it is auto-selected, so a
// single-section course just defaults to e.g. "BSIT - 1".
const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year'];

let sectionMs = null;   // multi-select for sections

function sectionsForCourse(course){
  const key = uc(course);
  if(!key) return [];
  return allSections.filter(section => uc(section.course) === key);
}

// "BSIT - 1" -> "1st Year"; unparseable names fall back to the 1st Year bucket.
function yearLevelFromSectionName(name){
  const text = String(name || '').trim();
  if(/^1st\b|\b1st year\b/i.test(text)) return '1st Year';
  if(/^2nd\b|\b2nd year\b/i.test(text)) return '2nd Year';
  if(/^3rd\b|\b3rd year\b/i.test(text)) return '3rd Year';
  if(/^4th\b|\b4th year\b/i.test(text)) return '4th Year';
  if(/^5th\b|\b5th year\b/i.test(text)) return '5th Year';
  const trailing = text.match(/(\d+)\s*$/);
  if(trailing){
    const n = Number(trailing[1]);
    if(n >= 1 && n <= 5) return YEAR_LEVELS[n - 1];
  }
  return '1st Year';
}

// Build "1st Year (BSIT - 1)" style labels, one option per section.
function sectionOptionLabel(section){
  const year = section.year_level || yearLevelFromSectionName(section.name);
  return `${year} (${section.name || 'Section'})`;
}

function initStudentPickers() {
  if (typeof createMultiSelect !== 'function') return;
  if (!sectionMs) {
    sectionMs = createMultiSelect({
      mountId: 'sectionMultiselect',
      placeholder: '-- Select a course first --'
    });
  }
}

function refreshSectionPicker() {
  initStudentPickers();
  if (!sectionMs) return;
  const course = document.getElementById('courseInput').value.trim();
  const sections = sectionsForCourse(course);

  const previous = sectionMs.getValues();
  sectionMs.setOptions(
    sections.map(section => ({ value: section.id, label: sectionOptionLabel(section) })),
    true
  );
  // Keep any previously picked section that is still visible.
  sectionMs.setValues(previous.filter(id =>
    sections.some(section => String(section.id) === String(id)))
  );

  if (!course) {
    sectionMs.setPlaceholder('-- Select a course first --');
    return;
  }
  if (!sections.length) {
    sectionMs.setPlaceholder('-- No sections for this course --');
    return;
  }
  sectionMs.setPlaceholder('-- Select a section --');

  // A single-section course is unambiguous: default to it (e.g. BSIT - 1).
  if (!sectionMs.getValues().length && sections.length === 1) {
    sectionMs.setValues([sections[0].id]);
  }
}

function renderAddStudentCourseSelect() {
  const select = document.getElementById('courseInput');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">-- Select a course --</option>' +
    (courses.length
      ? courses.map(course => `<option value="${escapeHtml(course.name)}">${escapeHtml(course.name)}</option>`).join('')
      : '<option value="" disabled>-- No courses added yet --</option>');
  select.disabled = !courses.length;
  if (courses.some(course => course.name === current)) select.value = current;
}

async function loadSectionsForStudentForm() {
  try {
    const data = await api("/api/sections");
    availableSections = data;
    // Keep a locally-created section/sections for courses the instructor-scoped
    // /api/sections response may not include, so the picker never loses them.
    const seen = new Set(data.map(section => Number(section.id)));
    allSections = data.concat(allSections.filter(section => !seen.has(Number(section.id))));
    initStudentPickers();
    refreshSectionPicker();
    renderTables();
  } catch (err) {
    console.error(err);
  }
  try {
    courses = (await api("/api/admin/courses")) || [];
  } catch (err) {
    console.error(err);
    courses = [];
  }
  courses.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  renderAddStudentCourseSelect();
}

function openCreateSection() {
  document.getElementById('sectionModalOverlay').classList.add('show');
  // The course is taken from the Add Student form context; only the year level
  // is chosen here. Sections are stored under that course name.
  createSectionCourse = document.getElementById('courseInput').value.trim();
  document.getElementById('sectionYearSelect').value = '';
  document.getElementById('sectionNameInput').value = '';
  ['f-section-year', 'f-section-name'].forEach(id => document.getElementById(id).classList.remove('invalid'));
  document.getElementById('sectionYearSelect').focus();
}

// Changing the year should clear its error immediately, so a picked value is
// visibly accepted while the modal is still open.
document.getElementById('sectionYearSelect').addEventListener('change', () => {
  document.getElementById('f-section-year').classList.remove('invalid');
});

document.getElementById('sectionNameInput').addEventListener('input', () => {
  document.getElementById('f-section-name').classList.remove('invalid');
});

function studentSectionName(course, courseCode){
  const suffix = (courseCode || '').trim() || '1';
  return `${course} - ${suffix}`;
}

function closeSectionModal() {
  document.getElementById('sectionModalOverlay').classList.remove('show');
}

document.getElementById('sectionModalOverlay').addEventListener('click', e => {
  if (e.target.id === 'sectionModalOverlay') closeSectionModal();
});

let sectionCreating = false;

async function createSection(e) {
  e.preventDefault();
  if (sectionCreating) return false; // guard against double-submit creating duplicates
  // The course <select> stores the course *id*; sections store the course *name*.
  const courseId = createSectionCourse;
  const course = courses.find(item => String(item.id) === String(courseId));
  const courseName = course ? course.name : '';
  const year = document.getElementById('sectionYearSelect').value.trim();
  const nameInput = document.getElementById('sectionNameInput').value.trim();
  // Section name is optional. Left blank it follows the "BSIT - 3" convention:
  // the year level number, with the next number appended if that year already
  // has a section.
  const yearNumber = year ? year.split(' ')[0] : '';
  const siblingCount = course
    ? sectionsForCourse(courseName).filter(section =>
        (section.year_level || yearLevelFromSectionName(section.name)) === year).length
    : 0;
  const sectionName = nameInput || `${courseName} - ${yearNumber}${siblingCount ? ` (${siblingCount + 1})` : ''}`;

  // Validate both fields independently so the right error is always the one shown.
  const yearField = document.getElementById('f-section-year');
  const yearError = yearField.querySelector('.field-error');
  yearField.classList.toggle('invalid', !year);
  if (!year) yearError.textContent = 'Please select a year level.';
  if (!course) {
    yearField.classList.add('invalid');
    yearError.textContent = 'Pick a course in the form first, then create a section.';
  }
  document.getElementById('f-section-name').classList.remove('invalid');

  if (!year || !course) {
    (year ? document.getElementById('sectionNameInput') : yearField).focus();
    return false;
  }

  sectionCreating = true;
  try {
    const section = await api("/api/sections", {
      method: "POST",
      body: JSON.stringify({
        name: sectionName,
        course: courseName,
        year_level: year
      })
    });

    if (!section || section.id == null) {
      throw new Error(`Could not create section "${sectionName}". Please try again.`);
    }

    await loadSectionsForStudentForm();
    // Select the newly created section in the Add Student form.
    if(String(courseId) === document.getElementById('courseInput').value.trim() && sectionMs){
      sectionMs.setValues([...new Set([...sectionMs.getValues(), section.id])]);
      // Keep the label in sync (setValues alone does not re-resolve the summary).
      sectionMs.render();
    }
    closeSectionModal();
    showToast(`Section "${sectionName}" added and selected.`);
  } catch (err) {
    showToast(err.message || `Could not create section "${sectionName}".`);
  } finally {
    sectionCreating = false;
  }

  return false;
}

function openModal(){
  document.getElementById('modalOverlay').classList.add('show');
  document.getElementById('studentForm').reset();
  ['f-course','f-section','f-name','f-facid'].forEach(id=>document.getElementById(id).classList.remove('invalid'));
  initStudentPickers();
  loadSectionsForStudentForm();
  document.getElementById('courseInput').focus();
}

// Course selection drives the section picker.
document.getElementById('courseInput').addEventListener('change', () => {
  document.getElementById('f-course').classList.remove('invalid');
  refreshSectionPicker();
});

document.addEventListener('click', event => {
  document.querySelectorAll('.ms.open').forEach(node => {
    if(!node.contains(event.target)) node.classList.remove('open');
  });
});

function closeModal(){
  document.getElementById('modalOverlay').classList.remove('show');
}
document.getElementById('modalOverlay').addEventListener('click', e=>{
  if(e.target.id === 'modalOverlay') closeModal();
});



function submitStudent(e){
  e.preventDefault();
  initStudentPickers();
  const sectionIds = sectionMs ? sectionMs.getValues().map(id => parseInt(id)).filter(id => !isNaN(id)) : [];
  const name = document.getElementById('nameInput').value.trim();
  const studentId = document.getElementById("facIdInput").value.trim();
  const course = document.getElementById('courseInput').value.trim();

  let valid = true;
  const checks = [
    ['f-course', course],
    ['f-name', name],
    ['f-facid', studentId],
  ];
  checks.forEach(([fid, val])=>{
    const el = document.getElementById(fid);
    if(!val){ el.classList.add('invalid'); valid = false; }
    else { el.classList.remove('invalid'); }
  });

  // Require at least one section when the course already has sections to pick from.
  const sectionField = document.getElementById('f-section');
  if(!sectionIds.length && sectionsForCourse(course).length){
    sectionField.classList.add('invalid');
    valid = false;
  } else {
    sectionField.classList.remove('invalid');
  }

  if(students.some(i => uc(i.studentId) === uc(studentId))){
    document.getElementById('f-facid').classList.add('invalid');
    document.querySelector('#f-facid .field-error').textContent = 'This Student ID already exists.';
    valid = false;
  }

  if(!valid) return false;

  // One student record per selected section; the year level is taken from
  // the section itself (or falls back to 1st Year).
  const enrollments = sectionIds.length
    ? sectionIds.map(id => {
        const section = allSections.find(item => Number(item.id) === Number(id));
        return {
          sectionId: Number(id),
          year: (section && sectionOptionYear(section)) || '1st Year'
        };
      })
    : [{ sectionId: undefined, year: '1st Year' }];

  Promise.all(enrollments.map(({ sectionId, year }) => api("/api/students", {
    method: "POST",
    body: JSON.stringify({ sectionId, course, name, studentId, year })
  }))).then(async () => {
    closeModal();
    await loadStudents();
    showToast(enrollments.length > 1
      ? `${name} added to ${enrollments.length} sections.`
      : `${name} added successfully.`);
  }).catch(err => {
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
  await verifyAdminAuth();
})();

// ── Init
// Populate top-right admin name from login session
(function populateAdminName(){
  const el = document.getElementById('topAvName');
  if(el){
    el.textContent = localStorage.getItem('adminName') || 'System Administrator';
  }
})();

loadStudents();
loadSectionsForStudentForm();
function confirmLogout(event) {
    event.preventDefault();

    if (confirm("Are you sure you want to sign out?")) {
      clearAdminAuthSession();
        localStorage.removeItem('wamsCurrentUserId');
        window.location.href = "wams-admin-log-in.html";
    }
}
