
/* ── Auth Guard ── */
(async function checkProfessorAuth(){
  const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
  if(!token){
    window.location.href = 'wams-professor-log-in.html';
    return;
  }
  try {
    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if(!res.ok){
      localStorage.removeItem('wamsToken');
      localStorage.removeItem('token');
      window.location.href = 'wams-professor-log-in.html';
      return;
    }
    const me = await res.json();
    if(me && me.role !== 'professor'){ window.location.href = 'wams-professor-log-in.html'; return; }
    // Populate professor name
    if(me && me.name){
      localStorage.setItem('wamsProfessorName', me.name);
    }
  } catch {}
})();

function toggleSb(){
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}

async function loadExams(){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return [];
    const res = await fetch('/api/my-exams', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(res.status === 401){
      localStorage.clear();
      window.location.href = "wams-professor-log-in.html";
      return [];
    }
    if(!res.ok) return [];
    const data = await res.json();
    const exams = await Promise.all(
      data.map(async (ex) => ({
        id: ex.id,
        title: ex.title,
        section: ex.section_name || ex.section || 'General',
        students: ex.students || 0,
        status: ex.status,
        type: ex.type,
        created: new Date(ex.created_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        }),
        flagged: await getRealFlaggedCount(ex.id),
        timeLimit: ex.time_limit || 60,
        schedule: ex.schedule || '',
        link: ex.link || '',
        accessCode: ex.access_code || 'N/A'
      }))
    );
    return exams;

  } catch (err) {
    console.error(err);
    return [];
  }
}

async function getRealFlaggedCount(examId){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return 0;
    const res = await fetch('/api/exams/' + examId + '/tab-switches', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return 0;
    const data = await res.json();
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

async function getDashboardState(){
  const exams = await loadExams();
  const liveExams = exams.filter(exam => exam.status === 'live').length;
  const studentsOnline = exams
    .filter(exam => exam.status === 'live')
    .reduce((sum, exam) => sum + (Number(exam.students) || 0), 0);
  const totalExams = exams.length;
  const activeSections = new Set(exams.map(exam => exam.section).filter(Boolean)).size;

  const flaggedCount = exams.reduce((sum, exam) => sum + (exam.flagged || 0), 0);
  const liveMonitorCount = exams.filter(ex => ['live', 'upcoming', 'scheduled'].includes(ex.status)).length;
  const endedExams = exams.filter(exam => exam.status === 'ended').length;

  const loggedInUser = localStorage.getItem('wamsProfessorName') || '';

  return {
    professorName: loggedInUser,
    liveExams,
    studentsOnline,
    totalExams,
    activeSections,
    flaggedCount,
    liveMonitorCount,
    endedExams,
    recentFlags: exams
      .filter(exam => (exam.flagged || 0) > 0)
      .slice(0, 5)
      .map(exam => ({
        title: exam.title,
        section: exam.section,
        status: exam.status,
        students: exam.students || 0
      })),
    actionTasks: getDashboardTasks(exams)
  };
}

function getDashboardTasks(exams){
  const tasks = [];
  const liveExams = exams.filter(exam => exam.status === 'live');
  const upcomingExams = exams.filter(exam => ['upcoming', 'scheduled'].includes(exam.status));
  const endedExams = exams.filter(exam => exam.status === 'ended');
  const totalFlagged = exams.reduce((sum, exam) => sum + (exam.flagged || 0), 0);
  const activeStudents = liveExams.reduce((sum, exam) => sum + (Number(exam.students) || 0), 0);

  if(totalFlagged > 0){
    tasks.push({
      type: 'flagged',
      title: `Review ${totalFlagged} flagged ${totalFlagged === 1 ? 'activity' : 'activities'}`,
      sub: `${liveExams.length} live exam${liveExams.length === 1 ? '' : 's'}`,
      action: 'wams-professor-live-monitor.html'
    });
  }

  if(upcomingExams.length){
    const next = upcomingExams[0];
    const starts = next.schedule ? humanizeSchedule(next.schedule) : 'starts soon';
    tasks.push({
      type: 'upcoming',
      title: `${next.title} — ${starts}`,
      sub: `${next.section} · ${next.students || 0} students`,
      action: 'wams-professor-my-exam.html'
    });
  }

  if(endedExams.length){
    const reportExam = endedExams[0];
    tasks.push({
      type: 'report',
      title: `Generate report for ${reportExam.title}`,
      sub: `${reportExam.section} · ${reportExam.students || 0} students`,
      action: 'wams-professor-my-exam.html'
    });
  }

  if(activeStudents > 0 && tasks.length < 3){
    tasks.push({
      type: 'monitor',
      title: `Monitor ${activeStudents} active student${activeStudents === 1 ? '' : 's'}`,
      sub: `${liveExams.length} live exam${liveExams.length === 1 ? '' : 's'} currently running`,
      action: 'wams-professor-live-monitor.html'
    });
  }

  if(tasks.length === 0){
    tasks.push({
      type: 'empty',
      title: 'No current action items',
      sub: 'Create an exam or start a live session to populate this list.',
      action: 'wams-professor-create-exam.html'
    });
  }

  return tasks.slice(0, 4);
}

function renderFromCache(){
  try {
    const cached = localStorage.getItem('wamsDashboardState');
    if(!cached) return false;
    const state = JSON.parse(cached);
    applyDashboardState(state);
    return true;
  } catch { return false; }
}

function applyDashboardState(state){
  const welcomeTitle = document.getElementById('welcomeTitle');
  if(welcomeTitle){ welcomeTitle.textContent = `Welcome back, ${state.professorName}`; }

  const liveValue = document.getElementById('liveExamsValue');
  if(liveValue){ liveValue.textContent = state.liveExams; }

  const liveDetail = document.getElementById('liveExamsDetail');
  if(liveDetail){ liveDetail.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>${state.studentsOnline} students online`; }

  const totalValue = document.getElementById('totalExamsValue');
  if(totalValue){ totalValue.textContent = state.totalExams; }

  const totalDetail = document.getElementById('totalExamsDetail');
  if(totalDetail){ totalDetail.textContent = `${state.activeSections} sections this term`; }

  const alertEl = document.getElementById('alertEl');
  if(alertEl){ alertEl.style.display = state.flaggedCount > 0 ? 'flex' : 'none'; }

  const alertCount = document.getElementById('flagAlertCount');
  if(alertCount){ alertCount.textContent = state.flaggedCount; }

  const liveMonitorBadge = document.querySelector('.sb-item[href="wams-professor-live-monitor.html"] .sb-badge.green');
  if(liveMonitorBadge){ liveMonitorBadge.textContent = state.liveMonitorCount; }

  const logsBadge = document.querySelector('.sb-item[href="wams-professor-monitoring-logs.html"] .sb-badge');
  if(logsBadge){ logsBadge.textContent = state.endedExams; }
}

async function renderDashboard(){
  const state = await getDashboardState();
  try { localStorage.setItem('wamsDashboardState', JSON.stringify(state)); } catch {}
  applyDashboardState(state);

  const welcomeTitle = document.getElementById('welcomeTitle');
  if(welcomeTitle){ welcomeTitle.textContent = `Welcome back, ${state.professorName}`; }

  const liveValue = document.getElementById('liveExamsValue');
  if(liveValue){ liveValue.textContent = state.liveExams; }

  const liveDetail = document.getElementById('liveExamsDetail');
  if(liveDetail){ liveDetail.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>${state.studentsOnline} students online`; }

  const totalValue = document.getElementById('totalExamsValue');
  if(totalValue){ totalValue.textContent = state.totalExams; }

  const totalDetail = document.getElementById('totalExamsDetail');
  if(totalDetail){ totalDetail.textContent = `${state.activeSections} sections this term`; }

  const alertEl = document.getElementById('alertEl');
  if(alertEl){ alertEl.style.display = state.flaggedCount > 0 ? 'flex' : 'none'; }

  const alertCount = document.getElementById('flagAlertCount');
  if(alertCount){ alertCount.textContent = state.flaggedCount; }

  const liveMonitorBadge = document.querySelector('.sb-item[href="wams-professor-live-monitor.html"] .sb-badge.green');
  if(liveMonitorBadge){ liveMonitorBadge.textContent = state.liveMonitorCount; }

  const logsBadge = document.querySelector('.sb-item[href="wams-professor-monitoring-logs.html"] .sb-badge');
  if(logsBadge){ logsBadge.textContent = state.endedExams; }

  const recentFlagsList = document.getElementById('recentFlagsList');
  if(recentFlagsList){
    if(state.recentFlags.length){
      recentFlagsList.innerHTML = state.recentFlags.map((flag, index) => `
        <li class="act-item">
          <span class="act-dot" style="background:${index % 2 === 0 ? 'var(--red)' : 'var(--amber)'}"></span>
          <div class="act-body">
            <div class="act-txt"><b>${flag.title}</b> · ${flag.status.toUpperCase()}</div>
            <div class="act-time">${flag.students} students · ${flag.section}</div>
          </div>
        </li>
      `).join('');
    } else {
      recentFlagsList.innerHTML = '<li class="act-item"><div class="act-body"><div class="act-txt">No recent flags yet.</div><div class="act-time">Create an exam to start monitoring.</div></div></li>';
    }
  }

const dashboardExamTbody = document.getElementById('dashboardExamTbody');
  if(dashboardExamTbody){
    if(state.totalExams === 0){
      dashboardExamTbody.innerHTML = '<tr><td colspan="4"><div class="empty-state">No exams created yet.</div></td></tr>';
    } else {
      const exams = await loadExams();
      dashboardExamTbody.innerHTML = exams.slice(0, 5).map(exam => `
        <tr>
          <td>${exam.title}</td>
          <td style="color:var(--tx2)">${exam.section}</td>
          <td style="color:var(--tx2)">${exam.students || 0}</td>
          <td><span class="bdg ${exam.status === 'live' ? 'bdg-green' : exam.status === 'upcoming' ? 'bdg-amber' : exam.status === 'ended' ? 'bdg-gray' : 'bdg-blue'}">${exam.status === 'live' ? '<span class="pulse"></span>Live' : exam.status === 'upcoming' ? 'Upcoming' : exam.status === 'ended' ? 'Ended' : 'Scheduled'}</span></td>
        </tr>
      `).join('');
    }
  }

  const actionList = document.getElementById('dashboardActionList');
  if(actionList){
    actionList.innerHTML = state.actionTasks.map(task => {
      const icons = {
        flagged: {bg:'var(--red-bg)', color:'var(--red)', svg:'<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'},
        upcoming: {bg:'var(--amber-bg)', color:'var(--amber)', svg:'<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'},
        report: {bg:'var(--blue-bg)', color:'var(--blue)', svg:'<svg viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>'},
        monitor: {bg:'var(--purple-bg)', color:'var(--purple)', svg:'<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>'},
        empty: {bg:'var(--gray-bg)', color:'var(--tx3)', svg:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="1"/></svg>'}
      };
      const icon = icons[task.type] || icons.empty;
      return `
        <li class="task-item">
          <div class="task-ic" style="background:${icon.bg};color:${icon.color}">${icon.svg}</div>
          <div class="task-body">
            <div class="task-title">${task.title}</div>
            <div class="task-sub">${task.sub}</div>
          </div>
          <button class="ghost-btn" onclick="window.location.href='${task.action}'">Open</button>
        </li>
      `;
    }).join('');
  }
}

function nav(e,el){
  e.preventDefault();
  document.querySelectorAll('.sb-item').forEach(i=>i.classList.remove('active'));
  el.classList.add('active');
}

const ranges = ['This Week','This Month','This Semester'];
let ri = 1;
function cycleRange(btn){
  ri = (ri+1)%ranges.length;
  btn.textContent = ranges[ri]+' ▾';
}

let chart = null;

async function initChart(){
  const chartData = await buildChartData();
  const ctx = document.getElementById('chart');
  if(ctx && !chart){
    chart = new Chart(ctx.getContext('2d'), {
      type:'bar',
      data: {
        labels: chartData.labels,
        datasets: [
          {
            label: 'Tab Switching',
            data: chartData.tabData,
            backgroundColor: 'rgba(37,99,235,0.72)',
            borderRadius: 5,
            borderSkipped: false
          },
          {
            label: 'Multiple Faces',
            data: chartData.faceData,
            backgroundColor: 'rgba(220,38,38,0.72)',
            borderRadius: 5,
            borderSkipped: false
          },
          {
            label: 'Audio Anomalies',
            data: chartData.audioData,
            backgroundColor: 'rgba(217,119,6,0.72)',
            borderRadius: 5,
            borderSkipped: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              font: {size: 11, family: 'Inter'},
              boxWidth: 10, padding: 14,
              color: '#4A5578'
            }
          },
          tooltip: { mode: 'index', intersect: false }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: {size: 11, family: 'Inter'}, color: '#8B93B0' }
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(0,0,0,0.04)' },
            ticks: { font: {size: 11, family: 'Inter'}, color: '#8B93B0', stepSize: 2 }
          }
        }
      }
    });
  }
}

async function updateChart(){
  if(!chart) return;
  const chartData = await buildChartData();
  chart.data.labels = chartData.labels;
  chart.data.datasets[0].data = chartData.tabData;
  chart.data.datasets[1].data = chartData.faceData;
  chart.data.datasets[2].data = chartData.audioData;
  chart.update();
}

(async () => {
  renderFromCache();
  await renderDashboard();
  await initChart();
  window.addEventListener('storage', async () => {
    await renderDashboard();
    await updateChart();
  });
})();

async function buildChartData(){
  const exams = await loadExams();
  const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
  const now = new Date();
  const labels = [];
  const tabData = [0, 0, 0, 0, 0];
  const faceData = [0, 0, 0, 0, 0];
  const audioData = [0, 0, 0, 0, 0];

  // Generate last 5 weeks
  for(let i = 4; i >= 0; i--){
    const d = new Date(now);
    d.setDate(d.getDate() - (i * 7));
    labels.push(d.toLocaleDateString('en-US', { month:'short', day:'numeric' }));
  }

  if (token && exams.length > 0) {
    for (const exam of exams) {
      try {
        const tsRes = await fetch(`/api/exams/${exam.id}/tab-switches`, { headers: { 'Authorization': 'Bearer ' + token } });
        if (tsRes.ok) {
          const switches = await tsRes.json();
          if (Array.isArray(switches)) {
            switches.forEach(sw => {
              const entryDate = new Date(sw.switched_at);
              const weekDiff = Math.floor((now - entryDate) / (7 * 24 * 60 * 60 * 1000));
              if (weekDiff >= 0 && weekDiff < 5) {
                tabData[4 - weekDiff] = (tabData[4 - weekDiff] || 0) + 1;
              }
            });
          }
        }

        const sessRes = await fetch(`/api/exams/${exam.id}/sessions`, { headers: { 'Authorization': 'Bearer ' + token } });
        if (sessRes.ok) {
          const sessions = await sessRes.json();
          if (Array.isArray(sessions)) {
            for (const sess of sessions) {
              const capRes = await fetch(`/api/sessions/${sess.id}/captures`, { headers: { 'Authorization': 'Bearer ' + token } });
              if (capRes.ok) {
                const caps = await capRes.json();
                if (Array.isArray(caps)) {
                  caps.filter(c => c.flagged).forEach(c => {
                    const entryDate = new Date(c.captured_at);
                    const weekDiff = Math.floor((now - entryDate) / (7 * 24 * 60 * 60 * 1000));
                    if (weekDiff >= 0 && weekDiff < 5) {
                      faceData[4 - weekDiff] = (faceData[4 - weekDiff] || 0) + 1;
                    }
                  });
                }
              }

              const audRes = await fetch(`/api/sessions/${sess.id}/audio-captures`, { headers: { 'Authorization': 'Bearer ' + token } });
              if (audRes.ok) {
                const auds = await audRes.json();
                if (Array.isArray(auds)) {
                  auds.filter(a => a.flagged).forEach(a => {
                    const entryDate = new Date(a.captured_at);
                    const weekDiff = Math.floor((now - entryDate) / (7 * 24 * 60 * 60 * 1000));
                    if (weekDiff >= 0 && weekDiff < 5) {
                      audioData[4 - weekDiff] = (audioData[4 - weekDiff] || 0) + 1;
                    }
                  });
                }
              }
            }
          }
        }
      } catch(e) {}
    }
  }

  return { labels, tabData, faceData, audioData };
}

function getTabSwitchData(examId){
  try {
    const stored = localStorage.getItem('wamsTabSwitch_' + examId);
    if(stored) return JSON.parse(stored);
  } catch {}
  return null;
}

async function confirmLogout(event){
    event.preventDefault();

    if(!confirm("Are you sure you want to sign out?")) return;

    localStorage.removeItem("token");
    localStorage.removeItem("wamsToken");
    localStorage.removeItem("wamsProfessorName");

    window.location.href = "wams-professor-log-in.html";
}

function humanizeSchedule(iso){
  if(!iso) return 'starts soon';
  const ts = Date.parse(iso);
  if(isNaN(ts)) return 'starts soon';
  const diff = ts - Date.now();
  if(diff <= 0) return 'starts now';
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if(days > 0) return `starts in ${days} day${days>1?'s':''}`;
  if(hours > 0) return `starts in ${hours} hr${hours>1?'s':''}`;
  return `starts in ${Math.max(1, minutes)} min${minutes>1?'s':''}`;
}