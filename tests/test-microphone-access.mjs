import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('WAMS/student/wams-proctoring.js', 'utf8');
const constraintsStart = source.indexOf('function getMicrophoneConstraints(');
const constraintsEnd = source.indexOf('function getActiveMicrophoneDeviceId()', constraintsStart);
const helpStart = source.indexOf('function mediaAccessHelp(');
const helpEnd = source.indexOf('function ensureMediaStreams()', helpStart);
assert.ok(constraintsStart >= 0 && constraintsEnd > constraintsStart);
assert.ok(helpStart >= 0 && helpEnd > helpStart);

function createMicrophoneApi(getUserMedia){
  const context = vm.createContext({
    navigator: { mediaDevices: { getUserMedia } },
    console: { warn() {} },
    Promise,
    Error,
    String,
    mediaAccessErrors: { camera: null, microphone: null }
  });
  vm.runInContext(
    `let selectedMicrophoneDeviceId = '';
     ${source.slice(constraintsStart, constraintsEnd)}
     ${source.slice(helpStart, helpEnd)}
     globalThis.api = { getMicrophoneConstraints, requestMicrophoneStream, mediaAccessHelp, mediaAccessErrors };`,
    context
  );
  return context.api;
}

test('default microphone uses browser-selected input with audio processing', async () => {
  let request;
  const stream = { id: 'default' };
  const api = createMicrophoneApi(async options => { request = options; return stream; });

  assert.equal(await api.requestMicrophoneStream(), stream);
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    audio: { echoCancellation: true, noiseSuppression: true }
  });
});

test('selected Bluetooth or external microphone is requested by exact device id', async () => {
  let request;
  const api = createMicrophoneApi(async options => { request = options; return {}; });

  await api.requestMicrophoneStream('bluetooth-mic');
  assert.deepEqual(JSON.parse(JSON.stringify(request)), {
    audio: {
      deviceId: { exact: 'bluetooth-mic' },
      echoCancellation: true,
      noiseSuppression: true
    }
  });
});

test('unsupported processing constraints retry the same selected microphone without them', async () => {
  const requests = [];
  const stream = { id: 'basic-audio' };
  const api = createMicrophoneApi(async options => {
    requests.push(options);
    if (requests.length === 1) {
      const error = new Error('Unsupported audio constraint');
      error.name = 'OverconstrainedError';
      throw error;
    }
    return stream;
  });

  assert.equal(await api.requestMicrophoneStream('headset-mic'), stream);
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[1])), {
    audio: { deviceId: { exact: 'headset-mic' } }
  });
});

test('busy Bluetooth microphone gives actionable Zoom and alternate-device guidance', () => {
  const api = createMicrophoneApi(async () => {});
  api.mediaAccessErrors.microphone = { name: 'NotReadableError' };

  const guidance = api.mediaAccessHelp('microphone');
  assert.match(guidance, /Zoom/);
  assert.match(guidance, /reconnect the headset/);
  assert.match(guidance, /built-in microphone/);
});
