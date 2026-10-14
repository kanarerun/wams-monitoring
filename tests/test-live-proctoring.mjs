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
    const camRes = await fetch('/api/camera/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({
        session_id: sessionId,
        image: sampleImg,
        face_count: 1,
        skin_pixels: 450,
        flagged: false
      })
    }).then(r => r.json());

    // 5. Send continuous periodic audio capture
    const audioRes = await fetch('/api/sessions/' + sessionId + '/audio-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({
        audio_data: JSON.stringify({ level: 25, flagged: false }),
        level: 25,
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

    const screenList = await fetch('/api/sessions/' + sessionId + '/screen-captures', {
      headers: { 'Authorization': 'Bearer ' + profToken }
    }).then(r => r.json());

    const audioList = await fetch('/api/sessions/' + sessionId + '/audio-captures', {
      headers: { 'Authorization': 'Bearer ' + profToken }
    }).then(r => r.json());

    return {
      cameraCapturesCount: camList.length,
      screenCapturesCount: screenList.length,
      audioCapturesCount: audioList.length,
      tabSwitchArchived,
      sessionId
    };
  });

  return result;
}
