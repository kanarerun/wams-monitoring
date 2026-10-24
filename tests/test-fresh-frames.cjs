// Verifies waitForFreshFrames: (1) resolves only after N real frame callbacks,
// (2) falls back when requestVideoFrameCallback is missing,
// (3) never hangs past the hard cap.
const vm = require('vm');
const fs = require('fs');

function makeVideo(opts) {
  const { hasRvfc, framesBeforeStop, readyState } = opts;
  const v = {
    readyState: readyState === undefined ? 4 : readyState,
    srcObject: { id: 'stream' },
    videoWidth: 640, videoHeight: 360,
    play: () => Promise.resolve(),
    style: {}, id: 'wamsScreenVideo'
  };
  if (hasRvfc) {
    v.requestVideoFrameCallback = (cb) => {
      if (framesBeforeStop !== undefined && framesBeforeStop <= 0) return 0;
      if (framesBeforeStop !== undefined) opts.framesBeforeStop--;
      setTimeout(cb, 5);
      return 1;
    };
  }
  return v;
}

function runCase(name, opts) {
  return new Promise(resolve => {
    const video = makeVideo(opts);
    const listeners = {};
    const doc = {
      addEventListener: (t, fn) => { listeners[t] = fn; },
      getElementById: () => video,
      createElement: () => ({ style: {}, getContext: () => ({ fillRect() { }, drawImage() { } }), toDataURL: () => 'data:,' }),
      querySelector: () => null, body: { appendChild() { } },
      documentElement: {}, visibilityState: 'visible', hidden: false, activeElement: null
    };
    const win = {
      addEventListener: () => { }, location: { search: '' },
      sessionStorage: { getItem: () => null, setItem() { } },
      localStorage: { getItem: () => null, setItem() { } }, mediaDevices: {}
    };
    const sandbox = {
      console: { log() { }, warn() { }, error() { } },
      document: doc, window: win, navigator: { mediaDevices: {} },
      sessionStorage: win.sessionStorage, localStorage: win.localStorage,
      setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
      examData: { id: 'x', monitor: { tab: true, screen: true } },
      showHint() { }
    };
    sandbox.window.document = doc;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync('WAMS/student/wams-screen-tabswitch.js', 'utf8'), ctx, { filename: 'tab.js' });

    const start = Date.now();
    ctx.waitForFreshFrames(5).then(() => {
      resolve({ name, ms: Date.now() - start });
    });
  });
}

(async () => {
  const a = await runCase('5 real frames', { hasRvfc: true, framesBeforeStop: 100 });
  const b = await runCase('no requestVideoFrameCallback', { hasRvfc: false });
  const c = await runCase('stream stalls (frame cap)', { hasRvfc: true, framesBeforeStop: 0 });

  console.log(JSON.stringify({ cases: [a, b, c] }, null, 2));
  const ok = a.ms >= 20 && a.ms < 600 && b.ms >= 200 && b.ms < 700 && c.ms >= 1100 && c.ms < 1600;
  console.log(ok ? 'PASS - frame wait behaves correctly in all three cases' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
