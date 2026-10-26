    /* ═══════
   WAMS — Screen sharing + tab-switch monitoring

   Two sibling features, deliberately kept apart:

   1) SCREEN SHARE  (initScreenCapture / startContinuousScreenCapture /
      stopScreenCapture / captureScreenOnce)
      Owns the getDisplayMedia stream and the yellow "share your screen"
      notifier. It NEVER takes a screenshot.

   2) TAB SWITCH  (detectTabSwitch → armAwayCapture → captureAwayOnce)
      The FIRST TAB_SWITCH_SCREEN_CAPTURE_LIMIT (5) detected switches each
      take one dedicated snapshot of the shared screen while the student is
      still away; every switch after that falls through to the regular        
      tab-switch recording only.

   Timeline for one tab switch:
      hidden  → detect the switch, record it on the server (keepalive,
                fires before the tab is throttled), show a "capturing"
                notifier on the tab the student switched to, and arm the
                off-tab capture pipeline (hidden <video> + paused canvas so
                drawImage() still works inside a throttled hidden tab)
      away    → captureAwayOnce() polls the live screen track and grabs the
                frame the moment the screen differs from the WAMS page, so
                the snapshot happens while the student is still away
      visible → nothing is captured here: the shared screen is the WAMS page
                again, so the switch is only closed out ("Tab switch recorded")

   The grab always comes from the shared screen stream, never from the exam
   page. To make that shot show the content the student opened, the share
   should be a whole screen (not just the exam tab) — see
   SCREEN_SHARE_CONSTRAINTS.

   Loaded AFTER wams-proctoring.js (uses examData, showHint, getSessionId,
   getAuthToken) and BEFORE the exam tool script (so the toolbar helpers the
   tool calls at startup already exist).
   ═══════ */

/* Server-reported count of tab-switch snapshots for this session. */
let screenCapturesTotal = 0;

/* ─── Constants ─── */
const TAB_SWITCH_SCREEN_CAPTURE_LIMIT = 5; // exactly this many snapshots per session
// Frames to wait for when pulling a frame through the live track.
const TAB_SWITCH_FRESH_FRAMES = 5;
const TAB_SWITCH_FRAME_WAIT_MAX_MS = 1200;   // hard cap on the frame wait
const TAB_SWITCH_FRAME_FALLBACK_MS = 250;    // used when the API is missing
// While-away capture loop. Hidden tabs clamp timers to ~1 Hz, so poll a
// little faster and rely on the dedupe in captureAwayOnce() to coalesce.
const AWAY_CAPTURE_POLL_MS = 600;
// After this long away, take a snapshot even if the frame still resembles the
// WAMS page — better one honest frame of the stay than no evidence at all.
const AWAY_CAPTURE_FORCE_AFTER_MS = 3000;
// A frame is only accepted as "outside WAMS" when at least this much of the
// shared screen differs from the WAMS baseline frame.
const AWAY_CAPTURE_DIFF_THRESHOLD = 0.03;
// Minimum gap between two accepted away-captures (stops a long absence from
// burning through the whole budget on near-identical frames).
const AWAY_CAPTURE_MIN_GAP_MS = 6000;
// How long the paused-canvas trick is armed after a switch (covers reloads of
// a still-hidden tab if the resume fires late).
const AWAY_ARM_MAX_MS = 15000;
// Cached WAMS baseline frame the away-captures are compared against.
const WAMS_SCREEN_BASELINE_KEY = 'wamsScreenBaseline_';
const WAMS_SCREEN_BASELINE_MAX_MS = 2 * 60 * 1000;   // re-baseline every 2 min
const WAMS_SCREEN_BASELINE_THUMB = 48;               // compare on a 48px thumbnail
const SCREEN_SHARE_CONSTRAINTS = {
  video: { cursor: 'never', width: { ideal: 1280 }, height: { ideal: 720 } },
  // Prefer the whole screen so the snapshot can show what the student opened.
  preferCurrentTab: false,
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  monitorTypeSurfaces: 'include'
};

/* ─── State ─── */
let screenStream = null;
let screenEnabled = false;
let screenCaptureInProgress = false;
let originallyGrantedScreen = false; // consent flow already started sharing
let pendingTabSwitchCaptures = 0;    // switches that still need a snapshot
let awayCaptureTimer = null;         // while-away polling loop
let awayCaptureArmedUntil = 0;       // paused-canvas prime window
let awayCaptureBusy = false;
let awayCaptureAt = 0;               // when the current switch began
let awayCaptureDeadline = 0;         // force a grab after this timestamp
let lastAwayCaptureAt = 0;
let wamsBaselineThumb = null;        // Float32Array of the WAMS page
let wamsBaselineAt = 0;

/* Server-side tab-switch count, so capture slots survive a reload. */
const TAB_SWITCH_SEEN_KEY_PREFIX = 'wamsServerTabSwitches_';
function proctorSessionId() { return (typeof getSessionId === 'function') ? getSessionId() : null; }
function proctorToken() { return (typeof getAuthToken === 'function') ? getAuthToken() : null; }
function tabSwitchSeenKey() { return TAB_SWITCH_SEEN_KEY_PREFIX + proctorSessionId(); }

function getSeenServerTabSwitches() {
  try { return parseInt(sessionStorage.getItem(tabSwitchSeenKey()) || '0', 10) || 0; } catch { return 0; }
}
function setSeenServerTabSwitches(value) {
  try { sessionStorage.setItem(tabSwitchSeenKey(), String(value)); } catch { }
}
function onServerTabSwitchCount(serverTotal) {
  const total = Number(serverTotal);
  if (!Number.isFinite(total)) return;
  setSeenServerTabSwitches(Math.max(0, total));
}

/* How many snapshots this session already holds (server + local counter). */
function getScreenCaptureCount() {
  const local = (typeof getCaptureCount === 'function') ? getCaptureCount('screen') : 0;
  const server = Number.isFinite(screenCapturesTotal) ? screenCapturesTotal : 0;
  return Math.max(local, server);
}

function screenCaptureBudgetLeft() {
  return Math.max(0, TAB_SWITCH_SCREEN_CAPTURE_LIMIT - getScreenCaptureCount());
}

function screenTrackLive() {
  const track = screenStream && screenStream.getVideoTracks()[0];
  return !!track && track.readyState === 'live';
}

/* ─── In-exam notifiers (small, non-blocking) ─── */
function getExamNotifier() {
  let el = document.getElementById('wamsExamNotifier');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'wamsExamNotifier';
  el.style.cssText = [
    'position:fixed', 'top:14px', 'left:50%', 'transform:translateX(-50%) translateY(-16px)',
    'z-index:2147483000', 'max-width:min(90vw,420px)', 'padding:9px 14px',
    'border-radius:10px', 'font:600 12.5px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    'background:#111827', 'color:#f9fafb', 'box-shadow:0 8px 24px rgba(0,0,0,.28)',
    'opacity:0', 'pointer-events:none', 'transition:opacity .18s ease,transform .18s ease'
  ].join(';');
  (document.body || document.documentElement).appendChild(el);
  return el;
}

function showExamNotifier(message, variant, holdMs) {
  const el = getExamNotifier();
  el.textContent = message;
  const palette = {
    capture: { background: '#1D4ED8', color: '#EFF6FF' },
    recorded: { background: '#065F46', color: '#ECFDF5' },
    idle: { background: '#111827', color: '#F9FAFB' }
  };
  const theme = palette[variant] || palette.idle;
  el.style.background = theme.background;
  el.style.color = theme.color;
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(window._wamsNotifierTimer);
  if (holdMs > 0) {
    window._wamsNotifierTimer = setTimeout(() => hideExamNotifier(), holdMs);
  }
}

function hideExamNotifier() {
  const el = document.getElementById('wamsExamNotifier');
  if (!el) return;
  clearTimeout(window._wamsNotifierTimer);
  el.style.opacity = '0';
  el.style.transform = 'translateX(-50%) translateY(-16px)';
}

/* Shown on the tab the student just switched to (capture mode only). It must
   not promise a shot before one exists — the snapshot is taken a moment later
   by the away-capture loop. */
function showSwitchCaptureNotice() {
  showExamNotifier(`📸 Tab switch detected — screen capture ${Math.max(1, getScreenCaptureCount() + 1)} of ${TAB_SWITCH_SCREEN_CAPTURE_LIMIT}`, 'capture', 0);
}

/* ═══════
   FEATURE 1 — SCREEN SHARE (no screenshots)
   ═══════ */

function setScreenShareNotifier(visible) {
  const banner = document.getElementById('screenShareBanner');
  if (banner) banner.style.display = visible ? 'flex' : 'none';
}

function attachScreenStream(stream) {
  if (screenStream && screenStream !== stream) {
    screenStream.getTracks().forEach(t => t.stop());
  }
  screenStream = stream || null;
  const track = screenStream && screenStream.getVideoTracks()[0];
  if (!track) return;

  track.onended = () => {
    // Only the *current* share ending should flip the UI back to "stopped".
    if (screenStream !== stream) return;
    stopScreenCapture();
    if (!window._wamsExamSubmitted) {
      showHint('Screen sharing stopped. Click Screen in the toolbar to resume.');
    }
  };

  // Prime the hidden capture <video> with the shared screen so grabScreenFrame
  // can draw a live frame instantly — even while the exam tab is hidden and
  // the screen shows whatever the student switched to.
  const screenVideo = getHiddenVideo();
  if (screenVideo.srcObject !== screenStream) {
    screenVideo.srcObject = screenStream;
    try { screenVideo.play(); } catch { }
  }

  // Resharing always clears the yellow notifier.
  setScreenShareNotifier(false);
  const btn = document.getElementById('screenBtn');
  if (btn) btn.classList.add('active');

  // Learn what "the WAMS page" looks like while there is no picker in front,
  // so a hidden tick can tell it apart from whatever the student opened.
  const onFirstFrame = () => { setTimeout(refreshWamsBaseline, 150); setTimeout(refreshWamsBaseline, 1500); };
  if (screenVideo.readyState >= 2) onFirstFrame();
  else screenVideo.addEventListener('loadeddata', onFirstFrame, { once: true });

  // If the student picked "this tab", every away-capture would just be another
  // picture of WAMS. Say so instead of silently storing useless frames.
  const surface = track.getSettings && track.getSettings().displaySurface;
  if (surface === 'browser') {
    showHint('You shared a browser tab. Share the entire screen so activity outside WAMS can be captured.');
  }
}

async function requestScreenShare() {
  window._wamsScreenPickerOpen = true;
  if (typeof armEmbeddedFormFocusGrace === 'function') armEmbeddedFormFocusGrace();
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(SCREEN_SHARE_CONSTRAINTS);
    attachScreenStream(stream);
    originallyGrantedScreen = true;
    return true;
  } finally {
    window._wamsScreenPickerOpen = false;
  }
}

async function initScreenCapture() {
  if (!examData) return;

  let monitor = examData.monitor || examData.monitor_settings || {};
  if (typeof monitor === 'string') { try { monitor = JSON.parse(monitor); } catch (e) { monitor = {}; } }

  if (monitor.screen === false) {
    const screenBtn = document.getElementById('screenBtn');
    if (screenBtn) screenBtn.style.display = 'none';
    return;
  }

  screenEnabled = true;
  addScreenCaptureButton();
  startLiveMonitoring();
  setScreenShareNotifier(true);

  if (originallyGrantedScreen && screenStream) {
    setScreenShareNotifier(false);
    return;
  }

  // Called from the consent "Agree and continue" click, so the gesture is still
  // valid here and the browser allows the picker.
  try {
    await requestScreenShare();
  } catch (err) {
    console.warn('Screen sharing denied by user:', err);
    showHint('Screen sharing is required for exam monitoring. Click Screen in the toolbar to share.');
  }

  // Keep the reference frame fresh while the exam is in front (video resize,
  // layout shifts) without touching the capture budget.
  if (!window._wamsBaselineTimer) {
    window._wamsBaselineTimer = setInterval(refreshWamsBaseline, WAMS_SCREEN_BASELINE_MAX_MS / 4);
  }
}

async function startContinuousScreenCapture() {
  const track = screenStream && screenStream.getVideoTracks()[0];
  if (track && track.readyState === 'live') {
    setScreenShareNotifier(false);
    return true;
  }
  try {
    await requestScreenShare();
    return true;
  } catch (err) {
    console.warn('Screen capture permission cancelled or denied:', err);
    showHint('Click Screen in the toolbar to activate screen sharing');
    return false;
  }
}

/* Toolbar button / yellow banner button: share → stop sharing → share … */
async function captureScreenOnce() {
  const track = screenStream && screenStream.getVideoTracks()[0];
  if (track && track.readyState === 'live') {
    stopScreenCapture();
    showHint('Screen sharing stopped');
  } else {
    await startContinuousScreenCapture();
    showHint('Screen sharing active');
  }
}

function stopScreenCapture() {
  const wasSharing = !!screenStream;
  if (screenStream) {
    const stream = screenStream;
    screenStream = null;
    stream.getTracks().forEach(t => {
      t.onended = null;
      t.stop();
    });
  }
  const btn = document.getElementById('screenBtn');
  if (btn) btn.classList.remove('active');
  // Only prompt again when a real share ended -> the yellow "share your screen"
  // notifier. It is cleared again as soon as they re-share.
  if (wasSharing && !window._wamsExamSubmitted && monitorPrefs().screen !== false) {
    screenEnabled = true;
    setScreenShareNotifier(true);
  }
}

function addScreenCaptureButton() {
  const toolsRail = document.querySelector('.tools-rail');
  if (!toolsRail) return;
  if (document.getElementById('screenBtn')) return;
  if (!toolsRail.querySelector('.tool-divider')) {
    const sep = document.createElement('div');
    sep.className = 'tool-divider';
    toolsRail.appendChild(sep);
  }
  const div = document.createElement('div');
  div.className = 'tool-btn';
  div.id = 'screenBtn';
  div.onclick = function () { captureScreenOnce(); };
  div.innerHTML = `
    <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
    <span class="tool-label">Screen</span>
  `;
  toolsRail.appendChild(div);
}

/* ═══════
   FEATURE 2 — TAB SWITCH
   ═══════ */

const TAB_SWITCH_GRACE_MS = 0;
const tabSwitchArmedAt = Date.now();
const EMBEDDED_FORM_FOCUS_GRACE_MS = 4000;

function armEmbeddedFormFocusGrace() {
  window._wamsEmbeddedFormFocusedAt = Date.now();
}

function isEmbeddedFormFocusBlur() {
  try {
    if (document.visibilityState !== 'visible') return false;
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return true;
    if (active.tagName === 'IFRAME') return true;
    if (window._wamsEmbeddedFormFocusedAt &&
      Date.now() - window._wamsEmbeddedFormFocusedAt < EMBEDDED_FORM_FOCUS_GRACE_MS) return true;
  } catch { }
  return false;
}

function isExamSetupInProgress() {
  return Date.now() - tabSwitchArmedAt < TAB_SWITCH_GRACE_MS;
}

function monitorPrefs() {
  let m = examData ? (examData.monitor || examData.monitor_settings || {}) : {};
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = {}; } }
  return m;
}

let tabSwitchPending = false;

/* Called from every detection path with mode 'capture' or 'record'. */
function detectTabSwitch(mode) {
  if (window._wamsExamSubmitted) return;
  if (monitorPrefs().tab === false) return;
  if (isExamSetupInProgress()) return;

  const now = Date.now();
  if (now - (window._wamsLastTabSwitchAt || 0) < 1200) return; // dedupe blur + visibilitychange
  window._wamsLastTabSwitchAt = now;

  // Let the student's device know on the tab they moved to before anything
  // else: timer callbacks in a hidden tab are clamped to ~1 Hz, so every
  // statement here can cost up to a second once visibility has flipped.
  if (mode === 'capture') {
    const pendingCount = pendingTabSwitchCaptures + 1 + getScreenCaptureCount();
    if (pendingCount <= TAB_SWITCH_SCREEN_CAPTURE_LIMIT && screenTrackLive()) {
      showSwitchCaptureNotice();
    }
  }

  // Fire the server record immediately: this is the last moment before the
  // browser throttles the hidden tab.
  reportTabSwitchToServer();

  if (mode === 'capture' && !window._wamsExamSubmitted) {
    pendingTabSwitchCaptures++;
    const pendingCount = pendingTabSwitchCaptures + getScreenCaptureCount();
    if (pendingCount <= TAB_SWITCH_SCREEN_CAPTURE_LIMIT &&
      screenStream && screenStream.getVideoTracks()[0] &&
      getScreenCaptureCount() < TAB_SWITCH_SCREEN_CAPTURE_LIMIT) {
      // Arm the while-away loop (paused <video> + canvas grabs). The snapshot
      // lands while the student is still on the other tab/window. There is
      // deliberately no capture on return: by then the shared screen is the
      // exam page again.
      armAwayCapture();
    }
  }
  // mode === 'record' → regular tab-switch behaviour only, nothing to capture.
}

function reportTabSwitchToServer() {
  const sessionId = proctorSessionId();
  const token = proctorToken();
  if (!sessionId || !token) {
    console.error('Tab switch detected, but no exam session or auth token is available.');
    return;
  }
  try {
    fetch('/api/sessions/' + sessionId + '/tab-switches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      keepalive: true
    }).catch(err => console.error('Tab switch reporting failed:', err));
  } catch (err) {
    console.error('Tab switch reporting failed:', err);
  }
  // Local mirror so the UI/count is right even if the network call is dropped.
  try {
    const key = 'wamsTabSwitch_' + (examData && examData.id);
    const stored = JSON.parse(localStorage.getItem(key) || '{"count":0,"log":[]}');
    stored.count = (stored.count || 0) + 1;
    stored.log = (stored.log || []).concat({ time: new Date().toISOString(), type: 'tab-switch' });
    localStorage.setItem(key, JSON.stringify(stored));
  } catch { }
}

/* ═══ Dedicated tab-switch screen capture ═══ */

function getHiddenVideo() {
  let video = document.getElementById('wamsScreenVideo');
  if (video) return video;
  video = document.createElement('video');
  video.id = 'wamsScreenVideo';
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.appendChild(video);
  return video;
}

/* Resolve after N new frames have been delivered by the attached <video>.
   This is the browser telling us the picture has actually changed — a timer
   cannot know that. Falls back to a short delay when the engine has no
   requestVideoFrameCallback, so this can never wedge a capture. */
function waitForFreshFrames(count) {
  return new Promise(resolve => {
    let video;
    try { video = getHiddenVideo(); } catch { return resolve(); }
    if (!video) return resolve();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    // Hard cap so a paused/dead stream cannot stall the capture loop.
    const timer = setTimeout(finish, TAB_SWITCH_FRAME_WAIT_MAX_MS);

    if (typeof video.requestVideoFrameCallback !== 'function' ||
        !video.srcObject || video.readyState < 2) {
      // No frame callback available (or no live stream yet): brief real delay.
      setTimeout(finish, TAB_SWITCH_FRAME_FALLBACK_MS);
      return;
    }

    let seen = 0;
    const onFrame = () => {
      seen++;
      if (seen >= count) { finish(); return; }
      try { video.requestVideoFrameCallback(onFrame); } catch { finish(); }
    };
    try { video.requestVideoFrameCallback(onFrame); } catch { finish(); }
  });
}

/* ═══ Off-tab capture primitives ═══
   A hidden tab freezes <video> compositing in Chrome, so drawImage(video)
   returns a stale or blank frame — but drawImage() still works when the
   video is *paused*. Pausing it before the tab hides (see armAwayCapture)
   pins the last good frame in the decoder, so a canvas grab while hidden
   gets the real pixels. pause() also flushes a frame drawn in the same
   task. Both helpers below are synchronous on purpose: the hidden tab only
   gets ~1 tick per second. */

function pauseHiddenVideo() {
  const video = getHiddenVideo();
  try { video.pause(); } catch { }
  return video;
}

/* Draw the paused/last-decoded frame into `canvas`. Returns false when the
   video has no frame yet. Throws when the canvas is not paintable (zero
   size on some engines) so callers can transcode instead. */
function drawHiddenVideoTo(canvas) {
  const video = getHiddenVideo();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return false;
  canvas.width = vw;
  canvas.height = vh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, vw, vh);
  return true;
}

/* Pull a frame straight off the *live* MediaStreamTrack. Unlike drawImage()
   on the <video>, ImageCapture.grabFrame() does not depend on the tab
   compositor, so it works while the tab is hidden — which is the whole point.
   Hidden-tab throttling freezes the video element and the canvas, but not this.

   When `thumbCanvas` is supplied the bitmap is also drawn into it at a small
   size so the caller can run the "is this still the WAMS page?" comparison on
   the very same frame that would be saved. Returns null when ImageCapture is
   unavailable (Safari, older Firefox) or the grab fails, so callers can fall
   back to the video path. */
async function grabScreenTrackFrame(thumbCanvas) {
  const track = screenStream && screenStream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') return null;
  if (typeof ImageCapture === 'undefined') return null;

  let bitmap = null;
  try {
    const capture = new ImageCapture(track);
    bitmap = await capture.grabFrame();
    if (!bitmap || !bitmap.width || !bitmap.height) return null;

    if (thumbCanvas) {
      const n = WAMS_SCREEN_BASELINE_THUMB;
      thumbCanvas.width = n;
      thumbCanvas.height = n;
      thumbCanvas.getContext('2d', { willReadFrequently: true })
        .drawImage(bitmap, 0, 0, n, n);
    }

    const scale = Math.min(1, 960 / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch (err) {
    console.warn('[screen-capture] Track frame failed:', err);
    return null;
  } finally {
    try { if (bitmap && typeof bitmap.close === 'function') bitmap.close(); } catch { }
  }
}

async function grabScreenFrame() {
  const track = screenStream && screenStream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') return null;

  // Preferred: an attached <video>. Kicking play() keeps it decoding while the
  // exam tab is visible; while hidden it stays paused on its last frame.
  const video = getHiddenVideo();
  if (video.srcObject !== screenStream) {
    video.srcObject = screenStream;
    // Kick off play() but never await it — a hidden tab can stall play()
    // indefinitely, and we need the frame now, not after the tab returns.
    try { video.play(); } catch { }
  }
  if (video.readyState < 2) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 300);
      video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;

  // Downscale so the payload stays small.
  const scale = Math.min(1, 960 / vw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext('2d');
  if (typeof ctx.drawImage === 'function') {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }
  return canvas.toDataURL('image/jpeg', 0.6);
}

/* ═══ While-away capture ═══
   Runs off a timer (hidden tabs keep timers alive at ~1 Hz) from the moment
   the exam tab goes hidden until the student comes back. Each tick samples the
   shared screen off a paused <video>; once the screen no longer looks like the
   WAMS page, that frame is the evidence and it is uploaded right there — the
   student never has to refocus WAMS for the shot to exist. */

function baselineStoreKey() {
  return WAMS_SCREEN_BASELINE_KEY + proctorSessionId();
}

function loadWamsBaseline() {
  if (wamsBaselineThumb && (Date.now() - wamsBaselineAt) < WAMS_SCREEN_BASELINE_MAX_MS) return wamsBaselineThumb;
  try {
    const raw = sessionStorage.getItem(baselineStoreKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.thumb) || !(Date.now() - parsed.at < WAMS_SCREEN_BASELINE_MAX_MS)) return null;
    wamsBaselineThumb = parsed.thumb;
    wamsBaselineAt = parsed.at;
    return wamsBaselineThumb;
  } catch { return null; }
}

function storeWamsBaseline(thumb) {
  wamsBaselineThumb = thumb;
  wamsBaselineAt = Date.now();
  try { sessionStorage.setItem(baselineStoreKey(), JSON.stringify({ thumb, at: wamsBaselineAt })); } catch { }
}

/* Remember what the shared screen looks like while the exam is in front, so a
   hidden tick can tell "still on WAMS" apart from "something was opened". */
async function refreshWamsBaseline() {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  if (!screenTrackLive()) return;
  if (window._wamsScreenPickerOpen) return;
  const canvas = document.createElement('canvas');
  try {
    if (!drawHiddenVideoTo(canvas)) return;
  } catch { return; }
  try {
    const thumb = readThumb(canvas);
    if (thumb) storeWamsBaseline(Array.from(thumb));
  } catch { }
}

/* Small luminance thumbnail used for the "not the WAMS page" comparison. */
function readThumb(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const n = WAMS_SCREEN_BASELINE_THUMB;
  ctx.drawImage(canvas, 0, 0, n, n);
  const data = ctx.getImageData(0, 0, n, n).data;
  const thumb = new Float32Array(n * n);
  for (let i = 0, p = 0; i < thumb.length; i++, p += 4) {
    thumb[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) / 255;
  }
  return thumb;
}

/* Fraction of thumbnail cells that differ noticeably from the baseline. */
function frameDiffersFromBaseline(canvas) {
  const baseline = loadWamsBaseline();
  if (!baseline) return null; // no reference yet
  let thumb;
  try { thumb = readThumb(canvas); } catch { return null; }
  if (!thumb) return null;
  let changed = 0;
  for (let i = 0; i < thumb.length; i++) {
    if (Math.abs(thumb[i] - baseline[i]) > 0.18) changed++;
  }
  return changed / thumb.length;
}

/* One hidden-tab tick. Returns true when something was saved. */
async function captureAwayOnce() {
  if (awayCaptureBusy) return false;
  if (getScreenCaptureCount() >= TAB_SWITCH_SCREEN_CAPTURE_LIMIT) { disarmAwayCapture(); return false; }
  if (!screenTrackLive()) return false;
  if (window._wamsExamSubmitted) { disarmAwayCapture(); return false; }
  if (document.visibilityState === 'visible') return false;
  if (Date.now() - lastAwayCaptureAt < AWAY_CAPTURE_MIN_GAP_MS) return false;

  // Update the deadline BEFORE any await so concurrent ticks share it.
  if (!awayCaptureDeadline) awayCaptureDeadline = Date.now() + AWAY_CAPTURE_FORCE_AFTER_MS;

  awayCaptureBusy = true;
  try {
    // The track grab is the only path that works reliably in a throttled
    // hidden tab, so it is tried FIRST. But it must still be *checked* against
    // the WAMS baseline before being kept, otherwise the very first tick —
    // taken while the student is still looking at the exam — would be stored
    // as "evidence".
    let canvas = null;
    const thumbOnly = document.createElement('canvas');
    const trackImage = await grabScreenTrackFrame(thumbOnly);
    let diff = null;
    if (trackImage) {
      diff = frameDiffersFromBaseline(thumbOnly);
      if (diff === null) {
        // No baseline yet: this frame *is* the WAMS page, so learn it.
        try { const thumb = readThumb(thumbOnly); if (thumb) storeWamsBaseline(Array.from(thumb)); } catch { }
        return false;
      }
      if (diff >= AWAY_CAPTURE_DIFF_THRESHOLD || Date.now() >= awayCaptureDeadline) {
        return finishAwayCapture(trackImage);
      }
      // Looks unchanged and we are still inside the grace window — fall through
      // to the video path below, which may already show the new screen.
    }

    canvas = document.createElement('canvas');
    let drew = false;
    try { drew = drawHiddenVideoTo(canvas); } catch { drew = false; }

    // No pinned frame (video never got one while visible) — nothing more to try.
    if (!drew) return false;

    diff = frameDiffersFromBaseline(canvas);
    if (diff === null) {
      try { const thumb = readThumb(canvas); if (thumb) storeWamsBaseline(Array.from(thumb)); } catch { }
      return false;
    }
    if (diff < AWAY_CAPTURE_DIFF_THRESHOLD) {
      // Still looks like WAMS. The other app may not have painted yet, so give
      // it a few ticks; once the deadline passes keep the frame anyway so the
      // switch is not silently left without a snapshot.
      if (Date.now() < awayCaptureDeadline) return false;
    }

    let image = null;
    try { image = canvas.toDataURL('image/jpeg', 0.6); } catch { }
    if (!image) image = await grabScreenFrame();
    if (!image) return false;
    return finishAwayCapture(image);
  } finally {
    awayCaptureBusy = false;
  }
}

async function finishAwayCapture(image) {
  const saved = await saveTabSwitchCapture(image);
  if (!saved || !saved.ok) {
    if (saved && saved.why === 'cap') disarmAwayCapture();
    return false;
  }
  lastAwayCaptureAt = Date.now();
  pendingTabSwitchCaptures = 0; // this switch is accounted for
  return true;
}

function awayCaptureTick() {
  captureAwayOnce().catch(err => console.warn('[screen-capture] away poll failed:', err));
}

/* Call as the exam tab is about to hide (or has just hidden). */
function armAwayCapture() {
  if (!screenTrackLive()) return;
  pauseHiddenVideo(); // freeze the last good frame — drawImage needs it
  awayCaptureArmedUntil = Date.now() + AWAY_ARM_MAX_MS;
  awayCaptureAt = Date.now();
  awayCaptureDeadline = awayCaptureAt + AWAY_CAPTURE_FORCE_AFTER_MS;
  // Try immediately (same task, before the browser throttles us) and again on
  // the next macrotask, so a switch that changes the screen instantly is
  // caught before the ~1 Hz hidden-tab timer kicks in.
  captureAwayTickNow();
  setTimeout(awayCaptureTick, 0);
  setTimeout(awayCaptureTick, 250);
  if (!awayCaptureTimer) {
    awayCaptureTimer = setInterval(awayCaptureTick, AWAY_CAPTURE_POLL_MS);
  }
}

function captureAwayTickNow() {
  try {
    captureAwayOnce().catch(err => console.warn('[screen-capture] away poll failed:', err));
  } catch (err) {
    console.warn('[screen-capture] away poll failed:', err);
  }
}

function disarmAwayCapture() {
  if (awayCaptureTimer) {
    clearInterval(awayCaptureTimer);
    awayCaptureTimer = null;
  }
  awayCaptureArmedUntil = 0;
  awayCaptureDeadline = 0;
}

/* Serialise capture attempts: the server counts every stored row, so a second
   snapshot started while the first is in flight could overshoot the limit. */
let captureChain = Promise.resolve();

async function dedicatedTabSwitchCapture() {
  const run = () => captureAwayOnce();
  const queued = captureChain.then(run, run);
  captureChain = queued.then(() => { }, () => { });
  return queued;
}

async function saveTabSwitchCapture(image) {
  const sessionId = proctorSessionId();
  const token = proctorToken();
  if (!sessionId || !token) return { ok: false, why: 'no-session' };
  try {
    const res = await fetch('/api/sessions/' + sessionId + '/screen-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      keepalive: true,
      body: JSON.stringify({ image, capture_trigger: 'tab-switch' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, why: 'http-' + res.status };
    if (data && data.limited) return { ok: false, why: 'cap' };
    if (typeof incrementCaptureCount === 'function') incrementCaptureCount('screen');
    screenCapturesTotal = getCaptureCount('screen');
    try {
      const key = 'wamsScreenCaptures_' + (examData && examData.id);
      const existing = JSON.parse(localStorage.getItem(key) || '[]');
      existing.push({ time: new Date().toISOString(), image });
      localStorage.setItem(key, JSON.stringify(existing.slice(-TAB_SWITCH_SCREEN_CAPTURE_LIMIT)));
    } catch { }
    console.log('[tab-switch-capture] saved', getScreenCaptureCount(), '/', TAB_SWITCH_SCREEN_CAPTURE_LIMIT);
    return { ok: true, why: 'saved' };
  } catch (err) {
    console.error('[tab-switch-capture] upload failed:', err);
    return { ok: false, why: 'network' };
  }
}

/* Called when the exam tab becomes visible again.

   IMPORTANT: this must NEVER take a snapshot. The shared screen is now showing
   the WAMS page again, so anything grabbed here is a picture of the exam —
   that is exactly the "it only captures when I refocus" behaviour. The switch
   either already has its away-capture or it doesn't; a missed one is recorded
   as a plain tab-switch event with no image. */
async function flushTabSwitchCaptures() {
  if (pendingTabSwitchCaptures <= 0) return true;
  if (document.visibilityState !== 'visible') return false;
  pendingTabSwitchCaptures = 0;
  return true;
}

/* ═══ Detection wiring ═══ */

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (tabSwitchPending) return;
    tabSwitchPending = true;
    hideExamNotifier();
    // First 5 switches -> dedicated capture; after that -> regular recording.
    // An unfinished capture keeps the mode in 'capture' (see flushTabSwitchCaptures).
    if (screenCaptureBudgetLeft() > 0 || pendingTabSwitchCaptures > 0) detectTabSwitch('capture');
    else detectTabSwitch('record');
    // Prime the off-tab grab FIRST — this has to happen while the tab is still
    // allowed to composite (the video pauses on a real frame).
    if (pendingTabSwitchCaptures > 0) armAwayCapture();
  } else {
    tabSwitchPending = false;
    disarmAwayCapture();
    resumeHiddenVideo();
    flushTabSwitchCaptures();
    // The exam page is back in front: this becomes the reference frame for the
    // next switch.
    setTimeout(refreshWamsBaseline, 1200);
    setTimeout(refreshWamsBaseline, 4000);
  }
});

window.addEventListener('blur', () => {
  if (tabSwitchPending) return;
  if (document.visibilityState === 'visible') return;
  if (isEmbeddedFormFocusBlur()) return;
  tabSwitchPending = true;
  // Backstop for engines where blur beats visibilitychange by a frame.
  if (screenCaptureBudgetLeft() > 0 || pendingTabSwitchCaptures > 0) detectTabSwitch('capture');
  else detectTabSwitch('record');
  if (pendingTabSwitchCaptures > 0) armAwayCapture();
});

window.addEventListener('focus', () => {
  tabSwitchPending = false;
  disardAwayCaptureIfVisible();
  if (document.visibilityState === 'visible') flushTabSwitchCaptures();
});

/* blur→focus without a visibilitychange (clicked on another app window). */
function disardAwayCaptureIfVisible() {
  if (document.visibilityState === 'visible') {
    disarmAwayCapture();
    resumeHiddenVideo();
    setTimeout(refreshWamsBaseline, 1200);
  }
}

/* Re-arm the paused-canvas prime if the tab comes back hidden (reload while
   another window is in front): without it there is no frame to sample. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  if (pendingTabSwitchCaptures > 0 && !awayCaptureTimer && screenTrackLive()) armAwayCapture();
});

function resumeHiddenVideo() {
  const video = document.getElementById('wamsScreenVideo');
  if (!video || !video.srcObject) return;
  try { video.play().catch(() => { }); } catch { }
}

/* ═══════
   Live-monitoring poll (keeps the capture budget in sync)
   ═══════ */
let liveMonitoringTimer = null;

function startLiveMonitoring() {
  if (liveMonitoringTimer) return;
  liveMonitoringTimer = setInterval(async () => {
    if (!examData || window._wamsExamSubmitted) return;
    const token = proctorToken();
    const sessionId = proctorSessionId();
    if (!sessionId || !token) return;
    try {
      const res = await fetch('/api/sessions/' + sessionId + '/monitoring', {
        headers: { 'Authorization': 'Bearer ' + token },
        cache: 'no-store'
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.tabSwitches !== undefined) onServerTabSwitchCount(data.tabSwitches);
      if (data.screenCaptures !== undefined) {
        screenCapturesTotal = data.screenCaptures;
        try { sessionStorage.setItem('wamsCaptureCount_screen_' + sessionId, String(data.screenCaptures)); } catch { }
      }
      flushTabSwitchCaptures();
    } catch (err) {
      console.warn('[live-monitor] polling failed:', err);
    }
  }, 10000);
}

function stopLiveMonitoring() {
  if (liveMonitoringTimer) {
    clearInterval(liveMonitoringTimer);
    liveMonitoringTimer = null;
  }
}
