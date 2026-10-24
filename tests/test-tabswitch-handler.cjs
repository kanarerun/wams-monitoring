// End-to-end handler test in a VM: loads the real modules in page order,
// dispatches a tab switch, and asserts a POST to /tab-switches is attempted.
const vm = require('vm');
const fs = require('fs');

const sent = [];
const listeners = {};
const makeEl = () => ({
  style: {}, classList: { add() {}, remove() {} }, appendChild() {}, dataset: {},
  innerHTML: '', textContent: '', hidden: false, disabled: false, checked: false,
  addEventListener() {}, closest() { return { hidden: false }; },
  getContext() { return { fillRect() {}, drawImage() {} }; },
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
  sessionStorage: { getItem: () => null, setItem() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  mediaDevices: {},
  _wamsLastTabSwitchAt: 0
};
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  document, window: windowObj, navigator: { mediaDevices: {} },
  sessionStorage: windowObj.sessionStorage, localStorage: windowObj.localStorage,
  setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
  fetch: (url) => { sent.push(String(url)); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
  examData: { id: 'x', monitor: { tab: true, screen: true } },
  showHint() {}
};
sandbox.window.document = document;

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('WAMS/student/wams-proctoring.js', 'utf8'), ctx, { filename: 'proctoring.js' });
vm.runInContext(fs.readFileSync('WAMS/student/wams-screen-tabswitch.js', 'utf8'), ctx, { filename: 'tabswitch.js' });

sandbox.getSessionId = () => '42';
sandbox.getAuthToken = () => 'tok';
sandbox.getCaptureCount = () => 0;
sandbox.incrementCaptureCount = () => {};

console.log('submitted flag at load:', windowObj._wamsExamSubmitted);
console.log('listeners:', Object.keys(listeners));

visibility = 'hidden';
(listeners['doc:visibilitychange'] || []).forEach(fn => fn());

setTimeout(() => {
  const ok = sent.some(u => u.indexOf('/tab-switches') >= 0);
  console.log('fetch calls:', sent);
  console.log(ok ? 'PASS - tab switch POSTed to server' : 'FAIL - no tab switch request');
  process.exit(ok ? 0 : 1);
}, 400);
