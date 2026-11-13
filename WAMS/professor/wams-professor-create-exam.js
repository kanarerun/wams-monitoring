verifyProfessorAuth();

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

    // New exams are always multiple choice; the radio marks the correct choice.
    let choices = [];
    let correct = -1;
    const choiceRows = item.querySelectorAll('.choice-input-row');
    choiceRows.forEach((row) => {
      const choiceInput = row.querySelector('input[type="text"]');
      const radio = row.querySelector('input[type="radio"]');
      if(choiceInput && choiceInput.value.trim()){
        const isCorrect = radio && radio.checked;
        choices.push(choiceInput.value.trim());
        if(isCorrect) correct = choices.length - 1;
      }
    });

    questions.push({ text, qtype: 'mc', choices, correct });
  });
  return questions;
}

let isCreatingExam = false;

function saveExamToServer(examObj, mode){
  if (isCreatingExam) return;
  isCreatingExam = true;

  const token = getProfessorAuthToken();
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
      year_level: examObj.year_level,
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
      year_level: serverExam.year_level || examObj.year_level,
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
  const yearLevelSelect = document.getElementById(mode === 'gforms' ? 'gformsYearLevel' : 'quizYearLevel');
  const yearLevel = yearLevelSelect ? yearLevelSelect.value : '';
  const sectionId = sectionSelect ? parseInt(sectionSelect.value, 10) : '';
  const sectionName = sectionSelect ? sectionSelect.options[sectionSelect.selectedIndex]?.text || '' : '';
  if (!yearLevel) {
    alert('Please select a year level.');
    return;
  }
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
    year_level: yearLevel,
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
      // Camera is not a tool: it is part of the AI camera monitoring toggle
      // above, so the Tools card no longer carries a second, conflicting one.
      whiteboard: whiteboardToggle ? whiteboardToggle.checked : true
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

/* New exams are always multiple choice: the redundant question-type selector
   was removed, so the answer body is fixed. Legacy multi-type renderers still
   live in wams-professor-my-exam.js for editing older exams. */
function renderAnsBody(qn){
  return `
        <div class="choice-inputs">
          <div class="choice-input-row"><input type="radio" name="q${qn}"><input type="text" placeholder="Choice A"></div>
          <div class="choice-input-row"><input type="radio" name="q${qn}"><input type="text" placeholder="Choice B"></div>
          <div class="choice-input-row"><input type="radio" name="q${qn}"><input type="text" placeholder="Choice C"></div>
          <div class="choice-input-row"><input type="radio" name="q${qn}"><input type="text" placeholder="Choice D"></div>
        </div>`;
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
    <div class="ans-body">${renderAnsBody(qCount)}</div>
    <div class="field-hint qhint">Select the radio button beside the correct answer.</div>
  `;
  document.getElementById('questionList').appendChild(wrap);
}

function removeQ(btn){
  const items = document.querySelectorAll('.q-item');
  if(items.length <= 1){ return; }
  btn.closest('.q-item').remove();
}

  function confirmLogout(event) {
    event.preventDefault();

    if (confirm("Are you sure you want to sign out?")) {
      clearProfessorAuthToken();
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
    const code = exam.accessCode || 'N/A';
    document.getElementById("examAccessCode").textContent = code;
    document.getElementById("linkOverlay").style.display = "flex";
    // Auto-copy the exam access code to the clipboard so professors can
    // share it immediately with their students.
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).catch(() => {});
    }
}

function closeOverlay() {
    document.getElementById("linkOverlay").style.display = "none";
    window.location.href = "wams-professor-my-exam.html";
}

function generateAccessCode(){
  return 'EXAM-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function renderSidebarBadges(){
  try {
    const token = getProfessorAuthToken();
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

let professorSections = [];

function escapeSectionText(value){
  const element = document.createElement('span');
  element.textContent = value || '';
  return element.innerHTML;
}

function refreshExamSections(mode){
  const yearLevel = document.getElementById(mode === 'gforms' ? 'gformsYearLevel' : 'quizYearLevel')?.value || '';
  const sectionSelect = document.getElementById(mode === 'gforms' ? 'gformsSection' : 'quizSection');
  if(!sectionSelect) return;
  const previousSectionId = sectionSelect.value;
  const matchingSections = yearLevel
    ? professorSections.filter(section => !section.year_level || section.year_level === yearLevel)
    : [];
  const uniqueSections = [...new Map(matchingSections.map(section => [String(section.id), section])).values()];
  sectionSelect.innerHTML = uniqueSections.length
    ? '<option value="">Select a section...</option>' +
      uniqueSections.map(section => `<option value="${section.id}">${escapeSectionText(section.name)} (${escapeSectionText(section.course)})</option>`).join('')
    : `<option value="">${yearLevel ? 'No sections assigned for this year level' : 'Select a year level first...'}</option>`;
  if(uniqueSections.some(section => String(section.id) === previousSectionId)){
    sectionSelect.value = previousSectionId;
  } else if(uniqueSections.length === 1){
    sectionSelect.value = String(uniqueSections[0].id);
  }
}

async function loadSections() {
  try {
    const token = getProfessorAuthToken();
    if (!token) throw new Error('You must be logged in to load your classes.');
    const res = await fetch('/api/sections', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText);
    }
    professorSections = await res.json();
    refreshExamSections('quiz');
    refreshExamSections('gforms');
  } catch (error) {
    console.error('Failed to load assigned classes:', error);
    alert('Unable to load your assigned classes: ' + error.message);
  }
}

(async () => {
  await renderSidebarBadges();
  await loadSections();
})();
