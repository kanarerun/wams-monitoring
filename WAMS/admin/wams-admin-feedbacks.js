function toggleSb(){
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}
function nav(e,el){
  e.preventDefault();
  document.querySelectorAll('.sb-item').forEach(i=>i.classList.remove('active'));
  el.classList.add('active');
}

function escapeHtml(s){
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function loadStoredData(key, fallback){
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function saveStoredData(key, value){
  try { localStorage.setItem(key, JSON.stringify(value)); } catch(e){ console.error('saveStoredData', e); }
}


const initials = name => {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0]||'') + (parts[parts.length-1]?.[0]||'')).toUpperCase();
};
const avColors = ['#2563EB','#16A34A','#7C3AED','#D97706','#DC2626','#0EA5E9','#DB2777'];
const colorFor = id => avColors[id % avColors.length];

// ── Feedback (submitted by instructors from the Professor Panel)
let feedbackList = [];

// Map server feedback data to the format expected by the UI
function mapServerFeedback(f){
  return {
    id: f.id,
    name: f.professor_name || 'Instructor',
    dept: f.module || 'Professor',
    category: f.category || 'General Feedback',
    subject: f.subject || '',
    message: f.message || '',
    date: f.created_at ? new Date(f.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '',
    status: f.status || 'New',
    contact: f.contact || '',
    module: f.module || ''
  };
}

// Load feedbacks from server API
async function loadFeedbacksFromServer(){
  try {
    const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
    if(!token) return;
    
    const res = await fetch('/api/feedbacks', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    
    if(res.ok){
      const data = await res.json();
      if(Array.isArray(data)){
        feedbackList = data.map(mapServerFeedback);
        saveStoredData('wamsAdminFeedbacks', feedbackList);
        renderFeedback();
      }
    }
  } catch(e){ console.error('Failed to load feedbacks from server', e); }
}

// Load from localStorage first, then refresh from server
feedbackList = loadStoredData('wamsAdminFeedbacks', []);
loadFeedbacksFromServer();

function fbBadgeClass(cat){
  if(cat === 'Bug Report') return 'bdg-red';
  if(cat === 'Feature Request') return 'bdg-blue';
  return 'bdg-gray';
}

function updateFeedbackStats(){
  document.getElementById('fbStatTotal').textContent = feedbackList.length;
  document.getElementById('fbStatBugs').textContent = feedbackList.filter(f=>f.category==='Bug Report').length;
  document.getElementById('fbStatFeatures').textContent = feedbackList.filter(f=>f.category==='Feature Request').length;
  document.getElementById('fbStatUnresolved').textContent = feedbackList.filter(f=>f.status!=='Resolved').length;
}

function renderFeedback(){
  updateFeedbackStats();

  const q = (document.getElementById('fbSearchInput')?.value || '').trim().toLowerCase();
  const catFilter = document.getElementById('fbCategoryFilter')?.value || '';
  const statusFilter = document.getElementById('fbStatusFilter')?.value || '';
  const wrap = document.getElementById('feedbackList');

  const filtered = feedbackList.filter(f=>{
    const matchesQ = !q || f.name.toLowerCase().includes(q) || f.subject.toLowerCase().includes(q) || f.message.toLowerCase().includes(q) || f.dept.toLowerCase().includes(q);
    const matchesCat = !catFilter || f.category === catFilter;
    const matchesStatus = !statusFilter || f.status === statusFilter;
    return matchesQ && matchesCat && matchesStatus;
  });

  if(filtered.length === 0){
    wrap.innerHTML = `
      <div class="card">
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          <div>${feedbackList.length===0 ? 'No feedback submitted by instructors yet.' : 'No feedback matches your search.'}</div>
        </div>
      </div>`;
    return;
  }

  wrap.innerHTML = filtered.map(f => {
    const attachments = Array.isArray(f.attachments) ? f.attachments : [];
    return `
    <div class="fb-item">
      <div class="fb-item-hd">
        <div class="fb-item-who">
          <div class="uav" style="background:${colorFor(f.id)};width:32px;height:32px;font-size:10.5px">${initials(f.name || 'Instructor')}</div>
          <div>
            <div class="fb-item-name">${escapeHtml(f.name || 'Instructor')}</div>
            <div class="fb-item-dept">${escapeHtml(f.dept || 'Instructor')}</div>
          </div>
        </div>
        <div class="fb-item-badges">
          <span class="bdg ${fbBadgeClass(f.category)}">${escapeHtml(f.category)}</span>
        </div>
      </div>
      <div class="fb-item-subject">${escapeHtml(f.subject)}</div>
      <div class="fb-item-meta">
        ${f.module ? `<span class="fb-meta-chip">Module: ${escapeHtml(f.module)}</span>` : ''}
        ${f.contact ? `<span class="fb-meta-chip">Contact: ${escapeHtml(f.contact)}</span>` : ''}
      </div>
      <div class="fb-item-msg">${escapeHtml(f.message)}</div>
      ${attachments.length ? `
        <div class="fb-attachments">
          ${attachments.map(att => `
            <div class="fb-attachment">
              <img src="${escapeHtml(att.src)}" alt="${escapeHtml(att.name)}">
              <div>${escapeHtml(att.name)}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="fb-item-ft">
        <div>
          <div class="fb-item-date">${escapeHtml(f.date)}</div>
        </div>
        <div class="fb-item-actions">
          <select class="bdg-select st-${f.status}" onchange="fbSetStatus(${f.id}, this.value)" title="Update status">
            <option value="New" ${f.status==='New'?'selected':''}>New</option>
            <option value="Reviewed" ${f.status==='Reviewed'?'selected':''}>Reviewed</option>
            <option value="Resolved" ${f.status==='Resolved'?'selected':''}>Resolved</option>
          </select>
          <div class="act-icbtn del" title="Delete" onclick="fbDelete(${f.id})">
            <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
          </div>
        </div>
      </div>
    </div>
  `;
  }).join('');
}

async function fbSetStatus(id, status){
  const f = feedbackList.find(x=>x.id===id);
  if(!f) return;
  
  // Update server
  try {
    const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
    if(!token) return;
    
    const res = await fetch('/api/feedbacks/' + id, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ status })
    });
    
    if(!res.ok){
      throw new Error('Failed to update feedback status');
    }
    
    f.status = status;
    saveStoredData('wamsAdminFeedbacks', feedbackList);
    renderFeedback();
    showToast(`Marked as ${status.toLowerCase()}.`);
  } catch(e){
    console.error('Failed to update feedback status', e);
    showToast('Failed to update status. Please try again.');
  }
}

async function fbDelete(id){
  const f = feedbackList.find(x=>x.id===id);
  if(!f) return;
  if(confirm(`Delete this ${f.category.toLowerCase()} from ${f.name}?`)){
    try {
      const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
      if(!token) return;
      
      const res = await fetch('/api/feedbacks/' + id, {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer ' + token
        }
      });
      
      if(!res.ok){
        throw new Error('Failed to delete feedback');
      }
      
      feedbackList = feedbackList.filter(x=>x.id!==id);
      saveStoredData('wamsAdminFeedbacks', feedbackList);
      renderFeedback();
      showToast('Feedback deleted.');
    } catch(e){
      console.error('Failed to delete feedback', e);
      showToast('Failed to delete feedback. Please try again.');
    }
  }
}


function showToast(msg){
  const toast = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  toast.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(()=>toast.classList.remove('show'), 2800);
}


// ── Auth Guard ──
(async function checkAdminAuth(){
  const token = localStorage.getItem('token') || localStorage.getItem('wamsToken');
  if(!token){
    window.location.href = 'wams-admin-log-in.html';
    return;
  }
  try {
    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if(!res.ok){
      localStorage.removeItem('token');
      localStorage.removeItem('wamsToken');
      window.location.href = 'wams-admin-log-in.html';
      return;
    }
    const me = await res.json();
    if(me && me.role !== 'admin'){ window.location.href = 'wams-admin-log-in.html'; }
  } catch {}
})();

// ── Init
// Populate top-right admin name from login session
(function populateAdminName(){
  const el = document.getElementById('topAvName');
  if(el){
    el.textContent = localStorage.getItem('adminName') || 'System Administrator';
  }
})();

renderFeedback();
// refresh when storage changes (professor submits from a different window)
window.addEventListener('storage', (ev) => {
  if(ev.key === 'wamsAdminFeedbacks'){
    try{ feedbackList = loadStoredData('wamsAdminFeedbacks', feedbackList); renderFeedback(); }catch{}
  }
});

// Auto-refresh from server every 30 seconds
setInterval(loadFeedbacksFromServer, 30000);

function confirmLogout(event) {
    event.preventDefault();

    if (confirm("Are you sure you want to sign out?")) {
        localStorage.removeItem('token');
        localStorage.removeItem('wamsToken');
        window.location.href = "wams-admin-log-in.html";
    }
}