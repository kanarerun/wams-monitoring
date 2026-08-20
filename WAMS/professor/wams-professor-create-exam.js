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

function getActiveExamMode(){
  if(document.getElementById('formGforms')?.classList.contains('show')) return 'gforms';
  return 'quiz';
}

function getProfessorExamStorageKey(){
  const userId = localStorage.getItem('wamsCurrentUserId') || 'local';
  return 'wamsProfessorExams_' + userId;
}

function loadLocalExamData(){
  try {
    const raw = localStorage.getItem(getProfessorExamStorageKey());
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalExamData(list){
  localStorage.setItem(getProfessorExamStorageKey(), JSON.stringify(list));
}

function persistExamLocally(exam){
  const exams = loadLocalExamData();
  exams.unshift(exam);
  saveLocalExamData(exams);
}

function collectQuizQuestions(){
  const items = document.querySelectorAll('#formQuiz .q-item');
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
  return questions;
}

let isCreatingExam = false;

function saveExamToServer(examObj, mode){
  if (isCreatingExam) return;
  isCreatingExam = true;

  const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
  if (!token) {
    isCreatingExam = false;
    alert("You must be logged in.");
    return;
  }

  fetch("/api/exams", {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({
      title: examObj.title,
      section_id: examObj.section_id,
      section: examObj.section,
      type: examObj.type === 'gforms' ? 'gforms' : 'wams-quiz',
      time_limit: examObj.timeLimit,
      link: examObj.link,
      schedule: examObj.schedule,
      accessCode: examObj.accessCode,
      questions: examObj.questions || [],
      monitor_settings: examObj.monitor,
      tools_settings: examObj.tools
    })
  })
  .then(async res => {
    if(!res.ok){
      const errorData = await res.json().catch(() => null);
      throw new Error(errorData?.error || 'Server error');
    }
    return res.json();
  })
  .then(serverExam => {
    const parseJsonField = (field, fallback) => {
      if (typeof field === 'string') {
        try { return JSON.parse(field); } catch { return fallback; }
      }
      return field || fallback;
    };

    const createdAt = serverExam.created_at || new Date().toISOString();
    const savedExam = {
      id: serverExam.id,
      title: serverExam.title,
      section: examObj.section,
      section_id: serverExam.section_id,
      students: 0,
      flagged: 0,
      status: serverExam.status || 'scheduled',
      type: serverExam.type === 'gforms' ? 'gforms' : 'wams-quiz',
      created: new Date(createdAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
      timeLimit: serverExam.time_limit,
      schedule: serverExam.schedule || '',
      link: serverExam.link || '',
      accessCode: serverExam.accessCode || examObj.accessCode,
      monitor: parseJsonField(serverExam.monitor_settings, examObj.monitor),
      tools: parseJsonField(serverExam.tools_settings, examObj.tools),
      questions: parseJsonField(serverExam.questions, examObj.questions || [])
    };

    persistExamLocally(savedExam);
    showExamLink(savedExam);
    renderSidebarBadges();
  })
  .catch(err => {
    console.error(err);
    alert("Failed to save exam: " + err.message);
  })
  .finally(() => {
    isCreatingExam = false;
  });
}

function createExamFromCurrentForm(){
  const mode = getActiveExamMode();
  const title = mode === 'gforms'
    ? (document.getElementById('gformsTitle')?.value || 'New Google Forms Exam')
    : (document.getElementById('quizTitle')?.value || 'New WAMS Quiz');
  const sectionSelect = document.getElementById(mode === 'gforms' ? 'gformsSection' : 'quizSection');
  const sectionId = sectionSelect ? parseInt(sectionSelect.value, 10) : '';
  const sectionName = sectionSelect ? sectionSelect.options[sectionSelect.selectedIndex]?.text || '' : '';
  if (!sectionId) {
    alert('Please select a section.');
    isCreatingExam = false;
    return;
  }
  const timeLimit = parseInt(mode === 'gforms'
    ? document.getElementById('gformsTimeLimit')?.value || '60'
    : document.getElementById('quizTimeLimit')?.value || '60', 10) || 60;
  const link = document.getElementById('gformsLink')?.value || '';
  const scheduleVal = mode === 'gforms'
    ? (document.getElementById('gformsSchedule')?.value || '')
    : (document.getElementById('quizSchedule')?.value || '');
  const scheduleISO = scheduleVal ? new Date(scheduleVal).toISOString() : '';

  // Read tool toggles from the Tools card checkboxes using IDs
  const calcToggle = document.getElementById(mode === 'gforms' ? 'gformsToolCalc' : 'quizToolCalc');
  const whiteboardToggle = document.getElementById(mode === 'gforms' ? 'gformsToolWhiteboard' : 'quizToolWhiteboard');
  const cameraToggle = document.getElementById(mode === 'gforms' ? 'gformsToolCamera' : 'quizToolCamera');

  // Read monitoring toggles from the Sekyo Monitoring card
  const camToggle = document.getElementById(mode === 'gforms' ? 'gformsToolCam' : 'quizToolCam');
  const audioToggle = document.getElementById(mode === 'gforms' ? 'gformsToolAudio' : 'quizToolAudio');
  const screenToggle = document.getElementById(mode === 'gforms' ? 'gformsToolScreen' : 'quizToolScreen');
  const tabToggle = document.getElementById(mode === 'gforms' ? 'gformsToolTab' : 'quizToolTab');

  const examObj = {
    id: Date.now(),
    title,
    section: sectionName,
    section_id: sectionId,
    students: 0,
    flagged: 0,
    status: 'scheduled',
    type: mode === 'gforms' ? 'gforms' : 'wams-quiz',
    created: new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
    timeLimit,
    schedule: scheduleISO,
    link,
    accessCode: generateAccessCode(),
    monitor:{
      cam: camToggle ? camToggle.checked : true,
      audio: audioToggle ? audioToggle.checked : true,
      screen: screenToggle ? screenToggle.checked : true,
      tab: tabToggle ? tabToggle.checked : true,
      face: false
    },
    tools:{
      calculator: calcToggle ? calcToggle.checked : true,
      whiteboard: whiteboardToggle ? whiteboardToggle.checked : true,
      camera: cameraToggle ? cameraToggle.checked : true
    }
  };

  if(mode === 'quiz'){
    examObj.questions = collectQuizQuestions();
    // Fallback: if no questions collected, use a placeholder
    if(examObj.questions.length === 0){
      examObj.questions = [{ text:'Sample question', qtype:'mc', choices:['Choice A','Choice B','Choice C','Choice D'], correct:0 }];
    }
  }

  saveExamToServer(examObj, mode);
}

function selectMode(mode){
  document.getElementById('step1').style.display = 'none';
  if(mode === 'gforms'){
    document.getElementById('formGforms').classList.add('show');
  } else {
    document.getElementById('formQuiz').classList.add('show');
  }
  document.getElementById('main').querySelector('.page').scrollTop = 0;
}

function goBack(){
  document.getElementById('formGforms').classList.remove('show');
  document.getElementById('formQuiz').classList.remove('show');
  document.getElementById('step1').style.display = 'block';
}

function checkLink(val){
  const preview = document.getElementById('linkPreview');
  if(val.includes('docs.google.com/forms')){
    preview.classList.add('show');
  } else {
    preview.classList.remove('show');
  }
}

let qCount = 1;

// Returns the inner HTML for the answer-body area based on question type
function renderAnsBody(type, qn){
  switch(type){
    case 'mc': // Multiple choice
      return `
        <div class="choice-inputs">
          <div class="choice-input-row"><input type="radio" name="q${qn}"><input type="text" placeholder="Choice A"></div>
          <div class="choice-input-row"><input type="radio" name="q${qn}"><input type="text" placeholder="Choice B"></div>
          <div class="choice-input-row"><input type="radio" name="q${qn}"><input type="text" placeholder="Choice C"></div>
          <div class="choice-input-row"><input type="radio" name="q${qn}"><input type="text" placeholder="Choice D"></div>
        </div>`;

    case 'cb': // Checkboxes
      return `
        <div class="choice-inputs">
          <div class="choice-input-row"><input type="checkbox"><input type="text" placeholder="Choice A"></div>
          <div class="choice-input-row"><input type="checkbox"><input type="text" placeholder="Choice B"></div>
          <div class="choice-input-row"><input type="checkbox"><input type="text" placeholder="Choice C"></div>
          <div class="choice-input-row"><input type="checkbox"><input type="text" placeholder="Choice D"></div>
        </div>`;

    case 'dd': // Dropdown
      return `
        <div class="choice-inputs">
          <div class="dd-row"><span>1.</span><input type="text" placeholder="Option 1"></div>
          <div class="dd-row"><span>2.</span><input type="text" placeholder="Option 2"></div>
          <div class="dd-row"><span>3.</span><input type="text" placeholder="Option 3"></div>
        </div>
        <span class="grid-add-link" onclick="addDropdownOption(this)">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add option
        </span>`;

    case 'sa': // Short answer
      return `<div class="ans-text-preview">Short answer text</div>`;

    case 'pg': // Paragraph
      return `<div class="ans-text-preview tall">Long answer text</div>`;

    case 'mg': // Multiple choice grid
      return renderGrid('radio');

    case 'cg': // Checkbox grid
      return renderGrid('checkbox');

    default:
      return '';
  }
}

function renderGrid(inputType){
  return `
    <div class="grid-wrap">
      <table class="grid-tbl">
        <thead>
          <tr>
            <th></th>
            <th><input type="text" class="grid-col-input" value="Column 1"></th>
            <th><input type="text" class="grid-col-input" value="Column 2"></th>
            <th><input type="text" class="grid-col-input" value="Column 3"></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><input type="text" class="grid-row-input" value="Row 1"></td>
            <td><input type="${inputType}" name="grid-${Date.now()}-1"></td>
            <td><input type="${inputType}" name="grid-${Date.now()}-1"></td>
            <td><input type="${inputType}" name="grid-${Date.now()}-1"></td>
          </tr>
          <tr>
            <td><input type="text" class="grid-row-input" value="Row 2"></td>
            <td><input type="${inputType}" name="grid-${Date.now()}-2"></td>
            <td><input type="${inputType}" name="grid-${Date.now()}-2"></td>
            <td><input type="${inputType}" name="grid-${Date.now()}-2"></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="grid-actions">
      <span class="grid-add-link" onclick="addGridRow(this)">
        <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add row
      </span>
      <span class="grid-add-link" onclick="addGridCol(this)">
        <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add column
      </span>
    </div>`;
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

function addQuestion(){
  qCount++;
  const wrap = document.createElement('div');
  wrap.className = 'q-item';
  wrap.dataset.qnum = qCount;
  wrap.innerHTML = `
    <div class="q-item-hd">
      <span>Question ${qCount}</span>
      <button class="q-remove" onclick="removeQ(this)">
        <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        Remove
      </button>
    </div>
    <div class="field">
      <input type="text" placeholder="Type your question here...">
    </div>
    <div class="qtype-row">
      <label>Question type:</label>
      <select class="qtype-select" onchange="changeQType(this)">
        <option value="mc" selected>Multiple choice</option>
        <option value="cb">Checkboxes</option>
        <option value="dd">Dropdown</option>
        <option value="sa">Short answer</option>
        <option value="pg">Paragraph</option>
        <option value="mg">Multiple choice grid</option>
        <option value="cg">Checkbox grid</option>
      </select>
    </div>
    <div class="ans-body">${renderAnsBody('mc', qCount)}</div>
    <div class="field-hint qhint">Select the radio button beside the correct answer.</div>
  `;
  document.getElementById('questionList').appendChild(wrap);
}

function removeQ(btn){
  const items = document.querySelectorAll('.q-item');
  if(items.length <= 1){ return; }
  btn.closest('.q-item').remove();
}

function addDropdownOption(linkEl){
  const wrap = linkEl.previousElementSibling;
  const n = wrap.querySelectorAll('.dd-row').length + 1;
  const row = document.createElement('div');
  row.className = 'dd-row';
  row.innerHTML = `<span>${n}.</span><input type="text" placeholder="Option ${n}">`;
  wrap.appendChild(row);
}

function addGridRow(linkEl){
  const table = linkEl.closest('.ans-body').querySelector('.grid-tbl');
  const tbody = table.querySelector('tbody');
  const colCount = table.querySelectorAll('thead th').length - 1;
  const rowNum = tbody.querySelectorAll('tr').length + 1;
  const inputType = table.querySelector('tbody input[type=radio], tbody input[type=checkbox]').type;
  let cells = `<td><input type="text" class="grid-row-input" value="Row ${rowNum}"></td>`;
  for(let i=0;i<colCount;i++){
    cells += `<td><input type="${inputType}" name="grid-${Date.now()}-${rowNum}"></td>`;
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
  th.innerHTML = `<input type="text" class="grid-col-input" value="Column ${colNum}">`;
  thead.appendChild(th);

  const inputType = table.querySelector('tbody input[type=radio], tbody input[type=checkbox]').type;
  table.querySelectorAll('tbody tr').forEach((tr, idx)=>{
    const td = document.createElement('td');
    td.innerHTML = `<input type="${inputType}" name="grid-${Date.now()}-${idx}">`;
    tr.appendChild(td);
  });

}
  function confirmLogout(event) {
    event.preventDefault();

    if (confirm("Are you sure you want to sign out?")) {
        window.location.href = "wams-professor-log-in.html";
    }
}
function buildStudentExamUrl(exam) {
    if(exam.type === 'wams-quiz'){
      // WAMS built-in quiz → exam tool page
      const url = new URL('../student/wams-student-exam-tool.html', window.location.href);
      url.searchParams.set("examId", exam.id);
      return url.toString();
    }
    // Google Forms exam → gform tool page
    const studentPageUrl = new URL('../student/wams-student-exam-tool-gform.html', window.location.href);
   studentPageUrl.searchParams.set("examId", exam.id);
    if (exam.link) {
        studentPageUrl.searchParams.set('gform', exam.link);
    }
    return studentPageUrl.toString();
}

function showExamLink(exam) {
    const url = buildStudentExamUrl(exam);
    document.getElementById("examLink").value = url;
    document.getElementById("examAccessCode").textContent = exam.accessCode || 'N/A';
    document.getElementById("linkOverlay").style.display = "flex";
}

function closeOverlay() {
    document.getElementById("linkOverlay").style.display = "none";
    window.location.href = "wams-professor-my-exam.html";
}

function copyLink() {
    const input = document.getElementById("examLink");
    navigator.clipboard.writeText(input.value);
    window.location.href = "wams-professor-my-exam.html";
}

function generateAccessCode(){
  return 'EXAM-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function renderSidebarBadges(){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return;
    const res = await fetch('/api/my-exams', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return;
    const exams = await res.json();
    const liveBadge = document.querySelector('a[href="wams-professor-live-monitor.html"] .sb-badge.green');
    const logsBadge = document.querySelector('a[href="wams-professor-monitoring-logs.html"] .sb-badge');
    if(liveBadge) liveBadge.textContent = exams.filter(ex => ['live', 'upcoming', 'scheduled'].includes(ex.status)).length;
    if(logsBadge) logsBadge.textContent = exams.filter(ex => ex.status === 'ended').length;
  } catch {}
}

async function loadSections() {
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if (!token) return;
    const res = await fetch('/api/sections', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return;
    const sections = await res.json();
    const quizSelect = document.getElementById('quizSection');
    const gformsSelect = document.getElementById('gformsSection');
    const options = sections.map(s => `<option value="${s.id}">${s.name} (${s.course})</option>`).join('');
    if (quizSelect) quizSelect.innerHTML = '<option value="">Select a section...</option>' + options;
    if (gformsSelect) gformsSelect.innerHTML = '<option value="">Select a section...</option>' + options;
  } catch {}
}

(async () => {
  await renderSidebarBadges();
  await loadSections();
})();
