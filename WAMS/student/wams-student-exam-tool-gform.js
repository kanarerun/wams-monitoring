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

/* ─── Load exam from localStorage ─── */
function loadExamFromId(){
  try {
    const examId = new URLSearchParams(window.location.search).get('examId');
    if(!examId) return null;

    const sessionExamStr = localStorage.getItem('wamsExamData');
    if(sessionExamStr){
      const sessionExam = JSON.parse(sessionExamStr);
      if(String(sessionExam.id) === String(examId)){
        return sessionExam;
      }
    }

    const exams = JSON.parse(localStorage.getItem('wamsProfessorExams') || '[]');
    return exams.find(item => String(item.id) === String(examId)) || null;
  } catch {
    return null;
  }
}

const examData = loadExamFromId();

/* ─── Determine total seconds from exam data ─── */
const TOTAL_EXAM_SECONDS = (examData && examData.timeLimit) ? (parseInt(examData.timeLimit) * 60) : 3600;
let secondsLeft = TOTAL_EXAM_SECONDS;
let examTimerInterval = null;
let examSubmitted = false;

/* ─── Persistent Timer ─── */
const TIMER_STORAGE_KEY = 'wamsGformTimerState';

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
  // Redirect wams-quiz type exams to the proper tool page
  const examId = new URLSearchParams(window.location.search).get('examId');
  if(examId){
    try {
      const exam = examData && String(examData.id) === String(examId)
        ? examData
        : JSON.parse(localStorage.getItem('wamsProfessorExams') || '[]').find(item => String(item.id) === String(examId));
      if(exam && exam.type === 'wams-quiz'){
        const correctUrl = new URL('wams-student-exam-tool.html', window.location.href);
        correctUrl.searchParams.set('examId', examId);
        window.location.href = correctUrl.toString();
        return;
      }
    } catch {}
  }

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

/* ═══════════════ CAMERA MONITORING ═══════════════ */
let cameraStream = null;
let cameraInterval = null;
let cameraEnabled = false;

async function initCamera(){
  if(!examData) return;
  let monitor = examData.monitor || examData.monitor_settings || {};
  if(typeof monitor === 'string') { try { monitor = JSON.parse(monitor); } catch(e) { monitor = {}; } }
  let tools = examData.tools || examData.tools_settings || {};
  if(typeof tools === 'string') { try { tools = JSON.parse(tools); } catch(e) { tools = {}; } }

  const isCameraDisabled = monitor.cam === false || monitor.camera === false;
  if (tools.camera === false) {
    const camBtn = document.getElementById('camBtn');
    if (camBtn) camBtn.style.display = 'none';
  }
  if (isCameraDisabled) {
    return;
  }

  const video = document.getElementById('camVideo');
  if(!video) return;

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' },
      audio: false
    });
    video.srcObject = cameraStream;
    cameraEnabled = true;

    // Take snapshot every 30 seconds
    if(cameraInterval) clearInterval(cameraInterval);
    cameraInterval = setInterval(takeCameraSnapshot, 30000);

    // Take initial snapshot after 2 seconds
    setTimeout(takeCameraSnapshot, 2000);
  } catch(err){
    console.warn('Camera access denied:', err);
    showHint('Camera access required for exam monitoring.');
  }
}

async function detectFaces(video, canvas, ctx){
  const w = canvas.width, h = canvas.height;
  ctx.drawImage(video, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const px = imgData.data;
  const skinMap = new Uint8Array(w * h);
  let skinCount = 0;

  for(let i = 0; i < px.length; i += 4){
    const r = px[i], g = px[i+1], b = px[i+2];
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

        const blobW = (maxX - minX + 1) * step;
        const blobH = (maxY - minY + 1) * step;
        const aspectRatio = blobH / Math.max(1, blobW);

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
  try { faceInfo = await detectFaces(video, canvas, ctx); } catch(e) { console.warn('Face detection failed:', e); }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const multipleFaces = faceInfo.faceCount > 1;

  // ONLY capture & upload when multiple faces are detected
  if(multipleFaces){
    drawAiFacialHitboxes(ctx, faceInfo, true);

    const imageData = canvas.toDataURL('image/jpeg', 0.75);
    showHint(`⚠️ Multiple faces detected! (${faceInfo.faceCount} faces)`);

    try {
      const sessionId = getSessionId();
      const token = getAuthToken();
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
  }
}

function getSessionId(){
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

function getAuthToken(){
  return localStorage.getItem('token') || localStorage.getItem('wamsToken');
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

/* ═══════════════ AUDIO CAPTURE MONITORING ═══════════════ */
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

  // Read monitor settings
  let monitor = examData.monitor || examData.monitor_settings || {};
  if(typeof monitor === 'string') {
    try { monitor = JSON.parse(monitor); } catch(e) { monitor = {}; }
  }

  if(monitor.audio === false){
    const audioBtn = document.getElementById('audioBtn');
    if(audioBtn) audioBtn.style.display = 'none';
    return;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
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
      audioInterval = setInterval(checkAudioLevels, 5000);

      // Take initial audio sample after 2 seconds
      setTimeout(checkAudioLevels, 2000);
    }
  } catch(err){
    console.warn('Audio access denied:', err);
    showHint('Microphone access required for exam monitoring.');
  }
}

function detectMultipleVoices(dataArray) {
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
    if (i > 1 && val > 42 && val > prevVal && val > (dataArray[i+1] || 0)) {
      formantPeaks++;
    }
    prevVal = val;
  }

  const avgVoiceEnergy = voiceBinsActive > 0 ? voiceEnergy / voiceBinsActive : 0;
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
    const token = getAuthToken();
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
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  audioEnabled = false;
}

/* ─── End Audio Capture Monitoring ─── */

/* ═══════════════ SCREEN CAPTURE MONITORING ═══════════════ */
let screenStream = null;
let screenInterval = null;
let screenEnabled = false;
const SCREEN_SNAPSHOT_INTERVAL = 30000;

async function initScreenCapture(){
  if(!examData) return;

  // Read monitor data
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
    const token = getAuthToken();
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

/* ─── End Screen Capture Monitoring ─── */

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
    const exams = JSON.parse(localStorage.getItem('wamsProfessorExams') || '[]');
    const idx = exams.findIndex(e => String(e.id) === String(examData.id));
    if(idx !== -1){
      exams[idx].flagged = tabSwitchCount;
      localStorage.setItem('wamsProfessorExams', JSON.stringify(exams));
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

// Clear tab switch data on fresh page load so each new session starts at zero
if(examData){
  localStorage.removeItem('wamsTabSwitch_' + examData.id);
  try {
    const exams = JSON.parse(localStorage.getItem('wamsProfessorExams') || '[]');
    const idx = exams.findIndex(e => String(e.id) === String(examData.id));
    if(idx !== -1){
      exams[idx].flagged = 0;
      localStorage.setItem('wamsProfessorExams', JSON.stringify(exams));
    }
  } catch {}
}

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

autoLoadExamForm();

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

restoreTimerState();
saveTimerState();
buildQGrid();
updateProgress();
updateStudentInfo();

// Initialize camera after a short delay
setTimeout(initCamera, 1000);
setTimeout(initAudioCapture, 1000);
setTimeout(initScreenCapture, 2000);

// Hide tools if disabled in exam settings
const tools = (examData && examData.tools) || {};
if(!tools.calculator){
  const calcBtn = document.getElementById('calcBtn');
  const calcWin = document.getElementById('calcWindow');
  if(calcBtn) calcBtn.style.display = 'none';
  if(calcWin) calcWin.style.display = 'none';
}
if(!tools.whiteboard){
  const sketchBtn = document.getElementById('sketchBtn');
  const sketchWin = document.getElementById('sketchWindow');
  if(sketchBtn) sketchBtn.style.display = 'none';
  if(sketchWin) sketchWin.style.display = 'none';
}
if(!tools.camera){
  const camBtn = document.getElementById('camBtn');
  const camWin = document.getElementById('camWindow');
  if(camBtn) camBtn.style.display = 'none';
  if(camWin) camWin.style.display = 'none';
}

examTimerInterval = setInterval(updateTimer, 1000);
