/* ═══════════════════════════════════════════════════════════════
   WAMS Shared Proctoring Module
   Used by BOTH exam tools (WAMS Quiz + Google Forms) so the
   detection features stay identical and are maintained in one place.

   Host page contract (must be defined by the including page):
     - let examData        → loaded exam object (set before monitoring starts)
     - showHint(msg)       → transient on-page hint helper
   ═══════════════════════════════════════════════════════════════ */

/* ─── Configurable Constants ─── */
const PROCTOR_CAMERA_SNAPSHOT_INTERVAL = 30000;
const PROCTOR_AUDIO_CHECK_INTERVAL = 5000;
const PROCTOR_SCREEN_SNAPSHOT_INTERVAL = 30000;

/* ─── Capture budget ───
   Each session stores at most MAX_CAPTURES_PER_SESSION captures per type
   (camera / screen / audio). The server enforces this too — when it replies
   { limited: true } we stop sending that capture type for the session so
   Turso doesn't accumulate heavy base64 payloads. */
const MAX_CAPTURES_PER_SESSION = 10;

function getCaptureCounterKey(type){
  const sessionId = getSessionId();
  return 'wamsCaptureCount_' + type + '_' + sessionId;
}

function getCaptureCount(type){
  try {
    return parseInt(sessionStorage.getItem(getCaptureCounterKey(type)) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function incrementCaptureCount(type){
  try {
    sessionStorage.setItem(getCaptureCounterKey(type), String(getCaptureCount(type) + 1));
  } catch {}
}

function isCaptureBudgetExhausted(type){
  return getCaptureCount(type) >= MAX_CAPTURES_PER_SESSION;
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
    window._wamsPermissionPending = true;
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
        window._wamsPermissionPending = false;
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
    cameraInterval = setInterval(takeCameraSnapshot, PROCTOR_CAMERA_SNAPSHOT_INTERVAL);

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

  // Respect the per-session capture budget so Turso stays light
  if(isCaptureBudgetExhausted('camera')) return;

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
  const flagged = multipleFaces || noFace;

  // Draw AI facial feature hitboxes when multiple faces are present
  if(multipleFaces){
    drawAiFacialHitboxes(ctx, faceInfo, true);
    showHint(`⚠️ Multiple faces detected! (${faceInfo.faceCount} faces)`);
  } else if(noFace && Math.random() < 0.2){
    showHint('No face detected in front of camera');
  }

  // Upload every snapshot on the periodic cadence so the Live Monitor has
  // fresh camera captures for normal single-student sessions too.
  try {
    const sessionId = getSessionId();
    const token = getAuthToken();
    if(sessionId && token){
      const res = await fetch('/api/camera/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          session_id: sessionId,
          image: canvas.toDataURL('image/jpeg', 0.75),
          face_count: faceInfo.faceCount,
          skin_pixels: faceInfo.skinPixels,
          flagged
        })
      });
      if(res.ok){
        const data = await res.json().catch(() => ({}));
        if(data && data.limited){
          // Server says the budget is spent — stop further camera uploads
          incrementCaptureCount('camera');
        } else {
          incrementCaptureCount('camera');
        }
      }
    }
  } catch(err){
    console.warn('Failed to send camera snapshot:', err);
  }
}

function getSessionId() {
  const examId = examData ? examData.id : new URLSearchParams(window.location.search).get('examId');
  if (!examId) return null;

  const isValidSessionId = value => /^\d+$/.test(String(value || '')) && Number(value) > 0;
  const sessionKey = 'wamsSession_' + examId;
  const storedExam = (() => {
    try { return JSON.parse(localStorage.getItem('wamsExamData') || 'null'); }
    catch { return null; }
  })();
  const activeSession = localStorage.getItem('examSessionId') || localStorage.getItem('wamsSessionId');

  if (storedExam && String(storedExam.id) === String(examId) && isValidSessionId(activeSession)) {
    localStorage.setItem(sessionKey, activeSession);
    return activeSession;
  }

  const scopedSession = localStorage.getItem(sessionKey);
  return isValidSessionId(scopedSession) ? scopedSession : null;
}

function getAuthToken() {
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
      audioInterval = setInterval(checkAudioLevels, PROCTOR_AUDIO_CHECK_INTERVAL);

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
    const token = getAuthToken();
    if(sessionId && token){
      // Respect the per-session audio capture budget
      if(isCaptureBudgetExhausted('audio')) return;
      const res = await fetch('/api/sessions/' + sessionId + '/audio-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
          audio_data: JSON.stringify({ level: level, flagged: isFlagged }),
          audio_clip: currentAudioClip || null,
          level: level,
          flagged: isFlagged
        })
      });
      if(res.ok){
        const data = await res.json().catch(() => ({}));
        if(!(data && data.limited)){
          incrementCaptureCount('audio');
        }
      }
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

/* ─── End Audio Capture Detection ─── */


/* ═══════════════ SCREEN CAPTURE DETECTION ═══════════════ */
let screenStream = null;
let screenInterval = null;
let screenEnabled = false;

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

    // Track when the browser's screen-share picker is open so tab-switch
    // detection doesn't flag the focus change it causes
    window._wamsScreenPickerOpen = true;
    let pickerStream;
    try {
      pickerStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'never', width: 1280, height: 720 }
      });
    } finally {
      window._wamsScreenPickerOpen = false;
    }
    screenStream = pickerStream;

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
    screenInterval = setInterval(takeScreenSnapshot, PROCTOR_SCREEN_SNAPSHOT_INTERVAL);

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
  // Respect the per-session screen capture budget
  if(isCaptureBudgetExhausted('screen')) return;
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
      // Respect the per-session screen capture budget
      if(isCaptureBudgetExhausted('screen')) return;
      const res = await fetch('/api/sessions/' + sessionId + '/screen-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ image: imageData })
      });
      if(res.ok){
        const data = await res.json().catch(() => ({}));
        if(!(data && data.limited)){
          incrementCaptureCount('screen');
        }
      }
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

/* ═══════════════ TAB SWITCH DETECTION ═══════════════ */
let tabSwitchCount = 0;
let tabSwitchLog = [];

/* ── Guidelines: ignore switches caused by exam setup ──
   Permission popups (camera/mic) and the screen-share picker legitimately
   move focus away from the tab, and students need a moment when the exam
   starts. Detection therefore only counts after a short grace period and
   never while a browser dialog is open. */
const TAB_SWITCH_GRACE_MS = 15000;
const tabSwitchArmedAt = Date.now();

function isExamSetupInProgress(){
  if(Date.now() - tabSwitchArmedAt < TAB_SWITCH_GRACE_MS) return true;
  return !!(window._wamsPermissionPending || window._wamsScreenPickerOpen);
}

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
    const exams = JSON.parse(localStorage.getItem('wamsProfessorExams') || '[]');
    const idx = exams.findIndex(e => String(e.id) === String(examData.id));
    if(idx !== -1){
      exams[idx].flagged = tabSwitchCount;
      localStorage.setItem('wamsProfessorExams', JSON.stringify(exams));
    }
  } catch {}
}

function recordTabSwitch(){
  if (window._wamsExamSubmitted) return;

  let monitor = examData ? (examData.monitor || examData.monitor_settings || {}) : {};
  if (typeof monitor === 'string') { try { monitor = JSON.parse(monitor); } catch(e) { monitor = {}; } }
  if (monitor.tab === false) return;

  // Don't flag switches caused by exam setup (permission prompts,
  // screen-share picker) or the initial startup grace period
  if (isExamSetupInProgress()) return;

  loadTabSwitchData();
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
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      keepalive: true
    }).then(res => {
      if (!res.ok) console.warn('Tab switch reporting failed with status:', res.status);
    }).catch(err => console.warn('Tab switch reporting failed:', err));
  } else {
    console.warn('Tab switch was detected, but no valid exam session or auth token was available.');
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