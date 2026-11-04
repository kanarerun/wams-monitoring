import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { retryTransientWrite } from '../server/media-upload-queue.js';

const databaseUrl = process.env.TURSO_DATABASE_URL || '';
const isLocalDatabase = /^file:/i.test(databaseUrl);
const isAllowedStagingDatabase = process.env.MEDIA_TEST_ALLOW_STAGING === '1' &&
  /^libsql:\/\/staging-[a-z0-9-]+\.aws-[a-z0-9-]+\.turso\.io\/?$/i.test(databaseUrl);
if (!isLocalDatabase && !isAllowedStagingDatabase) {
  throw new Error('Load test requires an isolated local file: database or explicit opt-in to a staging-*.turso.io database.');
}

const baseUrl = new URL(process.env.MEDIA_TEST_BASE_URL || 'http://127.0.0.1:3197');
if (!['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)) {
  throw new Error('Load test requests are restricted to a loopback server.');
}
const jwtSecret = process.env.JWT_SECRET || 'administratorSecretKey';
const databasePath = process.env.MEDIA_TEST_DB_PATH;
if (isLocalDatabase && !databasePath) {
  throw new Error('MEDIA_TEST_DB_PATH must identify the isolated local database file.');
}

let db = createClient({ url: databaseUrl, authToken: process.env.TURSO_AUTH_TOKEN || 'local-test' });
const marker = `media-load-${randomUUID().slice(0, 8)}`;
let examId;
let sectionId;
let professorId;
let studentIds = [];
let sessionIds = [];
let compatibilitySessionId;

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x84]);
const timings = [];
const allCaptureIds = { camera: [], screen: [], audio: [] };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function executeTestDb(statement) {
  return retryTransientWrite(() => db.execute({ ...statement, args: statement.args || [] }), {
    attempts: 8,
    baseDelayMs: 100
  });
}

async function request(path, { token, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(new URL(path, baseUrl), { ...options, headers });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function getInsertId(sql, args) {
  const result = await executeTestDb({ sql, args });
  return Number(result.lastInsertRowid);
}

function tokenFor(id) {
  return jwt.sign({ id }, jwtSecret);
}

async function seedData() {
  const admin = await executeTestDb({
    sql: "SELECT id FROM users WHERE role = 'admin' AND username = 'admin' LIMIT 1"
  });
  const adminId = Number(admin.rows[0]?.id);
  assert(adminId, 'Local server did not seed the default admin.');

  professorId = await getInsertId(
    'INSERT INTO users (role, name, username, password) VALUES (?, ?, ?, ?)',
    ['professor', `${marker} Professor`, `${marker}-professor`, 'unused']
  );
  sectionId = await getInsertId(
    'INSERT INTO sections (name, course, created_by) VALUES (?, ?, ?)',
    [`${marker} Section`, 'Load Test', adminId]
  );
  examId = await getInsertId(`INSERT INTO exams
    (professor_id, title, section_id, type, time_limit, access_code, status, live_started_at, published_at)
    VALUES (?, ?, ?, 'gforms', 120, ?, 'live', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [professorId, `${marker} Exam`, sectionId, `${marker}-CODE`]);

  for (let index = 0; index < 20; index++) {
    const userId = await getInsertId(
      'INSERT INTO users (role, name, username, password) VALUES (?, ?, ?, ?)',
      ['student', `${marker} Student ${index + 1}`, `${marker}-student-${index + 1}`, 'unused']
    );
    const studentId = await getInsertId(
      `INSERT INTO students (user_id, student_id, section_id, year_level, access_code)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, `${marker}-${String(index + 1).padStart(3, '0')}`, sectionId, 'Load Test', `${marker}-CODE`]
    );
    const sessionId = await getInsertId(
      'INSERT INTO exam_sessions (exam_id, student_id) VALUES (?, ?)',
      [examId, studentId]
    );
    studentIds.push({ userId, studentId, sessionId, token: tokenFor(userId) });
    sessionIds.push(sessionId);
  }
  compatibilitySessionId = await getInsertId(
    'INSERT INTO exam_sessions (exam_id, student_id) VALUES (?, ?)',
    [examId, studentIds[0].studentId]
  );
}

async function upload(student, type, index) {
  const captureId = randomUUID();
  const started = performance.now();
  const headers = {
    Authorization: `Bearer ${student.token}`,
    'X-Capture-Id': captureId
  };
  let url;
  let body;

  if (type === 'camera') {
    url = '/api/camera/capture';
    headers['X-Session-Id'] = String(student.sessionId);
    headers['Content-Type'] = 'image/jpeg';
    headers['X-Capture-Metadata'] = JSON.stringify({
      face_count: 1,
      skin_pixels: 20,
      flagged: index % 20 === 0,
      detection_data: { flagged_reasons: [] }
    });
    body = jpeg;
  } else if (type === 'screen') {
    url = `/api/sessions/${student.sessionId}/screen-capture`;
    headers['Content-Type'] = 'image/jpeg';
    headers['X-Capture-Trigger'] = 'tab-switch';
    body = jpeg;
  } else {
    url = `/api/sessions/${student.sessionId}/audio-capture`;
    headers['Content-Type'] = 'audio/webm';
    headers['X-Capture-Metadata'] = JSON.stringify({
      level_dbfs: -24,
      event: 'concurrent-load-test',
      flagged: index === 0
    });
    body = webm;
  }

  const { response, body: result } = await request(url, {
    token: undefined,
    method: 'POST',
    headers,
    body
  });
  const durationMs = performance.now() - started;
  assert(response.ok && result.success && !result.limited,
    `${type} upload failed for session ${student.sessionId}: HTTP ${response.status} ${result.error || ''}`);
  assert(result.capture_id === captureId, `${type} upload response did not confirm the capture ID.`);
  allCaptureIds[type].push({ captureId, sessionId: student.sessionId });
  timings.push({ type, durationMs });
  return { captureId, sessionId: student.sessionId, durationMs };
}

async function testRetryPolicy() {
  let attempts = 0;
  const result = await retryTransientWrite(async () => {
    attempts++;
    if (attempts < 3) {
      const error = new Error('database is locked');
      error.code = 'SQLITE_BUSY';
      throw error;
    }
    return 'persisted';
  }, { attempts: 4, baseDelayMs: 1 });
  assert(result === 'persisted' && attempts === 3, 'Transient retry policy did not recover after two failures.');
  const transientAttempts = attempts;

  attempts = 0;
  try {
    await retryTransientWrite(async () => {
      attempts++;
      throw new Error('validation error');
    }, { attempts: 4, baseDelayMs: 1 });
    throw new Error('Permanent errors should not be retried.');
  } catch (error) {
    assert(error.message === 'validation error' && attempts === 1,
      'Permanent errors were unexpectedly retried.');
  }
  return { transientAttempts, permanentAttempts: attempts };
}

function databaseSizeBytes() {
  if (!isLocalDatabase) return null;
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter(file => existsSync(file))
    .reduce((total, file) => total + statSync(file).size, 0);
}

async function testPermanentUploadValidation(student) {
  const { response, body } = await request('/api/camera/capture', {
    method: 'POST',
    token: student.token,
    headers: {
      'X-Session-Id': String(student.sessionId),
      'X-Capture-Id': randomUUID(),
      'Content-Type': 'image/jpeg',
      'X-Capture-Metadata': JSON.stringify({ face_count: 1, skin_pixels: 20 })
    },
    body: Buffer.from('invalid jpeg')
  });
  assert(response.status === 415 && body.error, 'Invalid media was not rejected as a permanent validation error.');
}

async function testUploadOwnership(student, otherStudent) {
  const { response } = await request('/api/camera/capture', {
    method: 'POST',
    token: otherStudent.token,
    headers: {
      'X-Session-Id': String(student.sessionId),
      'X-Capture-Id': randomUUID(),
      'Content-Type': 'image/jpeg',
      'X-Capture-Metadata': JSON.stringify({ face_count: 1, skin_pixels: 20 })
    },
    body: jpeg
  });
  assert(response.status === 403, 'A student uploaded media to another student session.');
}

async function testStudentSessions() {
  const results = await Promise.all(studentIds.map(student => request(
    `/api/sessions/${student.sessionId}/captures`,
    { token: student.token }
  )));
  assert(results.every(item => item.response.ok),
    'A seeded student token could not access its own session before load began.');
}

async function testLegacyJsonCompatibility() {
  const student = studentIds[0];
  const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const legacyRequests = await Promise.all([
    request('/api/camera/capture', {
      method: 'POST',
      token: student.token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: compatibilitySessionId,
        image,
        face_count: 1,
        skin_pixels: 20,
        flagged: true
      })
    }),
    request(`/api/sessions/${compatibilitySessionId}/screen-capture`, {
      method: 'POST',
      token: student.token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, capture_trigger: 'tab-switch' })
    }),
    request(`/api/sessions/${compatibilitySessionId}/audio-capture`, {
      method: 'POST',
      token: student.token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_data: JSON.stringify({ level_dbfs: -31.2, event: 'legacy-test', flagged: true }),
        flagged: true
      })
    })
  ]);
  assert(legacyRequests.every(item => item.response.ok && item.body.success),
    'A legacy JSON capture request was not accepted.');

  const professorToken = tokenFor(professorId);
  const [camera, screen, audio] = await Promise.all([
    request(`/api/sessions/${compatibilitySessionId}/captures`, { token: professorToken }),
    request(`/api/sessions/${compatibilitySessionId}/screen-captures`, { token: professorToken }),
    request(`/api/sessions/${compatibilitySessionId}/audio-captures`, { token: professorToken })
  ]);
  assert(camera.response.ok && screen.response.ok && audio.response.ok &&
    camera.body.length === 1 && screen.body.length === 1 && audio.body.length === 1,
  'Legacy JSON capture metadata was not available to the professor view.');
  const audioMetadata = JSON.parse(audio.body[0].metadata_json);
  assert(audioMetadata.level_dbfs === -31.2,
    'Legacy audio anomaly metadata was not preserved.');
}

async function testServerCaptureLimits(student) {
  const camera = await request('/api/camera/capture', {
    method: 'POST',
    token: student.token,
    headers: {
      'X-Session-Id': String(student.sessionId),
      'X-Capture-Id': randomUUID(),
      'Content-Type': 'image/jpeg',
      'X-Capture-Metadata': JSON.stringify({ face_count: 1, skin_pixels: 20 })
    },
    body: jpeg
  });
  const screen = await request(`/api/sessions/${student.sessionId}/screen-capture`, {
    method: 'POST',
    token: student.token,
    headers: {
      'X-Capture-Id': randomUUID(),
      'X-Capture-Trigger': 'tab-switch',
      'Content-Type': 'image/jpeg'
    },
    body: jpeg
  });
  assert(camera.response.ok && camera.body.success && camera.body.limited &&
    screen.response.ok && screen.body.success && screen.body.limited,
  `The server did not enforce capture limits: camera=${JSON.stringify(camera.body)}, screen=${JSON.stringify(screen.body)}.`);
}

async function testFailureNotification(student) {
  const captureId = randomUUID();
  const { response, body } = await request(`/api/sessions/${student.sessionId}/media-upload-failures`, {
    method: 'POST',
    token: student.token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      capture_id: captureId,
      capture_type: 'camera',
      message: 'Load-test permanent failure',
      attempts: 4
    })
  });
  assert(response.ok && body.success, 'Student could not persist a permanent-upload failure notification.');

  const prof = tokenFor(professorId);
  const failures = await request(`/api/exams/${examId}/media-upload-failures`, { token: prof });
  assert(failures.response.ok &&
    failures.body.some(item => item.capture_id === captureId && String(item.session_id) === String(student.sessionId)),
  'Professor dashboard could not retrieve the failed-upload notification.');
}

async function runLoad() {
  await seedData();
  const retryPolicy = await testRetryPolicy();
  await testPermanentUploadValidation(studentIds[0]);
  await testUploadOwnership(studentIds[0], studentIds[1]);
  await testStudentSessions();
  await testLegacyJsonCompatibility();
  await executeTestDb({
    sql: 'DELETE FROM camera_captures WHERE session_id = ?',
    args: [compatibilitySessionId]
  });
  await executeTestDb({
    sql: 'DELETE FROM exam_sessions WHERE id = ?',
    args: [compatibilitySessionId]
  });
  compatibilitySessionId = null;

  const baselineBytes = databaseSizeBytes();
  db.close();
  db = null;
  const uploadsByStudent = studentIds.map(student => [
    ...Array.from({ length: 5 }, (_, index) => () => upload(student, 'screen', index)),
    ...Array.from({ length: 10 }, (_, index) => () => upload(student, 'camera', index)),
    ...Array.from({ length: 2 }, (_, index) => () => upload(student, 'audio', index))
  ]);
  const pendingUploads = uploadsByStudent.map(async jobs => {
    for (let offset = 0; offset < jobs.length; offset += 3) {
      await Promise.all(jobs.slice(offset, offset + 3).map(job => job()));
    }
  });
  const professorDashboardPromise = (async () => {
    const started = performance.now();
    const result = await request(`/api/exams/${examId}/sessions`, {
      token: tokenFor(professorId)
    });
    return { result, durationMs: performance.now() - started };
  })();
  const tabSwitchesPromise = Promise.all(studentIds.map(student => request(
    `/api/sessions/${student.sessionId}/tab-switches`,
    { method: 'POST', token: student.token }
  )));

  const concurrentResults = await Promise.allSettled([
    professorDashboardPromise,
    tabSwitchesPromise,
    ...pendingUploads
  ]);
  const failedConcurrentWork = concurrentResults.find(result => result.status === 'rejected');
  if (failedConcurrentWork) throw failedConcurrentWork.reason;
  const professorDashboard = concurrentResults[0].value.result;
  const dashboardDurationMs = concurrentResults[0].value.durationMs;
  const tabSwitches = concurrentResults[1].value;
  assert(professorDashboard.response.ok && professorDashboard.body.length === 20,
    'Professor session dashboard was unavailable during concurrent uploads.');
  assert(tabSwitches.every(item => item.response.ok), 'Concurrent flag notification requests failed.');
  await testServerCaptureLimits(studentIds[0]);

  const duplicateCandidate = allCaptureIds.camera[0];
  const duplicates = await Promise.all(Array.from({ length: 10 }, async () => {
    const { captureId, sessionId } = duplicateCandidate;
    const student = studentIds.find(candidate => candidate.sessionId === sessionId);
    const headers = {
      Authorization: `Bearer ${student.token}`,
      'X-Session-Id': String(sessionId),
      'X-Capture-Id': captureId,
      'Content-Type': 'image/jpeg',
      'X-Capture-Metadata': JSON.stringify({ face_count: 1, skin_pixels: 20, flagged: false })
    };
    const result = await request('/api/camera/capture', { method: 'POST', headers, body: jpeg });
    return result;
  }));
  assert(duplicates.every(item => item.response.ok && item.body.success && item.body.duplicate),
    'Concurrent duplicate upload requests were not idempotent.');

  await testFailureNotification(studentIds[0]);

  const professorToken = tokenFor(professorId);
  const [cameraResponse, screenResponse, audioResponse] = await Promise.all([
    request(`/api/sessions/${studentIds[0].sessionId}/captures`, { token: professorToken }),
    request(`/api/sessions/${studentIds[0].sessionId}/screen-captures`, { token: professorToken }),
    request(`/api/sessions/${studentIds[0].sessionId}/audio-captures`, { token: professorToken })
  ]);
  assert(cameraResponse.response.ok && screenResponse.response.ok && audioResponse.response.ok,
    'Professor media metadata queries failed.');
  assert(cameraResponse.body.length === 10 && screenResponse.body.length === 5 && audioResponse.body.length === 2,
    'A session did not persist its full media capture allocation.');
  assert(!Object.prototype.hasOwnProperty.call(cameraResponse.body[0], 'image_data'),
    'Capture list returned embedded image data instead of metadata only.');

  const mediaUrl = cameraResponse.body[0].media_url;
  const mediaResponse = await fetch(new URL(mediaUrl, baseUrl), {
    headers: { Authorization: `Bearer ${professorToken}` }
  });
  const mediaBytes = Buffer.from(await mediaResponse.arrayBuffer());
  assert(mediaResponse.ok && mediaBytes.equals(jpeg),
    `Professor could not retrieve the persisted screenshot BLOB (HTTP ${mediaResponse.status}, ${mediaBytes.length} bytes).`);

  db = createClient({ url: databaseUrl, authToken: process.env.TURSO_AUTH_TOKEN || 'local-test' });
  const dbRows = await executeTestDb({
    sql: `SELECT capture_type, capture_id, COUNT(*) AS duplicates
          FROM camera_captures
          WHERE session_id IN (${sessionIds.map(() => '?').join(',')})
          GROUP BY capture_type, capture_id`,
    args: sessionIds
  });
  const expectedRows = { camera: 200, screen: 100, audio: 40 };
  const counts = { camera: 0, screen: 0, audio: 0 };
  let duplicateRows = 0;
  const persistedIds = new Set();
  for (const row of dbRows.rows) {
    counts[row.capture_type] = (counts[row.capture_type] || 0) + Number(row.duplicates);
    if (Number(row.duplicates) > 1) duplicateRows += Number(row.duplicates) - 1;
    persistedIds.add(row.capture_id);
  }
  for (const [type, expected] of Object.entries(expectedRows)) {
    assert(counts[type] === expected, `Expected ${expected} ${type} captures but found ${counts[type]}.`);
    const missingIds = allCaptureIds[type].filter(item => !persistedIds.has(item.captureId));
    assert(missingIds.length === 0, `Missing ${missingIds.length} ${type} capture(s).`);
  }
  assert(duplicateRows === 0, `Database contains ${duplicateRows} duplicate capture row(s).`);

  const [statsResult, tabSwitchResult] = await Promise.all([
    request('/api/admin/media-upload-stats', {
      token: (await request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
      })).body.token
    }),
    request(`/api/exams/${examId}/tab-switches`, { token: professorToken })
  ]);
  assert(statsResult.response.ok, 'Admin upload statistics endpoint was unavailable.');
  assert(statsResult.body.maxConcurrentWrites <= statsResult.body.concurrencyLimit,
    'Media write concurrency exceeded its configured limit.');
  assert(tabSwitchResult.response.ok && tabSwitchResult.body.length === 20,
    'The professor archive did not include all simultaneous tab-switch notifications.');

  const finalBytes = databaseSizeBytes();
  const durations = timings.map(item => item.durationMs).sort((a, b) => a - b);
  const average = timings.reduce((sum, item) => sum + item.durationMs, 0) / timings.length;
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  const max = durations[durations.length - 1];
  console.log(JSON.stringify({
    students: studentIds.length,
    concurrentUploads: timings.length,
    expectedCaptures: expectedRows,
    persistedCaptures: counts,
    uploadSuccessRate: '100%',
    averageUploadMs: Number(average.toFixed(2)),
    p95UploadMs: Number(p95.toFixed(2)),
    maxUploadMs: Number(max.toFixed(2)),
    professorDashboardDuringUploadsMs: Number(dashboardDurationMs.toFixed(2)),
    sqliteBusyRetries: statsResult.body.busyRetries,
    transientRetries: statsResult.body.transientRetries,
    injectedTransientRetryAttempts: retryPolicy.transientAttempts,
    permanentValidationAttempts: retryPolicy.permanentAttempts,
    serverMaxConcurrentWrites: statsResult.body.maxConcurrentWrites,
    configuredWriteConcurrency: statsResult.body.concurrencyLimit,
    duplicateRows,
    missingCaptures: 0,
    databaseGrowthBytes: baselineBytes === null || finalBytes === null ? null : finalBytes - baselineBytes,
    simultaneousTabSwitchNotifications: tabSwitchResult.body.length
  }, null, 2));
}

async function cleanupTestData() {
  if (!db) db = createClient({ url: databaseUrl, authToken: process.env.TURSO_AUTH_TOKEN || 'local-test' });
  const statements = [];
  if (examId) {
    statements.push(
      ['DELETE FROM media_upload_failures WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)', [examId]],
      ['DELETE FROM tab_switches WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)', [examId]],
      ['DELETE FROM camera_captures WHERE session_id IN (SELECT id FROM exam_sessions WHERE exam_id = ?)', [examId]],
      ['DELETE FROM exam_sessions WHERE exam_id = ?', [examId]],
      ['DELETE FROM exam_enrollments WHERE exam_id = ?', [examId]],
      ['DELETE FROM exams WHERE id = ?', [examId]]
    );
  }
  if (studentIds.length) {
    statements.push(
      ['DELETE FROM students WHERE id IN (' + studentIds.map(() => '?').join(',') + ')', studentIds.map(item => item.studentId)],
      ['DELETE FROM users WHERE id IN (' + studentIds.map(() => '?').join(',') + ')', studentIds.map(item => item.userId)]
    );
  }
  if (sectionId) statements.push(['DELETE FROM sections WHERE id = ?', [sectionId]]);
  if (professorId) statements.push(['DELETE FROM users WHERE id = ?', [professorId]]);

  const errors = [];
  for (const [sql, args] of statements) {
    try {
      await retryTransientWrite(() => db.execute({ sql, args }), { attempts: 8, baseDelayMs: 100 });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Unable to fully clean up media load-test records.');
}

let testError;
try {
  await runLoad();
} catch (error) {
  testError = error;
}

try {
  await cleanupTestData();
} catch (error) {
  if (testError) console.error('Load-test cleanup also failed:', error);
  else testError = error;
} finally {
  db.close();
}

if (testError) throw testError;
