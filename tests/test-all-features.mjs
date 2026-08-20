export default async function run(page, ui) {
  // 1. Authenticate as professor and fetch student session data
  const testResults = await page.evaluate(async () => {
    // Professor login
    const profLogin = await fetch('/api/auth/professor-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ faculty_id: 'FAC-2026-01', access_code: 'PROF-2026' })
    }).then(r => r.json());

    // Student login
    const studentLogin = await fetch('/api/auth/student-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: '2026-00001', access_code: 'EXAM-SEC2026' })
    }).then(r => r.json());

    const sessionId = studentLogin.exam.session_id;
    const studentToken = studentLogin.token;
    const profToken = profLogin.token;

    // Send sample audio clip data URL + sample camera image + sample screen image
    const sampleImg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const sampleAudio = 'data:audio/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAHTEU2bdLpnu4tTq4QVSalmU6yuyuvEAAA=';

    await fetch('/api/camera/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({ session_id: sessionId, image: sampleImg, face_count: 1, skin_pixels: 400, flagged: false })
    });

    await fetch('/api/sessions/' + sessionId + '/screen-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({ image: sampleImg })
    });

    await fetch('/api/sessions/' + sessionId + '/audio-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({ audio_clip: sampleAudio, audio_data: JSON.stringify({ level: 50, flagged: true, audio_clip: sampleAudio }), level: 50, flagged: true })
    });

    return {
      sessionCreated: sessionId,
      studentName: studentLogin.student.name
    };
  });

  return testResults;
}
