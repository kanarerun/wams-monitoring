export default async function run(page, ui) {
  // 1. Login as default admin and ensure a section and student exist
  const adminRes = await page.evaluate(async () => {
    const login = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' })
    }).then(r => r.json());

    const token = login.token;

    // Create section
    const sec = await fetch('/api/sections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ name: 'BSIT 4-A', course: 'BSIT' })
    }).then(r => r.json());

    // Create student
    const student = await fetch('/api/students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ name: 'Juan Dela Cruz', studentId: '2026-00001', sectionId: sec.id, year: '4th Year' })
    }).then(r => r.json());

    // Create instructor
    const inst = await fetch('/api/instructors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ name: 'Prof. Alan Turing', faculty_id: 'FAC-2026-01', department: 'Computer Science', access_code: 'PROF-2026' })
    }).then(r => r.json());

    // Login as professor
    const profLogin = await fetch('/api/auth/professor-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ faculty_id: 'FAC-2026-01', access_code: 'PROF-2026' })
    }).then(r => r.json());

    const profToken = profLogin.token;

    // Create exam
    const exam = await fetch('/api/exams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + profToken },
      body: JSON.stringify({
        title: 'Network Security Midterm',
        section_id: sec.id,
        type: 'wams-quiz',
        time_limit: 60,
        accessCode: 'EXAM-SEC2026',
        questions: [{ text: 'What is HTTPS port?', qtype: 'mc', choices: ['80', '443', '22', '21'], correct: 1 }],
        monitor_settings: { cam: true, audio: true, screen: true, tab: true },
        tools_settings: { camera: true, calculator: true, whiteboard: true }
      })
    }).then(r => r.json());

    // Student logs in to take exam
    const studentLogin = await fetch('/api/auth/student-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: '2026-00001', access_code: 'EXAM-SEC2026' })
    }).then(r => r.json());

    const studentToken = studentLogin.token;
    const sessionId = studentLogin.exam.session_id;

    // Send sample camera capture
    const testImg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    const camRes = await fetch('/api/camera/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({
        session_id: sessionId,
        image: testImg,
        face_count: 1,
        skin_pixels: 500,
        flagged: false
      })
    }).then(r => r.json());

    // Send sample screen capture
    const screenRes = await fetch('/api/sessions/' + sessionId + '/screen-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({ image: testImg })
    }).then(r => r.json());

    // Send sample audio capture anomaly
    const audioRes = await fetch('/api/sessions/' + sessionId + '/audio-capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + studentToken },
      body: JSON.stringify({ audio_data: JSON.stringify({ level: 85 }), level: 85, flagged: true })
    }).then(r => r.json());

    // Verify professor can retrieve all 3 captures
    const captures = await fetch('/api/sessions/' + sessionId + '/captures', {
      headers: { 'Authorization': 'Bearer ' + profToken }
    }).then(r => r.json());

    const screenCaptures = await fetch('/api/sessions/' + sessionId + '/screen-captures', {
      headers: { 'Authorization': 'Bearer ' + profToken }
    }).then(r => r.json());

    const audioCaptures = await fetch('/api/sessions/' + sessionId + '/audio-captures', {
      headers: { 'Authorization': 'Bearer ' + profToken }
    }).then(r => r.json());

    return {
      camSaved: captures.length,
      screenSaved: screenCaptures.length,
      audioSaved: audioCaptures.length,
      examCreated: exam.id,
      sessionId
    };
  });

  return adminRes;
}
