/* ─── Student Session Guard ─── */
(function checkStudentSession(){
  const hasStudentSession = localStorage.getItem('wamsStudentId') || localStorage.getItem('wamsStudentName');
  const hasToken = localStorage.getItem('token') || localStorage.getItem('wamsToken');
  if(!hasStudentSession && !hasToken){
    window.location.href = 'wams-student-log-in.html';
  }
})();

/* ─── Load exam from login-session data or localStorage ─── */
const STORAGE_KEY = 'wamsProfessorExams';
let examData = null;

/* ─── Configurable Constants ─── */
const DEFAULT_EXAM_SECONDS = 3600;
const CAMERA_SNAPSHOT_INTERVAL = 30000;
const AUDIO_CHECK_INTERVAL = 5000;
const HINT_TIMEOUT = 1400;

async function loadExamFromId() {

    const params = new URLSearchParams(window.location.search);
    const examId = params.get("examId");

    console.log("URL examId:", examId);

    // Primary: fetch the latest exam data from the server so professor edits
    // (questions, title, time limit, etc.) are reflected on student refresh.
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
    const sessionExamStr = localStorage.getItem("wamsExamData");
    if (sessionExamStr) {
      try {
        const sessionExam = JSON.parse(sessionExamStr);
        if (String(sessionExam.id) === String(examId)) {
          console.log("Loaded exam from login session data:", sessionExam);
          return sessionExam;
        }
      } catch(e) { console.warn("Failed to parse wamsExamData", e); }
    }

    // Fallback: load from wamsProfessorExams
    const exams = JSON.parse(localStorage.getItem("wamsProfessorExams")) || [];
    console.log("All Exams:", exams);
    const found = exams.find(e => String(e.id) === String(examId));
    console.log("Matched Exam:", found);
    return found || null;
}

// Global variables - initialized when exam loads
let questions = [];
let currentQ = 0;
let answers = {};
let examTimerInterval = null;
let examSubmitted = false;

// Initialize secondsLeft from TOTAL_EXAM_SECONDS when exam data loads
let secondsLeft = DEFAULT_EXAM_SECONDS;
let TOTAL_EXAM_SECONDS = DEFAULT_EXAM_SECONDS;

/* ─── Persistent Timer ─── */
function updateTimer(){
  secondsLeft--;
  if(secondsLeft <= 0){
    secondsLeft = 0;
    clearInterval(examTimerInterval);
    document.getElementById('timerText').textContent = '00:00';
    finalSubmit();
    return;
  }
  const m = Math.floor(secondsLeft/60).toString().padStart(2,'0');
  const s = (secondsLeft%60).toString().padStart(2,'0');
  document.getElementById('timerText').textContent = m + ':' + s;
  if(secondsLeft <= 300) document.getElementById('timerBox').classList.add('warn');
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
  });

  const examTitle = examData ? examData.title : 'Exam';
  document.body.innerHTML = '<div style="height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#0D1B3E,#0a1530);font-family:\'Inter\',sans-serif;"><div style="text-align:center;color:#fff;max-width:380px;padding:20px;"><div style="width:64px;height:64px;border-radius:18px;background:#16A34A;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;"><svg viewBox="0 0 24 24" width="30" height="30" stroke="#fff" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div><h2 style="font-size:21px;font-weight:700;margin-bottom:10px;">Exam Submitted</h2><p style="font-size:13.5px;color:rgba(255,255,255,.65);line-height:1.6;">Your exam for <b style="color:#F0C96A;">' + examTitle + '</b> has been submitted successfully. You may now close this window.</p></div></div>';
}

/* ─── Persistent Timer ─── */
function getTimerStorageKey(){
  const examId = examData ? examData.id : new URLSearchParams(window.location.search).get('examId') || 'unknown';
  return `wamsToolTimerState_${examId}`;
}

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

/* ═══════════════ CAMERA MONITORING (AI-POWERED) ═══════════════ */
let cameraStream = null;
let cameraInterval = null;
let cameraEnabled = false;
let faceApiModelsLoaded = false;
let faceApiLoading = false;

// Load face-api.js AI models (TinyFaceDetector + FaceLandmark68)
async function loadFaceApiModels(){
  if(faceApiModelsLoaded || faceApiLoading) return;
  if(typeof faceapi === 'undefined') return;
  faceApiLoading = true;
  try {
    const MODEL_URL = 'models';
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    faceApiModelsLoaded = true;
    console.log('✅ face-api.js AI models loaded');
  } catch(err){
    console.warn('Failed to load face-api.js models:', err);
  } finally {
    faceApiLoading = false;
  }
}

/* ── Shared media permission manager ──
   Requests camera + microphone in ONE combined getUserMedia call so the
   browser shows a single permission popup instead of two. Falls back to
   individual requests if the combined grant is partially blocked. */
function getMonitorPrefs(){
  let m = (examData && (examData.monitor || examData.monitor_settings)) || {};
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch(e) { m = {}; } }
  return m;
}

let mediaPromise = null;

function ensureMediaStreams(){
  const prefs = getMonitorPrefs();
  const needsCamera = prefs.cam !== false && prefs.camera !== false;
  const needsMic = prefs.audio !== false;

  const haveCam = !needsCamera || (cameraStream && cameraStream.active);
  const haveMic = !needsMic || (audioStream && audioStream.active);
  if (haveCam && haveMic) return Promise.resolve();

  if (!mediaPromise) {
    showHint('Please allow camera & microphone access when prompted');
    mediaPromise = (async () => {
      const constraints = {};
      if (needsCamera && !(cameraStream && cameraStream.active)) {
        constraints.video = { width: 320, height: 240, facingMode: 'user' };
      }
      if (needsMic && !(audioStream && audioStream.active)) {
        constraints.audio = { echoCancellation: true, noiseSuppression: true };
      }

      try {
        // One combined request → a single browser permission popup
        const combined = await navigator.mediaDevices.getUserMedia(constraints);
        const vTracks = combined.getVideoTracks();
        const aTracks = combined.getAudioTracks();
        if (vTracks.length > 0) cameraStream = new MediaStream(vTracks);
        if (aTracks.length > 0) audioStream = new MediaStream(aTracks);
      } catch (combinedErr) {
        console.warn('Combined media request failed, trying individually:', combinedErr);
        // Fallback so one denied device doesn't block the other
        if (constraints.video) {
          try { cameraStream = await navigator.mediaDevices.getUserMedia({ video: constraints.video }); }
          catch (e) { console.warn('Camera access denied:', e); }
        }
        if (constraints.audio) {
          try { audioStream = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio }); }
          catch (e) { console.warn('Microphone access denied:', e); }
        }
      } finally {
        mediaPromise = null;
      }
    })();
  }
  return mediaPromise;
}

async function initCamera(){
  if(!examData) return;

  let tools = examData.tools || examData.tools_settings || {};
  if (typeof tools === 'string') { try { tools = JSON.parse(tools); } catch(e) { tools = {}; } }

  const prefs = getMonitorPrefs();
  if (prefs.cam === false || prefs.camera === false) return;

  if (tools.camera === false) {
    const camBtn = document.getElementById('camBtn');
    if (camBtn) camBtn.style.display = 'none';
  }

  const video = document.getElementById('camVideo');
  if(!video) return;

  // Shared combined request — one popup covers camera + mic
  await ensureMediaStreams();

  if (cameraStream) {
    video.srcObject = cameraStream;
    cameraEnabled = true;

    // Load AI models in background
    loadFaceApiModels();

    // Take snapshot periodically
    if (cameraInterval) clearInterval(cameraInterval);
    cameraInterval = setInterval(takeCameraSnapshot, CAMERA_SNAPSHOT_INTERVAL);

    // Take initial snapshot after 2 seconds
    setTimeout(takeCameraSnapshot, 2000);
  } else {
    showHint('Camera access required for exam monitoring.');
  }
}

// AI-powered face detection using face-api.js (TinyFaceDetector + FaceLandmark68)
async function detectFaces(video, canvas, ctx){
  // Fallback to heuristic if AI models aren't loaded yet
  if(!faceApiModelsLoaded || typeof faceapi === 'undefined'){
    return detectFacesHeuristic(video, canvas, ctx);
  }

  try {
    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks();

    const faces = detections.map(d => {
      const box = d.detection.box;
      const landmarks = d.landmarks.positions;
      return {
        x: box.x,
        y: box.y,
        w: box.width,
        h: box.height,
        count: 1,
        landmarks,
        score: d.detection.score
      };
    });

    return { faceCount: faces.length, faces, skinPixels: 0, aiModel: true };
  } catch(err){
    console.warn('AI face detection failed, falling back to heuristic:', err);
    return detectFacesHeuristic(video, canvas, ctx);
  }
}

// Original heuristic fallback (kept as backup if AI models fail to load)
async function detectFacesHeuristic(video, canvas, ctx){
  const w = canvas.width, h = canvas.height;
  ctx.drawImage(video, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const px = imgData.data;
  const skinMap = new Uint8Array(w * h);
  let skinCount = 0;

  for(let i = 0; i < px.length; i += 4){
    const r = px[i], g = px[i+1], b = px[i+2];
    // YCbCr skin chrominance model
    const cr = 128 + 0.5*r - 0.331314*g - 0.168686*b;
    const cb = 128 - 0.168736*r - 0.331264*g + 0.5*b;
    if(cr > 133 && cr < 173 && cb > 80 && cb < 125 && r > 90 && g > 40 && b > 20 && (Math.max(r,g,b) - Math.min(r,g,b)) > 15){
      skinMap[i/4] = 1;
      skinCount++;
    }
  }

  // Downsample to 8x8 grid blocks for spatial cluster analysis
  const step = 8;
  const gw = Math.floor(w / step);
  const gh = Math.floor(h / step);
  const grid = new Uint8Array(gw * gh);

  for(let gy = 0; gy < gh; gy++){
    for(let gx = 0; gx < gw; gx++){
      let blockCount = 0;
      for(let dy = 0; dy < step; dy++){
        for(let dx = 0; dx < step; dx++){
          const idx = (gy * step + dy) * w + (gx * step + dx);
          if(skinMap[idx]) blockCount++;
        }
      }
      if(blockCount >= (step * step * 0.35)) {
        grid[gy * gw + gx] = 1;
      }
    }
  }

  // Connected-component analysis for distinct face candidates
  const visited = new Uint8Array(gw * gh);
  const faceCandidates = [];

  for(let y = 0; y < gh; y++){
    for(let x = 0; x < gw; x++){
      const rootIdx = y * gw + x;
      if(grid[rootIdx] && !visited[rootIdx]){
        let minX = x, maxX = x, minY = y, maxY = y, count = 0;
        const q = [[x, y]];
        visited[rootIdx] = 1;

        while(q.length){
          const [cx, cy] = q.pop();
          count++;
          if(cx < minX) minX = cx;
          if(cx > maxX) maxX = cx;
          if(cy < minY) minY = cy;
          if(cy > maxY) maxY = cy;

          for(const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]){
            const nx = cx + dx, ny = cy + dy;
            if(nx >= 0 && nx < gw && ny >= 0 && ny < gh){
              const nIdx = ny * gw + nx;
              if(grid[nIdx] && !visited[nIdx]){
                visited[nIdx] = 1;
                q.push([nx, ny]);
              }
            }
          }
        }

        // Validate candidate face blob size & aspect ratio
        const blobW = (maxX - minX + 1) * step;
        const blobH = (maxY - minY + 1) * step;
        const aspectRatio = blobH / Math.max(1, blobW);

        // A valid face region requires sufficient pixel density and natural facial proportions
        if(count >= 8 && blobW >= 32 && blobH >= 36 && aspectRatio >= 0.7 && aspectRatio <= 2.2){
          faceCandidates.push({ x: minX * step, y: minY * step, w: blobW, h: blobH, count });
        }
      }
    }
  }

  return { faceCount: faceCandidates.length, faces: faceCandidates, skinPixels: skinCount };
}

function drawAiFacialHitboxes(ctx, faceInfo, isMultipleFaces) {
  if (!faceInfo || !faceInfo.faces || faceInfo.faces.length === 0) return;

  faceInfo.faces.forEach((f, idx) => {
    const boxColor = isMultipleFaces ? '#DC2626' : '#0EA5E9';
    const featureColor = isMultipleFaces ? '#F87171' : '#38BDF8';

    // 1. Draw Corner AI Detection Brackets
    const len = Math.min(18, f.w * 0.25);
    ctx.strokeStyle = boxColor;
    ctx.lineWidth = 2.5;

    // Top-Left
    ctx.beginPath(); ctx.moveTo(f.x, f.y + len); ctx.lineTo(f.x, f.y); ctx.lineTo(f.x + len, f.y); ctx.stroke();
    // Top-Right
    ctx.beginPath(); ctx.moveTo(f.x + f.w - len, f.y); ctx.lineTo(f.x + f.w, f.y); ctx.lineTo(f.x + f.w, f.y + len); ctx.stroke();
    // Bottom-Left
    ctx.beginPath(); ctx.moveTo(f.x, f.y + f.h - len); ctx.lineTo(f.x, f.y + f.h); ctx.lineTo(f.x + len, f.y + f.h); ctx.stroke();
    // Bottom-Right
    ctx.beginPath(); ctx.moveTo(f.x + f.w - len, f.y + f.h); ctx.lineTo(f.x + f.w, f.y + f.h); ctx.lineTo(f.x + f.w, f.y + f.h - len); ctx.stroke();

    // 2. Face Header Tag
    ctx.fillStyle = boxColor;
    ctx.fillRect(f.x, Math.max(0, f.y - 18), Math.min(f.w, 110), 18);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 9.5px Inter, sans-serif';
    ctx.fillText(isMultipleFaces ? `⚠️ FACE ${idx + 1} ALERT` : `AI FACE ${idx + 1}`, f.x + 4, Math.max(12, f.y - 5));

    // 3. Eye Hitboxes
    ctx.strokeStyle = featureColor;
    ctx.lineWidth = 1.5;

    const eyeLW = f.w * 0.22, eyeLH = f.h * 0.16;
    const eyeLX = f.x + f.w * 0.18, eyeLY = f.y + f.h * 0.28;
    ctx.strokeRect(eyeLX, eyeLY, eyeLW, eyeLH);
    ctx.fillStyle = featureColor;
    ctx.font = '8px monospace';
    ctx.fillText('EYE-L', eyeLX, eyeLY - 2);

    const eyeRW = f.w * 0.22, eyeRH = f.h * 0.16;
    const eyeRX = f.x + f.w * 0.60, eyeRY = f.y + f.h * 0.28;
    ctx.strokeRect(eyeRX, eyeRY, eyeRW, eyeRH);
    ctx.fillText('EYE-R', eyeRX, eyeRY - 2);

    // 4. Nose Center Reticle
    const noseX = f.x + f.w * 0.50, noseY = f.y + f.h * 0.52;
    ctx.beginPath();
    ctx.moveTo(noseX - 4, noseY); ctx.lineTo(noseX + 4, noseY);
    ctx.moveTo(noseX, noseY - 4); ctx.lineTo(noseX, noseY + 4);
    ctx.stroke();

    // 5. Mouth Hitbox
    const mouthW = f.w * 0.38, mouthH = f.h * 0.15;
    const mouthX = f.x + f.w * 0.31, mouthY = f.y + f.h * 0.72;
    ctx.strokeRect(mouthX, mouthY, mouthW, mouthH);
    ctx.fillText('MOUTH', mouthX, mouthY + mouthH + 8);
  });
}

async function takeCameraSnapshot(){
  if(!cameraEnabled || !cameraStream) return;
  const video = document.getElementById('camVideo');
  if(!video || video.readyState < 2) return;

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');

  let faceInfo = { faceCount: 0, faces: [], skinPixels: 0 };
  try {
    faceInfo = await detectFaces(video, canvas, ctx);
  } catch(e) {
    console.warn('Face detection failed:', e);
  }

  // Draw current frame
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const multipleFaces = faceInfo.faceCount > 1;
  const noFace = faceInfo.faceCount === 0;

  // ONLY capture & upload when multiple faces are detected via AI analysis
  if(multipleFaces){
    // Draw AI facial feature hitboxes (Face, Eyes, Nose, Mouth)
    drawAiFacialHitboxes(ctx, faceInfo, true);

    const imageData = canvas.toDataURL('image/jpeg', 0.75);
    showHint(`⚠️ Multiple faces detected! (${faceInfo.faceCount} faces)`);

    try {
      const sessionId = getSessionId();
      const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
      if(sessionId && token){
        await fetch('/api/camera/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({
            session_id: sessionId,
            image: imageData,
            face_count: faceInfo.faceCount,
            skin_pixels: faceInfo.skinPixels,
            flagged: true
          })
        });
      }
    } catch(err){
      console.warn('Failed to send camera snapshot:', err);
    }
  } else if (noFace && Math.random() < 0.2) {
    showHint('No face detected in front of camera');
  }
}

function getSessionId() {
  const stored = localStorage.getItem('examSessionId') || localStorage.getItem('wamsSessionId');
  if(stored) return stored;
  const examId = examData ? examData.id : new URLSearchParams(window.location.search).get('examId');
  const key = 'wamsSession_' + (examId || 'unknown');
  const existing = localStorage.getItem(key);
  if(existing){
    localStorage.setItem('examSessionId', existing);
    return existing;
  }
  const fallback = Date.now().toString();
  localStorage.setItem(key, fallback);
  localStorage.setItem('examSessionId', fallback);
  return fallback;
}

function getAuthToken() {
  return localStorage.getItem('token') || localStorage.getItem('wamsToken');
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

function stopCamera(){
  if(cameraStream){
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  if(cameraInterval){
    clearInterval(cameraInterval);
    cameraInterval = null;
  }
  cameraEnabled = false;
}

/* ─── End Camera Monitoring ─── */

/* ═══════════════ TAB SWITCH DETECTION ═══════════════ */
let tabSwitchCount = 0;
let tabSwitchLog = [];

function loadTabSwitchData(){
  if(!examData) return;
  try {
    const stored = localStorage.getItem('wamsTabSwitch_' + examData.id);
    if(stored){
      const data = JSON.parse(stored);
      tabSwitchCount = data.count || 0;
      tabSwitchLog = data.log || [];
    }
  } catch {}
}

function saveTabSwitchData(){
  if(!examData) return;
  try {
    localStorage.setItem('wamsTabSwitch_' + examData.id, JSON.stringify({
      count: tabSwitchCount,
      log: tabSwitchLog
    }));
    // Also update the exam's flagged count in the main store
    const exams = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const idx = exams.findIndex(e => String(e.id) === String(examData.id));
    if(idx !== -1){
      exams[idx].flagged = tabSwitchCount;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(exams));
    }
  } catch {}
}

function recordTabSwitch(){
  let monitor = examData ? (examData.monitor || examData.monitor_settings || {}) : {};
  if (typeof monitor === 'string') { try { monitor = JSON.parse(monitor); } catch(e) { monitor = {}; } }
  if (monitor.tab === false) return;

  tabSwitchCount++;
  tabSwitchLog.push({
    time: new Date().toISOString(),
    type: 'tab-switch'
  });
  saveTabSwitchData();

  // Report tab switch to server
  const sessionId = getSessionId();
  const token = getAuthToken();
  if (sessionId && token) {
    fetch('/api/sessions/' + sessionId + '/tab-switches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
    }).catch(err => console.warn('Tab switch reporting failed:', err));
  }

  // Show warning on page
  const existing = document.querySelector('.tab-switch-warning');
  if(!existing){
    const warn = document.createElement('div');
    warn.className = 'tab-switch-warning';
    warn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      Tab switch detected! (${tabSwitchCount} time${tabSwitchCount>1?'s':''})
    `;
    document.body.appendChild(warn);
    setTimeout(() => warn.classList.add('show'));
  } else {
    existing.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      Tab switch detected! (${tabSwitchCount} time${tabSwitchCount>1?'s':''})
    `;
  }
}

// Load existing tab switch data so it persists across page refreshes
loadTabSwitchData();

let tabSwitchPending = false;
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'hidden' && !tabSwitchPending){
    tabSwitchPending = true;
    recordTabSwitch();
  } else if(document.visibilityState === 'visible'){
    tabSwitchPending = false;
  }
});

window.addEventListener('blur', () => {
  if(!tabSwitchPending){
    tabSwitchPending = true;
    recordTabSwitch();
  }
});

window.addEventListener('focus', () => {
  tabSwitchPending = false;
});

/* ─── End Tab Switch Detection ─── */



/* ═══════════════ SCREEN CAPTURE DETECTION ═══════════════ */
let screenStream = null;
let screenInterval = null;
let screenEnabled = false;
const SCREEN_SNAPSHOT_INTERVAL = 30000;

async function initScreenCapture(){
  if(!examData) return;

  // Support both monitor and monitor_settings naming
  let monitor = examData.monitor || examData.monitor_settings || {};
  if(typeof monitor === 'string') {
    try { monitor = JSON.parse(monitor); } catch(e) { monitor = {}; }
  }

  if(monitor.screen === false){
    const screenBtn = document.getElementById('screenBtn');
    if(screenBtn) screenBtn.style.display = 'none';
    return;
  }

  screenEnabled = true;
  addScreenCaptureButton();

  const banner = document.getElementById('screenShareBanner');
  if(banner) banner.style.display = 'flex';

  // Prompt for screen share activation after a short delay on exam start
  setTimeout(() => {
    if (!screenStream) {
      promptScreenShare();
    }
  }, 1500);
}

async function promptScreenShare(){
  try {
    showHint('Click Screen in toolbar to activate screen sharing');
    await startContinuousScreenCapture();
  } catch(err){
    console.warn('Auto screen share prompt waiting for user click:', err);
  }
}

async function startContinuousScreenCapture(){
  try {
    if(screenStream) {
      await takeScreenSnapshot();
      return;
    }

    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'never', width: 1280, height: 720 }
    });

    const track = screenStream.getVideoTracks()[0];
    if(!track) return;

    track.onended = () => {
      stopScreenCapture();
      showHint('Screen sharing paused. Click Screen to re-activate.');
    };

    // Take initial snapshot immediately
    setTimeout(takeScreenSnapshot, 1000);

    // Set up continuous periodic snapshots
    if(screenInterval) clearInterval(screenInterval);
    screenInterval = setInterval(takeScreenSnapshot, SCREEN_SNAPSHOT_INTERVAL);

    showHint('Screen monitoring active');
    const screenBtn = document.getElementById('screenBtn');
    if(screenBtn) screenBtn.classList.add('active');
    const banner = document.getElementById('screenShareBanner');
    if(banner) banner.style.display = 'none';
  } catch(err){
    console.warn('Screen capture permission cancelled or denied:', err);
    showHint('Click Screen in the toolbar to activate screen sharing');
  }
}

async function takeScreenSnapshot(){
  if(!screenStream) return;
  try {
    const track = screenStream.getVideoTracks()[0];
    if(!track || track.readyState !== 'live') {
      stopScreenCapture();
      return;
    }

    const video = document.createElement('video');
    video.srcObject = screenStream;
    video.muted = true;
    await video.play();

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = canvas.toDataURL('image/jpeg', 0.65);
    saveScreenCapture(imageData);
    await sendScreenCaptureToServer(imageData);
  } catch(err){
    console.warn('Periodic screen snapshot failed:', err);
  }
}

async function captureScreenOnce(){
  await startContinuousScreenCapture();
}

async function sendScreenCaptureToServer(imageData){
  try {
    const sessionId = getSessionId();
    const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
    if(sessionId && token){
      await fetch('/api/sessions/' + sessionId + '/screen-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ image: imageData })
      });
    }
  } catch(err){
    console.warn('Failed to send screen capture to server:', err);
  }
}

function saveScreenCapture(imageData){
  if(!examData) return;
  const storageKey = 'wamsScreenCaptures_' + examData.id;
  try {
    const existing = JSON.parse(localStorage.getItem(storageKey) || '[]');
    existing.push({
      time: new Date().toISOString(),
      image: imageData
    });
    localStorage.setItem(storageKey, JSON.stringify(existing));
  } catch {}
}

function stopScreenCapture(){
  if(screenStream){
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  if(screenInterval){
    clearInterval(screenInterval);
    screenInterval = null;
  }
  const screenBtn = document.getElementById('screenBtn');
  if(screenBtn) screenBtn.classList.remove('active');
  const banner = document.getElementById('screenShareBanner');
  if(banner && screenEnabled) banner.style.display = 'flex';
}

function addScreenCaptureButton(){
  const toolsRail = document.querySelector('.tools-rail');
  if(!toolsRail) return;

  // Check if button already exists
  if(document.getElementById('screenBtn')) return;

  // Add divider if needed
  if (!toolsRail.querySelector('.tool-divider')) {
    const sep = document.createElement('div');
    sep.className = 'tool-divider';
    toolsRail.appendChild(sep);
  }

  // Add screen capture button
  const div = document.createElement('div');
  div.className = 'tool-btn';
  div.id = 'screenBtn';
  div.onclick = function(){
    captureScreenOnce();
  };
  div.innerHTML = `
    <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
    <span class="tool-label">Screen</span>
  `;
  toolsRail.appendChild(div);
}

/* ─── End Screen Capture Detection ─── */

/* ═══════════════ AUDIO CAPTURE DETECTION ═══════════════ */
let audioStream = null;
let audioInterval = null;
let audioEnabled = false;
let audioContext = null;
let audioAnalyzer = null;
let audioCheckCounter = 0;
let mediaRecorder = null;
let recordedAudioChunks = [];
let currentAudioClip = null;

function startAudioRecording(stream) {
  if (!window.MediaRecorder) return;
  try {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : (MediaRecorder.isTypeSupported('audio/ogg') ? 'audio/ogg' : ''));

    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recordedAudioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedAudioChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      if (recordedAudioChunks.length > 0) {
        const audioBlob = new Blob(recordedAudioChunks, { type: mimeType || 'audio/webm' });
        recordedAudioChunks = [];
        const reader = new FileReader();
        reader.onloadend = () => {
          currentAudioClip = reader.result;
        };
        reader.readAsDataURL(audioBlob);
      }
      if (audioEnabled && audioStream && audioStream.active) {
        setTimeout(() => {
          try {
            if (mediaRecorder && mediaRecorder.state === 'inactive') {
              mediaRecorder.start();
              setTimeout(() => {
                if (mediaRecorder && mediaRecorder.state === 'recording') {
                  mediaRecorder.stop();
                }
              }, 4000);
            }
          } catch(e) {}
        }, 1000);
      }
    };

    mediaRecorder.start();
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, 4000);
  } catch(e) {
    console.warn('MediaRecorder error:', e);
  }
}

async function initAudioCapture(){
  if(!examData) return;

  // Support both monitor and monitor_settings naming
  let monitor = examData.monitor || examData.monitor_settings || {};
  if(typeof monitor === 'string') {
    try { monitor = JSON.parse(monitor); } catch(e) { monitor = {}; }
  }

  if(monitor.audio === false){
    const audioBtn = document.getElementById('audioBtn');
    if(audioBtn) audioBtn.style.display = 'none';
    return;
  }

  // Reuse the shared combined permission request (one popup total)
  await ensureMediaStreams();

  if (audioStream) {
    audioEnabled = true;
    startAudioRecording(audioStream);

    // Set up audio analysis for anomaly detection
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if(AudioContextClass){
      audioContext = new AudioContextClass();
      audioAnalyzer = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(audioStream);
      source.connect(audioAnalyzer);
      audioAnalyzer.fftSize = 256;

      // Check audio levels periodically
      if(audioInterval) clearInterval(audioInterval);
      audioInterval = setInterval(checkAudioLevels, AUDIO_CHECK_INTERVAL);

      // Take initial audio sample after 2 seconds
      setTimeout(checkAudioLevels, 2000);
    }
  } else {
    console.warn('Audio access denied');
    showHint('Microphone access required for exam monitoring.');
  }
}

function detectMultipleVoices(dataArray) {
  // Voice spectrum analysis (approx 100 Hz to 3400 Hz)
  let voiceEnergy = 0;
  let formantPeaks = 0;
  let prevVal = 0;
  let voiceBinsActive = 0;

  for (let i = 1; i < Math.min(22, dataArray.length); i++) {
    const val = dataArray[i];
    if (val > 28) {
      voiceEnergy += val;
      voiceBinsActive++;
    }
    // Peak detection (local maxima in voice spectrum)
    if (i > 1 && val > 42 && val > prevVal && val > (dataArray[i+1] || 0)) {
      formantPeaks++;
    }
    prevVal = val;
  }

  const avgVoiceEnergy = voiceBinsActive > 0 ? voiceEnergy / voiceBinsActive : 0;

  // Multiple voices condition:
  // 1. Elevated vocal energy (> 35)
  // 2. Wide spectral energy spread across speech bins
  // 3. Multiple simultaneous harmonic formant peaks (>= 2)
  const isMultipleVoices = avgVoiceEnergy > 35 && voiceBinsActive >= 5 && formantPeaks >= 2;

  return {
    isMultipleVoices,
    average: Math.round(avgVoiceEnergy),
    formantPeaks
  };
}

async function checkAudioLevels(){
  if(!audioEnabled || !audioAnalyzer) return;

  const dataArray = new Uint8Array(audioAnalyzer.frequencyBinCount);
  audioAnalyzer.getByteFrequencyData(dataArray);

  const voiceAnalysis = detectMultipleVoices(dataArray);

  // ONLY record and send audio captures when multiple voices are detected!
  if(voiceAnalysis.isMultipleVoices){
    showHint(`⚠️ Multiple voices detected! (${voiceAnalysis.formantPeaks} voices)`);
    recordAudioAnomaly(voiceAnalysis.average, true);
  }
}

function recordAudioAnomaly(level, isFlagged = true){
  if(!examData) return;
  const storageKey = 'wamsAudioCaptures_' + examData.id;
  try {
    const existing = JSON.parse(localStorage.getItem(storageKey) || '[]');
    existing.push({
      time: new Date().toISOString(),
      level: level,
      flagged: isFlagged
    });
    localStorage.setItem(storageKey, JSON.stringify(existing));
  } catch {}

  // Send to server
  sendAudioAnomalyToServer(level, isFlagged);
}

async function sendAudioAnomalyToServer(level, isFlagged = true){
  try {
    const sessionId = getSessionId();
    const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
    if(sessionId && token){
      await fetch('/api/sessions/' + sessionId + '/audio-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          audio_data: JSON.stringify({ level: level, flagged: isFlagged }),
          audio_clip: currentAudioClip || null,
          level: level,
          flagged: isFlagged
        })
      });
    }
  } catch(err){
    console.warn('Failed to send audio anomaly to server:', err);
  }
}

function stopAudioCapture(){
  if(audioStream){
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }
  if(audioInterval){
    clearInterval(audioInterval);
    audioInterval = null;
  }
  if(audioContext){
    audioContext.close();
    audioContext = null;
  }
  audioEnabled = false;
}

/* ─── End Audio Capture Detection ─── */


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

    TOTAL_EXAM_SECONDS = examData.timeLimit
        ? parseInt(examData.timeLimit) * 60
        : DEFAULT_EXAM_SECONDS;

    secondsLeft = TOTAL_EXAM_SECONDS;

    restoreTimerState();
    saveTimerState();

    const title = document.querySelector(".exam-top-title");
    if (title) {
        title.textContent = examData.title || "Exam";
    }

    examTimerInterval = setInterval(updateTimer, 1000);

    buildQGrid();
    renderQuestion();

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

    setTimeout(initCamera, 1000);
    setTimeout(initAudioCapture, 1000);

    // Add screen capture button to tools rail if needed
    addScreenCaptureButton();

    // Delay screen capture initialization to ensure page is fully loaded
    setTimeout(initScreenCapture, 2000);
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
  reportQuestionActivity('answered', currentQ + 1);
  renderQuestion();
}
function toggleCB(i){
  if(!answers[currentQ]) answers[currentQ] = [];
  const arr = answers[currentQ];
  const pos = arr.indexOf(i);
  if(pos === -1) arr.push(i); else arr.splice(pos, 1);
  if(arr.length === 0) delete answers[currentQ];
  reportQuestionActivity('answered', currentQ + 1);
  renderQuestion();
}
function setText(val){
  if(val.trim()==='') delete answers[currentQ];
  else {
    answers[currentQ]=val;
    reportQuestionActivity('answered', currentQ + 1);
  }
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

  reportQuestionActivity('answered', currentQ + 1);
  renderQuestion();
}

// Auto-init the exam when page loads
initExam();
