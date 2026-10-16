export default async function run(page, ui) {
  const result = await page.evaluate(async () => {
    // 1. Professor login
    const profLogin = await fetch('/api/auth/professor-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ faculty_id: 'FAC-2026-01', access_code: 'PROF-2026' })
    }).then(r => r.json());

    // 2. Student login
    const studentLogin = await fetch('/api/auth/student-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: '2026-00001', access_code: 'EXAM-SEC2026' })
    }).then(r => r.json());

    const studentToken = studentLogin.token;
    const sessionId = studentLogin.exam.session_id;
    const examId = studentLogin.exam.id;
    const profToken = profLogin.token;
    const loginTimeRemaining = studentLogin.exam.time_remaining_seconds;
    const configuredTimeSeconds = Number(studentLogin.exam.time_limit) * 60;
    if (!Number.isFinite(loginTimeRemaining) || loginTimeRemaining < 0 || loginTimeRemaining > configuredTimeSeconds) {
      throw new Error('Student login did not return a valid remaining exam time.');
    }

    // 3. Record a tab switch and verify it appears in the exam archive query
    const tabSwitchRes = await fetch('/api/sessions/' + sessionId + '/tab-switches', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + studentToken }
    });
    if (!tabSwitchRes.ok) throw new Error('Tab-switch POST failed: ' + tabSwitchRes.status);
    const insertedTabSwitch = await tabSwitchRes.json();
    const tabSwitchListRes = await fetch('/api/exams/' + examId + '/tab-switches', {
      headers: { 'Authorization': 'Bearer ' + profToken }
    });
    if (!tabSwitchListRes.ok) throw new Error('Tab-switch archive GET failed: ' + tabSwitchListRes.status);
    const tabSwitchList = await tabSwitchListRes.json();
    const tabSwitchArchived = tabSwitchList.some(item =>
      String(item.id) === String(insertedTabSwitch.id) && String(item.session_id) === String(sessionId)
    );
    if (!tabSwitchArchived) throw new Error('Recorded tab switch did not appear in exam archive.');

    // 4. Send test camera snapshot
    const sampleImg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const detectionData = {
      face_detector: 'face-api.js TinyFaceDetector',
      face_count: 1,
      object_detector: 'MediaPipe EfficientDet-Lite0',
      detections: [{ label: 'cell phone', score: 0.87 }],
      phone_detected: true,
      flagged_reasons: ['possible_phone']
    };
    const camRes = await fetch('/api/camera/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({
        session_id: sessionId,
        image: sampleImg,
        face_count: 1,
        skin_pixels: 450,
        flagged: true,
        detection_data: detectionData
      })
    }).then(r => r.json());

    // 5. Send continuous periodic audio capture
    const audioRes = await fetch('/api/sessions/' + sessionId + '/audio-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({
        audio_data: JSON.stringify({
          level_dbfs: -31.2,
          event: 'possible_audio_activity',
          flagged: false
        }),
        flagged: false
      })
    }).then(r => r.json());

    // 6. Send periodic screen capture snapshot
    const screenRes = await fetch('/api/sessions/' + sessionId + '/screen-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({ image: sampleImg })
    }).then(r => r.json());

    // 7. Professor retrieves all 3 streams
    const camList = await fetch('/api/sessions/' + sessionId + '/captures', {
      headers: { 'Authorization': 'Bearer ' + profToken }
    }).then(r => r.json());
    const savedCapture = camList.find(item => String(item.id) === String(camRes.id));
    const savedDetectionData = typeof savedCapture?.detection_data === 'string'
      ? JSON.parse(savedCapture.detection_data)
      : savedCapture?.detection_data;
    if (camRes.id && savedDetectionData?.phone_detected !== true) {
      throw new Error('Camera detection metadata was not persisted.');
    }

    const screenList = await fetch('/api/sessions/' + sessionId + '/screen-captures', {
      headers: { 'Authorization': 'Bearer ' + profToken }
    }).then(r => r.json());

    const audioList = await fetch('/api/sessions/' + sessionId + '/audio-captures', {
      headers: { 'Authorization': 'Bearer ' + profToken }
    }).then(r => r.json());
    const savedAudio = audioList.find(item => String(item.id) === String(audioRes.id));
    const savedAudioData = typeof savedAudio?.image_data === 'string'
      ? JSON.parse(savedAudio.image_data)
      : savedAudio?.image_data;
    const audioMetadataSaved = savedAudioData?.level_dbfs === -31.2;
    if (audioRes.id && !audioMetadataSaved) {
      throw new Error('Audio level metadata was not persisted.');
    }

    return {
      cameraCapturesCount: camList.length,
      screenCapturesCount: screenList.length,
      audioCapturesCount: audioList.length,
      detectionMetadataSaved: savedDetectionData?.phone_detected === true,
      audioMetadataSaved,
      loginTimeRemaining,
      tabSwitchArchived,
      sessionId
    };
  });

  return result;
}
