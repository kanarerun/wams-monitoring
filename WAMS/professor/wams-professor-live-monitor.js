

function getAuthToken(){
  return localStorage.getItem('wamsToken') || localStorage.getItem('token');
}

/* ── Auth Guard ── */
(async function checkProfessorAuth(){
  const token = getAuthToken();
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

let currentExamKey = null;
let liveMonitorView = 'exams';

async function loadExams(){
  try {
    const token = getAuthToken();
    if(!token) return [];
    const res = await fetch('/api/my-exams', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.map(ex => ({
      id: ex.id,
      title: ex.title,
      section: ex.section_name,
      students: ex.students,
      status: ex.status,
      type: ex.type,
      created: new Date(ex.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
    })) : [];
  } catch {
    return [];
  }
}

function getStatusBadge(status){
  const label = status === 'live' ? 'Live' : status === 'upcoming' ? 'Upcoming' : status === 'ended' ? 'Ended' : 'Scheduled';
  const className = status === 'live' ? 'live-badge' : status === 'upcoming' ? 'live-badge' : status === 'ended' ? 'bdg bdg-gray' : 'live-badge';
  if(status === 'ended'){
    return `<span class="${className}"><span class="bdg-dot"></span>${label}</span>`;
  }
  return `<span class="${className}"><span class="live-dot"></span>${label}</span>`;
}

function getExamIcon(type){
  if(type === 'gforms'){
    return {bg:'var(--purple-bg)', color:'var(--purple)', svg:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="8" x2="17" y2="8"/><line x1="9" y1="12" x2="17" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>'};
  }
  return {bg:'var(--blue-bg)', color:'var(--blue)', svg:'<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'};
}

async function getMonitoringExams(){
  const exams = await loadExams();
  return exams.filter(Boolean).filter(ex => ex.status !== 'ended').sort((a, b) => {
    const order = { live: 0, upcoming: 1, scheduled: 2 };
    return (order[a.status] ?? 99) - (order[b.status] ?? 99);
  });
}

async function renderSidebarBadges(exams){
  const liveBadge = document.querySelector('a[href="wams-professor-live-monitor.html"] .sb-badge.green');
  const logsBadge = document.querySelector('a[href="wams-professor-monitoring-logs.html"] .sb-badge');
  if(liveBadge) liveBadge.textContent = exams.filter(ex => ['live', 'upcoming', 'scheduled'].includes(ex.status)).length;
  if(logsBadge) logsBadge.textContent = exams.filter(ex => ex.status === 'ended').length;
}

async function getExamSessions(examId){
  try {
    const token = getAuthToken();
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

async function getRealFlaggedCount(examId){
  try {
    const token = getAuthToken();
    if(!token) return 0;
    const res = await fetch(`/api/exams/${examId}/tab-switches`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return 0;
    const data = await res.json();
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

async function getExamTabSwitches(examId){
  try {
    const token = getAuthToken();
    if(!token) return [];
    const res = await fetch(`/api/exams/${examId}/tab-switches`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function getSessionCaptures(sessionId){
  try {
    const token = getAuthToken();
    if(!token) return [];
    const res = await fetch(`/api/sessions/${sessionId}/captures`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function getSessionScreenCaptures(sessionId){
  try {
    const token = getAuthToken();
    if(!token) return [];
    const res = await fetch(`/api/sessions/${sessionId}/screen-captures`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function getSessionAudioCaptures(sessionId){
  try {
    const token = getAuthToken();
    if(!token) return [];
    const res = await fetch(`/api/sessions/${sessionId}/audio-captures`, {
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
    const token = getAuthToken();
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

function safeParseJSON(value, fallback){
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
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

async function getExamDetails(examId){
  try {
    const token = getAuthToken();
    if(!token) return null;
    const res = await fetch(`/api/exams/${examId}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function renderSidebarBadgesFromCache(){
  // caching disabled — always render from live API
  return;
}

function renderExamGridFromCache(){
  // caching disabled — no-op
  return;
}

async function renderExamGrid(){
  const grid = document.getElementById('examGrid');
  if(!grid) return;

  const allExams = await loadExams();
  const exams = await getMonitoringExams();
  await renderSidebarBadges(allExams);

  // caching intentionally disabled — always use live data

  if(exams.length === 0){
    grid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <p>No exams yet. Create one from My Exams and it will appear here.</p>
      </div>`;
    localStorage.removeItem('wamsLiveMonitorGrid');
    return;
  }

  const examsWithFlags = await Promise.all(exams.map(async ex => {
    const flagged = await getRealFlaggedCount(ex.id);
    const sessions = await getExamSessions(ex.id);
    const active = Array.isArray(sessions) ? sessions.filter(s => !s.submitted_at).length : 0;
    return { ...ex, flagged, active };
  }));

  grid.innerHTML = examsWithFlags.map(ex => {
    const icon = getExamIcon(ex.type);
    const total = Number(ex.students) || 0;
    const active = Number(ex.active) || 0;
    return `
      <div class="exam-card" onclick="openExam('${ex.id}')">
        <div class="exam-card-top">
          <div class="exam-card-icon" style="background:${icon.bg};color:${icon.color}">${icon.svg}</div>
          ${getStatusBadge(ex.status)}
        </div>
        <h3>${ex.title || 'Untitled Exam'}</h3>
        <div class="meta">${ex.section || 'TBD'} · ${ex.created || '—'}</div>
        <div class="exam-card-stats">
          <div class="ec-stat"><div class="n">${total}</div><div class="l">Students</div></div>
          <div class="ec-stat"><div class="n">${active}</div><div class="l">Active</div></div>
          <div class="ec-stat flag"><div class="n">${ex.flagged}</div><div class="l">Flagged</div></div>
        </div>
        <div class="exam-card-foot">
          View students
          <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
       </div>`;
   }).join('');

  // caching intentionally disabled — always use live data
 }

async function openExam(id){
  const exams = await getMonitoringExams();
  const ex = exams.find(item => String(item.id) === String(id));
  if(!ex) return;

  document.getElementById('examBannerIcon').innerHTML = getExamIcon(ex.type).svg;
  document.getElementById('examBannerTitle').textContent = ex.title || 'Untitled Exam';
  document.getElementById('examBannerMeta').textContent = `${ex.section || 'TBD'} · ${ex.created || '—'}`;

  const sessions = await getExamSessions(ex.id);
  const total = sessions.length;
  const active = sessions.filter(s => !s.submitted_at).length;
  const tabSwitches = await getExamTabSwitches(ex.id);
  const flaggedCount = Array.isArray(tabSwitches) ? tabSwitches.length : await getRealFlaggedCount(ex.id);

  document.getElementById('bannerTotal').textContent = total;
  document.getElementById('bannerActive').textContent = active;
  document.getElementById('bannerFlag').textContent = flaggedCount;

  const tbody = document.getElementById('studentTbody');
  if(total === 0){
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">No students have started this exam yet.</div></td></tr>`;
  } else {
    tbody.innerHTML = sessions.map((s, idx) => {
      const isSubmitted = !!s.submitted_at;
      const isFlagged = tabSwitches && tabSwitches.some(ts => String(ts.session_id) === String(s.id));
      const statusClass = isFlagged ? 'bdg bdg-red' : (isSubmitted ? 'bdg bdg-gray' : 'bdg bdg-green');
      const statusText = isFlagged ? 'Flagged' : (isSubmitted ? 'Submitted' : 'Active');
      const initials = (s.student_name || 'S' + (idx+1)).split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
      return `<tr onclick="openStudent('${ex.id}', '${s.id}')"><td><div class="uc"><div class="uav" style="background:${s.color || '#2563EB'}">${initials}</div><div><b>${s.student_name || 'Student ' + (idx+1)}</b><span style="color:var(--tx3);font-size:12px">${s.student_id || '—'}</span></div></div></td><td style="color:var(--tx2)">${formatLocalTime(s.started_at)}</td><td><span class="bdg ${statusClass}"><span class="bdg-dot"></span>${statusText}</span></td><td style="text-align:right"><svg class="chev" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></td></tr>`;
    }).join('');
  }

  document.getElementById('topTitle').textContent = ex.title || 'Untitled Exam';
  document.getElementById('topCrumb').innerHTML = `<span class="crumb-link" onclick="backToExams()">Live Monitoring</span> / ${ex.title || 'Untitled Exam'}`;

  switchView('view2');
  currentExamKey = id;
  liveMonitorView = 'students';
  clearTimeout(window._monitorTimer);
  window._monitorTimer = setTimeout(() => { if (currentExamKey === id && liveMonitorView !== 'student') openExam(id); }, 5000);
}


async function openStudent(key, sessionId){
  liveMonitorView = 'student';
  clearTimeout(window._monitorTimer);
  const exams = await getMonitoringExams();
  const ex = exams.find(item => String(item.id) === String(key));
  if(!ex) return;

  const sessions = await getExamSessions(ex.id);
  const session = sessions.find(s => String(s.id) === String(sessionId));
  if(!session) return;

  const captures = await getSessionCaptures(session.id);
  const screenCaptures = await getSessionScreenCaptures(session.id);
  const audioCaptures = await getSessionAudioCaptures(session.id);
  const tabSwitches = await getExamTabSwitches(ex.id);
  const questionActivities = await getQuestionActivity(ex.id);
  const studentActivities = questionActivities.filter(qa => String(qa.session_id) === String(session.id));
  const studentInitials = (session.student_name || 'Student').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  const studentAnswers = safeParseJSON(session.answers, {});
  const answeredCount = Object.keys(studentAnswers).length;
  const questionIndex = Math.max(1, answeredCount + 1);
  const examQuestions = safeParseJSON(session.exam_questions, []);
  // Use the actual question count from the exam's stored questions.
  // Fall back to fetching exam details if the session doesn't carry exam_questions.
  let totalQuestions = Array.isArray(examQuestions) && examQuestions.length > 0 ? examQuestions.length : 0;
  if(totalQuestions === 0){
    const examDetail = await getExamDetails(ex.id);
    const detailQuestions = examDetail && examDetail.questions ? (Array.isArray(examDetail.questions) ? examDetail.questions : safeParseJSON(examDetail.questions, [])) : [];
    totalQuestions = Array.isArray(detailQuestions) && detailQuestions.length > 0 ? detailQuestions.length : 0;
  }
  if(totalQuestions === 0) totalQuestions = 1; // avoid division by zero / "of 0"
  const isFlagged = tabSwitches.some(ts => String(ts.session_id) === String(session.id));
  const statusLabel = isFlagged ? 'Flagged' : (session.submitted_at ? 'Submitted' : 'Active');
  const statusClass = isFlagged ? 'bdg bdg-red' : session.submitted_at ? 'bdg bdg-gray' : 'bdg bdg-green';
  const startedAt = formatLocalTime(session.started_at);
  const startedDate = parseDbTime(session.started_at);
  const elapsed = startedDate ? Math.max(0, Math.floor((Date.now() - startedDate.getTime()) / 60000)) + ' min' : '—';

  document.getElementById('studentAvatar').textContent = studentInitials;
  document.getElementById('studentAvatar').style.background = session.color || '#7C3AED';
  document.getElementById('studentName').textContent = session.student_name || 'Unknown Student';
  document.getElementById('studentSection').textContent = `${ex.section || 'TBD'} · ${ex.title || 'Exam'}`;
  document.getElementById('studentStart').textContent = startedAt;
  document.getElementById('studentElapsed').textContent = elapsed;

  const badgeEl = document.getElementById('studentStatusBdg');
  badgeEl.className = statusClass;
  badgeEl.innerHTML = `<span class="bdg-dot"></span>${statusLabel}`;

  const tabLogEl = document.getElementById('liveTabSwitchLog');
  const tabFlagCount = document.getElementById('liveTabFlagCount');
  const studentTabSwitches = tabSwitches.filter(ts => String(ts.session_id) === String(session.id));
  if(studentTabSwitches.length > 0){
    tabLogEl.innerHTML = studentTabSwitches.map(ts => `
      <li class="tslog-item">
        <div class="tslog-ic">
          <svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div>
          <div class="tslog-txt">Switched away from exam tab</div>
          <div class="tslog-time">${formatLocalTime(ts.switched_at)}</div>
        </div>
      </li>`).join('');
    tabFlagCount.style.display = 'inline-flex';
    tabFlagCount.textContent = `${studentTabSwitches.length} events`;
  } else {
    tabLogEl.innerHTML = '<li class="tslog-item" style="color:var(--tx3);font-size:12px;">No tab switching detected.</li>';
    tabFlagCount.style.display = 'none';
  }

  const cameraGrid = document.getElementById('liveCameraShots');
  if(captures.length > 0){
    cameraGrid.innerHTML = captures.map(c => {
      const src = c.image_data?.startsWith('data:') ? c.image_data : `data:image/jpeg;base64,${c.image_data}`;
      const timeStr = formatLocalTime(c.captured_at);
      const flagged = !!c.flagged;
      return `
        <div class="shot ${flagged ? 'flagged' : ''}" onclick="viewImagePreview('${src}', 'Camera Capture', ${flagged}, '${timeStr}')" title="Click to view full image">
          <img src="${src}" alt="Camera Capture">
          ${flagged ? `<span class="shot-flag-tag">Flagged</span>` : ''}
          <span class="shot-time">${timeStr}</span>
        </div>`;
    }).join('');
    document.getElementById('liveCamFlagCount').style.display = 'inline-flex';
    document.getElementById('liveCamFlagCount').textContent = `${captures.length} captures`;
  } else {
    cameraGrid.innerHTML = '<div style="font-size:12px;color:var(--tx3);padding:10px 0;">No camera captures recorded.</div>';
    document.getElementById('liveCamFlagCount').style.display = 'none';
  }

  const screenShotsEl = document.getElementById('liveScreenShots');
  if(screenCaptures.length > 0){
    screenShotsEl.innerHTML = screenCaptures.map(c => {
      const src = c.image_data?.startsWith('data:') ? c.image_data : `data:image/jpeg;base64,${c.image_data}`;
      const timeStr = formatLocalTime(c.captured_at);
      return `
        <div class="screenshot" onclick="viewImagePreview('${src}', 'Screen Capture', false, '${timeStr}')" title="Click to view full screenshot">
          <img src="${src}" alt="Screen Capture">
          <span class="shot-time">${timeStr}</span>
        </div>`;
    }).join('');
  } else {
    screenShotsEl.innerHTML = '<div style="font-size:12px;color:var(--tx3);padding:10px 0;">No screen captures recorded.</div>';
  }

  const audioListEl = document.getElementById('liveAudioList');
  const audioFlagCount = document.getElementById('liveAudioFlagCount');
  if(audioCaptures.length > 0){
    audioListEl.innerHTML = audioCaptures.map((c, i) => {
      let audioData = null;
      let audioClip = null;
      let level = 30;
      try {
        const parsed = typeof c.image_data === 'string' ? JSON.parse(c.image_data) : c.image_data;
        if(parsed){
          audioData = parsed;
          audioClip = parsed.audio_clip || null;
          level = parsed.level || 30;
        }
      } catch {}
      const flagged = Boolean(c.flagged || (audioData && audioData.flagged));
      const timeStr = formatLocalTime(c.captured_at);
      const audioClipParam = audioClip ? `'${audioClip}'` : 'null';
      return `
        <li class="audio-item ${flagged ? 'flagged' : ''}">
          <div class="play-btn" onclick="playAudioItem(this, ${i}, ${audioClipParam}, ${level}, ${flagged})" title="Play recorded audio clip">
            <svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>
          </div>
          <div class="audio-wave" id="wave-${i}"></div>
          <div class="audio-meta">
            <div class="t">${timeStr}</div>
            <div class="s">${flagged ? 'Flagged anomaly' : 'Audio capture'}</div>
          </div>
        </li>`;
    }).join('');
    audioFlagCount.style.display = 'inline-flex';
    audioFlagCount.textContent = `${audioCaptures.filter(c => {
      try {
        const parsed = typeof c.image_data === 'string' ? JSON.parse(c.image_data) : c.image_data;
        return c.flagged || (parsed && parsed.flagged);
      } catch { return false; }
    }).length} flagged`;
    setTimeout(buildWaves, 10);
  } else {
    audioListEl.innerHTML = '<li style="font-size:12px;color:var(--tx3);padding:6px 0;">No audio captures recorded.</li>';
    audioFlagCount.style.display = 'none';
  }

  const questionProgress = document.getElementById('liveQuestionProgress');
  questionProgress.innerHTML = `
    <b>Currently on Question ${Math.min(questionIndex, totalQuestions)} of ${totalQuestions}</b>
    <span>Answered ${answeredCount} questions</span>
    <div class="qtrack-progress"><div class="qtrack-fill" style="width:${Math.min(100, (answeredCount / totalQuestions) * 100)}%"></div></div>`;

  const qlog = document.getElementById('liveQLog');
  if(studentActivities.length > 0){
    qlog.innerHTML = studentActivities.map(qa => `
      <li class="qlog-item"><span class="qlog-time">${formatLocalTime(qa.created_at)}</span><span class="qlog-txt">${qa.activity_type === 'answered' ? 'Answered' : 'Moved to'} <b>Question ${qa.question_number}</b></span></li>`).join('');
  } else if(answeredCount > 0){
    qlog.innerHTML = Object.keys(studentAnswers).sort((a,b)=>a-b).map(q => `
      <li class="qlog-item"><span class="qlog-time">${formatLocalTime(session.started_at)}</span><span class="qlog-txt">Answered <b>Question ${q}</b></span></li>`).join('');
  } else {
    qlog.innerHTML = '<li class="qlog-item" style="color:var(--tx3);font-size:12px;">No question activity recorded yet.</li>';
  }

  document.getElementById('topTitle').textContent = session.student_name || 'Student Session';
  document.getElementById('topCrumb').innerHTML = `<span class="crumb-link" onclick="backToExams()">Live Monitoring</span> / <span class="crumb-link" onclick="backToStudents()">${ex.title}</span> / ${session.student_name || 'Student Session'}`;

  switchView('view3');
}

function backToExams(){
  liveMonitorView = 'exams';
  clearTimeout(window._monitorTimer);
  document.getElementById('topTitle').textContent = 'Live Monitoring';
  document.getElementById('topCrumb').textContent = '';
  switchView('view1');
}

async function backToStudents(){
  liveMonitorView = 'students';
  clearTimeout(window._monitorTimer);
  const exams = await getMonitoringExams();
  const ex = exams.find(item => String(item.id) === String(currentExamKey));
  document.getElementById('topTitle').textContent = ex ? ex.title || 'Untitled Exam' : 'Live Monitoring';
  document.getElementById('topCrumb').innerHTML = `<span class="crumb-link" onclick="backToExams()">Live Monitoring</span> / ${ex ? ex.title || 'Untitled Exam' : ''}`;
  switchView('view2');
}

function switchView(id){
  document.querySelectorAll('.view').forEach(v => v.classList.remove('show'));
  document.getElementById(id).classList.add('show');
  document.querySelector('.page').scrollTop = 0;
}

function buildWaves(){
  ['wave1','wave2','wave3'].forEach(id=>{
    const el = document.getElementById(id);
    if(!el || el.dataset.built) return;
    let html = '';
    for(let i=0;i<40;i++){
      const h = 4 + Math.round(Math.random()*18);
      html += `<div class="wave-bar" style="height:${h}px"></div>`;
    }
    el.innerHTML = html;
    el.dataset.built = '1';
  });
}

function confirmLogout(event) {
  event.preventDefault();
  if(confirm('Are you sure you want to sign out?')){
    localStorage.removeItem('wamsToken');
    localStorage.removeItem('token');
    localStorage.removeItem('wamsProfessorName');
    localStorage.removeItem('wamsCurrentUserId');
    window.location.href = 'wams-professor-log-in.html';
  }
}

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

window.addEventListener('storage', renderExamGrid);
window.addEventListener('pageshow', renderExamGrid);
// caching removed: always render fresh data
renderExamGrid();
