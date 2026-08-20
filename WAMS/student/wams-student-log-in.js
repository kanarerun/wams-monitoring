
function togglePw(){
  const pw = document.getElementById('studentPassword');
  const btn = document.getElementById('togglePwBtn');
  if(pw.type === 'password'){
    pw.type = 'text';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  } else {
    pw.type = 'password';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  }
}

function handleLogin(e){
  e.preventDefault();
  const studentId = document.getElementById('studentId').value.trim();
  const studentPw = document.getElementById('studentPassword').value.trim();
  const errorEl = document.getElementById('errorMsg');

  if(studentId.length === 0 || studentPw.length === 0){
    errorEl.querySelector('span').textContent = 'Please enter both student number and password.';
    errorEl.classList.add('show');
    return false;
  }

// Validate with server
  fetch('/api/auth/student-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ student_id: studentId, access_code: studentPw })
  })
  .then(res => res.json())
  .then(data => {
    if(data.error){
      errorEl.querySelector('span').textContent = data.error;
      errorEl.classList.add('show');
    } else {
      // Store student info and exam data
      localStorage.setItem('wamsStudentId', data.student.student_id || data.student.id);
      localStorage.setItem('wamsStudentName', data.student.name);
      localStorage.setItem('wamsStudentSection', data.student.section_name || '');
      localStorage.setItem('wamsStudentCourse', data.student.course || '');
      localStorage.setItem('token', data.token);
      localStorage.setItem('examSessionId', data.exam.session_id);
      const safeParse = (v, fallback = {}) => {
        if (!v) return fallback;
        if (typeof v === 'object') return v;
        try { return JSON.parse(v); } catch { return fallback; }
      };

      localStorage.setItem('wamsExamData', JSON.stringify({
        id: data.exam.id,
        title: data.exam.title,
        timeLimit: data.exam.time_limit,
        type: data.exam.type,
        link: data.exam.link,
        questions: safeParse(data.exam.questions, []),
        monitor: safeParse(data.exam.monitor_settings, {}),
        tools: safeParse(data.exam.tools_settings, {})
      }));

      // Also store the full student object for reference
      localStorage.setItem('wamsStudentInfo', JSON.stringify({
        id: data.student.id,
        student_id: data.student.student_id,
        name: data.student.name,
        section_name: data.student.section_name,
        course: data.student.course,
        year_level: data.student.year_level,
        status: data.student.status,
        access_code: data.student.access_code
      }));

      // Redirect to exam
      const examUrl = data.exam.type === 'wams-quiz'
        ? 'wams-student-exam-tool.html?examId=' + data.exam.id
        : 'wams-student-exam-tool-gform.html?examId=' + data.exam.id + '&gform=' + encodeURIComponent(data.exam.link || '');
      window.location.href = examUrl;
    }
  })
  .catch(err => {
    // Fallback: Check if there's a locally stored exam
    const localExams = JSON.parse(localStorage.getItem('wamsProfessorExams') || '[]');
    const activeExam = localExams.find(e => e.status === 'live' || e.status === 'scheduled');

    if(activeExam){
      // Use local exam data for testing
      localStorage.setItem('wamsStudentId', Date.now());
      localStorage.setItem('wamsStudentName', 'Student');
      localStorage.setItem('wamsExamData', JSON.stringify({
        id: activeExam.id,
        title: activeExam.title,
        timeLimit: activeExam.timeLimit,
        type: activeExam.type,
        link: activeExam.link,
        questions: activeExam.questions || [],
        monitor: activeExam.monitor || {},
        tools: activeExam.tools || {}
      }));
      if(activeExam.type === 'gforms' && activeExam.link){
        window.location.href = 'wams-student-exam-tool-gform.html?examId=' + activeExam.id + '&gform=' + encodeURIComponent(activeExam.link);
      } else {
        window.location.href = 'wams-student-exam-tool.html?examId=' + activeExam.id;
      }
    } else {
      errorEl.querySelector('span').textContent = 'Unable to connect to server. Please ensure the server is running or create an exam in My Exams first.';
      errorEl.classList.add('show');
    }
  });

  return false;
}
