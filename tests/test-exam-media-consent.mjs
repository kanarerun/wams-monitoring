import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const proctoringSource = fs.readFileSync('WAMS/student/wams-proctoring.js', 'utf8');
const quizHtml = fs.readFileSync('WAMS/student/wams-student-exam-tool.html', 'utf8');
const formHtml = fs.readFileSync('WAMS/student/wams-student-exam-tool-gform.html', 'utf8');

function dialogMarkup(html, id){
  const start = html.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `Missing ${id}`);
  const dialogStart = html.lastIndexOf('<dialog', start);
  const dialogEnd = html.indexOf('</dialog>', start);
  assert.ok(dialogStart >= 0 && dialogEnd > start);
  return html.slice(dialogStart, dialogEnd);
}

for(const [name, html] of [['quiz', quizHtml], ['Google Forms', formHtml]]){
  test(`${name} presents privacy acknowledgment before device setup`, () => {
    const privacyDialog = dialogMarkup(html, 'privacyConsentDialog');
    const mediaDialog = dialogMarkup(html, 'mediaConsentDialog');

    assert.ok(privacyDialog.includes('Data Privacy Act of 2012'));
    assert.ok(privacyDialog.includes('privacyNoticeAgreement'));
    assert.ok(privacyDialog.includes('privacyConsentContinue'));
    assert.doesNotMatch(privacyDialog, /PermissionRow|cameraConsentDetail|microphoneDevice|mediaConsentStatus/);
    assert.ok(mediaDialog.includes('cameraPermissionRow'));
    assert.ok(mediaDialog.includes('microphonePermissionRow'));
    assert.ok(mediaDialog.includes('cameraDeviceSelect'));
    assert.ok(mediaDialog.includes('microphoneDeviceSelect'));
    assert.doesNotMatch(mediaDialog, /privacyNoticeAgreement|privacyNoticeDetail/);
  });
}

test('selected camera requests the exact camera and replaces the previous stream', async () => {
  const requestStart = proctoringSource.indexOf('async function requestSelectedCamera(){');
  const requestEnd = proctoringSource.indexOf('async function requestSelectedMicrophone()', requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);

  const stoppedTracks = [];
  const nextTrack = { readyState: 'live', stop() {} };
  const nextStream = {
    active: true,
    getVideoTracks: () => [nextTrack],
    getTracks: () => [nextTrack]
  };
  const previousTrack = { stop(){ stoppedTracks.push(true); } };
  const previousStream = {
    active: true,
    getTracks: () => [previousTrack]
  };
  const elements = {
    cameraDeviceSelect: { value: 'external-camera' },
    cameraDeviceApply: { disabled: false, textContent: '' },
    mediaConsentStatus: { hidden: true, textContent: '' }
  };
  let request;
  const context = vm.createContext({
    cameraStream: previousStream,
    mediaAccessErrors: { camera: null, microphone: null },
    selectedCameraDeviceId: '',
    navigator: {
      mediaDevices: {
        getUserMedia: async constraints => {
          request = constraints;
          return nextStream;
        }
      }
    },
    document: { getElementById: id => elements[id] },
    window: { _wamsMonitoringGuardActive: false },
    console: { warn() {} },
    mediaAccessHelp: () => 'camera help',
    updateMediaConsentDeviceState() {},
    updateMediaConsentAcceptState() {}
  });
  vm.runInContext(proctoringSource.slice(requestStart, requestEnd), context);

  await vm.runInContext('requestSelectedCamera()', context);
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    video: {
      width: { ideal: 320 },
      height: { ideal: 240 },
      deviceId: { exact: 'external-camera' }
    }
  });
  assert.equal(context.cameraStream, nextStream);
  assert.equal(stoppedTracks.length, 1);
  assert.equal(elements.mediaConsentStatus.hidden, false);
});

test('opening consent shows privacy first and advances only after acknowledgment', () => {
  const start = proctoringSource.indexOf('function showExamMediaConsent(onAllowed){');
  const end = proctoringSource.indexOf('/* Screen sharing lives in wams-screen-tabswitch.js', start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map();
  const makeElement = (id, properties = {}) => {
    const element = {
      id,
      hidden: false,
      checked: false,
      disabled: false,
      open: false,
      focus() {},
      showModal(){ this.open = true; },
      close(){ this.open = false; },
      ...properties
    };
    elements.set(id, element);
    return element;
  };
  makeElement('privacyConsentDialog');
  makeElement('mediaConsentDialog');
  makeElement('mediaConsentAgreement', { closest: () => ({ hidden: false }) });
  makeElement('privacyNoticeAgreement');
  makeElement('privacyConsentContinue');
  makeElement('mediaConsentRequest', { hidden: true });
  makeElement('mediaConsentAccept');
  makeElement('mediaConsentStatus');
  makeElement('cameraConsentDetail');
  makeElement('microphoneConsentDetail');
  makeElement('screenConsentDetail');
  makeElement('cameraPermissionRow');
  makeElement('microphonePermissionRow');
  const screenNote = { hidden: false };
  const context = vm.createContext({
    pendingMediaConsentCallback: null,
    cameraStream: null,
    audioStream: null,
    document: {
      getElementById: id => elements.get(id) || null,
      querySelector: () => screenNote
    },
    getMonitorPrefs: () => ({ cam: false, camera: false, audio: false, screen: false }),
    areRequiredMediaStreamsActive: () => true,
    updateMediaConsentDeviceState() {},
    updateMediaConsentAcceptState() {},
    refreshCameraDeviceList: async () => {},
    refreshMicrophoneDeviceList: async () => {},
    console: { error() {} }
  });
  vm.runInContext(
    `let pendingMediaConsentCallback = null;\n${proctoringSource.slice(start, end)}`,
    context
  );
  vm.runInContext('showExamMediaConsent(() => {})', context);

  assert.equal(elements.get('privacyConsentDialog').open, true);
  assert.equal(elements.get('mediaConsentDialog').open, false);
  elements.get('privacyNoticeAgreement').checked = true;
  elements.get('privacyNoticeAgreement').onchange();
  assert.equal(elements.get('privacyConsentContinue').disabled, false);
  elements.get('privacyConsentContinue').onclick();
  assert.equal(elements.get('privacyConsentDialog').open, false);
  assert.equal(elements.get('mediaConsentDialog').open, true);
});
