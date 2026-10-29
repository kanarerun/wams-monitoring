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

/* ─── Capture budget ───
   Each session stores at most MAX_CAPTURES_PER_SESSION captures per type
   (camera / screen / audio). The server enforces this too — when it replies
   { limited: true } we stop sending that capture type for the session so
   Turso doesn't accumulate heavy base64 payloads. */
const MAX_CAPTURES_PER_SESSION = 5;

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
let objectDetector = null;
let objectDetectorPromise = null;
let objectDetectorUnavailable = false;
const OBJECT_DETECTOR_VERSION = '0.10.14';
const OBJECT_DETECTOR_MODEL_URL = 'https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite';

async function loadObjectDetector(){
  if(objectDetector) return objectDetector;
  if(objectDetectorUnavailable) return null;
  if(!objectDetectorPromise){
    objectDetectorPromise = (async () => {
      const visionUrl = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${OBJECT_DETECTOR_VERSION}/vision_bundle.mjs`;
      const wasmUrl = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${OBJECT_DETECTOR_VERSION}/wasm`;
      const vision = await import(visionUrl);
      const visionFiles = await vision.FilesetResolver.forVisionTasks(wasmUrl);
      objectDetector = await vision.ObjectDetector.createFromOptions(visionFiles, {
        baseOptions: { modelAssetPath: OBJECT_DETECTOR_MODEL_URL },
        runningMode: 'VIDEO',
        scoreThreshold: 0.45,
        maxResults: 10
      });
      return objectDetector;
    })().catch(error => {
      objectDetectorUnavailable = true;
      console.warn('Object detection is unavailable:', error);
      return null;
    }).finally(() => {
      objectDetectorPromise = null;
    });
  }
  return objectDetectorPromise;
}

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

let pendingMediaConsentCallback = null;

function showExamMediaConsent(onAllowed){
  const prefs = getMonitorPrefs();
  const needsCamera = prefs.cam !== false && prefs.camera !== false;
  const needsMicrophone = prefs.audio !== false;
  const needsScreen = prefs.screen !== false;

  const dialog = document.getElementById('mediaConsentDialog');
  const agreement = document.getElementById('mediaConsentAgreement');
  const privacyAgreement = document.getElementById('privacyNoticeAgreement');
  const requestButton = document.getElementById('mediaConsentRequest');
  const acceptButton = document.getElementById('mediaConsentAccept');
  const status = document.getElementById('mediaConsentStatus');
  if(!dialog || !agreement || !privacyAgreement || !requestButton || !acceptButton || !status){
    console.error('Exam media consent UI is unavailable.');
    return;
  }

  pendingMediaConsentCallback = onAllowed;
  privacyAgreement.checked = false;
  agreement.checked = false;
  agreement.disabled = !needsCamera && !needsMicrophone && !needsScreen;
  acceptButton.disabled = true;
  acceptButton.textContent = 'Agree and continue';
  status.hidden = true;
  status.textContent = '';
  document.getElementById('cameraConsentDetail').hidden = !needsCamera;
  document.getElementById('microphoneConsentDetail').hidden = !needsMicrophone;
  document.getElementById('screenConsentDetail').hidden = !needsScreen;
  // The device-status rows only exist for camera/microphone; screen sharing is
  // prompted by the browser at "Agree and continue", so it has no row.
  const cameraRow = document.getElementById('cameraPermissionRow');
  const microphoneRow = document.getElementById('microphonePermissionRow');
  if (cameraRow) cameraRow.hidden = !needsCamera;
  if (microphoneRow) microphoneRow.hidden = !needsMicrophone;
  document.querySelector('.media-consent-screen-note').hidden = !needsCamera && !needsMicrophone && !needsScreen;
  agreement.closest('.media-consent-agreement').hidden = !needsCamera && !needsMicrophone && !needsScreen;
  requestButton.disabled = !needsCamera && !needsMicrophone;
  requestButton.hidden = !needsCamera && !needsMicrophone;
  requestButton.textContent = needsCamera && needsMicrophone ? 'Enable camera and microphone' : `Enable ${needsCamera ? 'camera' : 'microphone'}`;
  updateMediaConsentDeviceState('camera', needsCamera, cameraStream);
  updateMediaConsentDeviceState('microphone', needsMicrophone, audioStream);
  const updateAcceptState = () => {
    const mediaReady = agreement.checked && areRequiredMediaStreamsActive();
    const mediaAcknowledged = !needsCamera && !needsMicrophone || mediaReady;
    acceptButton.disabled = !privacyAgreement.checked || !mediaAcknowledged;
  };
  agreement.onchange = updateAcceptState;
  privacyAgreement.onchange = updateAcceptState;
  dialog.oncancel = event => event.preventDefault();
  dialog.showModal();
  if(requestButton.hidden) privacyAgreement.focus();
  else requestButton.focus();
}

/* Screen sharing lives in wams-screen-tabswitch.js, which loads after this file. */
function currentScreenStream(){
  try { return (typeof screenStream !== 'undefined') ? screenStream : null; } catch { return null; }
}

function updateMediaConsentDeviceState(device, required, stream){
  const row = document.getElementById(`${device}PermissionRow`);
  const label = document.getElementById(`${device}PermissionState`);
  if(!row || !label) return;

  const ready = required && stream && stream.active && stream.getTracks().some(track => track.readyState === 'live');
  row.dataset.state = !required ? 'not-required' : ready ? 'ready' : 'waiting';
  label.textContent = !required ? 'Not required' : ready ? 'Ready' : 'Waiting';
}

function areRequiredMediaStreamsActive(){
  const prefs = getMonitorPrefs();
  const needsCamera = prefs.cam !== false && prefs.camera !== false;
  const needsMicrophone = prefs.audio !== false;
  const cameraReady = !needsCamera || (cameraStream && cameraStream.active && cameraStream.getTracks().some(track => track.readyState === 'live'));
  const microphoneReady = !needsMicrophone || (audioStream && audioStream.active && audioStream.getTracks().some(track => track.readyState === 'live'));
  return cameraReady && microphoneReady;
}

async function requestExamMediaAccess(){
  const dialog = document.getElementById('mediaConsentDialog');
  const agreement = document.getElementById('mediaConsentAgreement');
  const requestButton = document.getElementById('mediaConsentRequest');
  const acceptButton = document.getElementById('mediaConsentAccept');
  const status = document.getElementById('mediaConsentStatus');
  if(!dialog || !agreement || !requestButton || !acceptButton || !status) return;

  const prefs = getMonitorPrefs();
  const needsCamera = prefs.cam !== false && prefs.camera !== false;
  const needsMicrophone = prefs.audio !== false;
  const needsScreen = prefs.screen !== false;
  requestButton.disabled = true;
  requestButton.textContent = 'Waiting for browser permission...';
  status.hidden = true;

  try {
    await ensureMediaStreams();
  } catch(error) {
    console.warn('Unable to request exam media access:', error);
  }

  const missingDevices = [];
  if(needsCamera && !(cameraStream && cameraStream.active)) missingDevices.push('camera');
  if(needsMicrophone && !(audioStream && audioStream.active)) missingDevices.push('microphone');
  updateMediaConsentDeviceState('camera', needsCamera, cameraStream);
  updateMediaConsentDeviceState('microphone', needsMicrophone, audioStream);
  if(missingDevices.length){
    const deviceLabel = missingDevices.length === 2 ? 'camera and microphone' : missingDevices[0];
    const connectionCheck = missingDevices.length === 2 ? 'both devices are connected' : 'it is connected';
    status.textContent = `Your browser did not provide access to the ${deviceLabel}. Check that ${connectionCheck} and allowed for this site in your browser's site permissions, then choose Retry access. The exam timer has not started.`;
    status.hidden = false;
    requestButton.disabled = false;
    requestButton.textContent = `Retry ${deviceLabel} access`;
    return;
  }

  agreement.disabled = false;
  const privacyAgreement = document.getElementById('privacyNoticeAgreement');
  acceptButton.disabled = !agreement.checked || !privacyAgreement.checked;
  requestButton.textContent = 'Required devices ready';
}

async function acceptExamMediaConsent(){
  const dialog = document.getElementById('mediaConsentDialog');
  const agreement = document.getElementById('mediaConsentAgreement');
  const privacyAgreement = document.getElementById('privacyNoticeAgreement');
  const requestButton = document.getElementById('mediaConsentRequest');
  const acceptButton = document.getElementById('mediaConsentAccept');
  const status = document.getElementById('mediaConsentStatus');
  if(!dialog || !agreement || !privacyAgreement?.checked || !requestButton || !acceptButton || !status) return;
  const prefs = getMonitorPrefs();
  const mediaRequired = prefs.cam !== false && prefs.camera !== false || prefs.audio !== false;
  if(mediaRequired && !agreement.checked) return;

  if(!areRequiredMediaStreamsActive()){
    const needsCamera = prefs.cam !== false && prefs.camera !== false;
    const needsMicrophone = prefs.audio !== false;
    updateMediaConsentDeviceState('camera', needsCamera, cameraStream);
    updateMediaConsentDeviceState('microphone', needsMicrophone, audioStream);
    agreement.checked = false;
    agreement.disabled = true;
    acceptButton.disabled = true;
    requestButton.disabled = false;
    requestButton.textContent = 'Reconnect required devices';
    status.textContent = 'Device access changed before agreement. Re-enable the required devices to continue.';
    status.hidden = false;
    return;
  }

  const onAllowed = pendingMediaConsentCallback;
  pendingMediaConsentCallback = null;
  dialog.close();

  // Prompt for screen share while we still have the user gesture from the
  // "Agree and continue" click. The share itself lives in
  // wams-screen-tabswitch.js; nothing is captured here — the first snapshot is
  // taken when a tab switch is detected.
  const needsScreen = prefs.screen !== false;
  if(needsScreen && typeof startContinuousScreenCapture === 'function' && !window._wamsScreenPickerOpen){
    try {
      await startContinuousScreenCapture();
    } catch(err) {
      console.warn('Screen share not activated:', err);
    }
    updateMediaConsentDeviceState('screen', true, currentScreenStream());
  }

  if(onAllowed) onAllowed();
}

function declineExamMediaConsent(){
  pendingMediaConsentCallback = null;
  stopCamera();
  stopAudioCapture();
  if(typeof stopScreenCapture === 'function') stopScreenCapture();
  window.location.href = 'wams-student-log-in.html';
}

/* ─── Tab-switch log (shared state the exam tools call on startup) ───
   Screen sharing and tab-switch capture themselves live in
   wams-screen-tabswitch.js. */
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
    loadObjectDetector();

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

    const headTurned = faces.some(face => {
      if(!face.landmarks || face.landmarks.length < 48) return false;
      const eyeCenter = indices => indices.reduce((sum, index) => sum + face.landmarks[index].x, 0) / indices.length;
      const leftEyeCenter = eyeCenter([36, 37, 38, 39, 40, 41]);
      const rightEyeCenter = eyeCenter([42, 43, 44, 45, 46, 47]);
      const eyeDistance = Math.abs(rightEyeCenter - leftEyeCenter);
      if(eyeDistance < 1) return false;
      const eyeMidpoint = (leftEyeCenter + rightEyeCenter) / 2;
      const noseOffset = Math.abs(face.landmarks[30].x - eyeMidpoint) / eyeDistance;
      face.headTurnRatio = Number(noseOffset.toFixed(3));
      return noseOffset > 0.2;
    });
    return { faceCount: faces.length, faces, skinPixels: 0, aiModel: true, headTurned };
  } catch(err){
    console.warn('AI face detection failed, falling back to heuristic:', err);
    return detectFacesHeuristic(video, canvas, ctx);
  }
}

async function detectObjects(video){
  const detector = await loadObjectDetector();
  if(!detector) return { available: false, detections: [], phoneDetected: false };

  try {
    const result = detector.detectForVideo(video, performance.now());
    const detections = (result.detections || []).flatMap(detection => {
      const category = detection.categories && detection.categories[0];
      const box = detection.boundingBox;
      if(!category || !box) return [];
      return [{
        label: category.categoryName,
        score: Number(category.score.toFixed(3)),
        box: {
          x: box.originX,
          y: box.originY,
          width: box.width,
          height: box.height
        }
      }];
    });
    return {
      available: true,
      detections,
      phoneDetected: detections.some(detection => detection.label.toLowerCase() === 'cell phone')
    };
  } catch(error) {
    console.warn('Object detection failed for camera capture:', error);
    return { available: false, detections: [], phoneDetected: false };
  }
}

function drawObjectDetectionBoxes(ctx, objectInfo, video){
  if(!objectInfo.available) return;
  const scaleX = ctx.canvas.width / Math.max(1, video.videoWidth);
  const scaleY = ctx.canvas.height / Math.max(1, video.videoHeight);
  for(const detection of objectInfo.detections){
    const box = detection.box;
    const x = box.x * scaleX;
    const y = box.y * scaleY;
    const width = box.width * scaleX;
    const height = box.height * scaleY;
    const isPhone = detection.label.toLowerCase() === 'cell phone';
    ctx.strokeStyle = isPhone ? '#DC2626' : '#38BDF8';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, width, height);
    if(isPhone){
      ctx.fillStyle = '#DC2626';
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.fillText(`PHONE ${Math.round(detection.score * 100)}%`, x, Math.max(12, y - 4));
    }
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
  const objectInfo = await detectObjects(video);

  // Draw current frame
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  drawObjectDetectionBoxes(ctx, objectInfo, video);

  const multipleFaces = faceInfo.faceCount > 1;
  const noFace = faceInfo.faceCount === 0;
  const headTurned = Boolean(faceInfo.headTurned);
  const flagged = multipleFaces || noFace || headTurned || objectInfo.phoneDetected;

  // Draw AI facial feature hitboxes when multiple faces are present. Detection
  // stays silent on purpose: no on-screen notice is shown to the student, the
  // capture is recorded and reviewed by the professor instead.
  if(multipleFaces){
    drawAiFacialHitboxes(ctx, faceInfo, true);
  }

  const detectionData = {
    face_detector: faceInfo.aiModel ? 'face-api.js TinyFaceDetector' : 'skin-region fallback',
    face_count: faceInfo.faceCount,
    head_turn_detected: headTurned,
    head_turn_ratios: (faceInfo.faces || []).map(face => face.headTurnRatio).filter(Number.isFinite),
    object_detector: objectInfo.available ? 'MediaPipe EfficientDet-Lite0' : 'unavailable',
    detections: objectInfo.detections,
    phone_detected: objectInfo.phoneDetected,
    flagged_reasons: [
      ...(noFace ? ['no_face'] : []),
      ...(multipleFaces ? ['multiple_faces'] : []),
      ...(headTurned ? ['possible_head_turn'] : []),
      ...(objectInfo.phoneDetected ? ['possible_phone'] : [])
    ]
  };

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
          flagged,
          detection_data: detectionData
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
let audioActivitySamples = 0;
let lastAudioActivityAt = 0;
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

function measureAudioLevelDbfs(analyzer){
  const samples = new Float32Array(analyzer.fftSize);
  analyzer.getFloatTimeDomainData(samples);
  const sumSquares = samples.reduce((sum, sample) => sum + sample * sample, 0);
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

async function checkAudioLevels(){
  if(!audioEnabled || !audioAnalyzer) return;

  const levelDbfs = measureAudioLevelDbfs(audioAnalyzer);
  audioActivitySamples = levelDbfs >= -36 ? audioActivitySamples + 1 : 0;
  if(audioActivitySamples < 2 || Date.now() - lastAudioActivityAt < 15000) return;

  lastAudioActivityAt = Date.now();
  audioActivitySamples = 0;
  recordAudioAnomaly(levelDbfs, true);
}

function recordAudioAnomaly(levelDbfs, isFlagged = true){
  if(!examData) return;
  const storageKey = 'wamsAudioCaptures_' + examData.id;
  try {
    const existing = JSON.parse(localStorage.getItem(storageKey) || '[]');
    existing.push({
      time: new Date().toISOString(),
      levelDbfs,
      flagged: isFlagged
    });
    localStorage.setItem(storageKey, JSON.stringify(existing));
  } catch {}

  // Send to server
  sendAudioAnomalyToServer(levelDbfs, isFlagged);
}

async function sendAudioAnomalyToServer(levelDbfs, isFlagged = true){
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
          audio_data: JSON.stringify({
            level_dbfs: Number.isFinite(levelDbfs) ? levelDbfs : null,
            event: 'possible_audio_activity',
            flagged: isFlagged
          }),
          audio_clip: currentAudioClip || null,
          flagged: isFlagged
        })
      });
      if(res.ok){
        const data = await res.json().catch(() => ({}));
        if(!(data && data.limited)){
          incrementCaptureCount('audio');
          currentAudioClip = null;
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
/* Screen sharing + tab-switch monitoring moved to wams-screen-tabswitch.js,
   which is loaded after the exam tool script. */

// This module is loaded before wams-screen-tabswitch.js, so only touch helpers
// that exist at this point. Guarding with typeof prevents the ReferenceError
// that used to abort the rest of the exam page's scripts.
