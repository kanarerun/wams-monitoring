// ── Token Management Helpers ──
function getAuthToken(){
  return getAdminAuthToken();
}

function clearAuthSession(token = getAuthToken()){
  clearAdminAuthSession(token);
  localStorage.removeItem('currentUser');
  localStorage.removeItem('wamsCurrentUserId');
}

// ── Auth Guard ──
verifyAdminAuth();

// Raw dashboard lists cached so the View-all overlays and row clicks can
// resolve details without a second dashboard fetch.
const dashState = { recentUsers: [], activeExams: [] };

// ── Sidebar toggle
function toggleSb(){
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}

// ── Chart range cycle (demo)
const ranges = ['Current','All Time'];
let ri = 1;
function cycleRange(btn){
  ri = (ri+1)%ranges.length;
  btn.textContent = ranges[ri]+' ▾';
}

// ── Chart.js
const ctx = document.getElementById('chart').getContext('2d');
const chart = new Chart(ctx, {
  type: 'bar',
  data: {
    labels: ["Students", "Instructors", "Exams", "Flags"],
    datasets: [{
      label: "System Statistics",
      data: [0, 0, 0, 0],
      backgroundColor: [
        "rgba(37,99,235,.7)",
        "rgba(22,163,74,.7)",
        "rgba(217,119,6,.7)",
        "rgba(220,38,38,.7)"
      ],
      borderRadius: 6
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false
      },
      tooltip: { mode: 'index', intersect: false }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 11, family: 'Inter' }, color: '#8B93B0' }
      },
      y: {
        beginAtZero: true,
        grid: { color: 'rgba(0,0,0,0.04)' },
        ticks: { font: { size: 11, family: 'Inter' }, color: '#8B93B0', stepSize: 5 }
      }
    }
  }
});

function renderStatCards(stats) {
    document.getElementById("totalUsers").textContent = stats.totalUsers ?? 0;
    document.getElementById("totalStudents").textContent = stats.totalStudents ?? 0;
    document.getElementById("totalInstructors").textContent = stats.totalInstructors ?? 0;
    document.getElementById("totalExams").textContent = stats.totalExams ?? 0;
    document.getElementById("flaggedSessions").textContent = stats.flaggedSessions ?? 0;
    document.getElementById("adminName").textContent = stats.admin?.name || 'System Administrator';
    document.getElementById("adminRole").textContent = 'Admin';
    document.getElementById("flaggedAlert").textContent = `${stats.flaggedSessions ?? 0} flagged incidents`;

    const activeExamsList = Array.isArray(stats.activeExams) ? stats.activeExams : [];
    const activeExamsCount = activeExamsList.length;
    document.getElementById("flaggedLiveExams").textContent = activeExamsCount;
    document.getElementById("flaggedLiveExamsWrap").hidden = activeExamsCount === 0;
    document.getElementById("flaggedLiveExamsPlural").textContent = activeExamsCount === 1 ? '' : 's';
    document.getElementById("studentsSections").hidden = activeExamsCount === 0;
    document.getElementById("studentsSections").textContent = `Across ${activeExamsCount} section${activeExamsCount === 1 ? '' : 's'}`;

    document.getElementById("usersTrend").textContent = (stats.totalUsers || 0) > 0 ? `+${stats.totalUsers} this month` : 'No change';
    document.getElementById("instructorsTrend").textContent = (stats.totalInstructors || 0) > 0 ? `+${stats.totalInstructors} this term` : 'No change';
    document.getElementById("activeExamsTrend").textContent = (stats.liveExams || 0) > 0 ? `${stats.liveExams} live now` : 'No live exams';


}

function renderRecentActivity(activities) {
    const activityList = document.getElementById("activityList");
    if (!activityList) return;
    const items = Array.isArray(activities) ? activities : [];
    activityList.innerHTML = items.map(activity => `
        <li class="act-item">
            <span class="act-dot"></span>
            <div class="act-body">
                <div class="act-txt">${activity.message || ''}</div>
                <div class="act-time">${activity.time || ''}</div>
            </div>
        </li>
    `).join("");
}

function renderActiveExams(exams) {
    const activeExamsBody = document.getElementById("activeExamsBody");
    if (!activeExamsBody) return;
    const items = Array.isArray(exams) ? exams : [];
    dashState.activeExams = items;
    if (items.length === 0) {
        activeExamsBody.innerHTML = '<tr><td colspan="3" class="tbl-empty">No live or upcoming exams today.</td></tr>';
        return;
    }
    activeExamsBody.innerHTML = items.map((exam, idx) => {
        const status = String(exam.status || 'scheduled').toLowerCase();
        const badgeClass = status === 'live' ? 'bdg-green' : status === 'ended' ? 'bdg-red' : 'bdg-amber';
        return `
        <tr class="row-click" data-exam-idx="${idx}" title="View exam details">
            <td class='td-title'>${exam.title || 'Untitled Exam'}</td>
            <td>${exam.students ?? 0}</td>
            <td><span class="bdg ${badgeClass}"><span class="bdg-dot"></span>${status.charAt(0).toUpperCase() + status.slice(1)}</span></td>
        </tr>
    `;
    }).join("");
}

function renderRecentUsers(users) {
    const recentUsersBody = document.getElementById("recentUsersBody");
    if (!recentUsersBody) return;
    const items = Array.isArray(users) ? users : [];
    dashState.recentUsers = items;
    if (items.length === 0) {
        recentUsersBody.innerHTML = '<tr><td colspan="4" class="tbl-empty">No registered users yet.</td></tr>';
        return;
    }
    recentUsersBody.innerHTML = items.map((user, idx) => {
        const createdAtStr = user.created_at ? new Date(user.created_at).toLocaleDateString() : '—';
        const role = user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : '-';
        const acct = String(user.account_status || user.status || 'active').toLowerCase();
        const badgeClass = acct === 'pending' ? 'bdg-amber' : acct === 'suspended' || acct === 'rejected' ? 'bdg-red' : 'bdg-green';
        const label = acct === 'pending' ? 'Pending' : acct === 'suspended' ? 'Suspended' : acct === 'rejected' ? 'Rejected' : 'Active';
        return `
            <tr class="row-click" data-user-idx="${idx}" title="View user details">
                <td>${user.name || 'User'}</td>
                <td>${role}</td>
                <td>
                    <span class="bdg ${badgeClass}">
                        <span class="bdg-dot"></span>${label}
                    </span>
                </td>
                <td>${createdAtStr}</td>
            </tr>
        `;
    }).join("");
}

function renderSystemHealth(health) {
    if (!health) return;
    const cpu = health.cpu ?? 15;
    const mem = health.memory ?? 40;
    const db = health.database ?? 20;
    const net = health.network ?? 10;
    const storage = health.storage ?? 35;

    const cpuVal = document.getElementById("cpuVal");
    const cpuFill = document.getElementById("cpuFill");
    if (cpuVal) cpuVal.textContent = `${cpu}%`;
    if (cpuFill) cpuFill.style.width = `${cpu}%`;

    const memVal = document.getElementById("memVal");
    const memFill = document.getElementById("memFill");
    if (memVal) memVal.textContent = `${mem}%`;
    if (memFill) memFill.style.width = `${mem}%`;

    const dbVal = document.getElementById("dbVal");
    const dbFill = document.getElementById("dbFill");
    if (dbVal) dbVal.textContent = `${db}%`;
    if (dbFill) dbFill.style.width = `${db}%`;

    const netVal = document.getElementById("netVal");
    const netFill = document.getElementById("netFill");
    if (netVal) netVal.textContent = `${net}%`;
    if (netFill) netFill.style.width = `${net}%`;

    const storageVal = document.getElementById("storageVal");
    const storageFill = document.getElementById("storageFill");
    if (storageVal) storageVal.textContent = `${storage}%`;
    if (storageFill) storageFill.style.width = `${storage}%`;
}

function renderDashboardChart(stats) {
    if (!chart) return;
    chart.data.labels = ["Students", "Instructors", "Exams", "Flags"];
    chart.data.datasets = [{
        label: "System Statistics",
        data: [
            stats.totalStudents ?? 0,
            stats.totalInstructors ?? 0,
            stats.totalExams ?? 0,
            stats.flaggedSessions ?? 0
        ],
        backgroundColor: [
            "rgba(37,99,235,.7)",
            "rgba(22,163,74,.7)",
            "rgba(217,119,6,.7)",
            "rgba(220,38,38,.7)"
        ],
        borderRadius: 6
    }];
    chart.update();
}

async function loadDashboard(){

    try{

        const token = getAuthToken();

        const res = await fetch("/api/dashboard",{
            headers:{
                Authorization:"Bearer "+token
            }
        });

        if(res.status === 401){
          clearAuthSession(token);
            window.location.href = "/";
            return;
        }

        if(!res.ok){
            throw new Error("Failed to load dashboard.");
        }

        const stats = await res.json().catch(() => ({}));
        renderStatCards(stats);
        renderRecentActivity(stats.recentActivity);
        renderActiveExams(stats.activeExams);
        renderRecentUsers(stats.recentUsers);
        renderDashboardChart(stats);
        renderSystemHealth(stats.systemHealth);















    }
    catch(err){

        console.error(err);

    }

}

function confirmLogout(event){

    event.preventDefault();

    if(confirm("Are you sure you want to sign out?")){

        clearAuthSession();

        window.location.href="/";

    }

}

window.addEventListener(
    "DOMContentLoaded",
    () => {
        loadDashboard();
        wireDashboardDetailEvents();
    }
);

// ═══════════ Read-only detail overlays ═══════════
function kvRows(pairs){
  return `<div class="kv-grid">${pairs.filter(p => p && p[1] !== null && p[1] !== undefined && p[1] !== '')
    .map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}
  </div>`;
}

function fmtDateTime(value){
  if(!value) return '—';
  const d = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  return isNaN(d) ? String(value) : d.toLocaleString();
}

function openDetailOverlay(kicker, title, html){
  document.getElementById('detailKicker').textContent = kicker;
  document.getElementById('detailTitle').textContent = title;
  document.getElementById('detailBody').innerHTML = html;
  document.getElementById('detailOverlay').classList.add('show');
}

function closeDetailOverlay(){
  document.getElementById('detailOverlay').classList.remove('show');
}

function chips(list){
  return `<div class="ovl-actions">${list.map(([label, on]) =>
    `<span class="ovl-chip" style="${on ? 'background:var(--green-bg);color:var(--green-tx);border-color:transparent' : 'color:var(--tx3)'}">${on ? '●' : '○'} ${label}</span>`
  ).join('')}</div>`;
}

async function showUserDetail(userId, fallbackName){
  openDetailOverlay('Recent User', fallbackName || 'Loading…', '<div class="ovl-empty">Loading details…</div>');
  try {
    const res = await fetch(`/api/dashboard/users/${userId}`, {
      headers: { Authorization: 'Bearer ' + getAuthToken() }
    });
    if (!res.ok) throw new Error('Unable to load this user.');
    const u = await res.json();
    const role = String(u.role || 'user').replace('_', ' ');
    const roleChip = `<span class="bdg ${u.role === 'student' ? 'bdg-blue' : u.role === 'professor' ? 'bdg-green' : 'bdg-purple'}">${role.charAt(0).toUpperCase() + role.slice(1)}</span>`;
    const acct = String(u.accountStatus || 'active').toLowerCase();
    const acctChip = `<span class="bdg ${acct === 'active' ? 'bdg-green' : acct === 'pending' ? 'bdg-amber' : 'bdg-red'}">${acct.charAt(0).toUpperCase() + acct.slice(1)}</span>`;
    const isStudent = u.role === 'student';
    openDetailOverlay('Recent User', u.name, `
      ${kvRows([
        ['Role', roleChip],
        ['Account status', acctChip],
        isStudent ? ['Student number', u.studentId] : ['Faculty ID', u.facultyId],
        isStudent ? ['Section', u.sectionName] : ['Department', u.department],
        isStudent ? ['Year level', u.yearLevel] : null,
        ['Email', u.email],
        ['Username', u.username],
        ['Joined', fmtDateTime(u.joinedAt)]
      ])}
      <div class="ovl-sub">Exam activity</div>
      ${kvRows([
        ['Sessions started', u.examSessionsStarted ?? 0],
        ['Sessions submitted', u.examSessionsSubmitted ?? 0],
        ['Flagged incidents', u.flaggedIncidents ?? 0]
      ])}
    `);
  } catch (err) {
    openDetailOverlay('Recent User', fallbackName || 'User', `<div class="ovl-empty">${err.message}</div>`);
  }
}

async function showExamDetail(examId, fallbackTitle){
  openDetailOverlay('Active Exam', fallbackTitle || 'Loading…', '<div class="ovl-empty">Loading details…</div>');
  try {
    const res = await fetch(`/api/dashboard/exams/${examId}`, {
      headers: { Authorization: 'Bearer ' + getAuthToken() }
    });
    if (!res.ok) throw new Error('Unable to load this exam.');
    const e = await res.json();
    const status = String(e.status || 'scheduled');
    const statusChip = `<span class="bdg ${status === 'live' ? 'bdg-green' : status === 'ended' ? 'bdg-red' : 'bdg-amber'}">${status.charAt(0).toUpperCase() + status.slice(1)}</span>`;
    const type = String(e.type || '').replace('gforms', 'Google Forms').replace('wams-quiz', 'WAMS Quiz');
    const monitor = e.monitorSettings || {};
    const tools = e.toolsSettings || {};
    openDetailOverlay('Active Exam', e.title, `
      ${kvRows([
        ['Status', statusChip],
        ['Type', type],
        ['Professor', e.professor],
        ['Course · Section', [e.course, e.sectionName].filter(Boolean).join(' · ')],
        ['Year level', e.yearLevel],
        ['Schedule', e.schedule],
        ['Time limit', e.timeLimitMinutes ? e.timeLimitMinutes + ' min' : null],
        ['Questions', e.questionCount],
        ['Created', fmtDateTime(e.createdAt)]
      ])}
      <div class="ovl-sub">Session activity</div>
      ${kvRows([
        ['Sessions started', e.sessionsStarted ?? 0],
        ['Sessions submitted', e.sessionsSubmitted ?? 0],
        ['Flagged incidents', e.flaggedIncidents ?? 0]
      ])}
      <div class="ovl-sub">Monitoring configuration</div>
      ${chips([
        ['Camera snapshots', monitor.camera !== false],
        ['Audio recording', tools.audio || tools.record_audio],
        ['Screen capture', monitor.screen !== false],
        ['Tab-switch detection', monitor.tab_switch !== false]
      ])}
    `);
  } catch (err) {
    openDetailOverlay('Active Exam', fallbackTitle || 'Exam', `<div class="ovl-empty">${err.message}</div>`);
  }
}

async function openAllUsersOverlay(){
  openDetailOverlay('Recent Users', 'All Recent Registrations', '<div class="ovl-empty">Loading…</div>');
  try {
    const res = await fetch('/api/dashboard/recent-users', {
      headers: { Authorization: 'Bearer ' + getAuthToken() }
    });
    if (!res.ok) throw new Error('Unable to load registrations.');
    const users = await res.json();
    if (!users.length) {
      openDetailOverlay('Recent Users', 'All Recent Registrations', '<div class="ovl-empty">No registered users yet.</div>');
      return;
    }
    const rows = users.map(u => {
      const acct = String(u.account_status || u.status || 'active').toLowerCase();
      const badgeClass = acct === 'pending' ? 'bdg-amber' : acct === 'suspended' || acct === 'rejected' ? 'bdg-red' : 'bdg-green';
      const label = acct === 'pending' ? 'Pending' : acct === 'suspended' ? 'Suspended' : acct === 'rejected' ? 'Rejected' : 'Active';
      return `<tr class="row-click" onclick="showUserDetail(${u.id}, '${String(u.name || '').replace(/'/g, "\\'")}')">
        <td>${u.name || 'User'}</td>
        <td>${u.role ? u.role.charAt(0).toUpperCase() + u.role.slice(1) : '-'}</td>
        <td><span class="bdg ${badgeClass}"><span class="bdg-dot"></span>${label}</span></td>
        <td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
      </tr>`;
    }).join('');
    openDetailOverlay('Recent Users', 'All Recent Registrations', `
      <table class="mini-tbl">
        <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Joined</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  } catch (err) {
    openDetailOverlay('Recent Users', 'All Recent Registrations', `<div class="ovl-empty">${err.message}</div>`);
  }
}

async function openAllExamsOverlay(){
  openDetailOverlay('Created Exams', 'All Live Exams', '<div class="ovl-empty">Loading…</div>');
  try {
    const res = await fetch('/api/dashboard/exams', {
      headers: { Authorization: 'Bearer ' + getAuthToken() }
    });
    if (!res.ok) throw new Error('Unable to load exams.');
    const exams = await res.json();
    if (!exams.length) {
      openDetailOverlay('Created Exams', 'All Live Exams', '<div class="ovl-empty">No exams have been created yet.</div>');
      return;
    }
    const rows = exams.map(e => {
      const status = String(e.status || 'scheduled').toLowerCase();
      const badgeClass = status === 'live' ? 'bdg-green' : status === 'ended' ? 'bdg-red' : 'bdg-amber';
      return `<tr class="row-click" onclick="showExamDetail(${e.id}, '${String(e.title || '').replace(/'/g, "\\'")}')">
        <td>${e.title || 'Untitled Exam'}</td>
        <td>${e.professor_name || '—'}</td>
        <td>${e.students ?? 0}</td>
        <td>${e.flagged ?? 0}</td>
        <td><span class="bdg ${badgeClass}"><span class="bdg-dot"></span>${status.charAt(0).toUpperCase() + status.slice(1)}</span></td>
      </tr>`;
    }).join('');
    openDetailOverlay('Created Exams', 'All Live Exams', `
      <table class="mini-tbl">
        <thead><tr><th>Exam</th><th>Professor</th><th>Students</th><th>Flags</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`);
  } catch (err) {
    openDetailOverlay('Created Exams', 'All Live Exams', `<div class="ovl-empty">${err.message}</div>`);
  }
}

// ── Flagged incidents overview ──
async function openFlaggedOverlay(event){
  if (event) event.preventDefault();
  document.getElementById('flaggedBody').innerHTML = '<div class="ovl-empty">Loading incidents…</div>';
  document.getElementById('flaggedOverlay').classList.add('show');
  try {
    const res = await fetch('/api/dashboard/flagged-incidents?limit=100', {
      headers: { Authorization: 'Bearer ' + getAuthToken() }
    });
    if (!res.ok) throw new Error('Unable to load flagged incidents.');
    const data = await res.json();
    const totals = data.totals || {};
    const incidents = Array.isArray(data.incidents) ? data.incidents : [];
    const list = incidents.length ? `
      <table class="mini-tbl">
        <thead><tr><th>When</th><th>Student</th><th>Exam</th><th>Type</th></tr></thead>
        <tbody>
          ${incidents.map(i => `
            <tr>
              <td style="white-space:nowrap">${fmtDateTime(i.switched_at)}</td>
              <td>${i.student_name || '—'}<div style="font-size:10.5px;color:var(--tx3)">${i.student_id || ''}</div></td>
              <td>${i.exam_title || '—'}</td>
              <td><span class="bdg ${i.source === 'alt-tab' ? 'bdg-red' : 'bdg-amber'}">${i.source === 'alt-tab' ? 'OS switch' : 'Tab switch'}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>` : '<div class="ovl-empty">No flagged incidents recorded. Students have kept to their exam tabs.</div>';
    document.getElementById('flaggedBody').innerHTML = `
      <div class="flg-totals">
        <div class="flg-total"><b>${totals.total ?? 0}</b><span>Total</span></div>
        <div class="flg-total"><b>${totals.osSwitches ?? 0}</b><span>OS switches</span></div>
        <div class="flg-total"><b>${totals.studentsInvolved ?? 0}</b><span>Students</span></div>
        <div class="flg-total"><b>${totals.examsAffected ?? 0}</b><span>Exams</span></div>
      </div>
      ${list}`;
  } catch (err) {
    document.getElementById('flaggedBody').innerHTML = `<div class="ovl-empty">${err.message}</div>`;
  }
}

function closeFlaggedOverlay(){
  document.getElementById('flaggedOverlay').classList.remove('show');
}

// Row clicks on the dashboard cards open the same detail overlays.
function wireDashboardDetailEvents(){
  document.getElementById('recentUsersBody')?.addEventListener('click', event => {
    const row = event.target.closest('tr.row-click');
    if (!row) return;
    const user = dashState.recentUsers[Number(row.dataset.userIdx)];
    if (user && user.id) showUserDetail(user.id, user.name);
  });
  document.getElementById('activeExamsBody')?.addEventListener('click', event => {
    const row = event.target.closest('tr.row-click');
    if (!row) return;
    const exam = dashState.activeExams[Number(row.dataset.examIdx)];
    if (exam && exam.id) showExamDetail(exam.id, exam.title);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeDetailOverlay(); closeFlaggedOverlay(); }
  });
}