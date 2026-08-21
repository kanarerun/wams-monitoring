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
    // Populate PDF header with real professor name
    if(me && me.name){
      const pdfName = document.getElementById('pdfGeneratedBy');
      if(pdfName) pdfName.textContent = me.name;
      localStorage.setItem('wamsProfessorName', me.name);
    }
  } catch {}
})();

function toggleSb(){
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}

/* ───── Load real data from server API ───── */
async function loadExams(){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return [];
    const res = await fetch('/api/my-exams', {
      headers: { 'Authorization': 'Bearer ' + token },
      cache: 'no-store'
    });
    if(res.status === 401){
      // Session expired — clear and re-authenticate instead of showing an empty page
      localStorage.removeItem('wamsToken');
      localStorage.removeItem('token');
      window.location.href = 'wams-professor-log-in.html';
      return [];
    }
    if(!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.map(ex => ({
      id: ex.id,
      title: ex.title,
      section: ex.section_name || ex.section || 'General',
      students: 0,
      status: ex.status,
      type: ex.type,
      created: new Date(ex.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
      flagged: ex.flagged || 0,
      timeLimit: ex.time_limit || 60,
      schedule: ex.schedule || '',
      link: ex.link || '',
      accessCode: ex.accessCode || 'N/A'
    })) : [];
  } catch {
    return [];
  }
}

async function getExamSessions(examId){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return [];
    const res = await fetch(`/api/exams/${examId}/sessions`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function getQuestionActivity(examId){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return [];
    const res = await fetch(`/api/exams/${examId}/question-activity`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function getTabSwitchData(examId){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return null;
    const res = await fetch('/api/exams/' + examId + '/tab-switches', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return null;
    const data = await res.json();
    return { log: data, count: data.length };
  } catch {
    return null;
  }
}

// SQLite CURRENT_TIMESTAMP stores UTC without timezone info (e.g. "2026-08-06 13:24:30").
// Append 'Z' so JS treats it as UTC instead of local time.
function parseDbTime(str){
  if(!str) return null;
  const s = String(str).trim();
  // Detect SQLite-style "YYYY-MM-DD HH:MM:SS" (UTC) and append Z
  if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)){
    return new Date(s.replace(' ', 'T') + 'Z');
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function formatLocalTime(value){
  const dt = parseDbTime(value);
  if(!dt || isNaN(dt.getTime())) return '—';
  return dt.toLocaleTimeString();
}

function getScreenCaptures(examId){
  try {
    const stored = localStorage.getItem('wamsScreenCaptures_' + examId);
    if(stored) return JSON.parse(stored);
  } catch {}
  return null;
}

async function fetchScreenCapturesFromServer(examId){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return [];
    const sessions = await getExamSessions(examId);
    const captures = [];
    for(const session of sessions){
      const res = await fetch(`/api/sessions/${session.id}/screen-captures`, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if(res.ok){
        const data = await res.json();
        data.forEach(c => {
          captures.push({
            session_id: session.id,
            time: c.captured_at,
            image: c.image_data
          });
        });
      }
    }
    return captures;
  } catch {
    return [];
  }
}

function getAudioCaptures(examId){
  try {
    const stored = localStorage.getItem('wamsAudioCaptures_' + examId);
    if(stored) return JSON.parse(stored);
  } catch {}
  return null;
}

async function fetchAudioCapturesFromServer(examId){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return [];
    const sessions = await getExamSessions(examId);
    const captures = [];
    for(const session of sessions){
      const res = await fetch(`/api/sessions/${session.id}/audio-captures`, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if(res.ok){
        const data = await res.json();
        data.forEach(c => {
          let isFlagged = Boolean(c.flagged);
          try {
            const parsed = typeof c.image_data === 'string' ? JSON.parse(c.image_data) : c.image_data;
            if (parsed && typeof parsed.flagged !== 'undefined') isFlagged = Boolean(parsed.flagged);
          } catch(e) {}
          captures.push({
            session_id: session.id,
            time: c.captured_at,
            flagged: isFlagged
          });
        });
      }
    }
    return captures;
  } catch {
    return [];
  }
}

let currentExamKey = null;
let currentStudentIdx = null;
let pendingDeleteKey = null;
let currentExamData = null;
let currentStudentData = null;
let currentStudentEntries = [];
let currentExamQuestionCount = 1;

function getExamIcon(type){
  if(type === 'gforms'){
    return {bg:'var(--purple-bg)', color:'var(--purple)', svg:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="8" x2="17" y2="8"/><line x1="9" y1="12" x2="17" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>'};
  }
  return {bg:'var(--blue-bg)', color:'var(--blue)', svg:'<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'};
}

function renderSidebarBadgesFromCache(){
  try {
    const cached = localStorage.getItem('wamsLiveMonitorBadges');
    if(!cached) return;
    const { live, ended } = JSON.parse(cached);
    const liveBadge = document.querySelector('a[href="wams-professor-live-monitor.html"] .sb-badge.green');
    const logsBadge = document.querySelector('a[href="wams-professor-monitoring-logs.html"] .sb-badge');
    if(liveBadge) liveBadge.textContent = live;
    if(logsBadge) logsBadge.textContent = ended;
  } catch {}
}

function renderExamGridFromCache(){
  try {
    const cached = localStorage.getItem('wamsMonitoringLogsGrid');
    if(!cached) return;
    const grid = document.getElementById('examGrid');
    if(grid) grid.innerHTML = cached;
    renderSidebarBadgesFromCache();
  } catch {}
}

async function renderExamGrid(filterText){
  filterText = (filterText || '').trim().toLowerCase();
  const grid = document.getElementById('examGrid');
  const allExams = await loadExams();
  const endedExams = allExams.filter(ex => ex.status === 'ended');

  // sidebar badges - consistent with live monitoring
  const liveBadge = document.querySelector('a[href="wams-professor-live-monitor.html"] .sb-badge.green');
  const logsBadge = document.querySelector('a[href="wams-professor-monitoring-logs.html"] .sb-badge');
  if(liveBadge) liveBadge.textContent = allExams.filter(ex => ['live', 'upcoming', 'scheduled'].includes(ex.status)).length;
  if(logsBadge) logsBadge.textContent = endedExams.length;

  // Cache sidebar badge values
  try {
    localStorage.setItem('wamsLiveMonitorBadges', JSON.stringify({
      live: allExams.filter(ex => ['live', 'upcoming', 'scheduled'].includes(ex.status)).length,
      ended: endedExams.length
    }));
  } catch {}

  if(endedExams.length === 0){
    grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <p>No ended exams yet. Exams that have finished will appear here for review.</p>
      </div>`;
    return;
  }

  const filtered = endedExams.filter(ex => {
    if(!filterText) return true;
    return ex.title.toLowerCase().includes(filterText) || ex.section.toLowerCase().includes(filterText);
  });

  if(filtered.length === 0){
    grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <p>No ended exams match "${filterText}".</p>
      </div>`;
    return;
  }

  grid.innerHTML = filtered.map(ex => {
    const icon = getExamIcon(ex.type);
    const ts = getTabSwitchData(ex.id);
    const flaggedCount = ts ? ts.count : 0;
    return `
      <div class="exam-card" onclick="openExam('${ex.id}')">
        <button class="exam-card-del" title="Delete exam" onclick="event.stopPropagation(); openDeleteModal('${ex.id}')">
          <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
        <div class="exam-card-top">
          <div class="exam-card-icon" style="background:${icon.bg};color:${icon.color}">${icon.svg}</div>
          <span class="ended-badge">Ended</span>
        </div>
        <h3>${ex.title}</h3>
        <div class="meta">${ex.section || 'TBD'} · ${ex.created || '—'}</div>
        <div class="exam-card-stats">
          <div class="ec-stat"><div class="n">${ex.students || 0}</div><div class="l">Students</div></div>
          <div class="ec-stat flag"><div class="n">${flaggedCount}</div><div class="l">Flagged</div></div>
          <div class="ec-stat"><div class="n">${ts ? ts.log.length : 0}</div><div class="l">Incidents</div></div>
        </div>
        <div class="exam-card-foot">
          View students
          <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>`;
  }).join('');

  // Cache the rendered grid (only when no filter is applied)
  if(!filterText){
    try { localStorage.setItem('wamsMonitoringLogsGrid', grid.innerHTML); } catch {}
  }
}

function filterExams(value){
  document.getElementById('examSearchBox').classList.toggle('has-value', value.trim().length > 0);
  renderExamGrid(value);
}
function clearExamSearch(){
  const input = document.getElementById('examSearchInput');
  input.value = '';
  input.focus();
  filterExams('');
}

async function openDeleteModal(key){
  pendingDeleteKey = key;
  const exams = await loadExams();
  const ex = exams.find(e => String(e.id) === String(key));
  if(!ex) return;
  document.getElementById('deleteModalExamName').innerHTML = `<b>${ex.title}</b>`;
  document.getElementById('deleteModal').classList.add('show');
}
function closeDeleteModal(){
  pendingDeleteKey = null;
  document.getElementById('deleteModal').classList.remove('show');
}
async function confirmDeleteExam(){
  if(!pendingDeleteKey) return;
  const exams = await loadExams();
  const ex = exams.find(e => String(e.id) === String(pendingDeleteKey));
  const title = ex ? ex.title : 'Exam';
  const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
  try {
    const res = await fetch(`/api/exams/${pendingDeleteKey}`, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) throw new Error('Delete failed');
  } catch (err) {
    showToast(`Failed to delete "${title}".`);
    return;
  }
  pendingDeleteKey = null;
  closeDeleteModal();
  await renderExamGrid();
  showToast(`"${title}" was deleted.`);
}

function typeTag(type){
  const map = {tab:['Tab Switch','tab'], face:['Camera','face'], audio:['Audio','audio'], screen:['Screen','screen']};
  const [label, cls] = map[type] || [type, 'tab'];
  return `<span class="type-tag ${cls}">${label}</span>`;
}

function resetTabSwitches(){
  if(!currentExamKey) return;
  if(!confirm('Reset tab switch counter for this exam? This cannot be undone.')) return;
  localStorage.removeItem('wamsTabSwitch_' + currentExamKey);
  // Update the exam flagged count
  const exams = loadExams();
  const ex = exams.find(e => String(e.id) === String(currentExamKey));
  if(ex){
    ex.flagged = 0;
    localStorage.setItem(getStorageKey(), JSON.stringify(exams));
  }
  showToast('Tab switch counter reset.');
  renderExamGrid();
  backToExams();
}

async function openExam(id){
  currentExamKey = id;
  const exams = await loadExams();
  const ex = exams.find(e => String(e.id) === String(id));
  if(!ex) return;

  const icon = getExamIcon(ex.type);
  const ts = await getTabSwitchData(ex.id);
  const flaggedCount = ts ? ts.count : 0;
  const incidentCount = ts ? ts.log.length : 0;

  document.getElementById('examBannerIcon').innerHTML = icon.svg;
  document.getElementById('examBannerTitle').textContent = ex.title;
  document.getElementById('examBannerMeta').textContent = ex.section + ' · ' + (ex.created || '—');
  document.getElementById('bannerTotal').textContent = ex.students || 0;
  document.getElementById('bannerFlag').textContent = flaggedCount;
  document.getElementById('bannerIncidents').textContent = incidentCount;

  const searchInput = document.getElementById('studentSearchInput');
  searchInput.value = '';
  document.getElementById('studentSearchBox').classList.remove('has-value');
  renderStudentTable('');

  document.getElementById('topTitle').textContent = ex.title;
  document.getElementById('topCrumb').innerHTML = `<span class="crumb-link" onclick="backToExams()">Monitoring Logs</span> / ${ex.title}`;

  switchView('view2');
}

async function renderStudentTable(filterText){
  filterText = (filterText || '').trim().toLowerCase();
  const exams = await loadExams();
  const ex = exams.find(e => String(e.id) === String(currentExamKey));
  const tbody = document.getElementById('studentTbody');
  const noResults = document.getElementById('studentNoResults');
  const countLabel = document.getElementById('studentCount');

  if(!ex){
    tbody.innerHTML = '';
    noResults.style.display = 'block';
    noResults.innerHTML = 'Exam not found.';
    countLabel.textContent = '0 students';
    return;
  }

  const ts = await getTabSwitchData(ex.id);
  const log = ts ? ts.log : [];
  const screens = await fetchScreenCapturesFromServer(ex.id);
  const audios = await fetchAudioCapturesFromServer(ex.id);
  const questionActivities = await getQuestionActivity(ex.id);

  // Get actual exam sessions (students who took this exam)
  const sessions = await getExamSessions(ex.id);

  // Determine the actual number of questions for this exam
  currentExamQuestionCount = 0;
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if (token) {
      const examRes = await fetch('/api/exams/' + ex.id, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (examRes.ok) {
        const examDetail = await examRes.json();
        let qs = examDetail.questions;
        if (typeof qs === 'string') { try { qs = JSON.parse(qs); } catch { qs = []; } }
        if (Array.isArray(qs)) currentExamQuestionCount = qs.length;
      }
    }
  } catch {}
  if (currentExamQuestionCount === 0) currentExamQuestionCount = 1;

  // Load exam questions for grading
  let examQuestions = [];
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if (token) {
      const examRes = fetch('/api/exams/' + ex.id, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      examRes.then(async r => {
        if (r.ok) {
          const examDetail = await r.json();
          let qs = examDetail.questions;
          if (typeof qs === 'string') { try { qs = JSON.parse(qs); } catch { qs = []; } }
          if (Array.isArray(qs)) examQuestions = qs;
        }
      }).catch(() => {});
    }
  } catch {}

  // Build student entries from actual sessions
  currentStudentEntries = sessions.map((session, idx) => {
    const studentName = session.student_name || ('Student ' + (idx + 1));
    const initials = studentName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();

    // Get tab switches, screen, and audio for this specific session
    const sessionTabSwitches = log.filter(ts => String(ts.session_id) === String(session.id));
    const sessionScreens = screens.filter(sc => String(sc.session_id) === String(session.id));
    const sessionAudios = audios.filter(au => String(au.session_id) === String(session.id));

    // Determine incident types for this session
    const types = [];
    if(sessionTabSwitches.length > 0) types.push('tab');
    if(sessionScreens.length > 0) types.push('screen');
    if(sessionAudios.filter(a => a.flagged).length > 0) types.push('audio');

    const totalIncidents = sessionTabSwitches.length + sessionScreens.length + sessionAudios.filter(a => a.flagged).length;
    const sessionActivities = questionActivities.filter(qa => String(qa.session_id) === String(session.id));

    // Build review answers from stored answers + exam questions
    const studentAnswers = session.answers ? safeParseJSON(session.answers, {}) : {};
    let answers = [];
    const examQ = ex.id ? (Array.isArray(examQuestions) && examQuestions.length > 0 ? examQuestions : loadExamQuestionsSync(ex.id)) : [];

    if (examQ.length > 0) {
      answers = Object.keys(studentAnswers).map(qIdx => {
        const qi = parseInt(qIdx, 10);
        const question = examQ[qi];
        if (!question) return null;
        const qtype = question.qtype || 'mc';
        const studentVal = studentAnswers[qIdx];
        return buildAnswerItem(qi + 1, question, studentVal);
      }).filter(Boolean);
    }

    // Auto-score if questions have correct answers
    let autoScore = null;
    const gradable = answers.filter(a => a.type !== 'paragraph');
    if (gradable.length > 0) {
      const correctCount = gradable.filter(a => a.correct).length;
      autoScore = correctCount;
    }
    if (session.score == null && autoScore != null) {
      session.score = autoScore;
    }

    return {
      name: studentName,
      init: initials,
      color: session.color || '#2563EB',
      types: types.length > 0 ? types : [],
      totalIncidents: totalIncidents,
      tabSwitches: sessionTabSwitches,
      score: session.score,
      totalItems: currentExamQuestionCount,
      cam: [],
      screen: sessionScreens || [],
      audio: sessionAudios || [],
      qlog: sessionActivities.map(qa => ({
        text: qa.activity_type === 'answered' ? `Answered Question ${qa.question_number}` : `Moved to Question ${qa.question_number}`,
        time: formatLocalTime(qa.created_at)
      })),
      sessionId: session.id,
      answers: answers
    };
  });

  const rows = currentStudentEntries
    .map((s, idx) => ({ s, idx }))
    .filter(({s}) => !filterText || s.name.toLowerCase().includes(filterText));

  if(rows.length === 0){
    tbody.innerHTML = '';
    noResults.style.display = 'block';
    noResults.innerHTML = filterText ? `No results for "${filterText}".` : 'No sessions recorded yet.';
  } else {
    noResults.style.display = 'none';
    tbody.innerHTML = rows.map(({s, idx}) => `
      <tr onclick="openStudent(${idx})">
        <td><div class="uc"><div class="uav" style="background:${s.color}">${s.init}</div>${s.name}</div></td>
        <td><div class="type-tags">${s.types.map(typeTag).join('')}</div></td>
        <td><span class="flag-pill"><svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${s.totalIncidents}</span></td>
        <td style="text-align:right"><svg class="chev" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></td>
      </tr>
    `).join('');
  }

  countLabel.textContent = filterText
    ? `${rows.length} of ${currentStudentEntries.length} sessions`
    : `${currentStudentEntries.length} session${currentStudentEntries.length === 1 ? '' : 's'}`;
}

function filterStudents(value){
  document.getElementById('studentSearchBox').classList.toggle('has-value', value.trim().length > 0);
  renderStudentTable(value);
}
function clearStudentSearch(){
  const input = document.getElementById('studentSearchInput');
  input.value = '';
  input.focus();
  filterStudents('');
}

async function openStudent(idx){
  currentStudentIdx = idx;
  const exams = await loadExams();
  const ex = exams.find(e => String(e.id) === String(currentExamKey));
  if(!ex) return;

  const ts = await getTabSwitchData(ex.id);
  const log = ts ? ts.log : [];

  // Fetch screen and audio captures from server
  const screens = await fetchScreenCapturesFromServer(ex.id);
  const audios = await fetchAudioCapturesFromServer(ex.id);

  const chipMap = {
    tab:{label:'Tab Switching', bg:'var(--blue-bg)', color:'var(--blue)', svg:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'},
    face:{label:'Camera', bg:'var(--red-bg)', color:'var(--red)', svg:'<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'},
    audio:{label:'Audio', bg:'var(--amber-bg)', color:'var(--amber)', svg:'<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>'},
    screen:{label:'Screen', bg:'var(--purple-bg)', color:'var(--purple)', svg:'<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'},
  };

  // Get the specific student entry
  const s = currentStudentEntries[idx] || {
    name: 'Student Session',
    init: 'S1',
    color: '#2563EB',
    types: [],
    totalIncidents: 0,
    tabSwitches: [],
    score: null,
    totalItems: currentExamQuestionCount || 1,
    cam: [],
    screen: screens || [],
    audio: audios || [],
    qlog: [],
    sessionId: null
  };
  document.getElementById('incidentChipRow').innerHTML = s.types.map(t => {
    const c = chipMap[t];
    return `<div class="incident-chip"><span class="incident-chip-ic" style="background:${c.bg};color:${c.color}">${c.svg}</span> <b>${c.label}</b> flagged this session</div>`;
  }).join('');

  // Camera shots - fetch from server for this session
  let camCaptures = [];
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    const sessionId = s.sessionId;
    if (sessionId && token) {
      const capturesRes = await fetch(`/api/sessions/${sessionId}/captures`, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const captures = capturesRes.ok ? await capturesRes.json() : [];
      camCaptures = captures || [];
    }
  } catch (e) {
    console.warn('Failed to fetch camera captures:', e);
  }

  // Also merge locally-stored captures (for offline/testing mode)
  if (!camCaptures.length && s.cam && s.cam.length > 0) {
    camCaptures = s.cam;
  }

  const camFlagged = camCaptures.filter(c => c.flagged).length;
  if (camCaptures.length > 0) {
    document.getElementById('cameraShots').innerHTML = camCaptures.map(c => {
      const src = c.image_data?.startsWith('data:') ? c.image_data : `data:image/jpeg;base64,${c.image_data}`;
      const timeStr = formatLocalTime(c.captured_at || c.time);
      const flagged = Boolean(c.flagged);
      return `
      <div class="shot ${flagged ? 'flagged' : ''}" onclick="viewImagePreview('${src}', 'Camera Capture', ${flagged}, '${timeStr}')" title="Click to view full image">
        <img src="${src}" alt="Capture">
        ${flagged ? `<span class="shot-flag-tag">Flagged</span>` : ''}
        <span class="shot-time">${timeStr}</span>
      </div>
      `;
    }).join('');
  } else {
    document.getElementById('cameraShots').innerHTML = '<div style="font-size:12px;color:var(--tx3);padding:10px 0;">No camera captures recorded.</div>';
  }
  document.getElementById('camFlagCount').textContent = `${camFlagged} flagged`;
  document.getElementById('camFlagCount').style.display = camFlagged === 0 ? 'none' : 'inline-flex';

  // Populate the student entry's cam array for PDF export
  s.cam = camCaptures.map(c => ({
    flagged: c.flagged || false,
    time: c.captured_at || c.time,
    image_data: c.image_data,
    tag: c.capture_type || 'camera'
  }));
  currentStudentData = s;

  // Screen shots - display actual captured images
  document.getElementById('screenShots').innerHTML = s.screen.length ? s.screen.map(sc => {
    const src = sc.image?.startsWith('data:') ? sc.image : `data:image/jpeg;base64,${sc.image}`;
    const timeStr = formatLocalTime(sc.time);
    return `
      <div class="screenshot" onclick="viewImagePreview('${src}', 'Screen Capture', false, '${timeStr}')" title="Click to view full screenshot">
        <img src="${src}" alt="Screen Capture">
        <span class="shot-time">${timeStr}</span>
      </div>`;
  }).join('') : '<div style="font-size:12px;color:var(--tx3);padding:10px 0;">No screen captures recorded.</div>';

  // Tab switch log
  const tabHtml = s.tabSwitches.map(t => `
    <li class="tslog-item">
      <div class="tslog-ic"><svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
      <div><div class="tslog-txt">Switched away from exam tab</div><div class="tslog-time">${formatLocalTime(t.time)}</div></div>
    </li>`).join('');
  document.getElementById('tabSwitchLog').innerHTML = tabHtml || '<div style="font-size:12px;color:var(--tx3);padding:6px 0;">No tab switching detected.</div>';
  document.getElementById('tabFlagCount').textContent = `${s.tabSwitches.length} events`;
  document.getElementById('tabFlagCount').style.display = s.tabSwitches.length === 0 ? 'none' : 'inline-flex';

  // Audio list - display actual audio capture data
  document.getElementById('audioList').innerHTML = s.audio.length ? s.audio.map((a,i) => {
    const audioClipParam = a.audio_clip ? `'${a.audio_clip}'` : 'null';
    const level = a.level || 30;
    const isFlagged = Boolean(a.flagged);
    const timeStr = formatLocalTime(a.time);
    return `
      <li class="audio-item ${isFlagged ? 'flagged' : ''}">
        <div class="play-btn" onclick="playAudioItem(this, ${i}, ${audioClipParam}, ${level}, ${isFlagged})" title="Play recorded audio clip">
          <svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>
        </div>
        <div class="audio-wave" id="wave-${i}"></div>
        <div class="audio-meta"><div class="t">${timeStr}</div><div class="s">${isFlagged ? 'Flagged anomaly' : 'Audio capture'}</div></div>
      </li>`;
  }).join('') : '<div style="font-size:12px;color:var(--tx3);padding:6px 0;">No audio captures recorded.</div>';
  setTimeout(buildWaves, 10);
  const audioFlagged = s.audio.filter(a=>a.flagged).length;
  document.getElementById('audioFlagCount').textContent = `${audioFlagged} flagged`;
  document.getElementById('audioFlagCount').style.display = audioFlagged === 0 ? 'none' : 'inline-flex';

  // Question activity log
  document.getElementById('qActivityLog').innerHTML = s.qlog.length ? s.qlog.map(q => `
    <li class="tslog-item">
      <div class="tslog-ic" style="background:var(--surface2);color:var(--tx2)"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
      <div><div class="tslog-txt">${q.text}</div><div class="tslog-time">${q.time}</div></div>
    </li>`).join('') : '<div style="font-size:12px;color:var(--tx3);padding:6px 0;">No question activity recorded.</div>';

  // Score
  document.getElementById('scoreInput').value = s.score != null ? s.score : '';
  document.getElementById('scoreTotalLabel').textContent = s.totalItems || 25;
  updateScoreBar();

  // Summary
  document.getElementById('summaryText').value = s.summary || '';
  document.getElementById('savedNote').classList.add('hidden');

  // Review answers (new feature)
  currentExamData = ex;
  currentStudentData = s;
  renderReviewAnswers(ex, s);

  document.getElementById('topTitle').textContent = s.name;
  document.getElementById('topCrumb').innerHTML = `<span class="crumb-link" onclick="backToExams()">Monitoring Logs</span> / <span class="crumb-link" onclick="backToStudents()">${ex.title}</span> / ${s.name}`;

  switchView('view3');
  setTimeout(buildWaves, 10);
}

function updateScoreBar(){
  const exams = loadExams();
  const ex = exams.find(e => String(e.id) === String(currentExamKey));
  const ts = getTabSwitchData(ex ? ex.id : null);
  const log = ts ? ts.log : [];

  const s = currentStudentData || {
    name: 'Student Session',
    totalItems: 25,
    score: null
  };

  const total = s.totalItems || 25;
  const raw = document.getElementById('scoreInput').value;
  const scoreVal = raw === '' ? null : Math.min(Math.max(parseInt(raw) || 0, 0), total);
  const pct = scoreVal != null ? Math.round((scoreVal / total) * 100) : null;

  const pctEl = document.getElementById('scorePercent');
  const barFill = document.getElementById('scoreBarFill');
  const barLabel = document.getElementById('scoreBarLabel');
  const gradeBdg = document.getElementById('scoreGradeBdg');

  if(pct == null){
    pctEl.textContent = '—';
    pctEl.style.background = 'var(--surface2)';
    pctEl.style.color = 'var(--tx3)';
    barFill.style.width = '0%';
    barFill.style.background = 'var(--border2)';
    barLabel.textContent = 'Not yet entered';
    gradeBdg.textContent = '—';
    gradeBdg.className = 'bdg bdg-gray';
    return;
  }

  pctEl.textContent = pct + '%';
  barFill.style.width = pct + '%';
  barLabel.textContent = scoreVal + ' out of ' + total + ' correct';

  let grade, barColor, pctBg, pctColor, bdgClass;
  if(pct >= 90){ grade='A'; barColor='var(--green)'; pctBg='var(--green-bg)'; pctColor='var(--green-tx)'; bdgClass='bdg bdg-green'; }
  else if(pct >= 75){ grade='B'; barColor='var(--blue)'; pctBg='var(--blue-bg)'; pctColor='var(--blue-tx)'; bdgClass='bdg bdg-blue'; }
  else if(pct >= 60){ grade='C'; barColor='var(--amber)'; pctBg='var(--amber-bg)'; pctColor='var(--amber-tx)'; bdgClass='bdg bdg-amber'; }
  else{ grade='F'; barColor='var(--red)'; pctBg='var(--red-bg)'; pctColor='var(--red-tx)'; bdgClass='bdg bdg-red'; }

  barFill.style.background = barColor;
  pctEl.style.background = pctBg;
  pctEl.style.color = pctColor;
  gradeBdg.textContent = 'Grade ' + grade;
  gradeBdg.className = 'bdg ' + bdgClass;
}

function saveSummary(){
  const note = document.getElementById('summarySavedNote');
  if(note) note.classList.remove('hidden');

  // Save to current student data
  if(currentStudentData){
    currentStudentData.summary = document.getElementById('summaryText').value;
  }

  showToast('Summary saved.');
}

/* ───── Review Answers (new feature) ───── */
function safeParseJSON(value, fallback){
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function loadExamQuestionsSync(examId){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return [];
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/exams/' + examId, false);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.send();
    if(xhr.status === 200){
      const data = JSON.parse(xhr.responseText);
      let qs = data.questions;
      if(typeof qs === 'string'){ try { qs = JSON.parse(qs); } catch { qs = []; } }
      return Array.isArray(qs) ? qs : [];
    }
  } catch {}
  return [];
}

function buildAnswerItem(qNum, question, studentVal){
  const qtype = question.qtype || 'mc';
  const text = question.text || 'Untitled question';
  const choices = Array.isArray(question.choices) ? question.choices : [];
  const correctIdx = question.correct != null ? question.correct : -1;

  if(qtype === 'mc'){
    const studentIdx = typeof studentVal === 'number' ? studentVal : parseInt(studentVal, 10);
    const isCorrect = studentIdx === correctIdx;
    return {
      q: text,
      type: 'mcq',
      options: choices,
      studentAnswer: choices[studentIdx] !== undefined ? choices[studentIdx] : '(no answer)',
      correctAnswer: choices[correctIdx] !== undefined ? choices[correctIdx] : '(no correct answer)',
      correct: isCorrect
    };
  }
  if(qtype === 'cb'){
    const studentArr = Array.isArray(studentVal) ? studentVal : [];
    const correctArr = Array.isArray(question.correct) ? question.correct : [];
    const studentChoices = studentArr.map(i => choices[i]).filter(Boolean);
    const correctChoices = correctArr.map(i => choices[i]).filter(Boolean);
    const isCorrect = studentChoices.length === correctChoices.length && studentChoices.every(c => correctChoices.includes(c));
    return {
      q: text,
      type: 'checkbox',
      options: choices,
      studentAnswer: studentChoices,
      correctAnswer: correctChoices,
      correct: isCorrect
    };
  }
  if(qtype === 'sa'){
    const studentText = String(studentVal || '').trim();
    const correctText = String(question.correct_answer || question.answer || '').trim();
    const isCorrect = correctText !== '' && studentText.toLowerCase() === correctText.toLowerCase();
    return {
      q: text,
      type: 'short',
      options: [],
      studentAnswer: studentText || '(no answer)',
      correctAnswer: correctText || '(no correct answer)',
      correct: isCorrect
    };
  }
  if(qtype === 'dd'){
    const studentIdx = typeof studentVal === 'number' ? studentVal : parseInt(studentVal, 10);
    const isCorrect = studentIdx === correctIdx;
    return {
      q: text,
      type: 'mcq',
      options: choices,
      studentAnswer: choices[studentIdx] !== undefined ? choices[studentIdx] : '(no answer)',
      correctAnswer: choices[correctIdx] !== undefined ? choices[correctIdx] : '(no correct answer)',
      correct: isCorrect
    };
  }
  // pg (paragraph) - always needs manual review
  return {
    q: text,
    type: 'paragraph',
    options: [],
    studentAnswer: String(studentVal || ''),
    correctAnswer: '',
    correct: false
  };
}

function answerTypeLabel(type){
  return {mcq:'Multiple Choice', checkbox:'Checkboxes', short:'Short Answer', paragraph:'Paragraph'}[type] || 'Question';
}

function renderAnswerItem(a){
  const isWrong = a.type !== 'paragraph' && a.correct === false;
  let bodyHtml = '';

  if(a.type === 'mcq'){
    bodyHtml = `<div class="answer-options">${a.options.map(opt => {
      const isSelected = opt === a.studentAnswer;
      const isCorrectOpt = opt === a.correctAnswer;
      let cls = 'answer-option';
      let icon = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg>';
      if(isSelected) cls += ' selected';
      if(isCorrectOpt){ cls += ' correct-opt'; icon = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>'; }
      else if(isSelected){ cls += ' wrong-opt'; icon = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'; }
      return `<div class="${cls}">${icon}<span>${opt}</span></div>`;
    }).join('')}</div>`;
  } else if(a.type === 'checkbox'){
    bodyHtml = `<div class="answer-options">${a.options.map(opt => {
      const isSelected = a.studentAnswer.includes(opt);
      const isCorrectOpt = a.correctAnswer.includes(opt);
      let cls = 'answer-option';
      let icon = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';
      let note = '';
      if(isSelected && isCorrectOpt){ cls += ' selected correct-opt'; icon = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>'; }
      else if(isSelected && !isCorrectOpt){ cls += ' selected wrong-opt'; icon = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'; }
      else if(!isSelected && isCorrectOpt){ cls += ' missed-correct'; note = ' <em>(should have been selected)</em>'; }
      return `<div class="${cls}">${icon}<span>${opt}${note}</span></div>`;
    }).join('')}</div>`;
  } else if(a.type === 'short'){
    bodyHtml = `
      <div class="answer-item-row ${a.correct ? 'correct' : 'wrong'}">
        <svg viewBox="0 0 24 24">${a.correct ? '<polyline points="20 6 9 17 4 12"/>' : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'}</svg>
        <span><span class="lbl">Student's answer:</span> ${a.studentAnswer}</span>
      </div>
      ${a.correct ? '' : `
      <div class="answer-item-row">
        <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
        <span><span class="lbl">Correct answer:</span> ${a.correctAnswer}</span>
      </div>`}
    `;
  } else if(a.type === 'paragraph'){
    bodyHtml = `<div class="answer-paragraph-box">${a.studentAnswer}</div>`;
  }

  const tags = a.type === 'paragraph'
    ? `<span class="answer-type-tag">${answerTypeLabel(a.type)}</span><span class="answer-badge-review">Needs review</span>`
    : `<span class="answer-type-tag">${answerTypeLabel(a.type)}</span>`;

  return `
    <div class="answer-item ${isWrong ? 'wrong' : ''}">
      <div class="answer-item-q-row">
        <div class="answer-item-q">${a.q}</div>
        <div class="answer-item-tags">${tags}</div>
      </div>
      ${bodyHtml}
    </div>`;
}

function renderReviewAnswers(ex, s){
  const body = document.getElementById('reviewAnswersBody');
  const badge = document.getElementById('reviewAnswersBadge');
  if(!body) return;

  const platform = ex.platform || (ex.type === 'gforms' ? 'gform' : 'wams');

  if(platform === 'gform'){
    if(badge) badge.style.display = 'none';
    body.innerHTML = `
      <div class="gform-notice">
        <div class="gform-notice-icon">
          <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </div>
        <p>This exam was conducted using <b>Google Forms</b>. Student answers aren't stored in WAMS — review and grade them directly on Google Forms.</p>
        <a class="gform-link" href="https://docs.google.com/forms/u/0/?tgif=d" target="_blank" rel="noopener noreferrer">
          https://docs.google.com/forms/u/0/?tgif=d
          <svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
      </div>`;
    return;
  }

  const answers = s.answers || [];

  if(answers.length === 0){
    if(badge) badge.style.display = 'none';
    body.innerHTML = '<div style="font-size:12px;color:var(--tx3);padding:6px 0;">No answer data recorded for this student.</div>';
    return;
  }

  const gradable = answers.filter(a => a.type !== 'paragraph');
  const correctCount = gradable.filter(a => a.correct).length;
  const reviewCount = answers.length - gradable.length;

  if(badge){
    badge.style.display = 'inline-flex';
    if(gradable.length === 0){
      badge.className = 'bdg bdg-amber';
      badge.textContent = `${reviewCount} need${reviewCount === 1 ? 's' : ''} review`;
    } else {
      badge.className = 'bdg ' + (correctCount === gradable.length ? 'bdg-green' : (correctCount === 0 ? 'bdg-red' : 'bdg-amber'));
      badge.textContent = `${correctCount}/${gradable.length} correct` + (reviewCount ? ` · ${reviewCount} to review` : '');
    }
  }

  body.innerHTML = answers.map(renderAnswerItem).join('');
}

function saveScore(){
  if(!currentStudentData) return;
  const rawScore = document.getElementById('scoreInput').value;
  currentStudentData.score = rawScore === '' ? null : Math.min(Math.max(parseInt(rawScore) || 0, 0), currentStudentData.totalItems || 25);
  if(currentStudentData.score != null) document.getElementById('scoreInput').value = currentStudentData.score;
  document.getElementById('savedNote').classList.remove('hidden');
  showToast(`Score saved for ${currentStudentData.name}.`);
}

function backToExams(){
  document.getElementById('topTitle').textContent = 'Monitoring Logs';
  document.getElementById('topCrumb').textContent = '';
  switchView('view1');
}
async function backToStudents(){
  const exams = await loadExams();
  const ex = exams.find(e => String(e.id) === String(currentExamKey));
  document.getElementById('topTitle').textContent = ex ? ex.title : 'Monitoring Logs';
  document.getElementById('topCrumb').innerHTML = `<span class="crumb-link" onclick="backToExams()">Monitoring Logs</span> / ${ex ? ex.title : ''}`;
  switchView('view2');
}
function switchView(id){
  document.querySelectorAll('.view').forEach(v => v.classList.remove('show'));
  document.getElementById(id).classList.add('show');
  document.querySelector('.page').scrollTop = 0;
}

function buildWaves(){
  document.querySelectorAll('[id^="wave-"]').forEach(el=>{
    if(el.dataset.built) return;
    let html = '';
    for(let i=0;i<40;i++){
      const h = 4 + Math.round(Math.random()*18);
      html += `<div class="wave-bar" style="height:${h}px"></div>`;
    }
    el.innerHTML = html;
    el.dataset.built = '1';
  });
}

function exportPDF(){
  if(!currentExamData || !currentStudentData){
    showToast('No student selected for export.');
    return;
  }
  const ex = currentExamData;
  const s = currentStudentData;
  const btn = document.querySelector('.btn-export');

  const rawScore = document.getElementById('scoreInput').value;
  s.score = rawScore === '' ? null : Math.min(Math.max(parseInt(rawScore) || 0, 0), s.totalItems || 25);

  const originalBtnHtml = btn ? btn.innerHTML : '';
  if(btn){
    btn.innerHTML = 'Generating PDF…';
    btn.disabled = true;
    btn.style.pointerEvents = 'none';
    btn.style.opacity = '.7';
  }

  try{
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:'mm', format:'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const marginX = 14;
    const contentW = pageW - marginX*2;

    const navy = [13,27,62];
    const gold = [201,168,76];
    const red = [220,38,38];
    const green = [22,163,74];
    const gray = [139,147,176];
    const dark = [13,27,62];
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-PH', {year:'numeric',month:'long',day:'numeric'});
    const timeStr = now.toLocaleTimeString('en-PH', {hour:'2-digit',minute:'2-digit'});

    let y = 0;
    let pageNum = 1;

    function drawHeader(){
      doc.setFillColor(...navy);
      doc.rect(0, 0, pageW, 24, 'F');
      doc.setFillColor(...gold);
      doc.roundedRect(marginX, 6, 12, 12, 2.5, 2.5, 'F');
      doc.setDrawColor(...navy);
      doc.setLineWidth(0.7);
      doc.line(marginX+3.2, 12, marginX+5.3, 14.3);
      doc.line(marginX+5.3, 14.3, marginX+8.8, 9.3);
      doc.setTextColor(255,255,255);
      doc.setFont('helvetica','bold');
      doc.setFontSize(12.5);
      doc.text('WAMS — Incident Report', marginX+16, 12);
      doc.setFont('helvetica','normal');
      doc.setFontSize(8);
      doc.setTextColor(200,205,225);
      doc.text('', marginX+16, 17.5);
      doc.setFontSize(8);
      doc.setTextColor(220,220,230);
      doc.text(`Generated by: ${localStorage.getItem('wamsProfessorName') || 'Professor'}`, pageW-marginX, 10, {align:'right'});
      doc.text(`Date: ${dateStr}, ${timeStr}`, pageW-marginX, 15, {align:'right'});
      y = 32;
    }

    function drawFooter(){
      doc.setFontSize(7.5);
      doc.setTextColor(...gray);
      doc.setFont('helvetica','normal');
      doc.text(`WAMS Incident Report — ${s.name}`, marginX, pageH-8);
      doc.text(`Page ${pageNum}`, pageW-marginX, pageH-8, {align:'right'});
    }

    function newPage(){
      drawFooter();
      doc.addPage();
      pageNum++;
      drawHeader();
    }

    function ensureSpace(h){
      if(y + h > pageH - 14) newPage();
    }

    function sectionTitle(title, badge, badgeColor){
      ensureSpace(12);
      doc.setFillColor(248,249,252);
      doc.rect(marginX, y, contentW, 8, 'F');
      doc.setDrawColor(228,232,240);
      doc.setLineWidth(0.2);
      doc.rect(marginX, y, contentW, 8);
      doc.setFont('helvetica','bold');
      doc.setFontSize(10);
      doc.setTextColor(...navy);
      doc.text(title, marginX+3, y+5.5);
      if(badge){
        doc.setFontSize(7.5);
        doc.setTextColor(...(badgeColor || red));
        doc.text(badge, marginX+contentW-3, y+5.5, {align:'right'});
      }
      y += 12;
    }

    function logLine(text, time, flagged, tag){
      ensureSpace(7);
      const dotColor = flagged ? red : gray;
      doc.setFillColor(...dotColor);
      doc.circle(marginX+1.5, y+1.7, 1, 'F');
      doc.setFont('helvetica','normal');
      doc.setFontSize(9);
      doc.setTextColor(...dark);
      const label = tag ? `${text}  —  ${tag}` : text;
      const lines = doc.splitTextToSize(label, contentW-45);
      doc.text(lines, marginX+6, y+2.2);
      doc.setFontSize(8);
      doc.setTextColor(...gray);
      doc.text(time || '', marginX+contentW, y+2.2, {align:'right'});
      y += Math.max(6.5, lines.length*4.4);
    }

    function emptyLine(text){
      ensureSpace(7);
      doc.setFont('helvetica','italic');
      doc.setFontSize(8.5);
      doc.setTextColor(...gray);
      doc.text(text, marginX+2, y+3);
      y += 8;
    }

    drawHeader();

    doc.setFillColor(248,249,252);
    doc.roundedRect(marginX, y, contentW, 22, 2, 2, 'F');
    doc.setDrawColor(228,232,240);
    doc.roundedRect(marginX, y, contentW, 22, 2, 2);
    const initColor = s.color || '#7C3AED';
    const rgb = initColor.match(/\w\w/g).map(h=>parseInt(h,16));
    doc.setFillColor(...rgb);
    doc.circle(marginX+13, y+11, 7, 'F');
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold');
    doc.setFontSize(9);
    doc.text(s.init || 'S1', marginX+13, y+13, {align:'center'});
    doc.setTextColor(...navy);
    doc.setFontSize(12.5);
    doc.text(s.name || 'Student Session', marginX+26, y+9.5);
    doc.setFont('helvetica','normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...gray);
    doc.text(`${ex.section || ex.meta || 'TBD'} · ${ex.title}`, marginX+26, y+15);
    doc.setFont('helvetica','bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...navy);
    doc.text(`Total Incidents: ${s.totalIncidents || 0}`, marginX+contentW-3, y+9, {align:'right'});
    doc.text(`Score: ${s.score != null ? s.score+' / '+(s.totalItems || 25) : 'Not entered'}`, marginX+contentW-3, y+15, {align:'right'});
    y += 28;

    const camFlagged = (s.cam || []).filter(c=>c.flagged).length;
    sectionTitle('Camera Capture', camFlagged ? `${camFlagged} flagged` : null);
    if((s.cam || []).length === 0) emptyLine('No camera captures recorded.');
    else (s.cam || []).forEach(c => logLine(c.flagged ? `Camera snapshot — ${c.tag}` : 'Camera snapshot — normal', c.time, c.flagged, null));
    y += 3;

    sectionTitle('Screen Capture');
    if((s.screen || []).length === 0) emptyLine('No screen captures recorded.');
    else (s.screen || []).forEach(sc => logLine('Screen snapshot captured', sc.time, false, null));
    y += 3;

    sectionTitle('Tab Switch Detection', (s.tabSwitches || []).length ? `${(s.tabSwitches || []).length} events` : null);
    if((s.tabSwitches || []).length === 0) emptyLine('No tab switching detected.');
    else (s.tabSwitches || []).forEach(t => logLine(t.text || 'Switched away from exam tab', t.time, true, null));
    y += 3;

    const audioFlagged = (s.audio || []).filter(a=>a.flagged).length;
    sectionTitle('Audio Capture', audioFlagged ? `${audioFlagged} flagged` : null);
    if((s.audio || []).length === 0) emptyLine('No audio captures recorded.');
    else (s.audio || []).forEach(a => logLine(`Audio clip (${a.dur})`, a.note, a.flagged, null));
    y += 3;

    sectionTitle('Question Activity Log');
    if((s.qlog || []).length === 0) emptyLine('No question activity recorded.');
    else (s.qlog || []).forEach(q => logLine(q.text, q.time, false, null));
    y += 3;

    const platform = ex.platform || (ex.type === 'gforms' ? 'gform' : 'wams');
    if(platform === 'gform'){
      sectionTitle('Review Answers');
      ensureSpace(24);
      doc.setFont('helvetica','normal');
      doc.setFontSize(9);
      doc.setTextColor(...dark);
      const noteLines = doc.splitTextToSize('This exam was conducted using Google Forms. Student answers are not stored in WAMS — review and grade them directly on Google Forms.', contentW-4);
      doc.text(noteLines, marginX, y+4);
      y += noteLines.length*4.4 + 8;
      ensureSpace(8);
      doc.setFont('helvetica','bold');
      doc.setFontSize(9);
      doc.setTextColor(...navy);
      doc.textWithLink('https://docs.google.com/forms/u/0/?tgif=d', marginX, y+2, { url:'https://docs.google.com/forms/u/0/?tgif=d' });
      y += 10;
    } else {
      const answers = s.answers || [];
      const gradable = answers.filter(a => a.type !== 'paragraph');
      const correctCount = gradable.filter(a => a.correct).length;
      const reviewCount = answers.length - gradable.length;

      let badgeText = null, badgeColor = gray;
      if(answers.length){
        if(gradable.length === 0){
          badgeText = `${reviewCount} to review`;
          badgeColor = [217,119,6];
        } else {
          badgeText = `${correctCount}/${gradable.length} correct` + (reviewCount ? ` · ${reviewCount} to review` : '');
          badgeColor = correctCount === gradable.length ? green : (correctCount === 0 ? red : [217,119,6]);
        }
      }
      sectionTitle('Review Answers', badgeText, badgeColor);

      if(answers.length === 0){
        emptyLine('No answer data recorded for this student.');
      } else {
        answers.forEach((a, i) => {
          const typeLabel = {mcq:'Multiple Choice', checkbox:'Checkboxes', short:'Short Answer', paragraph:'Paragraph'}[a.type] || 'Question';
          const qLines = doc.splitTextToSize(`${i+1}. ${a.q}  [${typeLabel}]`, contentW-4);
          ensureSpace(qLines.length*4.4 + 14);
          doc.setFont('helvetica','bold');
          doc.setFontSize(9);
          doc.setTextColor(...dark);
          doc.text(qLines, marginX, y+3);
          y += qLines.length*4.4 + 2;

          doc.setFont('helvetica','normal');
          doc.setFontSize(8.5);

          if(a.type === 'mcq' || a.type === 'short'){
            doc.setTextColor(...(a.correct ? green : red));
            const ansLines = doc.splitTextToSize(`${a.correct ? 'Correct' : 'Incorrect'} — Student's answer: ${a.studentAnswer}`, contentW-6);
            ensureSpace(ansLines.length*4.2 + 6);
            doc.text(ansLines, marginX+2, y+3);
            y += ansLines.length*4.2;
            if(!a.correct){
              doc.setTextColor(...gray);
              const correctLines = doc.splitTextToSize(`Correct answer: ${a.correctAnswer}`, contentW-6);
              ensureSpace(correctLines.length*4.2 + 4);
              doc.text(correctLines, marginX+2, y+3);
              y += correctLines.length*4.2;
            }
          } else if(a.type === 'checkbox'){
            doc.setTextColor(...(a.correct ? green : red));
            const selLines = doc.splitTextToSize(`${a.correct ? 'Correct' : 'Incorrect'} — Selected: ${a.studentAnswer.join(', ') || 'None'}`, contentW-6);
            ensureSpace(selLines.length*4.2 + 6);
            doc.text(selLines, marginX+2, y+3);
            y += selLines.length*4.2;
            if(!a.correct){
              doc.setTextColor(...gray);
              const correctLines = doc.splitTextToSize(`Correct selection: ${a.correctAnswer.join(', ')}`, contentW-6);
              ensureSpace(correctLines.length*4.2 + 4);
              doc.text(correctLines, marginX+2, y+3);
              y += correctLines.length*4.2;
            }
          } else if(a.type === 'paragraph'){
            doc.setTextColor(...[217,119,6]);
            doc.setFont('helvetica','italic');
            doc.text('Needs manual review', marginX+2, y+3);
            y += 5;
            doc.setFont('helvetica','normal');
            doc.setTextColor(...dark);
            const paraLines = doc.splitTextToSize(a.studentAnswer, contentW-8);
            ensureSpace(paraLines.length*4.2 + 4);
            doc.setDrawColor(228,232,240);
            doc.setFillColor(248,249,252);
            const boxH2 = paraLines.length*4.2 + 6;
            doc.roundedRect(marginX+2, y-2, contentW-4, boxH2, 1.5, 1.5, 'FD');
            doc.text(paraLines, marginX+5, y+3);
            y += boxH2;
          }
          y += 5;
        });
      }
    }
    y += 3;

    drawFooter();

    const filename = `${(s.name || 'Student').replace(/\s+/g,'_')}_${(ex.title || 'Exam').replace(/\s+/g,'_')}_Incident_Report.pdf`;
    doc.save(filename);

    if(btn){
      btn.innerHTML = originalBtnHtml;
      btn.disabled = false;
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    }
    showToast(`PDF report downloaded for ${s.name || 'student'}.`);
  }catch(err){
    console.error(err);
    if(btn){
      btn.innerHTML = originalBtnHtml;
      btn.disabled = false;
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    }
    showToast('Could not generate PDF. Please try again.');
  }
}

function showToast(message){
  const toast = document.getElementById('toast');
  const msg = document.getElementById('toastMsg');
  if(!toast || !msg) return;
  msg.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function confirmLogout(event){
  event.preventDefault();
  if(confirm('Are you sure you want to sign out?')){
    localStorage.removeItem('wamsToken');
    localStorage.removeItem('token');
    localStorage.removeItem('wamsProfessorName');
    localStorage.removeItem('wamsCurrentUserId');
    window.location.href = 'wams-professor-log-in.html';
  }
}

/* close modal on overlay click / Escape key (new feature) */
document.getElementById('deleteModal').addEventListener('click', function(e){
  if(e.target === this) closeDeleteModal();
});
/* ═══════════════ PLAYABLE AUDIO & IMAGE MODAL HELPERS ═══════════════ */
let currentPlayingAudio = null;
let currentPlayingBtn = null;
let audioToneCtx = null;

function playAudioItem(btn, index, audioClip, level, isFlagged) {
  if (currentPlayingAudio && currentPlayingBtn === btn) {
    stopCurrentAudio();
    return;
  }
  stopCurrentAudio();

  btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:currentColor;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  btn.classList.add('playing');
  currentPlayingBtn = btn;

  const waveEl = document.getElementById(`wave-${index}`);
  if (waveEl) waveEl.classList.add('animating');

  if (audioClip && typeof audioClip === 'string' && audioClip.startsWith('data:audio')) {
    try {
      const audio = new Audio(audioClip);
      currentPlayingAudio = audio;
      audio.onended = () => stopCurrentAudio();
      audio.onerror = () => playSynthesizedTone(level || 40, isFlagged);
      audio.play().catch(() => playSynthesizedTone(level || 40, isFlagged));
      return;
    } catch(e) {}
  }

  playSynthesizedTone(level || 40, isFlagged);
}

function playSynthesizedTone(level, isFlagged) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audioToneCtx = new AudioCtx();
    const osc = audioToneCtx.createOscillator();
    const gain = audioToneCtx.createGain();

    osc.type = isFlagged ? 'sawtooth' : 'sine';
    osc.frequency.setValueAtTime(isFlagged ? 520 : 340, audioToneCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(isFlagged ? 360 : 440, audioToneCtx.currentTime + 1.2);

    const vol = Math.min(0.8, Math.max(0.15, (level || 30) / 100));
    gain.gain.setValueAtTime(vol, audioToneCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioToneCtx.currentTime + 1.5);

    osc.connect(gain);
    gain.connect(audioToneCtx.destination);

    osc.start();
    osc.stop(audioToneCtx.currentTime + 1.5);

    currentPlayingAudio = {
      pause: () => {
        try { osc.stop(); } catch(e) {}
        try { audioToneCtx.close(); } catch(e) {}
      }
    };

    setTimeout(stopCurrentAudio, 1500);
  } catch(e) {
    stopCurrentAudio();
  }
}

function stopCurrentAudio() {
  if (currentPlayingAudio) {
    if (typeof currentPlayingAudio.pause === 'function') {
      currentPlayingAudio.pause();
    }
    currentPlayingAudio = null;
  }
  if (currentPlayingBtn) {
    currentPlayingBtn.innerHTML = `<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
    currentPlayingBtn.classList.remove('playing');
    currentPlayingBtn = null;
  }
  document.querySelectorAll('.audio-wave.animating').forEach(w => w.classList.remove('animating'));
}

function viewImagePreview(src, title, isFlagged, timeStr) {
  const modal = document.getElementById('imageModal');
  const modalImg = document.getElementById('imageModalImg');
  const modalTitle = document.getElementById('imageModalTitle');
  const modalBadge = document.getElementById('imageModalBadge');
  const modalTime = document.getElementById('imageModalTime');

  if (!modal || !modalImg) return;
  modalImg.src = src;
  if (modalTitle) modalTitle.textContent = title || 'Capture Preview';
  if (modalTime) modalTime.textContent = timeStr ? `Captured at ${timeStr}` : '';
  if (modalBadge) modalBadge.style.display = isFlagged ? 'inline-flex' : 'none';
  modal.style.display = 'flex';
}

function closeImageModal(e) {
  if (e && e.target && e.target.id !== 'imageModal' && !e.target.closest('.image-modal-close') && e.target.tagName !== 'BUTTON' && !e.target.closest('button')) return;
  const modal = document.getElementById('imageModal');
  if (modal) modal.style.display = 'none';
}

function downloadModalImage() {
  const modalImg = document.getElementById('imageModalImg');
  if (!modalImg || !modalImg.src) return;
  const a = document.createElement('a');
  a.href = modalImg.src;
  a.download = `wams-capture-${Date.now()}.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

document.addEventListener('keydown', function(e){
  if(e.key === 'Escape') {
    closeDeleteModal();
    closeImageModal();
  }
});

renderExamGridFromCache();
renderExamGrid();
