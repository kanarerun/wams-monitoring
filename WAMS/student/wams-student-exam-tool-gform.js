/* ─── Student Session Guard ─── */
(function checkStudentSession(){
  const hasStudentSession = localStorage.getItem('wamsStudentId') || localStorage.getItem('wamsStudentName');
  const hasToken = localStorage.getItem('token') || localStorage.getItem('wamsToken');
  if(!hasStudentSession && !hasToken){
    window.location.href = 'wams-student-log-in.html';
  }
})();

let currentQ = 0;
let gformLoaded = false;

/* ─── Configurable Constants ─── */
const DEFAULT_EXAM_SECONDS = 3600;

/* ─── Load exam from server (primary) or localStorage (fallback) ─── */
async function loadExamFromId() {

    const params = new URLSearchParams(window.location.search);
    const examId = params.get("examId");

    // Primary: fetch the latest exam data from the server so professor edits
    // (link, time limit, monitoring toggles) are reflected on student refresh.
    const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
    if (token && examId) {
      try {
        const res = await fetch('/api/exams/' + examId, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (res.ok) {
          const serverExam = await res.json();
          console.log("Loaded exam from server:", serverExam);
          // Cache the latest server data for offline/fallback use
          try {
            localStorage.setItem('wamsExamData', JSON.stringify(serverExam));
          } catch(e) {}
          return serverExam;
        }
      } catch(e) {
        console.warn("Failed to load exam from server, falling back to local:", e);
      }
    }

    // Fallback: try to load from wamsExamData (set during student login via server)
    try {
      const examIdParam = examId;
      if(!examIdParam) return null;

      const sessionExamStr = localStorage.getItem('wamsExamData');
      if(sessionExamStr){
        const sessionExam = JSON.parse(sessionExamStr);
        if(String(sessionExam.id) === String(examIdParam)){
          return sessionExam;
        }
      }

      const exams = JSON.parse(localStorage.getItem('wamsProfessorExams') || '[]');
      return exams.find(item => String(item.id) === String(examIdParam)) || null;
    } catch {
      return null;
    }
}

let examData = null;

/* ─── Timer state (initialized once exam data loads) ─── */
let TOTAL_EXAM_SECONDS = DEFAULT_EXAM_SECONDS;
let secondsLeft = DEFAULT_EXAM_SECONDS;
let examTimerInterval = null;
let examSubmitted = false;

function restoreTimerState(){
  try {
    const saved = JSON.parse(localStorage.getItem(getTimerStorageKey()));
    if(!saved || !saved.startTime) return;
    const elapsed = Math.floor((Date.now() - saved.startTime) / 1000);
    secondsLeft = Math.max(0, saved.totalSeconds - elapsed);
  } catch {}
}

function saveTimerState(){
  try {
    const data = { totalSeconds: TOTAL_EXAM_SECONDS, startTime: Date.now() - (TOTAL_EXAM_SECONDS - secondsLeft) * 1000 };
    localStorage.setItem(getTimerStorageKey(), JSON.stringify(data));
  } catch {}
}

function clearTimerState(){
  try { localStorage.removeItem(getTimerStorageKey()); } catch {}
}

function getTimerStorageKey(){
  const examId = examData ? examData.id : new URLSearchParams(window.location.search).get('examId') || 'unknown';
  return `wamsGformTimerState_${examId}`;
}

function readGformUrlFromQuery(){
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('gform');
  if(fromQuery) return fromQuery.trim();

  const examId = params.get('examId');
  if(examId){
    try {
      const exam = examData && String(examData.id) === String(examId)
        ? examData
        : JSON.parse(localStorage.getItem('wamsProfessorExams') || '[]').find(item => String(item.id) === String(examId));
      if(exam?.link) return exam.link.trim();
    } catch {}
  }

  return '';
}

function autoLoadExamForm(){
  const gformUrl = readGformUrlFromQuery();
  if(!gformUrl) return;

  const input = document.getElementById('gformLink');
  if(input) input.value = gformUrl;
  loadForm(gformUrl);
}

function buildQGrid(){
  document.getElementById('qGrid').innerHTML = [0].map((_, i) => `
    <button class="qbtn ${i===currentQ?'current':''} ${gformLoaded?'answered':''}" onclick="jumpTo(${i})">${i+1}</button>
  `).join('');
}

function jumpTo(i){
  currentQ = i;
  updateProgress();
}

function updateProgress(){
  document.getElementById('progressLabel').textContent = gformLoaded ? 'Google Form Loaded' : 'Load your Google Form';
  document.getElementById('progressFill').style.width = gformLoaded ? '100%' : '20%';
  buildQGrid();
}

function loadForm(forceUrl = ''){
  const inputValue = (forceUrl || document.getElementById('gformLink').value.trim() || readGformUrlFromQuery()).trim();
  if(!inputValue.includes('docs.google.com/forms')){
    alert('Please enter a valid Google Form URL.');
    return;
  }

  const input = document.getElementById('gformLink');
  if(input) input.value = inputValue;

  let embed = inputValue;
  if(!embed.includes('embedded=true')){
    embed += embed.includes('?') ? '&embedded=true' : '?embedded=true';
  }

  document.getElementById('examFrame').src = embed;
  document.getElementById('gformPrompt').style.display = 'none';
  document.getElementById('gformFrameWrap').style.display = 'block';
  document.querySelector('.gform-note').textContent = 'Google Form loaded successfully. Complete the form and then submit your exam when ready.';
  gformLoaded = true;
  updateProgress();
}

function updateTimer(){
  secondsLeft--;
  if(secondsLeft <= 0){
    secondsLeft = 0;
    clearInterval(examTimerInterval);
    clearTimerState();
    document.getElementById('timerText').textContent = '00:00';
    finalSubmit();
    return;
  }
  const m = Math.floor(secondsLeft/60).toString().padStart(2,'0');
  const s = (secondsLeft%60).toString().padStart(2,'0');
  document.getElementById('timerText').textContent = `${m}:${s}`;
  const box = document.getElementById('timerBox');
  if(secondsLeft <= 300) box.classList.add('warn'); else box.classList.remove('warn');
  if(secondsLeft % 5 === 0) saveTimerState();
}

function openSubmitModal(timeUp){
  clearInterval(examTimerInterval);

  // Stop all monitoring streams
  stopCamera();
  stopAudioCapture();
  stopScreenCapture();

  const answered = gformLoaded ? 1 : 0;
  const unanswered = 1 - answered;
  document.getElementById('sumAnswered').textContent = answered;
  document.getElementById('sumUnanswered').textContent = unanswered;

  const used = TOTAL_EXAM_SECONDS - secondsLeft;
  const m = Math.floor(used/60).toString().padStart(2,'0');
  const s = (used%60).toString().padStart(2,'0');
  document.getElementById('sumTime').textContent = `${m}:${s}`;

  const warning = document.getElementById('unansweredWarning');
  warning.style.display = unanswered > 0 ? 'flex' : 'none';

  const modalP = document.querySelector('#overlaySubmit .modal-hd p');
  const goBackBtn = document.querySelector('#overlaySubmit .btn-secondary-block');
  if(timeUp){
    modalP.textContent = "Time's up! Your exam will be submitted automatically with your current answers.";
    goBackBtn.style.display = 'none';
  } else {
    modalP.textContent = "Please review your progress before submitting. You won't be able to make changes after this.";
    goBackBtn.style.display = 'block';
  }

  document.getElementById('overlaySubmit').classList.add('show');
}

function closeSubmitModal(){
  document.getElementById('overlaySubmit').classList.remove('show');
  examTimerInterval = setInterval(updateTimer, 1000);
}

function finalSubmit(){
  if(examSubmitted) return;
  examSubmitted = true;
  clearInterval(examTimerInterval);
  clearTimerState();

  // Stop all monitoring streams
  stopCamera();
  stopAudioCapture();
  stopScreenCapture();

  // Send submission to server
  const sessionId = getSessionId();
  const token = getAuthToken();
  const timeUsed = TOTAL_EXAM_SECONDS - secondsLeft;
  if(sessionId && token){
    fetch('/api/sessions/' + sessionId + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ time_used: timeUsed, answers: { gform_loaded: gformLoaded } })
    }).catch(err => console.warn('Failed to submit exam:', err));
  }

  document.body.innerHTML = `
    <div style="height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#0D1B3E,#0a1530);">
      <div style="text-align:center;color:#fff;max-width:380px;padding:20px;">
        <div style="width:64px;height:64px;border-radius:18px;background:#16A34A;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">
          <svg viewBox="0 0 24 24" width="30" height="30" stroke="#fff" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <h2 style="font-size:21px;font-weight:700;margin-bottom:10px;font-family:'Inter',sans-serif;">Exam Submitted</h2>
        <p style="font-size:13.5px;color:rgba(255,255,255,.65);line-height:1.6;font-family:'Inter',sans-serif;">Your Google Form exam session has been submitted successfully. You may now close this window.</p>
      </div>
    </div>
  `;
}

function toggleWindow(id, btn){
  const win = document.getElementById(id);
  const isShowing = win.classList.contains('show');
  if(isShowing){
    win.classList.remove('show');
    btn.classList.remove('active');
  } else {
    win.classList.add('show');
    btn.classList.add('active');
    bringToFront(win);
    if(id === 'sketchWindow'){
      if(!skCanvas){
        requestAnimationFrame(initSketchCanvas);
      } else {
        requestAnimationFrame(resizeSketchCanvas);
      }
    }
  }
}

function closeWindow(id, btnId){
  document.getElementById(id).classList.remove('show');
  document.getElementById(btnId).classList.remove('active');
}

let topZ = 100;
function bringToFront(win){
  topZ++;
  win.style.zIndex = topZ;
}

function showHint(msg){
  const hint = document.getElementById('toolHint');
  hint.textContent = msg;
  hint.classList.add('show');
  clearTimeout(window._hintTimeout);
  window._hintTimeout = setTimeout(()=> hint.classList.remove('show'), 1400);
}

function updateStudentInfo(){
  const nameEl = document.getElementById('studentName');
  const sectionEl = document.getElementById('studentSection');
  if(nameEl) nameEl.textContent = localStorage.getItem('wamsStudentName') || 'Student';
  if(sectionEl){
    const sectionName = localStorage.getItem('wamsStudentSection') || examData?.section_name || examData?.section || '';
    const courseName = localStorage.getItem('wamsStudentCourse') || '';
    const studentId = localStorage.getItem('wamsStudentId') || '';
    const parts = [];
    if (sectionName) parts.push(sectionName);
    if (courseName) parts.push(courseName);
    if (studentId) parts.push('ID ' + studentId);
    sectionEl.textContent = parts.length > 0 ? parts.join(' · ') : 'Student';
  }
  const titleEl = document.querySelector('.exam-top-title');
  if(titleEl && examData?.title) titleEl.textContent = examData.title;
}

document.querySelectorAll('.float-win').forEach(win => {
  const handle = win.querySelector('[data-drag-handle]');
  let dragging = false, offX = 0, offY = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    win.classList.add('dragging');
    bringToFront(win);
    const rect = win.getBoundingClientRect();
    const bodyRect = document.getElementById('examBody').getBoundingClientRect();
    offX = e.clientX - rect.left;
    offY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if(!dragging) return;
    const bodyRect = document.getElementById('examBody').getBoundingClientRect();
    let newLeft = e.clientX - bodyRect.left - offX;
    let newTop = e.clientY - bodyRect.top - offY;
    newLeft = Math.max(0, Math.min(newLeft, bodyRect.width - win.offsetWidth));
    newTop = Math.max(0, Math.min(newTop, bodyRect.height - win.offsetHeight));
    win.style.left = newLeft + 'px';
    win.style.top = newTop + 'px';
    win.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    dragging = false;
    win.classList.remove('dragging');
  });

  const resizer = win.querySelector('[data-resize-handle]');
  let resizing = false, startW = 0, startH = 0, startX = 0, startY = 0;
  resizer.addEventListener('mousedown', e => {
    resizing = true;
    startW = win.offsetWidth; startH = win.offsetHeight;
    startX = e.clientX; startY = e.clientY;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', e => {
    if(!resizing) return;
    const newW = Math.max(220, startW + (e.clientX - startX));
    const newH = Math.max(180, startH + (e.clientY - startY));
    win.style.width = newW + 'px';
    win.style.height = newH + 'px';
    if(win.id === 'sketchWindow') resizeSketchCanvas();
  });
  document.addEventListener('mouseup', () => { resizing = false; });
});

let calcCurrent = '0';
let calcPrevVal = null;
let calcOperator = null;
let calcResetNext = false;

function calcRender(){
  document.getElementById('calcCurr').textContent = calcCurrent;
  document.getElementById('calcPrev').textContent = calcPrevVal !== null ? `${calcPrevVal} ${calcOperator}` : '\u00A0';
}
function calcNum(n){
  if(calcResetNext){ calcCurrent = '0'; calcResetNext = false; }
  if(n === '.' && calcCurrent.includes('.')) return;
  calcCurrent = calcCurrent === '0' && n !== '.' ? n : calcCurrent + n;
  calcRender();
}
function calcOp(op){
  calcPrevVal = calcCurrent;
  calcOperator = op;
  calcResetNext = true;
  calcRender();
}
function calcEquals(){
  if(calcOperator === null) return;
  const a = parseFloat(calcPrevVal);
  const b = parseFloat(calcCurrent);
  let result;
  switch(calcOperator){
    case '+': result = a + b; break;
    case '−': result = a - b; break;
    case '×': result = a * b; break;
    case '÷': result = b === 0 ? 'Error' : a / b; break;
  }
  calcCurrent = result.toString();
  calcPrevVal = null;
  calcOperator = null;
  calcResetNext = true;
  calcRender();
}
function calcClear(){
  calcCurrent = '0'; calcPrevVal = null; calcOperator = null; calcResetNext = false;
  calcRender();
}
function calcBackspace(){
  if(calcResetNext) return;
  calcCurrent = calcCurrent.length > 1 ? calcCurrent.slice(0,-1) : '0';
  calcRender();
}
function calcPercent(){
  calcCurrent = (parseFloat(calcCurrent) / 100).toString();
  calcRender();
}

let skCtx, skCanvas, skDrawing = false, skTool = 'pen', skColor = '#0D1B3E';
let skActiveTextInput = null;
let skInitialized = false;
let sketchHistory = [];
const MAX_HISTORY = 30;

function initSketchCanvas(){
  skCanvas = document.getElementById('sketchCanvas');
  skCtx = skCanvas.getContext('2d');

  const wrap = document.getElementById('sketchCanvasWrap');
  skCanvas.width = wrap.clientWidth;
  skCanvas.height = wrap.clientHeight;
  skCtx.fillStyle = '#fff';
  skCtx.fillRect(0,0,skCanvas.width, skCanvas.height);
  saveSketchState();
  if(skInitialized) return;
  skInitialized = true;

  skCanvas.addEventListener('mousedown', (e) => {
    if(skActiveTextInput){ commitTextInput(); }
    const rect = skCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if(skTool === 'text'){
      placeTextInput(x, y);
      return;
    }
    skDrawing = true;
    skCtx.beginPath();
    skCtx.moveTo(x, y);
  });

  skCanvas.addEventListener('mousemove', (e) => {
    if(!skDrawing) return;
    const rect = skCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    skCtx.strokeStyle = skTool === 'erase' ? '#FFFFFF' : skColor;
    skCtx.lineWidth = skTool === 'erase' ? 18 : 2.5;
    skCtx.lineCap = 'round';
    skCtx.lineJoin = 'round';
    skCtx.lineTo(x, y);
    skCtx.stroke();
  });

  window.addEventListener('mouseup', () => {
    if(skDrawing){
      skDrawing = false;
      saveSketchState();
    }
  });
}

function resizeSketchCanvas(){
  if(!skCanvas) return;
  const wrap = document.getElementById('sketchCanvasWrap');
  const newW = wrap.clientWidth, newH = wrap.clientHeight;
  if(newW === 0 || newH === 0) return;
  if(newW === skCanvas.width && newH === skCanvas.height) return;

  const imgData = skCanvas.toDataURL();
  skCanvas.width = newW;
  skCanvas.height = newH;
  skCtx.fillStyle = '#fff';
  skCtx.fillRect(0,0,skCanvas.width, skCanvas.height);
  const img = new Image();
  img.onload = () => skCtx.drawImage(img, 0, 0);
  img.src = imgData;
}

function saveSketchState(){
  if(!skCanvas) return;
  if(sketchHistory.length >= MAX_HISTORY){ sketchHistory.shift(); }
  sketchHistory.push(skCanvas.toDataURL());
}

function restoreSketchState(dataURL){
  const img = new Image();
  img.onload = () => {
    skCtx.clearRect(0,0,skCanvas.width, skCanvas.height);
    skCtx.fillStyle = '#fff';
    skCtx.fillRect(0,0,skCanvas.width, skCanvas.height);
    skCtx.drawImage(img,0,0);
  };
  img.src = dataURL;
}

function setSkTool(tool, btn){
  if(skActiveTextInput) commitTextInput();
  skTool = tool;
  document.querySelectorAll('.sketch-toolbar .sk-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  showHint(tool === 'pen' ? 'Pen tool selected' : tool === 'text' ? 'Click canvas to type' : 'Eraser selected');
}

function setSkColor(color, el){
  skColor = color;
  document.querySelectorAll('.sk-color').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
}

function clearSketch(){
  if(!skCtx) return;
  if(skActiveTextInput) commitTextInput();
  skCtx.fillStyle = '#fff';
  skCtx.fillRect(0,0,skCanvas.width, skCanvas.height);
  saveSketchState();
  showHint('Canvas cleared');
}

function undoSketch(){
  if(sketchHistory.length <= 1){ showHint('Nothing to undo'); return; }
  sketchHistory.pop();
  restoreSketchState(sketchHistory[sketchHistory.length-1]);
  showHint('Undo');
}

function placeTextInput(x, y){
  const wrap = document.getElementById('sketchCanvasWrap');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sk-text-input';
  input.style.left = x + 'px';
  input.style.top = (y - 11) + 'px';
  input.style.color = skColor;
  wrap.appendChild(input);
  skActiveTextInput = {el: input, x, y};
  requestAnimationFrame(() => input.focus());
  input.addEventListener('blur', () => commitTextInput());
  input.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); commitTextInput(); }
    if(e.key === 'Escape'){ e.preventDefault(); skActiveTextInput.el.value=''; commitTextInput(); }
  });
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}

function commitTextInput(){
  if(!skActiveTextInput) return;
  const {el, x, y} = skActiveTextInput;
  const val = el.value;
  skActiveTextInput = null;
  if(val && val.trim() !== ''){
    skCtx.fillStyle = skColor;
    skCtx.font = '14px Inter, sans-serif';
    skCtx.textBaseline = 'middle';
    skCtx.fillText(val, x, y);
  }
  if(el.parentNode) el.parentNode.removeChild(el);
  saveSketchState();
}

function saveSketchAsPng(){
  if(!skCanvas){ showHint('Nothing to save yet'); return; }
  if(skActiveTextInput) commitTextInput();
  const link = document.createElement('a');
  const ts = new Date();
  const stamp = ts.getFullYear() + '-' + String(ts.getMonth()+1).padStart(2,'0') + '-' + String(ts.getDate()).padStart(2,'0') + '_' + String(ts.getHours()).padStart(2,'0') + String(ts.getMinutes()).padStart(2,'0');
  link.download = `sketch-googleform-${stamp}.png`;
  link.href = skCanvas.toDataURL('image/png');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showHint('Sketch saved as PNG');
}

/* ─── Initialize Exam (called after async load) ─── */
async function initExam() {
  examData = await loadExamFromId();

  console.log("Loaded Exam:", examData);

  if (!examData) {
    const container = document.getElementById('questionContainer');
    if(container) container.innerHTML = "<div class='q-card'><h3>No exam found.</h3><p>Please log in again from the student portal.</p></div>";
  }

  // Restore any tab-switch count persisted from earlier in this session
  loadTabSwitchData();

  // Redirect wams-quiz type exams to the proper tool page
  const examId = new URLSearchParams(window.location.search).get('examId');
  if(examData && examData.type === 'wams-quiz'){
    const correctUrl = new URL('wams-student-exam-tool.html', window.location.href);
    correctUrl.searchParams.set('examId', examId || examData.id);
    window.location.href = correctUrl.toString();
    return;
  }

  // Determine total seconds from exam data
  TOTAL_EXAM_SECONDS = (examData && examData.timeLimit) ? (parseInt(examData.timeLimit) * 60) : DEFAULT_EXAM_SECONDS;
  secondsLeft = TOTAL_EXAM_SECONDS;

  restoreTimerState();
  saveTimerState();

  autoLoadExamForm();
  buildQGrid();
  updateProgress();
  updateStudentInfo();

  // Initialize monitoring after a short delay
  setTimeout(initCamera, 1000);
  setTimeout(initAudioCapture, 1000);

  // Add screen capture button to tools rail if needed
  addScreenCaptureButton();

  // Delay screen capture initialization to ensure page is fully loaded
  setTimeout(initScreenCapture, 2000);

  // Hide tools if disabled in exam settings
  let tools = (examData && (examData.tools || examData.tools_settings)) || {};
  if (typeof tools === 'string') { try { tools = JSON.parse(tools); } catch(e) { tools = {}; } }
  if (tools.calculator === false) {
    const calcBtn = document.getElementById('calcBtn');
    const calcWin = document.getElementById('calcWindow');
    if(calcBtn) calcBtn.style.display = 'none';
    if(calcWin) calcWin.style.display = 'none';
  }
  if (tools.whiteboard === false) {
    const sketchBtn = document.getElementById('sketchBtn');
    const sketchWin = document.getElementById('sketchWindow');
    if(sketchBtn) sketchBtn.style.display = 'none';
    if(sketchWin) sketchWin.style.display = 'none';
  }
  if (tools.camera === false) {
    const camBtn = document.getElementById('camBtn');
    const camWin = document.getElementById('camWindow');
    if(camBtn) camBtn.style.display = 'none';
    if(camWin) camWin.style.display = 'none';
  }

  examTimerInterval = setInterval(updateTimer, 1000);
}

// Auto-init the exam when page loads
initExam();