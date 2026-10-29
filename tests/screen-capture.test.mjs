// Behaviour test for the tab-switch capture state machine in
// WAMS/student/wams-screen-tabswitch.js.
//
// The bug being guarded against: a snapshot was taken whenever the shared
// screen *changed* while the exam tab was hidden, so repainting or clicking on
// the other tab produced extra captures. A switch must now yield at most ONE
// snapshot, no matter how much activity happens on the other tab afterwards.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync('WAMS/student/wams-screen-tabswitch.js', 'utf8');

function makeEnv() {
  let now = 1_000_000;
  let diff = 0.9;
  let captureCount = 0;                 // 0 = exam page, 1 = completely different
  const saved = [];
  const listeners = {};
  const intervals = new Map();
  const timeouts = [];
  let nextId = 1;

  const ctx2d = {
    drawImage() { },
    getImageData(x, y, w, h) {
      return { data: new Uint8ClampedArray(w * h * 4).fill(Math.round(diff * 255)) };
    }
  };

  const document = {
    visibilityState: 'hidden',
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatch(t, e) { (listeners[t] || []).forEach(f => f(e)); },
    createElement(tag) {
      if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ctx2d, toDataURL: () => 'data:image/jpeg;base64,STUB' };
      return { style: {}, appendChild() { }, setAttribute() { }, removeAttribute() { } };
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: { appendChild() { } }
  };

  const window = {
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    _wamsExamSubmitted: false,
    localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    sessionStorage: { getItem: () => null, setItem() { }, removeItem() { } }
  };

  const timers = {
    setTimeout: (f, ms = 0) => { const id = nextId++; timeouts.push({ id, f, at: now + ms }); return id; },
    clearTimeout: (id) => { const i = timeouts.findIndex(t => t.id === id); if (i >= 0) timeouts.splice(i, 1); },
    setInterval: (f, ms) => { const id = nextId++; intervals.set(id, { f, ms, next: now + ms }); return id; },
    clearInterval: (id) => intervals.delete(id)
  };

  function advance(ms, flush) {
    const end = now + ms;
    for (; ;) {
      const t = timeouts.map(x => ({ ...x, kind: 't' }))
        .concat([...intervals.entries()].map(([id, i]) => ({ id, f: i.f, at: i.next, kind: 'i' })))
        .sort((a, b) => a.at - b.at)[0];
      if (!t || t.at > end) break;
      if (t.kind === 't') index = timeouts.findIndex(x => x.id === t.id), timeouts.splice(index, 1);
      else intervals.get(t.id).next = t.at + intervals.get(t.id).ms;
      now = t.at;
      t.f();
      if (timeouts.length) now = Math.max(now, t.at);
    }
    now = end;
  }
  let index = 0;

  const fakeDate = class extends Date { };
  Object.defineProperty(fakeDate, 'now', { value: () => now });

  const context = vm.createContext({
    window, document, console,
    Date: fakeDate,
    ImageCapture: class { async grabFrame() { return { width: 640, height: 360 }; } },
    Promise, Uint8ClampedArray, Float32Array, Math, JSON, Number, Array, Object, String, Error,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    examData: { id: 1 },
    getSessionId: () => 42,
    getAuthToken: () => 'token',
    // Real per-session counter, so the 5-snapshot budget behaves as in the app.
    getCaptureCount: () => captureCount,
    incrementCaptureCount() { captureCount++; },
    showHint() { },
    fetch: async function (url) {
      if (String(url).includes('/screen-capture')) { saved.push(now); return { ok: true, json: async () => ({ success: true }) }; }
      return { ok: true, json: async () => ({}) };
    }
  });
  context.globalThis = context;
  context.STUB_TRACK = { readyState: 'live', getSettings: () => ({ displaySurface: 'monitor' }), stop() { } };

  vm.runInContext(source + `
;screenStream = { getTracks: () => [STUB_TRACK], getVideoTracks: () => [STUB_TRACK] };
globalThis.__api = {
  armAwayCapture, disarmAwayCapture, captureAwayOnce,
  pending: () => pendingTabSwitchCaptures,
  armed: () => awayCaptureArmedUntil,
  timer: () => awayCaptureTimer,
  budgetLeft: () => screenCaptureBudgetLeft(),
  seedBaseline: () => { storeWamsBaseline(Array.from({ length: 48 * 48 }, () => 0)); }
}`, context);

  return {
    api: context.__api,
    document, window,
    saved,
    advance,
    // Async work (grabFrame/save) settles on microtasks; run pending timers once
    // the promise chain has drained.
    async settle(ms = 0) { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); advance(ms); await new Promise(r => setImmediate(r)); },
    setDiff(v) { diff = v; }
  };
}

const env = makeEnv();
env.api.seedBaseline();
assert.ok(env.api.budgetLeft() > 0, 'capture budget should be available');

// 1) A switch while the screen now shows another site → exactly one snapshot.
env.setDiff(0.9);
env.api.armAwayCapture();
await env.settle(400);
const afterSwitch = env.saved.length;

// 2) The other tab keeps repainting / getting clicks for 20 seconds.
for (let i = 0; i < 20; i++) await env.settle(1000);
const afterActivity = env.saved.length;

assert.equal(afterSwitch, 1, `one snapshot per switch (got ${afterSwitch})`);
assert.equal(afterActivity, 1, `no extra snapshots while away (got ${afterActivity - 1} extra)`);
assert.equal(env.api.timer(), null, 'the away loop must be disarmed after the switch is captured');
console.log(`PASS  switch + 20s of activity on the other tab -> ${afterActivity} snapshot(s)`);

// 3) A switch back to a screen that still looks like the exam → no snapshot,
//    and the retry loop gives up instead of polling forever.
const env2 = makeEnv();
env2.api.seedBaseline();
env2.setDiff(0.02);
env2.api.armAwayCapture();
await env2.settle(3500);
assert.equal(env2.saved.length, 0, `nothing should be stored for an unchanged screen (got ${env2.saved.length})`);
assert.equal(env2.api.timer(), null, 'retry loop must stop once the window closes');
console.log(`PASS  screen still shows the exam -> ${env2.saved.length} snapshot(s), loop stopped`);

// 4) Two separate switches → two snapshots, not more.
const env3 = makeEnv();
env3.api.seedBaseline();
env3.setDiff(0.9);
for (let s = 0; s < 2; s++) {
  env3.document.visibilityState = 'hidden';
  env3.document.dispatch('visibilitychange');
  await env3.settle(600);
  env3.document.visibilityState = 'visible';
  env3.document.dispatch('visibilitychange');
  await env3.settle(3000);
}
assert.equal(env3.saved.length, 2, `two switches should store two snapshots (got ${env3.saved.length})`);
console.log(`PASS  two switches -> ${env3.saved.length} snapshot(s)`);

console.log('\nAll tab-switch capture checks passed.');
