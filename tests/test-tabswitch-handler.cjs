// End-to-end handler test in a VM: loads the real modules in page order,
// dispatches a tab switch, and asserts a POST to /tab-switches is attempted.
const vm = require('vm');
const fs = require('fs');

const sent = [];
const listeners = {};
const makeEl = () => ({
  style: {}, classList: { add() { }, remove() { } }, appendChild() { }, dataset: {},
  innerHTML: '', textContent: '', hidden: false, disabled: false, checked: false,
  addEventListener() { }, closest() { return { hidden: false }; },
  getContext() { return { fillRect() { }, drawImage() { } }; },
  captureStream() { return { getTracks: () => [], getVideoTracks: () => [], active: true }; },
  toDataURL: () => 'data:,'
});

let visibility = 'visible';
const document = {
  addEventListener: (t, fn) => { (listeners['doc:' + t] = listeners['doc:' + t] || []).push(fn); },
  getElementById: () => null,
  createElement: makeEl,
  querySelector: () => null,
  body: makeEl(),
  documentElement: makeEl(),
  get visibilityState() { return visibility; },
  get hidden() { return visibility === 'hidden'; },
  activeElement: null
};
const windowObj = {
  addEventListener: (t, fn) => { (listeners['win:' + t] = listeners['win:' + t] || []).push(fn); },
  location: { search: '' },
  sessionStorage: { getItem: () => null, setItem() { } },
  localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
  mediaDevices: {},
  _wamsLastTabSwitchAt: 0
};
const sandbox = {
  console: { log() { }, warn() { }, error() { } },
  document, window: windowObj, navigator: { mediaDevices: {} },
  sessionStorage: windowObj.sessionStorage, localStorage: windowObj.localStorage,
  setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
  fetch: (url, opts) => { sent.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
  examData: { id: 'x', monitor: { tab: true, screen: true } },
  showHint() { }
};
sandbox.window.document = document;

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('WAMS/student/wams-proctoring.js', 'utf8'), ctx, { filename: 'proctoring.js' });
vm.runInContext(fs.readFileSync('WAMS/student/wams-screen-tabswitch.js', 'utf8'), ctx, { filename: 'tabswitch.js' });

sandbox.getSessionId = () => '42';
sandbox.getAuthToken = () => 'tok';
sandbox.getCaptureCount = () => 0;
sandbox.incrementCaptureCount = () => { };

console.log('submitted flag at load:', windowObj._wamsExamSubmitted);
console.log('listeners:', Object.keys(listeners));

visibility = 'hidden';
(listeners['doc:visibilitychange'] || []).forEach(fn => fn());

setTimeout(() => {
  const ok = sent.some(r => r.url.indexOf('/tab-switches') >= 0);
  const plain = sent.find(r => r.url.indexOf('/tab-switches') >= 0);
  const plainOk = !!plain && plain.body && plain.body.source === 'tab-switch';

  // Alt+Tab while the exam tab stays visible: keydown Alt, keydown Tab.
  visibility = 'visible';
  (listeners['win:focus'] || []).forEach(fn => fn());
  sandbox.window._wamsLastTabSwitchAt = 0;
  sandbox.window._wamsLastAltTabAt = 0;
  sent.length = 0;
  const key = (k, altKey) => ({ key: k, altKey: !!altKey, ctrlKey: false, metaKey: false, shiftKey: false });
  (listeners['doc:keydown'] || []).forEach(fn => fn(key('Alt')));
  (listeners['doc:keydown'] || []).forEach(fn => fn(key('Tab', true)));
  // The OS blurs the page right after: must not be recorded twice.
  (listeners['win:blur'] || []).forEach(fn => fn());
  (listeners['doc:visibilitychange'] || []).forEach(fn => fn());

  setTimeout(() => {
    const altPosts = sent.filter(r => r.url.indexOf('/tab-switches') >= 0);
    const altOk = altPosts.length === 1 && altPosts[0].body && altPosts[0].body.source === 'alt-tab';
    console.log('fetch calls:', sent);
    console.log(plainOk ? 'PASS - tab switch POSTed with source=tab-switch' : 'FAIL - plain tab switch source wrong');
    console.log(altOk ? 'PASS - Alt+Tab recorded once with source=alt-tab' : 'FAIL - Alt+Tab detection (' + altPosts.length + ' posts)');
    process.exit(ok && plainOk && altOk ? 0 : 1);
  }, 300);
}, 400);
