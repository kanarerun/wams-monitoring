/* ── Auth Guard ── */
(async function checkProfessorAuth(){
  const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
  if(!token){
    window.location.href = 'wams-professor-log-in.html';
    return;
  }
  try {
    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if(!res.ok){
      localStorage.removeItem('wamsToken');
      localStorage.removeItem('token');
      window.location.href = 'wams-professor-log-in.html';
      return;
    }
    const me = await res.json();
    if(me && me.role !== 'professor'){ window.location.href = 'wams-professor-log-in.html'; }
  } catch {}
})();

function toggleSb(){
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}

/* ───── Exam data store - professor-specific ───── */
// Use professor-specific localStorage key based on logged-in user
function getStorageKey() {
  const userId = localStorage.getItem('wamsCurrentUserId') || 'local';
  return 'wamsProfessorExams_' + userId;
}

function loadExams(){
  try {
    const raw = localStorage.getItem(getStorageKey());
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveExams(list){
  localStorage.setItem(getStorageKey(), JSON.stringify(list));
}

function buildStudentExamUrl(exam){
  if(exam.type === 'wams-quiz'){
    const url = new URL('../student/wams-student-exam-tool.html', window.location.href);
    url.searchParams.set('examId', exam.id);
    return url.toString();
  }
  const studentPageUrl = new URL('../student/wams-student-exam-tool-gform.html', window.location.href);
  studentPageUrl.searchParams.set('examId', exam.id);
  if(exam.link){
    studentPageUrl.searchParams.set('gform', exam.link);
  }
  return studentPageUrl.toString();
}

function copyExamCode(id){
  const exam = examData.find(e => e.id === id);
  if(!exam) return;

  const code = exam.accessCode || exam.code || exam.id;
  if(!code){
    showToast('No exam code available for this exam.');
    return;
  }

  navigator.clipboard.writeText(code)
    .then(() => showToast('Exam code copied.'))
    .catch(() => showToast('Unable to copy exam code.'));
}

let examData = [];
let currentFilter = 'all';
let currentSearch = '';
let editingId = null;

// Load exams from server (professor-specific)
async function loadExamsFromServer() {
  const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
  if (!token) {
    examData = loadExams(); // fallback to local
    renderList();
    return;
  }

  try {
    const res = await fetch('/api/my-exams', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) throw new Error('Failed to load exams');
    const serverExams = await res.json();

    // Safely parse JSON fields so a malformed field never breaks the whole list
    const safeParse = (val, fallback) => {
      if (val === null || val === undefined) return fallback;
      if (typeof val !== 'string') return val;
      try { return JSON.parse(val); } catch { return fallback; }
    };

    // Transform server exams to match frontend format
    examData = serverExams.map(e => ({
      id: e.id,
      title: e.title,
      section: e.section_name || e.section || 'General',
      section_id: e.section_id,
      students: e.students || 0,
      flagged: e.flagged || 0,
      status: e.status || 'scheduled',
      type: e.type === 'gforms' ? 'gforms' : 'wams-quiz',
      created: new Date(e.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
      timeLimit: e.time_limit || 60,
      schedule: e.schedule || '',
      link: e.link || '',
      accessCode: e.accessCode || 'N/A',
      monitor: safeParse(e.monitor_settings, { cam: true, audio: true, screen: true, tab: true, face: false }),
      tools: safeParse(e.tools_settings, { calculator: true, whiteboard: true, camera: true }),
      questions: safeParse(e.questions, [])
    }));

    // Also save locally for offline/badge use
    saveExams(examData);

    renderList();
    renderSidebarBadges();
  } catch(err) {
    console.warn('Failed to load from server, using local:', err);
    // Merge local exams with any server data we might have
    const localExams = loadExams();
    if (localExams.length > 0) {
      examData = localExams;
    }
    renderList();
  }
}

function statusBadge(status){
  if(status === 'live') return '<span class="bdg bdg-green"><span class="pulse"></span>Live</span>';
  if(status === 'upcoming') return '<span class="bdg bdg-amber"><span class="bdg-dot"></span>Upcoming</span>';
  if(status === 'ended') return '<span class="bdg bdg-gray"><span class="bdg-dot"></span>Ended</span>';
  return '<span class="bdg bdg-gray"><span class="bdg-dot"></span>Scheduled</span>';
}

function typeIcon(type){
  if(type === 'gforms'){
    return {bg:'var(--purple-bg)', color:'var(--purple)', svg:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="8" x2="17" y2="8"/><line x1="9" y1="12" x2="17" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>', label:'Google Forms'};
  }
  return {bg:'var(--blue-bg)', color:'var(--blue)', svg:'<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>', label:'WAMS Quiz'};
}

function renderList(){
  const tbody = document.getElementById('examTbody');
  let rows = examData.filter(e => currentFilter === 'all' || e.status === currentFilter);
  if(currentSearch){
    rows = rows.filter(e => e.title.toLowerCase().includes(currentSearch) || e.section.toLowerCase().includes(currentSearch));
  }

  document.getElementById('cntAll').textContent = examData.length;
  document.getElementById('cntLive').textContent = examData.filter(e=>e.status==='live').length;
  document.getElementById('cntUpcoming').textContent = examData.filter(e=>e.status==='upcoming').length;
  document.getElementById('cntScheduled').textContent = examData.filter(e=>e.status==='scheduled').length;
  document.getElementById('cntEnded').textContent = examData.filter(e=>e.status==='ended').length;

  if(rows.length === 0){
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No exams yet. Create your first exam to see it here.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(e => {
    const ic = typeIcon(e.type);
    return `
    <tr>
      <td>
        <div class="exam-name-cell">
          <div class="exam-icon-sm" style="background:${ic.bg};color:${ic.color}">${ic.svg}</div>
          <div class="exam-name-txt">
            <b>${e.title}</b>
            <span>${ic.label}</span>
          </div>
        </div>
      </td>
      <td style="color:var(--tx2)">${e.section}</td>
      <td style="color:var(--tx2)">${e.students}</td>
      <td>${statusBadge(e.status)}</td>
      <td style="color:var(--tx3)">${e.created}</td>
      <td>
        <div class="row-actions">
          <div class="icon-action" title="Copy Code" onclick="copyExamCode(${e.id})">
            <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </div>
          <div class="icon-action" title="Edit" onclick="openEdit(${e.id})">
            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
          </div>
          <div class="icon-action danger" title="Delete" onclick="quickDelete(${e.id})">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function filterExams(filter, el){
  currentFilter = filter;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderList();
}

function searchExams(val){
  currentSearch = val.toLowerCase();
  renderList();
}

async function quickDelete(id){
  const exam = examData.find(e => e.id === id);
  if(!exam) return showToast('Exam not found');
  if(!confirm(`Delete "${exam.title}"? This cannot be undone.`)) return;

  const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
  if (!token) {
    return showToast('You must be logged in as a professor to delete exams.');
  }

  if (token) {
    try {
      const res = await fetch('/api/exams/' + id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          try { const body = await res.json().catch(()=>({}));
            showToast((body && body.error) ? ('Auth error: ' + body.error) : 'Authentication error — please log in.');
          } catch(e) { showToast('Authentication error — please log in.'); }
          return;
        }
        const body = await res.json().catch(()=>({}));
        return showToast('Server delete failed: ' + (body.error || res.statusText));
      }
    } catch (err) {
      console.warn('Failed to delete from server:', err);
      return showToast('Network error while deleting exam.');
    }
  }

  const idx = examData.findIndex(e => e.id === id);
  if (idx !== -1) examData.splice(idx, 1);
  saveExams(examData);
  // Broadcast a simple refresh signal for other tabs (live-monitor listens for storage)
  try { localStorage.setItem('wamsLiveMonitorRefresh', String(Date.now())); } catch {}
  renderList();
  renderSidebarBadges();
  showToast('Exam deleted.');
}

/* ───── Edit view ───── */
function openEdit(id){
  editingId = id;
  const e = examData.find(x => x.id === id);
  if(!e){
    showToast('Error: Exam not found');
    return;
  }
    const ic = typeIcon(e.type);

    document.getElementById('editModeIcon').style.background = ic.bg;
    document.getElementById('editModeIcon').style.color = ic.color;
    document.getElementById('editModeIcon').innerHTML = ic.svg;
    document.getElementById('editModeTitle').textContent = ic.label + ' Exam';
    document.getElementById('editModeSub').textContent = 'Editing exam details and monitoring settings';

    e.title = e.title || 'Untitled Exam';
    e.section = e.section || 'TBD';
    e.timeLimit = e.timeLimit || 60;
    e.status = e.status || 'scheduled';

    document.getElementById('editTitle').value = e.title;
    document.getElementById('editSection').value = e.section;
    document.getElementById('editTimeLimit').value = e.timeLimit;
    document.getElementById('editSchedule').value = e.schedule || '';

    document.querySelectorAll('.status-pill').forEach(p => {
      p.classList.remove('sel-live','sel-upcoming','sel-scheduled','sel-ended');
      if(p.dataset.status === e.status){
        p.classList.add('sel-' + e.status);
      }
    });

  const isGforms = e.type === 'gforms';
  if(isGforms){
    document.getElementById('gformsCard').style.display = 'block';
    document.getElementById('quizCard').style.display = 'none';
    document.getElementById('editGformsLink').value = e.link || '';
  } else {
    document.getElementById('gformsCard').style.display = 'none';
    document.getElementById('quizCard').style.display = 'block';
    let questions = e.questions;
    if(!questions){
      questions = [];
    } else if(typeof questions === 'string'){
      try {
        questions = JSON.parse(questions);
      } catch {
        questions = [];
      }
    }
    if(!Array.isArray(questions) || questions.length === 0){
      questions = [{ text: 'Sample question', qtype: 'mc', choices: ['Choice A', 'Choice B', 'Choice C', 'Choice D'], correct: 0 }];
    }
    renderQuestions(questions);
  }

  const tglCamEl = document.getElementById('tglCam');
  const tglAudioEl = document.getElementById('tglAudio');
  const tglScreenEl = document.getElementById('tglScreen');
  const tglTabEl = document.getElementById('tglTab');
  const tglFaceEl = document.getElementById('tglFace');
  const tglCalcEl = document.getElementById('tglCalc');
  const tglWhiteboardEl = document.getElementById('tglWhiteboard');
  const tglCameraEl = document.getElementById('tglCamera');

  if(tglCamEl) tglCamEl.checked = e.monitor ? e.monitor.cam : true;
  if(tglAudioEl) tglAudioEl.checked = e.monitor ? e.monitor.audio : true;
  if(tglScreenEl) tglScreenEl.checked = e.monitor ? e.monitor.screen : true;
  if(tglTabEl) tglTabEl.checked = e.monitor ? e.monitor.tab : true;
  if(tglFaceEl) tglFaceEl.checked = e.monitor ? e.monitor.face : false;

  if(tglCalcEl) tglCalcEl.checked = e.tools ? e.tools.calculator : true;
  if(tglWhiteboardEl) tglWhiteboardEl.checked = e.tools ? e.tools.whiteboard : true;
  if(tglCameraEl) tglCameraEl.checked = e.tools ? e.tools.camera : true;

  document.getElementById('topTitle').textContent = 'Edit Exam';
  document.getElementById('topCrumb').innerHTML = `<span class="crumb-link" onclick="backToList()">My Exams</span> / Edit: ${e.title}`;

  switchView('viewEdit');
}

function selectStatus(el){
  document.querySelectorAll('.status-pill').forEach(p => {
    p.classList.remove('sel-live','sel-upcoming','sel-scheduled','sel-ended');
  });
  el.classList.add('sel-' + el.dataset.status);
}

function renderQuestions(questions){
  const wrap = document.getElementById('questionList');
  if(!wrap){
    console.error('questionList element not found');
    return;
  }
  if(!questions || questions.length === 0){
    questions = [{ text: 'Sample question', qtype: 'mc', choices: ['Choice A', 'Choice B', 'Choice C', 'Choice D'], correct: 0 }];
  }
  wrap.innerHTML = questions.map((q, i) => {
    const qn = i + 1;
    const qtype = q.qtype || 'mc';
    const selMc = qtype==='mc'?'selected':'';
    const selCb = qtype==='cb'?'selected':'';
    const selDd = qtype==='dd'?'selected':'';
    const selSa = qtype==='sa'?'selected':'';
    const selPg = qtype==='pg'?'selected':'';
    const selMg = qtype==='mg'?'selected':'';
    const selCg = qtype==='cg'?'selected':'';
    const ansBody = renderAnsBody(qtype, qn, q);
    const hint = hintForType(qtype);
    return '<div class="q-item" data-qnum="' + qn + '"><div class="q-item-hd"><span>Question ' + qn + '</span><button class="q-remove" onclick="removeQ(this)"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Remove</button></div><div class="field"><input type="text" value="' + q.text + '"></div><div class="qtype-row"><label>Question type:</label><select class="qtype-select" onchange="changeQType(this)"><option value="mc" ' + selMc + '>Multiple choice</option><option value="cb" ' + selCb + '>Checkboxes</option><option value="dd" ' + selDd + '>Dropdown</option><option value="sa" ' + selSa + '>Short answer</option><option value="pg" ' + selPg + '>Paragraph</option><option value="mg" ' + selMg + '>Multiple choice grid</option><option value="cg" ' + selCg + '>Checkbox grid</option></select></div><div class="ans-body">' + ansBody + '</div><div class="field-hint qhint">' + hint + '</div></div>';
  }).join('');
}

function renderAnsBody(type, qn, existing){
  const choices = (existing && existing.choices) || ['Choice A','Choice B','Choice C','Choice D'];
  const correct = existing ? existing.correct : 0;

  switch(type){
    case 'mc':
      return '<div class="choice-inputs">' + choices.map((c,ci) =>
        '<div class="choice-input-row"><input type="radio" name="q' + qn + '" ' + (ci===correct?'checked':'') + '><input type="text" value="' + c + '"></div>'
      ).join('') + '</div>';

    case 'cb':
      return '<div class="choice-inputs">' + choices.map((c) =>
        '<div class="choice-input-row"><input type="checkbox"><input type="text" value="' + c + '"></div>'
      ).join('') + '</div>';

    case 'dd':
      return '<div class="choice-inputs">' + choices.map((c,ci) =>
        '<div class="dd-row"><span>' + (ci+1) + '.</span><input type="text" value="' + c + '"></div>'
      ).join('') + '</div><span class="grid-add-link" onclick="addDropdownOption(this)"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add option</span>';

    case 'sa':
      return '<div class="ans-text-preview">Short answer text</div>';

    case 'pg':
      return '<div class="ans-text-preview tall">Long answer text</div>';

    case 'mg':
      return renderGrid('radio');

    case 'cg':
      return renderGrid('checkbox');

    default:
      return '';
  }
}

function renderGrid(inputType){
  const ts = Date.now();
  return '<div class="grid-wrap"><table class="grid-tbl"><thead><tr><th></th><th><input type="text" class="grid-col-input" value="Column 1"></th><th><input type="text" class="grid-col-input" value="Column 2"></th><th><input type="text" class="grid-col-input" value="Column 3"></th></tr></thead><tbody><tr><td><input type="text" class="grid-row-input" value="Row 1"></td><td><input type="' + inputType + '" name="grid-' + ts + '-1"></td><td><input type="' + inputType + '" name="grid-' + ts + '-1"></td><td><input type="' + inputType + '" name="grid-' + ts + '-1"></td></tr><tr><td><input type="text" class="grid-row-input" value="Row 2"></td><td><input type="' + inputType + '" name="grid-' + ts + '-2"></td><td><input type="' + inputType + '" name="grid-' + ts + '-2"></td><td><input type="' + inputType + '" name="grid-' + ts + '-2"></td></tr></tbody></table></div><div class="grid-actions"><span class="grid-add-link" onclick="addGridRow(this)"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add row</span><span class="grid-add-link" onclick="addGridCol(this)"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>Add column</span></div>';
}

function hintForType(type){
  switch(type){
    case 'mc': return 'Select the radio button beside the correct answer.';
    case 'cb': return 'Check all answers that apply as correct.';
    case 'dd': return 'Students will choose one option from this dropdown list.';
    case 'sa': return 'Students will type a brief one-line answer.';
    case 'pg': return 'Students will type an extended, multi-sentence answer.';
    case 'mg': return 'Students select one option per row across the columns.';
    case 'cg': return 'Students may select multiple options per row across the columns.';
    default: return '';
  }
}

function changeQType(selectEl){
  const qItem = selectEl.closest('.q-item');
  const qn = qItem.dataset.qnum;
  const type = selectEl.value;
  qItem.querySelector('.ans-body').innerHTML = renderAnsBody(type, qn);
  qItem.querySelector('.qhint').textContent = hintForType(type);
}

let qAddCounter = 1000;
function addQuestion(){
  qAddCounter++;
  const wrap = document.getElementById('questionList');
  if(!wrap) return;
  const ansBody = renderAnsBody('mc', qAddCounter);
  const div = document.createElement('div');
  div.className = 'q-item';
  div.dataset.qnum = qAddCounter;
  div.innerHTML = '<div class="q-item-hd"><span>New Question</span><button class="q-remove" onclick="removeQ(this)"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Remove</button></div><div class="field"><input type="text" placeholder="Type your question here..."></div><div class="qtype-row"><label>Question type:</label><select class="qtype-select" onchange="changeQType(this)"><option value="mc" selected>Multiple choice</option><option value="cb">Checkboxes</option><option value="dd">Dropdown</option><option value="sa">Short answer</option><option value="pg">Paragraph</option><option value="mg">Multiple choice grid</option><option value="cg">Checkbox grid</option></select></div><div class="ans-body">' + ansBody + '</div><div class="field-hint qhint">Select the radio button beside the correct answer.</div>';
  wrap.appendChild(div);
}

function addDropdownOption(linkEl){
  const wrap = linkEl.previousElementSibling;
  if(!wrap) return;
  const n = wrap.querySelectorAll('.dd-row').length + 1;
  const row = document.createElement('div');
  row.className = 'dd-row';
  row.innerHTML = '<span>' + n + '.</span><input type="text" placeholder="Option ' + n + '">';
  wrap.appendChild(row);
}

function addGridRow(linkEl){
  const table = linkEl.closest('.ans-body').querySelector('.grid-tbl');
  const tbody = table.querySelector('tbody');
  const colCount = table.querySelectorAll('thead th').length - 1;
  const rowNum = tbody.querySelectorAll('tr').length + 1;
  const inputType = table.querySelector('tbody input[type=radio], tbody input[type=checkbox]').type;
  const ts = Date.now();
  let cells = '<td><input type="text" class="grid-row-input" value="Row ' + rowNum + '"></td>';
  for(let i=0;i<colCount;i++){
    cells += '<td><input type="' + inputType + '" name="grid-' + ts + '-' + rowNum + '"></td>';
  }
  const tr = document.createElement('tr');
  tr.innerHTML = cells;
  tbody.appendChild(tr);
}

function addGridCol(linkEl){
  const table = linkEl.closest('.ans-body').querySelector('.grid-tbl');
  const thead = table.querySelector('thead tr');
  const colNum = thead.querySelectorAll('th').length;
  const th = document.createElement('th');
  th.innerHTML = '<input type="text" class="grid-col-input" value="Column ' + colNum + '">';
  thead.appendChild(th);

  const inputType = table.querySelector('tbody input[type=radio], tbody input[type=checkbox]').type;
  const ts = Date.now();
  table.querySelectorAll('tbody tr').forEach((tr, idx)=>{
    const td = document.createElement('td');
    td.innerHTML = '<input type="' + inputType + '" name="grid-' + ts + '-' + idx + '">';
    tr.appendChild(td);
  });
}

function removeQ(btn){
  const items = document.querySelectorAll('#questionList .q-item');
  if(items.length <= 1){ btn.closest('.q-item').remove(); return; }
  btn.closest('.q-item').remove();
}

async function saveExamToServer(examDataObj) {
  const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
  if (!token) return;
  try {
    await fetch('/api/exams/' + examDataObj.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        title: examDataObj.title,
        section_id: examDataObj.section_id || examDataObj.section,
        section: examDataObj.section,
        time_limit: examDataObj.timeLimit,
        link: examDataObj.link || '',
        questions: examDataObj.questions ? JSON.stringify(examDataObj.questions) : null,
        monitor_settings: JSON.stringify(examDataObj.monitor || {}),
        tools_settings: JSON.stringify(examDataObj.tools || {}),
        status: examDataObj.status
      })
    });
  } catch(err) {
    console.warn('Failed to save to server:', err);
  }
}

function saveExam(){
  try {
    if(!editingId){
      showToast('Error: No exam selected for editing');
      return;
    }

    const e = examData.find(x => x.id === editingId);
    if(!e){
      showToast('Error: Exam not found');
      return;
    }

    const editTitle = document.getElementById('editTitle');
    const editSection = document.getElementById('editSection');
    const editTimeLimit = document.getElementById('editTimeLimit');
    const editSchedule = document.getElementById('editSchedule');
    const tglCam = document.getElementById('tglCam');
    const tglAudio = document.getElementById('tglAudio');
    const tglScreen = document.getElementById('tglScreen');
    const tglTab = document.getElementById('tglTab');
    const tglFace = document.getElementById('tglFace');
    const tglCalc = document.getElementById('tglCalc');
    const tglWhiteboard = document.getElementById('tglWhiteboard');
    const tglCamera = document.getElementById('tglCamera');

    if(!editTitle || !editSection){
      showToast('Error: Form elements not found');
      return;
    }

    e.title = editTitle.value || e.title;
    e.section = editSection.value;
    e.timeLimit = editTimeLimit ? editTimeLimit.value : e.timeLimit;
    e.schedule = editSchedule ? editSchedule.value : '';
    const selPill = document.querySelector('.status-pill[class*="sel-"]');
    if(selPill) e.status = selPill.dataset.status;
    e.monitor = {
      cam: tglCam ? tglCam.checked : true,
      audio: tglAudio ? tglAudio.checked : true,
      screen: tglScreen ? tglScreen.checked : true,
      tab: tglTab ? tglTab.checked : true,
      face: tglFace ? tglFace.checked : false,
    };
    e.tools = {
      calculator: tglCalc ? tglCalc.checked : true,
      whiteboard: tglWhiteboard ? tglWhiteboard.checked : true,
      // Camera tool toggle removed from UI — camera is managed under Sekyo Monitoring.
      // Preserve the previously stored value instead of resetting it.
      camera: e.tools ? e.tools.camera : true
    };
    if(e.type === 'gforms' || e.type === 'google'){
      e.link = document.getElementById('editGformsLink').value;
    }
    if(e.type !== 'gforms' && e.type !== 'google'){
      const items = document.querySelectorAll('#viewEdit .q-item');
      const questions = [];
      items.forEach(item => {
        const textInput = item.querySelector('.field input[type="text"]');
        const text = textInput ? textInput.value.trim() : '';
        if(!text) return;
        const typeSelect = item.querySelector('.qtype-select');
        const qtype = typeSelect ? typeSelect.value : 'mc';
        let choices = [];
        let correct = -1;
        if(qtype === 'mc'){
          const rows = item.querySelectorAll('.choice-input-row');
          rows.forEach((row, idx) => {
            const choiceInput = row.querySelector('input[type="text"]');
            const radio = row.querySelector('input[type="radio"]');
            if(choiceInput && choiceInput.value.trim()){
              choices.push(choiceInput.value.trim());
              if(radio && radio.checked) correct = idx;
            }
          });
        } else if(qtype === 'cb'){
          const rows = item.querySelectorAll('.choice-input-row');
          rows.forEach((row) => {
            const choiceInput = row.querySelector('input[type="text"]');
            if(choiceInput && choiceInput.value.trim()){
              choices.push(choiceInput.value.trim());
            }
          });
        } else if(qtype === 'dd'){
          const rows = item.querySelectorAll('.dd-row');
          rows.forEach((row) => {
            const input = row.querySelector('input');
            if(input && input.value.trim()){
              choices.push(input.value.trim());
            }
          });
        }
        questions.push({ text, qtype, choices, correct });
      });
      e.questions = questions.length > 0 ? questions : e.questions;
    }
    saveExams(examData);

    // Also save to server
    saveExamToServer(e);

    renderList();
    renderSidebarBadges();
    backToList();
    showToast('Changes saved successfully.');
  } catch(err){
    console.error('Save exam error:', err);
    showToast('Error saving exam: ' + err.message);
  }
}

function deleteExam(){
  const e = examData.find(x => x.id === editingId);
  if(confirm(`Delete "${e.title}"? This cannot be undone.`)){
    // Delete from server
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if (token) {
      fetch('/api/exams/' + editingId, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
      }).catch(err => console.warn('Failed to delete from server:', err));
    }
    const idx = examData.findIndex(x => x.id === editingId);
    examData.splice(idx, 1);
    saveExams(examData);
    renderList();
    renderSidebarBadges();
    backToList();
    showToast('Exam deleted.');
  }
}

function backToList(){
  document.getElementById('topTitle').textContent = 'My Exams';
  document.getElementById('topCrumb').textContent = '';
  switchView('viewList');
}

function switchView(id){
  document.querySelectorAll('.view').forEach(v => v.classList.remove('show'));
  document.getElementById(id).classList.add('show');
  document.querySelector('.page').scrollTop = 0;
}

function showToast(msg){
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 2600);
}

/* init - load exams from server */
loadExamsFromServer();

function renderSidebarBadges(){
  const exams = loadExams();
  const liveBadge = document.querySelector('a[href="wams-professor-live-monitor.html"] .sb-badge.green');
  const logsBadge = document.querySelector('a[href="wams-professor-monitoring-logs.html"] .sb-badge');
  if(liveBadge) liveBadge.textContent = exams.filter(ex => ['live', 'upcoming', 'scheduled'].includes(ex.status)).length;
  if(logsBadge) logsBadge.textContent = exams.filter(ex => ex.status === 'ended').length;
}

document.addEventListener('DOMContentLoaded', renderSidebarBadges);
window.addEventListener('storage', renderSidebarBadges);


function confirmLogout(event) {
    event.preventDefault();
    if (confirm("Are you sure you want to sign out?")) {
        localStorage.removeItem('wamsToken');
        localStorage.removeItem('token');
        window.location.href = "wams-professor-log-in.html";
    }
}
