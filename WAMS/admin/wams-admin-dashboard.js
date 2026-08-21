// ── Token Management Helpers ──
function getAuthToken(){
  return localStorage.getItem('token') || localStorage.getItem('wamsToken');
}

function clearAuthSession(){
  localStorage.removeItem('token');
  localStorage.removeItem('wamsToken');
  localStorage.removeItem('currentUser');
  localStorage.removeItem('wamsCurrentUserId');
}

// ── Auth Guard ──
(async function checkAdminAuth(){
  const token = getAuthToken();
  if(!token){ window.location.href = 'wams-admin-log-in.html'; return; }
  try {
    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if(!res.ok){
      clearAuthSession();
      window.location.href = 'wams-admin-log-in.html';
      return;
    }
    const me = await res.json();
    if(me && me.role !== 'admin'){
      clearAuthSession();
      window.location.href = 'wams-admin-log-in.html';
    }
  } catch {
    clearAuthSession();
    window.location.href = 'wams-admin-log-in.html';
  }
})();

// ── Sidebar toggle
function toggleSb(){
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}

// ── Nav active state
function nav(e,el){
  e.preventDefault();
  document.querySelectorAll('.sb-item').forEach(i=>i.classList.remove('active'));
  el.classList.add('active');
}

// ── Chart range cycle (demo)
const ranges = ['This Week','This Month','This Semester'];
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
    activeExamsBody.innerHTML = items.map(exam => `
        <tr>
            <td>${exam.title || 'Untitled Exam'}</td>
            <td>${exam.students ?? 0}</td>
            <td>${exam.status || 'scheduled'}</td>
        </tr>
    `).join("");
}

function renderRecentUsers(users) {
    const recentUsersBody = document.getElementById("recentUsersBody");
    if (!recentUsersBody) return;
    const items = Array.isArray(users) ? users : [];
    recentUsersBody.innerHTML = items.map(user => {
        const createdAtStr = user.created_at ? new Date(user.created_at).toLocaleDateString() : '—';
        return `
            <tr>
                <td>${user.name || 'User'}</td>
                <td>${user.role || '—'}</td>
                <td>
                    <span class="bdg bdg-green">
                        <span class="bdg-dot"></span>Active
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
            clearAuthSession();
            window.location.href = "wams-admin-log-in.html";
            return;
        }

        if(!res.ok){
            throw new Error("Failed to load dashboard.");
        }

        const stats = await res.json();
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

        window.location.href="wams-admin-log-in.html";

    }

}

window.addEventListener(
    "DOMContentLoaded",
    loadDashboard
);