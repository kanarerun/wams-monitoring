/* ─── Student Session Guard ─── */
(function checkStudentSession(){
  const hasToken = localStorage.getItem('token') || localStorage.getItem('wamsToken');
  if(!hasToken || !localStorage.getItem('examSessionId')){
    window.location.href = 'wams-student-log-in.html';
  }
})();

/* ─── Load and validate the exam through the server ─── */
let examData = null;

/* ─── Configurable Constants ─── */
const DEFAULT_EXAM_SECONDS = 3600;
const HINT_TIMEOUT = 1400;

async function loadExamFromId() {

    const params = new URLSearchParams(window.location.search);
    const examId = params.get("examId");

    console.log("URL examId:", examId);

    try {
    const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
    if(!token || !examId) return null;
    // The session id is minted with the token at login. If it is missing the
    // request is rejected as unauthorized and the exam page would come up empty.
    if(!localStorage.getItem('examSessionId') && localStorage.getItem('wamsSession_' + examId)){
      localStorage.setItem('examSessionId', localStorage.getItem('wamsSession_' + examId));
    }
    const response = await fetch('/api/exams/' + encodeURIComponent(examId), {
      headers: { 'Authorization': 'Bearer ' + token },
      cache: 'no-store'
    });
    if(!response.ok){
      console.warn(`Failed to load authorized exam (${response.status}).`);
      return null;
    }
    const serverExam = await response.json();
    serverExam.time_remaining_calculated_at = Date.now();
    return serverExam;
  } catch(error) {
    console.warn('Failed to load exam from server:', error);
    return null;
  }
}

// Global variables - initialized when exam loads
let questions = [];
let currentQ = 0;
let answers = {};
let examTimerInterval = null;
let examSubmitted = false;
let examStatusInterval = null;
let checkingExamStatus = false;

// Initialize secondsLeft from TOTAL_EXAM_SECONDS when exam data loads
let secondsLeft = DEFAULT_EXAM_SECONDS;
let TOTAL_EXAM_SECONDS = DEFAULT_EXAM_SECONDS;

function showExamLifecycleScreen(status){
  examSubmitted = true;
  clearInterval(examTimerInterval);
  clearInterval(examStatusInterval);
  clearTimerState();
  stopCamera();
  stopAudioCapture();
  stopScreenCapture();
  const ended = status === 'ended';
  document.body.innerHTML = `
    <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#0D1B3E,#0a1530);font-family:'Inter',sans-serif;padding:24px;">
      <section style="text-align:center;color:#fff;max-width:420px;padding:28px;border:1px solid rgba(255,255,255,.12);border-radius:20px;background:rgba(255,255,255,.04);">
        <div style="width:64px;height:64px;border-radius:18px;background:${ended ? '#B45309' : '#2563EB'};display:flex;align-items:center;justify-content:center;margin:0 auto 20px;color:white;font-size:30px;">${ended ? '!' : '◷'}</div>
        <h1 style="font-size:22px;margin:0 0 10px;">${ended ? 'Exam Ended' : 'Exam Has Not Started'}</h1>
        <p style="font-size:14px;color:rgba(255,255,255,.72);line-height:1.6;margin:0;">${ended ? 'This exam has ended. Answers can no longer be submitted. You may close this window.' : 'This exam is not open yet. Please wait until the scheduled start time before entering.'}</p>
      </section>
    </main>`;
}

async function checkExamLifecycle(){
  if(checkingExamStatus || examSubmitted || !examData?.id) return;
  checkingExamStatus = true;
  try {
    const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
    const response = await fetch('/api/exams/' + examData.id, {
      headers: { 'Authorization': 'Bearer ' + token },
      cache: 'no-store'
    });
    if(!response.ok) throw new Error(`Exam status check failed (${response.status})`);
    const currentExam = await response.json();
    if(currentExam.status === 'ended'){
      finalSubmit(true);
    } else if(currentExam.status !== 'live'){
      showExamLifecycleScreen('scheduled');
    }
  } catch(error) {
    console.warn('Unable to refresh exam status:', error);
  } finally {
    checkingExamStatus = false;
  }
}

/* ─── Persistent Timer ─── */
function updateTimer(){
  secondsLeft--;
  if(secondsLeft <= 0){
    secondsLeft = 0;
    clearInterval(examTimerInterval);
    clearTimerState();
    document.getElementById('timerText').textContent = '00:00';
    finalSubmit(true);
    return;
  }
  const m = Math.floor(secondsLeft/60).toString().padStart(2,'0');
  const s = (secondsLeft%60).toString().padStart(2,'0');
  document.getElementById('timerText').textContent = m + ':' + s;
  if(secondsLeft <= 300) document.getElementById('timerBox').classList.add('warn');
  else document.getElementById('timerBox').classList.remove('warn');
  if(secondsLeft % 5 === 0) saveTimerState();
}

/* ─── Submit Modal Functions ─── */
function openSubmitModal(timeUp){
  clearInterval(examTimerInterval);
  clearTimerState();

  // Stop all monitoring streams
  stopCamera();
  stopAudioCapture();
  stopScreenCapture();

  const answered = Object.keys(answers).length;
  const unanswered = questions.length - answered;
  document.getElementById('sumAnswered').textContent = answered;
  document.getElementById('sumUnanswered').textContent = unanswered;

  const used = TOTAL_EXAM_SECONDS - secondsLeft;
  const m = Math.floor(used/60).toString().padStart(2,'0');
  const s = (used%60).toString().padStart(2,'0');
  document.getElementById('sumTime').textContent = m + ':' + s;

  const warning = document.getElementById('unansweredWarning');
  warning.style.display = unanswered > 0 ? 'flex' : 'none';

  const modalP = document.querySelector('#overlaySubmit .modal-hd p');
  const goBackBtn = document.querySelector('#overlaySubmit .btn-secondary-block');
  if(timeUp){
    modalP.textContent = "Time's up! Your exam will be submitted automatically with your current answers.";
    goBackBtn.style.display = 'none';
  } else {
    modalP.textContent = "Please review your progress before submitting. You won't be able to make changes after this.";
    goBackBtn.style.display = 'flex';
  }

  // The consent <dialog> is a top-layer element: while it is open it paints a
  // backplate over everything, including this modal. Close it when the student
  // asks to submit, otherwise the dialog sits on top of the confirmation.
  const consentDialog = document.getElementById('mediaConsentDialog');
  if(consentDialog && consentDialog.open) consentDialog.close();

  document.getElementById('overlaySubmit').classList.add('show');
}
function closeSubmitModal(){
  document.getElementById('overlaySubmit').classList.remove('show');
  // Dismissing the time-up / submitted modal must not revive the countdown.
  if(examSubmitted || secondsLeft <= 0) return;
  clearInterval(examTimerInterval);
  examTimerInterval = setInterval(updateTimer, 1000);
}
function finalSubmit(examEnded = false){
  if(examSubmitted) return;
  examSubmitted = true;
  window._wamsExamSubmitted = true;
  clearAnswersLocal();
  clearInterval(examTimerInterval);
  clearInterval(examStatusInterval);
  clearTimerState();

  // Stop all monitoring streams (also covers the time-up path,
  // which reaches finalSubmit without going through the submit modal)
  stopCamera();
  stopAudioCapture();
  stopScreenCapture();

  // Send submission to server
  const sessionId = getSessionId();
  const timeUsed = TOTAL_EXAM_SECONDS - secondsLeft;
  const token = localStorage.getItem("token");

  fetch("/api/sessions/" + sessionId + "/submit", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
    },
    body: JSON.stringify({
        time_used: timeUsed,
        answers: answers
    })
  }).then(async response => {
    if(response.status === 409){
      const result = await response.json().catch(() => ({}));
      if(result.status === 'ended'){
        showExamLifecycleScreen('ended');
      }
    } else if(!response.ok){
      console.warn('Failed to submit exam:', response.status);
    }
  }).catch(error => console.warn('Failed to submit exam:', error));

  if(examEnded){
    showExamLifecycleScreen('ended');
    return;
  }
  document.body.innerHTML = '<div style="height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#0D1B3E,#0a1530);font-family:\'Inter\',sans-serif;"><div style="text-align:center;color:#fff;max-width:380px;padding:20px;"><div style="width:64px;height:64px;border-radius:18px;background:#16A34A;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;"><svg viewBox="0 0 24 24" width="30" height="30" stroke="#fff" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><h2 style="font-size:21px;font-weight:700;margin-bottom:10px;">Exam Submitted</h2><p style="font-size:13.5px;color:rgba(255,255,255,.65);line-height:1.6;">Your exam has been submitted successfully. You may now close this window.</p></div></div>';
}

/* ─── Persistent Timer ───
   The server is the only source of the countdown: it measures the student's own
   session (entry time + exam duration). localStorage is just a local copy so a
   reload paints instantly; it is clamped to the server value and thrown away if
   it disagrees by more than the drift tolerance, which is what used to eat
   2-3 minutes on every fresh attempt. */
function getTimerStorageKey(){
  const examId = examData ? examData.id : new URLSearchParams(window.location.search).get('examId') || 'unknown';
  return `wamsToolTimerState_${examId}`;
}

/* Server value minus the seconds that passed since the server answered. */
function secondsLeftFromServer(){
  const serverRemaining = Number(examData?.timeRemainingSeconds ?? examData?.time_remaining_seconds);
  if(!Number.isFinite(serverRemaining)) return null;
  const calculatedAt = Number(examData?.timeRemainingCalculatedAt ?? examData?.time_remaining_calculated_at);
  const drift = Number.isFinite(calculatedAt) ? Math.max(0, Math.floor((Date.now() - calculatedAt) / 1000)) : 0;
  return Math.min(TOTAL_EXAM_SECONDS, Math.max(0, Math.floor(serverRemaining) - drift));
}

function restoreTimerState(){
  try {
    const saved = JSON.parse(localStorage.getItem(getTimerStorageKey()));
    if(!saved || !saved.startTime) return;
    // Discard stale timer states saved under a different total duration
    // (e.g., the old 1-hour default fallback or a changed time limit).
    if(saved.totalSeconds !== TOTAL_EXAM_SECONDS){
      clearTimerState();
      return;
    }

    const elapsed = Math.floor((Date.now() - saved.startTime) / 1000);
    const localLeft = Math.max(0, saved.totalSeconds - elapsed);
    const serverLeft = secondsLeftFromServer();
    if(serverLeft !== null && Math.abs(serverLeft - localLeft) > TIMER_DRIFT_TOLERANCE_S){
      clearTimerState();
      return;
    }
    secondsLeft = serverLeft !== null ? Math.min(localLeft, serverLeft) : localLeft;
  } catch {}
}

function saveTimerState(){
  try {
    const data = {
      totalSeconds: TOTAL_EXAM_SECONDS,
      startTime: Date.now() - (TOTAL_EXAM_SECONDS - secondsLeft) * 1000
    };
    localStorage.setItem(getTimerStorageKey(), JSON.stringify(data));
  } catch {}
}

function clearTimerState(){
  try { localStorage.removeItem(getTimerStorageKey()); } catch {}
}

// Restore timer AFTER exam data loads, in initializeExam

/* ─── Helper to setup floating window drag - used for dynamically created windows ─── */
function setupDrag(win, handle) {
  let dragging = false, offX = 0, offY = 0;

  function bringToFront(w) {
    let topZ = 100;
    document.querySelectorAll('.float-win').forEach(fw => {
      const z = parseInt(fw.style.zIndex) || 100;
      if (z > topZ) topZ = z;
    });
    w.style.zIndex = topZ + 1;
  }

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

  /* resize */
  const resizer = win.querySelector('[data-resize-handle]');
  if (resizer) {
    let resizing = false, startW=0, startH=0, startX=0, startY=0;
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
      if(win.id === 'sketchWindow' && typeof resizeSketchCanvas === 'function') resizeSketchCanvas();
    });
    document.addEventListener('mouseup', () => { resizing = false; });
  }
}

/* ─── Question Activity Tracking ─── */
function reportQuestionActivity(activityType, questionNumber){
  const sessionId = getSessionId();
  const token = getAuthToken();
  if(!sessionId || !token) return;
  fetch('/api/sessions/' + sessionId + '/question-activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ activity_type: activityType, question_number: questionNumber })
  }).catch(err => console.warn('Question activity reporting failed:', err));
}


/* ═══════════════ FLOATING WINDOW DRAG + RESIZE ═══════════════ */
function toggleWindow(id, btn){
  const win = document.getElementById(id);
  const isShowing = win.classList.contains('show');
  if(isShowing){
    win.classList.remove('show');
    btn.classList.remove('active');
  } else {
    win.classList.add('show');
    btn.classList.add('active');
    // bring to front
    let topZ = 100;
    document.querySelectorAll('.float-win').forEach(fw => {
      const z = parseInt(fw.style.zIndex) || 100;
      if (z > topZ) topZ = z;
    });
    win.style.zIndex = topZ + 1;
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

function showHint(msg){
  const hint = document.getElementById('toolHint');
  hint.textContent = msg;
  hint.classList.add('show');
  clearTimeout(window._hintTimeout);
  window._hintTimeout = setTimeout(()=> hint.classList.remove('show'), HINT_TIMEOUT);
}

document.querySelectorAll('.float-win').forEach(win => {
  const handle = win.querySelector('[data-drag-handle]');
  if (!handle) return;
  let dragging = false, offX = 0, offY = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    win.classList.add('dragging');
    let topZ = 100;
    document.querySelectorAll('.float-win').forEach(fw => {
      const z = parseInt(fw.style.zIndex) || 100;
      if (z > topZ) topZ = z;
    });
    win.style.zIndex = topZ + 1;
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

  /* resize */
  const resizer = win.querySelector('[data-resize-handle]');
  let resizing = false, startW=0, startH=0, startX=0, startY=0;
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

/* ═══════════════ CALCULATOR LOGIC ═══════════════ */
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

/* ═══════════════ SKETCHER LOGIC ═══════════════ */
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

  if(sketchHistory.length >= MAX_HISTORY){
    sketchHistory.shift();
  }

  sketchHistory.push(skCanvas.toDataURL());
}

function restoreSketchState(dataURL){
  const img = new Image();

  img.onload = () => {
    skCtx.clearRect(0,0,skCanvas.width,skCanvas.height);

    skCtx.fillStyle = "#fff";
    skCtx.fillRect(0,0,skCanvas.width,skCanvas.height);

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

  if(sketchHistory.length <= 1){
    showHint('Nothing to undo');
    return;
  }

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

/* ═══════════════ SAVE SKETCH AS PNG ═══════════════ */
function saveSketchAsPng(){
  if(!skCanvas){
    showHint('Nothing to save yet');
    return;
  }
  if(skActiveTextInput) commitTextInput();

  const link = document.createElement('a');
  const ts = new Date();
  const stamp = ts.getFullYear() + '-' + String(ts.getMonth()+1).padStart(2,'0') + '-' + String(ts.getDate()).padStart(2,'0')
    + '_' + String(ts.getHours()).padStart(2,'0') + String(ts.getMinutes()).padStart(2,'0');
  link.download = `sketch-question${currentQ+1}-${stamp}.png`;
  link.href = skCanvas.toDataURL('image/png');
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showHint('Sketch saved as PNG');
}

/* ─── Timer helpers must not sit in the temporal dead zone ───
   initExam() is called further down this file, but it runs while the script is
   still being parsed: every top-level `const`/`let` declared *after* that call
   is still uninitialized at that point. Referencing one threw
   "Cannot access 'X' before initialization" inside the async init, which left
   the exam page unwired (no timer, no submit, banner stuck on "share screen").
   These are `var` so they can be read from the very first statement. */
var TIMER_DRIFT_TOLERANCE_S = 90;

/* ─── Convert stored questions to exam format ─── */
function buildQuestionsFromExam(exam){
  if(!exam || !exam.questions || exam.questions.length === 0){
    return [];
  }
  // Handle if questions is a string (JSON stored)
  let qList = exam.questions;
  if(typeof qList === 'string'){
    try {
      qList = JSON.parse(qList);
    } catch {
      return [];
    }
  }
  return qList.map(q => {
    const item = {
      type: q.qtype === 'mc' ? 'mc' : q.qtype === 'sa' ? 'sa' : q.qtype === 'cb' ? 'cb' : q.qtype === 'dd' ? 'dd' : q.qtype === 'pg' ? 'pg' : q.qtype === 'mg' ? 'mg' : q.qtype === 'cg' ? 'cg' : 'mc',
      text: q.text || 'Untitled question',
      points: q.points || 5
    };
    if(q.choices && q.choices.length > 0){
      item.options = q.choices;
    }
    if(q.type === 'mg' || q.type === 'cg' || q.qtype === 'mg' || q.qtype === 'cg'){
      item.rows = q.rows || q.gridRows || ['Row 1', 'Row 2'];
      item.columns = q.columns || q.gridColumns || ['Column 1', 'Column 2'];
    }
    return item;
  });
}

/* ─── Initialize Exam (called after async load) ─── */
async function initExam() {

    examData = await loadExamFromId();

    console.log("Loaded Exam:", examData);

    if (!examData) {
        document.getElementById("questionContainer").innerHTML =
            "<div class='q-card'><h3>No exam found.</h3></div>";
        return;
    }
    if(examData.status === 'ended'){
      showExamLifecycleScreen('ended');
      return;
    }
    if(examData.status && examData.status !== 'live'){
      showExamLifecycleScreen('scheduled');
      return;
    }

    loadTabSwitchData();

    // Show real student info from login
    const studentName = document.getElementById('studentName');
    const studentSection = document.getElementById('studentSection');
    if (studentName) {
      studentName.textContent = localStorage.getItem('wamsStudentName') || 'Student';
    }
    if (studentSection) {
      const sectionName = localStorage.getItem('wamsStudentSection') || examData.section_name || examData.section || '';
      const courseName = localStorage.getItem('wamsStudentCourse') || '';
      const studentId = localStorage.getItem('wamsStudentId') || '';
      const parts = [];
      if (sectionName) parts.push(sectionName);
      if (courseName) parts.push(courseName);
      if (studentId) parts.push('ID ' + studentId);
      studentSection.textContent = parts.length > 0 ? parts.join(' · ') : 'Student';
    }

    questions = buildQuestionsFromExam(examData);

    console.log("Questions:", questions);

    if (questions.length === 0) {
        document.getElementById("questionContainer").innerHTML =
            "<div class='q-card'><h3>No questions found.</h3></div>";
        return;
    }

    // Accept both camelCase (timeLimit, from locally stored exams) and
    // snake_case (time_limit, returned by the server API) so the timer uses
    // the exact duration the professor configured instead of the 1-hour default.
    const timeLimitRaw = examData.timeLimit ?? examData.time_limit;
    const timeLimitMinutes = parseInt(timeLimitRaw, 10);
    const configuredSeconds = Number.isFinite(timeLimitMinutes) && timeLimitMinutes > 0
        ? timeLimitMinutes * 60
        : DEFAULT_EXAM_SECONDS;
    TOTAL_EXAM_SECONDS = configuredSeconds;
    const remainingSeconds = Number(examData.timeRemainingSeconds ?? examData.time_remaining_seconds);
    secondsLeft = Number.isFinite(remainingSeconds)
        ? Math.min(configuredSeconds, Math.max(0, Math.floor(remainingSeconds)))
        : configuredSeconds;
    restoreTimerState();
    saveTimerState();
    // Show the countdown right away instead of waiting for the first tick, and
    // start from the exact server clock so the entry minutes are never lost.
    const initialLeft = secondsLeftFromServer();
    if(initialLeft !== null) secondsLeft = initialLeft;
    document.getElementById('timerText').textContent =
        String(Math.floor(secondsLeft / 60)).padStart(2, '0') + ':' + String(secondsLeft % 60).padStart(2, '0');

    const title = document.querySelector(".exam-top-title");
    if (title) {
        title.textContent = examData.title || "Exam";
    }

    buildQGrid();
    renderQuestion();

    // Returning student: restore their answers / position, and pull the latest
    // server-side copy in case they answered from another device.
    const restored = restoreAnswersLocal();
    if(restored){
      buildQGrid();
      renderQuestion();
    }
    syncAnswersFromServer();

    // Hide tools if disabled in exam settings
    let toolsSettings = examData.tools || examData.tools_settings || {};
    if (typeof toolsSettings === 'string') { try { toolsSettings = JSON.parse(toolsSettings); } catch(e) { toolsSettings = {}; } }
    if (toolsSettings.calculator === false) {
      const calcBtn = document.getElementById('calcBtn');
      if (calcBtn) calcBtn.style.display = 'none';
    }
    if (toolsSettings.whiteboard === false) {
      const sketchBtn = document.getElementById('sketchBtn');
      if (sketchBtn) sketchBtn.style.display = 'none';
    }

    showExamMediaConsent(startExamAfterMediaConsent);
}

function startExamAfterMediaConsent(){
    // Trust the server's clock only: a restored localStorage value can belong to
    // an older attempt and would hand the student fewer minutes than they have.
    const serverLeft = secondsLeftFromServer();
    if(serverLeft !== null){
      secondsLeft = serverLeft;
      saveTimerState();
    }
    if(secondsLeft <= 0){
      finalSubmit(true);
      return;
    }
    examTimerInterval = setInterval(updateTimer, 1000);
    examStatusInterval = setInterval(checkExamLifecycle, 5000);
    checkExamLifecycle();
    setTimeout(initCamera, 0);
    setTimeout(initAudioCapture, 0);
    addScreenCaptureButton();
    setTimeout(initScreenCapture, 1000);
  }


/* ─── Exam Functions ─── */
function buildQGrid(){
  document.getElementById('qGrid').innerHTML = questions.map((q,i) => `
    <button class="qbtn ${i===currentQ?'current':''} ${answers[i]!==undefined?'answered':''}" onclick="jumpTo(${i})">${i+1}</button>
  `).join('');
}
function jumpTo(i){
  if(i !== currentQ) reportQuestionActivity('moved', i + 1);
  currentQ = i;
  renderQuestion();
}

function renderQuestion(){
  const q = questions[currentQ];
  if(!q) return;
  document.getElementById('progressLabel').textContent = `Question ${currentQ+1} of ${questions.length}`;
  document.getElementById('progressFill').style.width = ((currentQ+1)/questions.length*100)+'%';

  let bodyHtml = '';
  if(q.type === 'mc' || q.type === 'cb'){
    const inputType = q.type === 'mc' ? 'radio' : 'checkbox';
    const selected = answers[currentQ];
    const selectedArr = Array.isArray(selected) ? selected : (selected !== undefined ? [selected] : []);
    bodyHtml = `<div class="opt-list">` + (q.options || []).map((opt,i)=>{
      const isSelected = q.type === 'mc' ? selected === i : selectedArr.includes(i);
      return `
      <label class="opt-row ${isSelected?'selected':''}" onclick="${q.type === 'mc' ? `selectMC(${i})` : `toggleCB(${i})`}">
        <input type="${inputType}" name="mcq" ${isSelected?'checked':''}>
        <span>${opt}</span>
      </label>`;
    }).join('') + `</div>`;
  } else if(q.type === 'dd'){
    bodyHtml = `<select class="short-answer-input" style="font-family:'Inter',monospace;width:100%;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--tx2);font-size:14px;" onchange="setText(this.value)">
      <option value="" ${!answers[currentQ]?'selected':''}>Select an option...</option>
      ${(q.options || []).map((opt,i) => {
        const isSelected = answers[currentQ] === String(i);
        return `<option value="${i}" ${isSelected?'selected':''}>${opt}</option>`;
      }).join('')}
    </select>`;
  } else if(q.type === 'pg'){
    bodyHtml = `<textarea class="short-answer-input" rows="5" placeholder="Type your answer here..." oninput="setText(this.value)" style="font-family:'Inter',monospace;width:100%;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--tx1);resize:vertical;font-size:14px;">${answers[currentQ]||''}</textarea>`;
  } else if(q.type === 'mg' || q.type === 'cg'){
    bodyHtml = renderGridQuestion();
  } else {
    bodyHtml = `<input type="text" class="short-answer-input" placeholder="Type your answer here..." value="${answers[currentQ]||''}" oninput="setText(this.value)" style="font-family:'Inter',monospace;">`;
  }

  let qTypeLabel = 'Question';
  if (q.type === 'mc') qTypeLabel = 'Multiple Choice';
  else if (q.type === 'cb') qTypeLabel = 'Checkboxes';
  else if (q.type === 'sa') qTypeLabel = 'Short Answer';
  else if (q.type === 'dd') qTypeLabel = 'Dropdown';
  else if (q.type === 'pg') qTypeLabel = 'Paragraph';
  else if (q.type === 'mg') qTypeLabel = 'Multiple Choice Grid';
  else if (q.type === 'cg') qTypeLabel = 'Checkbox Grid';

  document.getElementById('questionContainer').innerHTML = `
    <div class="q-card">
      <div class="q-num">${qTypeLabel} <span class="pts">${q.points} pts</span></div>
      <div class="q-text">${q.text}</div>
      ${bodyHtml}
    </div>`;

  document.getElementById('prevBtn').disabled = currentQ === 0;
  const nextBtn = document.getElementById('nextBtn');
  if(currentQ === questions.length-1){
    nextBtn.innerHTML = `Review & Submit <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
    nextBtn.onclick = openSubmitModal;
  } else {
    nextBtn.innerHTML = `Next <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>`;
    nextBtn.onclick = nextQuestion;
  }
  buildQGrid();
}

function selectMC(i){
  answers[currentQ]=i;
  saveAnswersLocal();
  reportQuestionActivity('answered', currentQ + 1);
  renderQuestion();
}
function toggleCB(i){
  if(!answers[currentQ]) answers[currentQ] = [];
  const arr = answers[currentQ];
  const pos = arr.indexOf(i);
  if(pos === -1) arr.push(i); else arr.splice(pos, 1);
  if(arr.length === 0) delete answers[currentQ];
  saveAnswersLocal();
  reportQuestionActivity('answered', currentQ + 1);
  renderQuestion();
}
function setText(val){
  if(val.trim()==='') delete answers[currentQ];
  else {
    answers[currentQ]=val;
    reportQuestionActivity('answered', currentQ + 1);
  }
  saveAnswersLocal();
  buildQGrid();
}
function nextQuestion(){
  if(currentQ<questions.length-1){
    currentQ++;
    reportQuestionActivity('moved', currentQ + 1);
    renderQuestion();
  }
}
function prevQuestion(){
  if(currentQ>0){
    currentQ--;
    reportQuestionActivity('moved', currentQ + 1);
    renderQuestion();
  }
}

function renderGridQuestion() {
  const q = questions[currentQ];
  const rows = q.rows || [];
  const cols = q.columns || [];
  const isCg = q.type === 'cg';
  const inputType = isCg ? 'checkbox' : 'radio';

  // Initialize grid answers if empty
  if (!answers[currentQ]) {
    answers[currentQ] = {};
  }
  const currentAnswers = answers[currentQ];

  let headerHtml = `<th></th>` + cols.map(c => `<th>${c}</th>`).join('');
  let rowsHtml = rows.map((rowName, rIdx) => {
    let cellsHtml = cols.map((colName, cIdx) => {
      let isSelected = false;
      if (isCg) {
        const arr = currentAnswers[rIdx] || [];
        isSelected = arr.includes(cIdx);
      } else {
        isSelected = currentAnswers[rIdx] === cIdx;
      }
      return `
        <td>
          <input type="${inputType}" name="grid-row-${rIdx}" ${isSelected ? 'checked' : ''} onchange="toggleGrid(${rIdx}, ${cIdx})">
        </td>
      `;
    }).join('');
    return `
      <tr>
        <td class="grid-row-header"><strong>${rowName}</strong></td>
        ${cellsHtml}
      </tr>
    `;
  }).join('');

  return `
    <div class="grid-question-wrap" style="margin-top: 15px; overflow-x: auto;">
      <table class="grid-question-table" style="width: 100%; border-collapse: collapse; text-align: center;">
        <thead>
          <tr>${headerHtml}</tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

function toggleGrid(rowIdx, colIdx) {
  const q = questions[currentQ];
  const isCg = q.type === 'cg';
  if (!answers[currentQ]) {
    answers[currentQ] = {};
  }
  const currentAnswers = answers[currentQ];

  if (isCg) {
    if (!currentAnswers[rowIdx]) {
      currentAnswers[rowIdx] = [];
    }
    const arr = currentAnswers[rowIdx];
    const pos = arr.indexOf(colIdx);
    if (pos === -1) {
      arr.push(colIdx);
    } else {
      arr.splice(pos, 1);
    }
    if (arr.length === 0) {
      delete currentAnswers[rowIdx];
    }
  } else {
    currentAnswers[rowIdx] = colIdx;
  }

  if (Object.keys(currentAnswers).length === 0) {
    delete answers[currentQ];
  } else {
    answers[currentQ] = currentAnswers;
  }

  saveAnswersLocal();
  reportQuestionActivity('answered', currentQ + 1);
  renderQuestion();
}

/* The server is the source of truth once a session exists (it is the same
   session on re-entry), so merge in anything saved there. */
async function syncAnswersFromServer(){
  const sessionId = getSessionId();
  const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
  if(!sessionId || !token) return;
  try {
    const res = await fetch('/api/sessions/' + sessionId + '/answers', {
      headers: { 'Authorization': 'Bearer ' + token },
      cache: 'no-store'
    });
    if(!res.ok) return;
    const data = await res.json();
    let serverAnswers = data && data.answers;
    if(typeof serverAnswers === 'string'){
      try { serverAnswers = JSON.parse(serverAnswers); } catch { serverAnswers = null; }
    }
    if(!serverAnswers || typeof serverAnswers !== 'object' || Array.isArray(serverAnswers)) return;
    const merged = { ...answers, ...serverAnswers };
    if(JSON.stringify(merged) === JSON.stringify(answers)) return;
    answers = merged;
    saveAnswersLocal();
    buildQGrid();
    renderQuestion();
  } catch (err) {
    console.warn('Unable to sync saved answers:', err);
  }
}

/* ─── Answer persistence ───
   Answers are mirrored locally so closing the page (then logging back in)
   returns the student to the state they left, on the same exam session. */
function getAnswersStorageKey(){
  const examId = examData ? examData.id : new URLSearchParams(window.location.search).get('examId') || 'unknown';
  return 'wamsAnswers_' + examId;
}

function saveAnswersLocal(){
  try {
    localStorage.setItem(getAnswersStorageKey(), JSON.stringify({
      answers: answers,
      currentQ: currentQ,
      sessionId: getSessionId()
    }));
  } catch {}
}

function restoreAnswersLocal(){
  try {
    const saved = JSON.parse(localStorage.getItem(getAnswersStorageKey()) || 'null');
    if(!saved || !saved.answers) return false;
    // Only restore into the same exam session; a new session starts fresh.
    if(saved.sessionId && getSessionId() && String(saved.sessionId) !== String(getSessionId())) return false;
    answers = saved.answers;
    if(Number.isInteger(saved.currentQ) && saved.currentQ >= 0){
      currentQ = Math.min(saved.currentQ, Math.max(0, questions.length - 1));
    }
    return Object.keys(answers).length > 0;
  } catch {
    return false;
  }
}

function clearAnswersLocal(){
  try { localStorage.removeItem(getAnswersStorageKey()); } catch {}
}

// Auto-init the exam when page loads
initExam();
