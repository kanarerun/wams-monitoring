verifyProfessorAuth(me => {
  if(me.name){
    const pdfName = document.getElementById('pdfGeneratedBy');
    if(pdfName) pdfName.textContent = me.name;
  }
});

function toggleSb(){
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}

const logMediaObjectUrls = new Set();

async function loadLogCaptureMedia(capture, token){
  if(!capture || !capture.media_url) return null;
  try {
    const response = await fetch(capture.media_url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    logMediaObjectUrls.add(url);
    return url;
  } catch(error) {
    console.warn(`Failed to load ${capture.capture_type || 'exam'} media:`, error);
    return null;
  }
}

/* HTML-escape any server value before it goes through innerHTML. Student
   names, exam titles, question text and answers are all free-text fields, so
   without this a crafted name or title would run script in the professor's
   browser (stored XSS). */
function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[ch]);
}

/* ───── Load real data from server API ───── */
async function loadExams(){
  try {
    const token = getProfessorAuthToken();
    if(!token) return [];
    const res = await fetch('/api/my-exams', {
      headers: { 'Authorization': 'Bearer ' + token },
      cache: 'no-store'
    });
    if(res.status === 401){
      handleProfessorAuthExpired(token);
      return [];
    }
    if(!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.map(ex => ({
      id: ex.id,
      title: ex.title,
      section: ex.section_name || ex.section || 'General',
      students: Number(ex.students) || 0,
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
    const token = getProfessorAuthToken();
    if(!token) return [];
    const res = await fetch(`/api/exams/${examId}/sessions`, {
      headers: { 'Authorization': 'Bearer ' + token },
      cache: 'no-store'
    });
    if(!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function countUniqueStudents(sessions){
  return new Set(sessions.map(session => String(session.student_id ?? session.id))).size;
}



async function getTabSwitchData(examId){
  try {
    const token = getProfessorAuthToken();
    if(!token){
      console.warn('Cannot load tab-switch archive without an auth token.');
      return null;
    }
    const res = await fetch('/api/exams/' + examId + '/tab-switches', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok){
      console.warn('Tab-switch archive request failed with status:', res.status);
      return null;
    }
    const data = await res.json();
    return { log: data, count: data.length };
  } catch (error) {
    console.warn('Unable to load tab-switch archive:', error);
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

// Exam duration for one session: the stored time_used when the server has it,
// otherwise the gap between the session start and its submission.
function formatExamDuration(session){
  if(!session) return '—';
  let seconds = null;
  if(Number.isFinite(session.timeUsed) && session.timeUsed > 0){
    seconds = session.timeUsed;
  } else {
    const start = parseDbTime(session.startedAt);
    const end = parseDbTime(session.submittedAt);
    if(start && end && end.getTime() > start.getTime()){
      seconds = Math.round((end.getTime() - start.getTime()) / 1000);
    }
  }
  if(seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  if(h > 0) return `${h}h ${m}m`;
  if(m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatEventTimestamp(value){
  const dt = parseDbTime(value);
  if(!dt || isNaN(dt.getTime())) return 'Time unavailable';
  return dt.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit'
  });
}

function getCameraDetectionLabels(capture){
  let data = capture.detection_data;
  if(typeof data === 'string'){
    try { data = JSON.parse(data); }
    catch { return []; }
  }
  const labels = {
    no_face: 'No face',
    multiple_faces: 'Multiple faces',
    possible_head_turn: 'Possible head turn',
    possible_phone: 'Possible phone'
  };
  const results = Array.isArray(data?.flagged_reasons)
    ? data.flagged_reasons.map(reason => labels[reason]).filter(Boolean)
    : [];
  if(Array.isArray(data?.detections)){
    data.detections.forEach(detection => {
      if(typeof detection?.label !== 'string') return;
      const label = detection.label.replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[character]);
      const score = Number(detection.score);
      results.push(`${label}${Number.isFinite(score) ? ` ${Math.round(score * 100)}%` : ''}`);
    });
  }
  if(results.length > 3) return [...results.slice(0, 3), `+${results.length - 3} more`];
  return results;
}

async function fetchScreenCapturesFromServer(examId){
  try {
    const token = getProfessorAuthToken();
    if(!token) return [];
    const sessions = await getExamSessions(examId);
    const captures = [];
    for(const session of sessions){
      const res = await fetch(`/api/sessions/${session.id}/screen-captures`, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if(res.ok){
        const data = await res.json();
        // Every stored screen row is a tab-switch snapshot; the server already
        // normalises the trigger, so no client-side filter is needed here.
        for(const c of data){
          const image = await loadLogCaptureMedia(c, token);
          if(image) captures.push({
            session_id: session.id,
            time: c.captured_at,
            image,
            capture_id: c.capture_id
          });
        }
      }
    }
    return captures;
  } catch {
    return [];
  }
}

// Metadata-only capture list for one exam: no media is downloaded, so the
// student table can count incidents without touching the blob URLs.
async function fetchCaptureList(examId, endpoint){
  try {
    const token = getProfessorAuthToken();
    if(!token) return [];
    const sessions = await getExamSessions(examId);
    const rows = [];
    for(const session of sessions){
      const res = await fetch(`/api/sessions/${session.id}/${endpoint}`, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if(!res.ok) continue;
      const data = await res.json();
      if(Array.isArray(data)) rows.push(...data);
    }
    return rows;
  } catch {
    return [];
  }
}

function parseAudioLevel(metadataJson){
  try {
    const parsed = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson;
    const level = Number(parsed && parsed.level_dbfs);
    return Number.isFinite(level) ? level : null;
  } catch {
    return null;
  }
}

async function fetchAudioCapturesFromServer(examId){
  try {
    const token = getProfessorAuthToken();
    if(!token) return [];
    const sessions = await getExamSessions(examId);
    const captures = [];
    for(const session of sessions){
      const res = await fetch(`/api/sessions/${session.id}/audio-captures`, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if(res.ok){
        const data = await res.json();
        for(const c of data){
          let isFlagged = Boolean(c.flagged);
          let audioData = {};
          try {
            const parsed = typeof c.metadata_json === 'string' ? JSON.parse(c.metadata_json) : c.metadata_json;
            if(parsed && typeof parsed === 'object'){
              audioData = parsed;
              if(typeof parsed.flagged !== 'undefined') isFlagged = Boolean(parsed.flagged);
            }
          } catch(e) {}
          const audioClip = await loadLogCaptureMedia(c, token);
          captures.push({
            session_id: session.id,
            time: c.captured_at,
            audio_clip: audioClip,
            levelDbfs: typeof audioData.level_dbfs === 'number' && Number.isFinite(audioData.level_dbfs)
              ? audioData.level_dbfs
              : null,
            flagged: isFlagged
          });
        }
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
        <p>No ended exams match "${escapeHtml(filterText)}".</p>
      </div>`;
    return;
  }

  // getTabSwitchData is async — resolve all cards before injecting into the grid
  const cards = await Promise.all(filtered.map(async ex => {
    const icon = getExamIcon(ex.type);
    const ts = await getTabSwitchData(ex.id);
    const sessions = await getExamSessions(ex.id);
    const flaggedCount = ts ? ts.count : 0;
    const incidentCount = ts ? ts.log.length : 0;
    return `
      <div class="exam-card" onclick="openExam('${ex.id}')">
        <button class="exam-card-del" title="Delete exam" onclick="event.stopPropagation(); openDeleteModal('${ex.id}')">
          <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
        <div class="exam-card-top">
          <div class="exam-card-icon" style="background:${icon.bg};color:${icon.color}">${icon.svg}</div>
          <span class="ended-badge">Ended</span>
        </div>
        <h3>${escapeHtml(ex.title)}</h3>
        <div class="meta">${escapeHtml(ex.section || 'TBD')} · ${escapeHtml(ex.created || '—')}</div>
        <div class="exam-card-stats">
          <div class="ec-stat"><div class="n">${countUniqueStudents(sessions)}</div><div class="l">Students</div></div>
          <div class="ec-stat flag"><div class="n">${flaggedCount}</div><div class="l">Flagged</div></div>
          <div class="ec-stat"><div class="n">${incidentCount}</div><div class="l">Incidents</div></div>
        </div>
        <div class="exam-card-foot">
          View students
          <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>`;
  }));

  grid.innerHTML = cards.join('');
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
  document.getElementById('deleteModalExamName').innerHTML = `<b>${escapeHtml(ex.title)}</b>`;
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
  const token = getProfessorAuthToken();
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

async function openExam(id){
  currentExamKey = id;
  const exams = await loadExams();
  const ex = exams.find(e => String(e.id) === String(id));
  if(!ex) return;

  const icon = getExamIcon(ex.type);
  const ts = await getTabSwitchData(ex.id);
  const flaggedCount = ts ? ts.count : 0;
  const incidentCount = ts ? ts.log.length : 0;
  const sessions = await getExamSessions(ex.id);

  document.getElementById('examBannerIcon').innerHTML = icon.svg;
  document.getElementById('examBannerTitle').textContent = ex.title;
  document.getElementById('examBannerMeta').textContent = ex.section + ' · ' + (ex.created || '—');
  document.getElementById('bannerTotal').textContent = countUniqueStudents(sessions);
  document.getElementById('bannerFlag').textContent = flaggedCount;
  document.getElementById('bannerIncidents').textContent = incidentCount;

  const searchInput = document.getElementById('studentSearchInput');
  searchInput.value = '';
  document.getElementById('studentSearchBox').classList.remove('has-value');
  renderStudentTable('');

  document.getElementById('topTitle').textContent = ex.title;
  document.getElementById('topCrumb').innerHTML = `<span class="crumb-link" onclick="backToExams()">Monitoring Logs</span> / ${escapeHtml(ex.title)}`;

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

  // The table only needs capture COUNTS, not the media itself. Downloading the
  // blobs here and again in openStudent() produced two sets of object URLs, and
  // revoking the first set broke the images the detail view was still loading.
  // Counts come from the lightweight list endpoints; the media is fetched once,
  // when a student is opened.
  const [screenRows, audioRows] = await Promise.all([
    fetchCaptureList(ex.id, 'screen-captures'),
    fetchCaptureList(ex.id, 'audio-captures')
  ]);
  const screens = screenRows.map(row => ({ session_id: row.session_id, time: row.captured_at, capture_id: row.capture_id }));
  const audios = audioRows.map(row => ({
    session_id: row.session_id,
    time: row.captured_at,
    flagged: Boolean(row.flagged),
    levelDbfs: parseAudioLevel(row.metadata_json)
  }));

  // Get actual exam sessions (students who took this exam)
  const sessions = await getExamSessions(ex.id);
  const uniqueStudentCount = countUniqueStudents(sessions);
  document.getElementById('bannerTotal').textContent = uniqueStudentCount;

  // Determine the actual number of questions for this exam (reuse the same
  // response for grading below instead of fetching the exam twice).
  let examQuestions = [];
  currentExamQuestionCount = 0;
  try {
    const token = getProfessorAuthToken();
    if (token) {
      const examRes = await fetch('/api/exams/' + ex.id, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (examRes.ok) {
        const examDetail = await examRes.json();
        let qs = examDetail.questions;
        if (typeof qs === 'string') { try { qs = JSON.parse(qs); } catch { qs = []; } }
        if (Array.isArray(qs)) {
          examQuestions = qs;
          currentExamQuestionCount = qs.length;
        }
      }
    }
  } catch {}
  if (currentExamQuestionCount === 0) currentExamQuestionCount = 1;

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
      sessionId: session.id,
      startedAt: session.started_at || null,
      submittedAt: session.submitted_at || null,
      timeUsed: session.time_used != null ? Number(session.time_used) : null,
      answers: answers
    };
  });

  const rows = currentStudentEntries
    .map((s, idx) => ({ s, idx }))
    .filter(({s}) => !filterText || s.name.toLowerCase().includes(filterText));

  if(rows.length === 0){
    tbody.innerHTML = '';
    noResults.style.display = 'block';
    noResults.innerHTML = filterText ? `No results for "${escapeHtml(filterText)}".` : 'No sessions recorded yet.';
  } else {
    noResults.style.display = 'none';
    tbody.innerHTML = rows.map(({s, idx}) => `
      <tr onclick="openStudent(${idx})">
        <td><div class="uc"><div class="uav" style="background:${escapeHtml(s.color)}">${escapeHtml(s.init)}</div>${escapeHtml(s.name)}</div></td>
        <td><div class="type-tags">${s.types.map(typeTag).join('')}</div></td>
        <td><span class="flag-pill"><svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>${s.totalIncidents}</span></td>
        <td style="text-align:right"><svg class="chev" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></td>
      </tr>
    `).join('');
  }

  countLabel.textContent = filterText
    ? `${rows.length} of ${currentStudentEntries.length} sessions`
    : `${uniqueStudentCount} student${uniqueStudentCount === 1 ? '' : 's'}`;
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

let refreshingLogStudents = false;
setInterval(async () => {
  if(refreshingLogStudents || !document.getElementById('view2')?.classList.contains('show')) return;
  refreshingLogStudents = true;
  try {
    const input = document.getElementById('studentSearchInput');
    await renderStudentTable(input?.value || '');
  } catch(error) {
    console.error('Failed to refresh Monitoring Logs student counts:', error);
  } finally {
    refreshingLogStudents = false;
  }
}, 15000);

async function openStudent(idx){
  currentStudentIdx = idx;
  const exams = await loadExams();
  const ex = exams.find(e => String(e.id) === String(currentExamKey));
  if(!ex) return;

  const ts = await getTabSwitchData(ex.id);
  const log = ts ? ts.log : [];

  // This is the only place the capture media is downloaded. The student table
  // works from metadata-only counts, so there is exactly one set of blob URLs
  // and nothing revokes them while the images are still decoding.
  const entry = currentStudentEntries[idx];
  const [screens, audios] = await Promise.all([
    fetchScreenCapturesFromServer(ex.id),
    fetchAudioCapturesFromServer(ex.id)
  ]);

  const chipMap = {
    tab:{label:'Tab Switching', bg:'var(--blue-bg)', color:'var(--blue)', svg:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'},
    face:{label:'Camera', bg:'var(--red-bg)', color:'var(--red)', svg:'<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'},
    audio:{label:'Audio', bg:'var(--amber-bg)', color:'var(--amber)', svg:'<svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>'},
    screen:{label:'Screen', bg:'var(--purple-bg)', color:'var(--purple)', svg:'<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'},
  };

  // Get the specific student entry
  const s = entry || {
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
    sessionId: null,
    startedAt: null,
    submittedAt: null,
    timeUsed: null
  };
  await window.renderMediaUploadFailures({
    panel: document.getElementById('mediaUploadFailures'),
    examId: ex.id,
    sessionId: s.sessionId,
    token: getProfessorAuthToken()
  });
  document.getElementById('incidentChipRow').innerHTML = s.types.map(t => {
    const c = chipMap[t];
    return `<div class="incident-chip"><span class="incident-chip-ic" style="background:${c.bg};color:${c.color}">${c.svg}</span> <b>${c.label}</b> flagged this session</div>`;
  }).join('');

  // Student banner: name, section, total incidents and exam duration
  const avatarEl = document.getElementById('studentAvatar');
  if(avatarEl){
    avatarEl.textContent = s.init || 'S1';
    avatarEl.style.background = s.color || '#2563EB';
  }
  document.getElementById('studentName').textContent = s.name || 'Student Session';
  document.getElementById('studentSection').textContent = [ex.section, ex.title].filter(Boolean).join(' · ') || 'Exam session';
  document.getElementById('studentTotalIncidents').textContent = s.totalIncidents || 0;
  document.getElementById('studentExamDuration').textContent = formatExamDuration(s);

  // Camera shots - fetch from server for this session
  let camCaptures = [];
  try {
    const token = getProfessorAuthToken();
    const sessionId = s.sessionId;
    if (sessionId && token) {
      const capturesRes = await fetch(`/api/sessions/${sessionId}/captures`, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const captures = capturesRes.ok ? await capturesRes.json() : [];
      camCaptures = captures || [];
      camCaptures = await Promise.all(camCaptures.map(async capture => ({
        ...capture,
        media_src: await loadLogCaptureMedia(capture, token) ||
          (typeof capture.image_data === 'string' && capture.image_data.startsWith('data:')
            ? capture.image_data
            : null)
      })));
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
    document.getElementById('cameraShots').innerHTML = camCaptures.filter(c => c.media_src).map(c => {
      const src = c.media_src;
      const timeStr = formatLocalTime(c.captured_at || c.time);
      const flagged = Boolean(c.flagged);
      const detectionLabels = getCameraDetectionLabels(c);
      return `
      <div class="shot ${flagged ? 'flagged' : ''}" onclick="viewImagePreview('${src}', 'Camera Capture', ${flagged}, '${timeStr}')" title="Click to view full image">
        <img src="${src}" alt="Capture">
        ${flagged ? `<span class="shot-flag-tag">Flagged</span>` : ''}
        ${detectionLabels.length ? `<span class="shot-detection-tag">${detectionLabels.join(' · ')}</span>` : ''}
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
    image_data: c.media_src || c.image_data,
    tag: c.capture_type || 'camera',
    detection_data: c.detection_data || null
  }));
  currentStudentData = s;

  // Screen shots - display actual captured images. `screens` holds the media
  // fetched above; s.screen only carries the table's metadata (no image), so
  // rendering from it produced an empty grid.
  const sessionScreens = (screens || []).filter(sc => String(sc.session_id) === String(s.sessionId));
  const screenShots = sessionScreens.length ? sessionScreens : (screens || []);
  document.getElementById('screenShots').innerHTML = screenShots.length ? screenShots.map(sc => {
    const src = sc.image;
    if(!src) return '';
    const timeStr = formatLocalTime(sc.time);
    return `
      <div class="screenshot" onclick="viewImagePreview('${src}', 'Screen Capture', false, '${timeStr}')" title="Click to view full screenshot">
        <img src="${src}" alt="Screen Capture">
        <span class="shot-time">${timeStr}</span>
      </div>`;
  }).join('') : '<div style="font-size:12px;color:var(--tx3);padding:10px 0;">No screen captures recorded.</div>';

  // Keep the entry in sync so the PDF report lists the same snapshots.
  s.screen = screenShots.map(sc => ({ time: sc.time, image: sc.image, capture_id: sc.capture_id }));

  // Tab switch log
  const tabHtml = s.tabSwitches.map(t => `
    <li class="tslog-item">
      <div class="tslog-ic"><svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
      <div><div class="tslog-txt">${(t.switch_source === 'alt-tab' || t.type === 'alt-tab') ? 'Alt+Tab — switched to another window' : 'Switched away from exam tab'}</div><div class="tslog-time">${formatEventTimestamp(t.switched_at || t.time)}</div></div>
    </li>`).join('');
  document.getElementById('tabSwitchLog').innerHTML = tabHtml || '<div style="font-size:12px;color:var(--tx3);padding:6px 0;">No tab switching detected.</div>';
  document.getElementById('tabFlagCount').textContent = `${s.tabSwitches.length} events`;
  document.getElementById('tabFlagCount').style.display = s.tabSwitches.length === 0 ? 'none' : 'inline-flex';

  // Audio list - display actual audio capture data. `audios` holds the clips
  // fetched above; s.audio only carries the table's metadata (no audio_clip),
  // so rendering from it left every play button disabled.
  const sessionAudios = (audios || []).filter(a => String(a.session_id) === String(s.sessionId));
  const audioItems = sessionAudios.length ? sessionAudios : (audios || []);
  s.audio = audioItems;
  document.getElementById('audioList').innerHTML = audioItems.length ? audioItems.map((a,i) => {
    const isFlagged = Boolean(a.flagged);
    const timeStr = formatEventTimestamp(a.time);
    const activityText = Number.isFinite(a.levelDbfs)
      ? `Possible audio activity · ${a.levelDbfs.toFixed(1)} dBFS`
      : 'Possible audio activity · level unavailable';
    return `
      <li class="audio-item ${isFlagged ? 'flagged' : ''}">
        <button class="play-btn" data-audio-index="${i}" ${a.audio_clip ? '' : 'disabled'} title="${a.audio_clip ? 'Play recorded audio clip' : 'No audio recording was stored'}" aria-label="${a.audio_clip ? 'Play recorded audio clip' : 'No audio recording stored'}">
          <svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>
        </button>
        <div class="audio-wave" id="wave-${i}"></div>
        <div class="audio-meta"><div class="t">${timeStr}</div><div class="s">${activityText}</div></div>
      </li>`;
  }).join('') : '<div style="font-size:12px;color:var(--tx3);padding:6px 0;">No audio captures recorded.</div>';
  document.querySelectorAll('#audioList .play-btn:not(:disabled)').forEach(btn => {
    const index = Number(btn.dataset.audioIndex);
    btn.addEventListener('click', () => playAudioItem(btn, index, audioItems[index].audio_clip));
  });
  setTimeout(buildWaves, 10);
  const audioFlagged = audioItems.filter(a=>a.flagged).length;
  document.getElementById('audioFlagCount').textContent = `${audioFlagged} flagged`;
  document.getElementById('audioFlagCount').style.display = audioFlagged === 0 ? 'none' : 'inline-flex';

  // Review answers (new feature)
  currentExamData = ex;
  currentStudentData = s;
  renderReviewAnswers(ex, s);

  document.getElementById('topTitle').textContent = s.name;
  document.getElementById('topCrumb').innerHTML = `<span class="crumb-link" onclick="backToExams()">Monitoring Logs</span> / <span class="crumb-link" onclick="backToStudents()">${escapeHtml(ex.title)}</span> / ${escapeHtml(s.name)}`;

  switchView('view3');
  setTimeout(buildWaves, 10);
}



/* ───── Review Answers (new feature) ───── */
function safeParseJSON(value, fallback){
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function loadExamQuestionsSync(examId){
  try {
    const token = getProfessorAuthToken();
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
      const optHtml = escapeHtml(opt);
      let cls = 'answer-option';
      let icon = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg>';
      if(isSelected) cls += ' selected';
      if(isCorrectOpt){ cls += ' correct-opt'; icon = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>'; }
      else if(isSelected){ cls += ' wrong-opt'; icon = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'; }
      return `<div class="${cls}">${icon}<span>${optHtml}</span></div>`;
    }).join('')}</div>`;
  } else if(a.type === 'checkbox'){
    bodyHtml = `<div class="answer-options">${a.options.map(opt => {
      const isSelected = a.studentAnswer.includes(opt);
      const isCorrectOpt = a.correctAnswer.includes(opt);
      const optHtml = escapeHtml(opt);
      let cls = 'answer-option';
      let icon = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>';
      let note = '';
      if(isSelected && isCorrectOpt){ cls += ' selected correct-opt'; icon = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>'; }
      else if(isSelected && !isCorrectOpt){ cls += ' selected wrong-opt'; icon = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'; }
      else if(!isSelected && isCorrectOpt){ cls += ' missed-correct'; note = ' <em>(should have been selected)</em>'; }
      return `<div class="${cls}">${icon}<span>${optHtml}${note}</span></div>`;
    }).join('')}</div>`;
  } else if(a.type === 'short'){
    bodyHtml = `
      <div class="answer-item-row ${a.correct ? 'correct' : 'wrong'}">
        <svg viewBox="0 0 24 24">${a.correct ? '<polyline points="20 6 9 17 4 12"/>' : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'}</svg>
        <span><span class="lbl">Student's answer:</span> ${escapeHtml(a.studentAnswer)}</span>
      </div>
      ${a.correct ? '' : `
      <div class="answer-item-row">
        <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
        <span><span class="lbl">Correct answer:</span> ${escapeHtml(a.correctAnswer)}</span>
      </div>`}
    `;
  } else if(a.type === 'paragraph'){
    bodyHtml = `<div class="answer-paragraph-box">${escapeHtml(a.studentAnswer)}</div>`;
  }

  const tags = a.type === 'paragraph'
    ? `<span class="answer-type-tag">${answerTypeLabel(a.type)}</span><span class="answer-badge-review">Needs review</span>`
    : `<span class="answer-type-tag">${answerTypeLabel(a.type)}</span>`;

  return `
    <div class="answer-item ${isWrong ? 'wrong' : ''}">
      <div class="answer-item-q-row">
        <div class="answer-item-q">${escapeHtml(a.q)}</div>
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



function backToExams(){
  document.getElementById('topTitle').textContent = 'Monitoring Logs';
  document.getElementById('topCrumb').textContent = '';
  switchView('view1');
}
async function backToStudents(){
  const exams = await loadExams();
  const ex = exams.find(e => String(e.id) === String(currentExamKey));
  document.getElementById('topTitle').textContent = ex ? ex.title : 'Monitoring Logs';
  document.getElementById('topCrumb').innerHTML = `<span class="crumb-link" onclick="backToExams()">Monitoring Logs</span> / ${escapeHtml(ex ? ex.title : '')}`;
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

/* ═══════════════ PDF REPORT ═══════════════
   A clean, self-contained incident report: a branded cover block with the
   student's key figures, then one section per monitoring channel. Every
   section is drawn with the same primitives so the pages stay aligned. */
function exportPDF(){
  if(!currentExamData || !currentStudentData){
    showToast('No student selected for export.');
    return;
  }
  const ex = currentExamData;
  const s = currentStudentData;
  const btn = document.querySelector('.btn-export');
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
    const marginX = 16;
    const contentW = pageW - marginX * 2;

    const navy   = [13, 27, 62];
    const gold   = [201, 168, 76];
    const red    = [220, 38, 38];
    const amber  = [217, 119, 6];
    const green  = [22, 163, 74];
    const blue   = [37, 99, 235];
    const gray   = [139, 147, 176];
    const ink    = [30, 41, 59];
    const line   = [226, 232, 240];
    const wash   = [248, 250, 252];

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });
    const timeStr = now.toLocaleTimeString('en-PH', { hour:'2-digit', minute:'2-digit' });
    const generatedBy = localStorage.getItem('wamsProfessorName') || 'Professor';

    let y = 0;
    let pageNum = 1;

    function drawHeader(){
      doc.setFillColor(...navy);
      doc.rect(0, 0, pageW, 26, 'F');
      doc.setFillColor(...gold);
      doc.roundedRect(marginX, 7, 12, 12, 2.5, 2.5, 'F');
      doc.setDrawColor(...navy);
      doc.setLineWidth(0.8);
      doc.line(marginX + 3.2, 13, marginX + 5.3, 15.3);
      doc.line(marginX + 5.3, 15.3, marginX + 8.8, 10.3);

      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.text('WAMS', marginX + 16, 12.5);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(190, 200, 225);
      doc.text('Student Monitoring Report', marginX + 16, 17.5);

      doc.setFontSize(8);
      doc.setTextColor(215, 222, 240);
      doc.text(`Generated by: ${generatedBy}`, pageW - marginX, 11, { align:'right' });
      doc.text(`${dateStr} · ${timeStr}`, pageW - marginX, 16.5, { align:'right' });
      y = 34;
    }

    function drawFooter(){
      doc.setDrawColor(...line);
      doc.setLineWidth(0.2);
      doc.line(marginX, pageH - 13, pageW - marginX, pageH - 13);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...gray);
      doc.text(`WAMS · ${s.name || 'Student'} · ${ex.title || 'Exam'}`, marginX, pageH - 8);
      doc.text(`Page ${pageNum}`, pageW - marginX, pageH - 8, { align:'right' });
    }

    // Bottom limit for body content: the footer rule sits at pageH - 13, so
    // nothing may be drawn below pageH - 18.
    const bodyBottom = pageH - 18;

    function newPage(){
      drawFooter();
      doc.addPage();
      pageNum++;
      drawHeader();
    }

    function ensureSpace(h){
      if(y + h > bodyBottom) newPage();
    }

    function sectionTitle(title, badge, badgeColor){
      ensureSpace(14);
      doc.setFillColor(...wash);
      doc.roundedRect(marginX, y, contentW, 9, 1.5, 1.5, 'F');
      doc.setFillColor(...navy);
      doc.rect(marginX, y, 1.6, 9, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...navy);
      doc.text(title, marginX + 5, y + 6);
      if(badge){
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(...(badgeColor || gray));
        doc.text(badge, marginX + contentW - 4, y + 6, { align:'right' });
      }
      y += 13;
    }

    function emptyLine(text){
      ensureSpace(8);
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor(...gray);
      doc.text(text, marginX + 2, y + 3);
      y += 8;
    }

    function logLine(text, time, flagged, detail){
      // Measure first, then reserve the whole row, so a wrapped line or a
      // detail line can never be drawn past the bottom of the page.
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      const lines = doc.splitTextToSize(text, contentW - 48);
      const rowH = Math.max(7, lines.length * 4.4 + (detail ? 4 : 0));
      ensureSpace(rowH);

      doc.setFillColor(...(flagged ? red : gray));
      doc.circle(marginX + 1.6, y + 1.8, 1, 'F');
      doc.setTextColor(...ink);
      doc.text(lines, marginX + 6, y + 2.4);
      if(detail){
        doc.setFontSize(7.5);
        doc.setTextColor(...gray);
        doc.text(detail, marginX + 6, y + 2.4 + lines.length * 4.2);
      }
      doc.setFontSize(8);
      doc.setTextColor(...gray);
      doc.text(time || '', marginX + contentW, y + 2.4, { align:'right' });
      y += rowH;
    }

    drawHeader();

    /* ── Cover block: student identity + key figures ── */
    const coverH = 34;
    doc.setFillColor(...wash);
    doc.roundedRect(marginX, y, contentW, coverH, 2.5, 2.5, 'F');
    doc.setDrawColor(...line);
    doc.setLineWidth(0.3);
    doc.roundedRect(marginX, y, contentW, coverH, 2.5, 2.5);

    const avatarColor = (s.color || '#2563EB').replace('#', '');
    const rgb = avatarColor.length === 6
      ? [parseInt(avatarColor.slice(0,2),16), parseInt(avatarColor.slice(2,4),16), parseInt(avatarColor.slice(4,6),16)]
      : blue;
    doc.setFillColor(...rgb);
    doc.circle(marginX + 15, y + 17, 8, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(s.init || 'S1', marginX + 15, y + 19, { align:'center' });

    doc.setTextColor(...navy);
    doc.setFontSize(14);
    doc.text(s.name || 'Student Session', marginX + 29, y + 13);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...gray);
    doc.text([ex.section, ex.title].filter(Boolean).join('  ·  ') || 'Exam session', marginX + 29, y + 19);

    // Three key figures across the bottom of the cover block. They start to the
    // right of the avatar so the first label never runs under the circle.
    const figures = [
      ['Total Incidents', String(s.totalIncidents || 0)],
      ['Exam Duration', formatExamDuration(s)],
      ['Flagged Channels', String((s.types || []).length)]
    ];
    const figLeft = marginX + 29;
    const figW = (contentW - 29) / 3;
    figures.forEach(([label, value], i) => {
      const fx = figLeft + figW * i;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...gray);
      doc.text(label.toUpperCase(), fx, y + 26);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...navy);
      doc.text(value, fx, y + 31.5);
    });
    y += coverH + 10;

    /* ── Incident summary chips ── */
    const channelLabels = { tab:'Tab Switching', face:'Camera', audio:'Audio', screen:'Screen' };
    if((s.types || []).length){
      ensureSpace(12);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(...gray);
      doc.text('FLAGGED THIS SESSION', marginX, y);
      y += 5;
      let chipX = marginX;
      (s.types || []).forEach(type => {
        const label = channelLabels[type] || type;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        const w = doc.getTextWidth(label) + 8;
        if(chipX + w > marginX + contentW){ chipX = marginX; y += 8; ensureSpace(8); }
        doc.setFillColor(...(type === 'audio' ? amber : type === 'screen' ? blue : red));
        doc.roundedRect(chipX, y - 3.6, w, 6.4, 3.2, 3.2, 'F');
        doc.setTextColor(255, 255, 255);
        doc.text(label, chipX + 4, y + 0.9);
        chipX += w + 4;
      });
      y += 10;
    }

    /* ── Camera ── */
    const camFlagged = (s.cam || []).filter(c => c.flagged).length;
    sectionTitle('Camera Capture', (s.cam || []).length ? `${(s.cam || []).length} captures · ${camFlagged} flagged` : null, camFlagged ? red : gray);
    if(!(s.cam || []).length) emptyLine('No camera captures were recorded for this session.');
    else (s.cam || []).forEach(c => {
      const labels = getCameraDetectionLabels(c);
      logLine(c.flagged ? 'Camera snapshot — flagged' : 'Camera snapshot — normal',
        formatEventTimestamp(c.time), c.flagged, labels.length ? labels.join(' · ') : null);
    });
    y += 4;

    /* ── Screen ── */
    sectionTitle('Screen Capture', (s.screen || []).length ? `${(s.screen || []).length} snapshots` : null, gray);
    if(!(s.screen || []).length) emptyLine('No screen captures were recorded for this session.');
    else (s.screen || []).forEach(sc => logLine('Screen snapshot taken on a tab switch', formatEventTimestamp(sc.time), false, null));
    y += 4;

    /* ── Tab switches ── */
    sectionTitle('Tab Switch Detection', (s.tabSwitches || []).length ? `${(s.tabSwitches || []).length} events` : null, (s.tabSwitches || []).length ? red : gray);
    if(!(s.tabSwitches || []).length) emptyLine('No tab switching was detected.');
    else (s.tabSwitches || []).forEach(t => logLine(
      (t.switch_source === 'alt-tab' || t.type === 'alt-tab') ? 'Alt+Tab — switched to another window' : 'Switched away from the exam tab',
      formatEventTimestamp(t.switched_at || t.time), true, null));
    y += 4;

    /* ── Audio ── */
    const audioFlagged = (s.audio || []).filter(a => a.flagged).length;
    sectionTitle('Audio Capture', (s.audio || []).length ? `${(s.audio || []).length} clips · ${audioFlagged} flagged` : null, audioFlagged ? amber : gray);
    if(!(s.audio || []).length) emptyLine('No audio captures were recorded for this session.');
    else (s.audio || []).forEach(a => logLine(
      a.flagged ? 'Possible audio activity — flagged' : 'Audio activity',
      formatEventTimestamp(a.time), a.flagged,
      Number.isFinite(a.levelDbfs) ? `${a.levelDbfs.toFixed(1)} dBFS` : null));
    y += 4;

    /* ── Review answers (WAMS exams only) ── */
    const platform = ex.platform || (ex.type === 'gforms' ? 'gform' : 'wams');
    if(platform !== 'gform'){
      const answers = s.answers || [];
      const gradable = answers.filter(a => a.type !== 'paragraph');
      const correctCount = gradable.filter(a => a.correct).length;
      const reviewCount = answers.length - gradable.length;
      let badgeText = null, badgeColor = gray;
      if(answers.length){
        if(gradable.length === 0){
          badgeText = `${reviewCount} to review`;
          badgeColor = amber;
        } else {
          badgeText = `${correctCount}/${gradable.length} correct` + (reviewCount ? ` · ${reviewCount} to review` : '');
          badgeColor = correctCount === gradable.length ? green : (correctCount === 0 ? red : amber);
        }
      }
      sectionTitle('Review Answers', badgeText, badgeColor);

      if(answers.length === 0){
        emptyLine('No answer data was recorded for this student.');
      } else {
        answers.forEach((a, i) => {
          const typeLabel = { mcq:'Multiple Choice', checkbox:'Checkboxes', short:'Short Answer', paragraph:'Paragraph' }[a.type] || 'Question';
          const qLines = doc.splitTextToSize(`${i + 1}. ${a.q}`, contentW - 4);
          // Keep the question, its type label and the first answer line together.
          ensureSpace(qLines.length * 4.4 + 22);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9);
          doc.setTextColor(...ink);
          doc.text(qLines, marginX, y + 3);
          y += qLines.length * 4.4 + 1;

          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7);
          doc.setTextColor(...gray);
          doc.text(typeLabel.toUpperCase(), marginX, y + 3);
          y += 4.5;

          doc.setFontSize(8.5);
          if(a.type === 'mcq' || a.type === 'short'){
            const ansLines = doc.splitTextToSize(`${a.correct ? 'Correct' : 'Incorrect'} — Student's answer: ${a.studentAnswer}`, contentW - 6);
            const correctLines = a.correct ? [] : doc.splitTextToSize(`Correct answer: ${a.correctAnswer}`, contentW - 6);
            ensureSpace(ansLines.length * 4.2 + correctLines.length * 4.2 + 6);
            doc.setTextColor(...(a.correct ? green : red));
            doc.text(ansLines, marginX + 2, y + 3);
            y += ansLines.length * 4.2;
            if(correctLines.length){
              doc.setTextColor(...gray);
              doc.text(correctLines, marginX + 2, y + 3);
              y += correctLines.length * 4.2;
            }
          } else if(a.type === 'checkbox'){
            const selLines = doc.splitTextToSize(`${a.correct ? 'Correct' : 'Incorrect'} — Selected: ${a.studentAnswer.join(', ') || 'None'}`, contentW - 6);
            const correctLines = a.correct ? [] : doc.splitTextToSize(`Correct selection: ${a.correctAnswer.join(', ')}`, contentW - 6);
            ensureSpace(selLines.length * 4.2 + correctLines.length * 4.2 + 6);
            doc.setTextColor(...(a.correct ? green : red));
            doc.text(selLines, marginX + 2, y + 3);
            y += selLines.length * 4.2;
            if(correctLines.length){
              doc.setTextColor(...gray);
              doc.text(correctLines, marginX + 2, y + 3);
              y += correctLines.length * 4.2;
            }
          } else if(a.type === 'paragraph'){
            const paraLines = doc.splitTextToSize(a.studentAnswer || '(no answer)', contentW - 10);
            const boxH = paraLines.length * 4.2 + 6;
            ensureSpace(boxH + 6);
            doc.setTextColor(...amber);
            doc.setFont('helvetica', 'italic');
            doc.text('Needs manual review', marginX + 2, y + 3);
            y += 5;
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(...ink);
            doc.setDrawColor(...line);
            doc.setFillColor(...wash);
            doc.roundedRect(marginX + 2, y - 2, contentW - 4, boxH, 1.5, 1.5, 'FD');
            doc.text(paraLines, marginX + 5, y + 3);
            y += boxH;
          }
          y += 6;
        });
      }
    }

    drawFooter();

    const filename = `${(s.name || 'Student').replace(/\s+/g, '_')}_${(ex.title || 'Exam').replace(/\s+/g, '_')}_Monitoring_Report.pdf`;
    doc.save(filename);

    if(btn){
      btn.innerHTML = originalBtnHtml;
      btn.disabled = false;
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    }
    showToast(`Report downloaded for ${s.name || 'student'}.`);
  }catch(err){
    console.error(err);
    if(btn){
      btn.innerHTML = originalBtnHtml;
      btn.disabled = false;
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    }
    showToast('Could not generate the report. Please try again.');
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
    clearProfessorAuthToken();
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
function playAudioItem(btn, index, audioClip) {
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

  if (audioClip && typeof audioClip === 'string' &&
      (audioClip.startsWith('data:audio') || audioClip.startsWith('blob:'))) {
    try {
      const audio = new Audio(audioClip);
      currentPlayingAudio = audio;
      audio.onended = () => stopCurrentAudio();
      audio.onerror = () => {
        stopCurrentAudio();
        showToast('This audio clip could not be played.');
      };
      const played = audio.play();
      if (played && typeof played.catch === 'function') {
        played.catch(() => {
          stopCurrentAudio();
          showToast('This audio clip could not be played.');
        });
      }
      return;
    } catch(e) {
      stopCurrentAudio();
    }
  }
  stopCurrentAudio();
  showToast('No audio recording was stored for this event.');
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

renderExamGrid();
