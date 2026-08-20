
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
    if(me && me.role !== 'professor'){ window.location.href = 'wams-professor-log-in.html'; }
    // Populate header with real professor info
    if(me){
      const nameEl = document.getElementById('profName');
      const deptEl = document.getElementById('profDept');
      if(nameEl) nameEl.textContent = me.name || 'Professor';
      if(deptEl) deptEl.textContent = me.department || localStorage.getItem('wamsProfessorDept') || 'Faculty';
      // Cache for other pages
      if(me.name) localStorage.setItem('wamsProfessorName', me.name);
      if(me.department) localStorage.setItem('wamsProfessorDept', me.department);
    }
  } catch {}
})();

/* ── Sidebar ── */
function toggleSb(){
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}

/* ── Type selection ── */
let selectedType = null;
let selectedSev  = null;

function selectType(type){
  selectedType = type;
  const pills = ['bug','feature','performance','ux','other'];
  pills.forEach(p => {
    const el = document.getElementById('pill-'+p);
    el.className = 'type-pill' + (p===type ? ' sel-'+type : '');
  });
  // show/hide severity for bug/performance
  const showSev   = type==='bug' || type==='performance';
  const showSteps = type==='bug';
  document.getElementById('sevField').style.display   = showSev   ? 'block' : 'none';
  document.getElementById('stepsField').style.display = showSteps ? 'block' : 'none';
}

/* ── Severity ── */
function selectSev(sev){
  selectedSev = sev;
  ['low','medium','high'].forEach(s => {
    document.getElementById('sev-'+s).className = 'sev-pill' + (s===sev ? ' sel-'+s : '');
  });
}

/* ── Char counts ── */
function updateSubjectCount(){
  const el = document.getElementById('subject');
  const len = el.value.length;
  const cnt = document.getElementById('subjectCount');
  cnt.textContent = len+' / 120';
  cnt.classList.toggle('warn', len > 100);
}
function updateDescCount(){
  const el = document.getElementById('description');
  const len = el.value.length;
  const cnt = document.getElementById('descCount');
  cnt.textContent = len+' / 2000';
  cnt.classList.toggle('warn', len > 1800);
}

/* ── File attach ── */
const attachedFiles = [];
function handleFiles(input){
  Array.from(input.files).forEach(file=>{
    if(file.size > 5*1024*1024){ showToast('File too large (max 5 MB)'); return; }
    const reader = new FileReader();
    reader.onload = e => {
      attachedFiles.push({name:file.name, src:e.target.result});
      renderPreviews();
    };
    reader.readAsDataURL(file);
  });
  input.value = '';
}
function renderPreviews(){
  const wrap = document.getElementById('attachPreviews');
  wrap.innerHTML = attachedFiles.map((f,i) => `
    <div class="attach-thumb">
      <img src="${f.src}" alt="${f.name}">
      <div class="rm" onclick="removeFile(${i})">×</div>
    </div>`).join('');
}
function removeFile(i){
  attachedFiles.splice(i,1);
  renderPreviews();
}

/* drag-drop */
const aa = document.getElementById('attachArea');
aa.addEventListener('dragover', e => { e.preventDefault(); aa.style.borderColor='var(--navy3)'; });
aa.addEventListener('dragleave', () => { aa.style.borderColor=''; });
aa.addEventListener('drop', e => {
  e.preventDefault(); aa.style.borderColor='';
  const dt = e.dataTransfer;
  if(dt.files.length){
    Array.from(dt.files).forEach(file=>{
      if(!file.type.startsWith('image/')){ showToast('Only image files accepted'); return; }
      if(file.size > 5*1024*1024){ showToast('File too large (max 5 MB)'); return; }
      const reader = new FileReader();
      reader.onload = ev => { attachedFiles.push({name:file.name, src:ev.target.result}); renderPreviews(); };
      reader.readAsDataURL(file);
    });
  }
});

/* ── Submit ── */
async function submitFeedback(){
  const subject = document.getElementById('subject').value.trim();
  const description = document.getElementById('description').value.trim();
  const module = document.getElementById('module').value;
  const email = document.getElementById('email').value.trim();

  if(!selectedType){ showToast('Please choose a report type.'); return; }
  if(!module){ showToast('Please select the affected module.'); return; }
  if(!subject){ showToast('Please enter a subject.'); return; }
  if(!description){ showToast('Please describe the issue.'); return; }
  if(!email){ showToast('Please enter your email for follow-up.'); return; }

  const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
  if (!token) {
    showToast('You must be logged in to submit feedback.');
    return;
  }

  const categoryMap = { bug: 'Bug Report', feature: 'Feature Request', performance: 'Performance', ux: 'UX', other: 'General Feedback' };

  // Show sending state
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.innerHTML = '<svg viewBox="0 0 24 24" style="animation:spin .7s linear infinite"><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" stroke-dasharray="56" stroke-dashoffset="14"/></svg> Sending…';

  try {
    const response = await fetch('/api/feedbacks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        category: categoryMap[selectedType] || 'General Feedback',
        subject,
        message: description + (selectedSev ? `\n\nSeverity: ${selectedSev}` : '') + (document.getElementById('steps')?.value ? '\n\nSteps:\n' + document.getElementById('steps').value : ''),
        contact: email,
        module: module
      })
    });

    if (!response.ok) {
      throw new Error('Failed to submit feedback');
    }

    // Clear attachments after successful submission
    attachedFiles.length = 0;
    renderPreviews();

    // Show success screen only after server confirms
    document.getElementById('formWrap').style.display = 'none';
    document.getElementById('successScreen').classList.add('show');
    document.getElementById('confirmEmail').textContent = email;

    // Refresh past submissions list
    loadPastSubmissions();
  } catch (e) {
    console.error('Failed to submit feedback', e);
    showToast('Failed to submit feedback. Please try again.');
    // Restore button state
    btn.disabled = false;
    btn.innerHTML = `
      <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      Send Report to Admin`;
  }
}

function resetForm(){
  selectedType = null; selectedSev = null;
  ['bug','feature','performance','ux','other'].forEach(p => document.getElementById('pill-'+p).className='type-pill');
  ['low','medium','high'].forEach(s => document.getElementById('sev-'+s).className='sev-pill');
  document.getElementById('sevField').style.display='none';
  document.getElementById('stepsField').style.display='none';
  document.getElementById('subject').value='';
  document.getElementById('description').value='';
  document.getElementById('steps').value='';
  document.getElementById('module').value='';
  attachedFiles.length=0; renderPreviews();
  updateSubjectCount(); updateDescCount();
  document.getElementById('submitBtn').disabled=false;
  document.getElementById('submitBtn').innerHTML=`
    <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    Send Report to Admin`;
  document.getElementById('formWrap').style.display='block';
  document.getElementById('successScreen').classList.remove('show');
}

function showToast(msg){
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2600);
}

 function confirmLogout(event) {
    event.preventDefault();

    if (confirm("Are you sure you want to sign out?")) {
        localStorage.removeItem('wamsToken');
        localStorage.removeItem('token');
        window.location.href = "wams-professor-log-in.html";
    }
}

async function renderSidebarBadges(){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return;
    const res = await fetch('/api/my-exams', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if(!res.ok) return;
    const exams = await res.json();
    const liveBadge = document.querySelector('a[href="wams-professor-live-monitor.html"] .sb-badge.green');
    const logsBadge = document.querySelector('a[href="wams-professor-monitoring-logs.html"] .sb-badge');
    if(liveBadge) liveBadge.textContent = exams.filter(ex => ['live', 'upcoming', 'scheduled'].includes(ex.status)).length;
    if(logsBadge) logsBadge.textContent = exams.filter(ex => ex.status === 'ended').length;
  } catch {}
}

(async () => {
  await renderSidebarBadges();
  window.addEventListener('storage', renderSidebarBadges);
})();

/* ── Load past submissions from server ── */
async function loadPastSubmissions(){
  try {
    const token = localStorage.getItem('wamsToken') || localStorage.getItem('token');
    if(!token) return;
    
    const res = await fetch('/api/feedbacks', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    
    if(!res.ok) return;
    const data = await res.json();
    if(!Array.isArray(data)) return;
    
    // Get current user's feedbacks
    const meRes = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if(!meRes.ok) return;
    const me = await meRes.json();
    
    const myFeedbacks = data.filter(f => f.professor_id === me.id);
    
    const subList = document.querySelector('.sub-list');
    if(!subList) return;
    
    // Update count
    const cs = document.querySelector('.card-hd .cs');
    if(cs) cs.textContent = myFeedbacks.length + (myFeedbacks.length === 1 ? ' submission' : ' submissions') + ' this semester';
    
    if(myFeedbacks.length === 0){
      subList.innerHTML = '<li class="sub-item" style="justify-content:center;padding:16px;color:var(--muted)">No reports submitted yet.</li>';
      return;
    }
    
    const catIcons = {
      'Bug Report': '<svg viewBox="0 0 24 24"><path d="M8 2l1.5 1.5M16 2l-1.5 1.5M9 12h6M9 16h4M10 2.5C10 2.5 6 4 6 8H18c0-4-4-5.5-4-5.5"/><path d="M6 8v3a6 6 0 0 0 12 0V8"/></svg>',
      'Feature Request': '<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
      'Performance': '<svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
      'UX': '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
      'General Feedback': '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>'
    };
    
    const catColors = {
      'Bug Report': 'var(--red-bg);color:var(--red)',
      'Feature Request': 'var(--blue-bg);color:var(--blue)',
      'Performance': 'var(--amber-bg);color:var(--amber)',
      'UX': 'var(--purple-bg);color:var(--purple)',
      'General Feedback': 'var(--gray-bg);color:var(--gray)'
    };
    
    const statusBadge = (status) => {
      if(status === 'Resolved') return '<span class="bdg bdg-green"><span class="bdg-dot"></span>Resolved</span>';
      if(status === 'Reviewed') return '<span class="bdg bdg-amber"><span class="bdg-dot"></span>In Review</span>';
      return '<span class="bdg bdg-gray">Noted</span>';
    };
    
    subList.innerHTML = myFeedbacks.map(f => {
      const date = f.created_at ? new Date(f.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '';
      return `
        <li class="sub-item">
          <div class="sub-ic" style="background:${catColors[f.category] || 'var(--gray-bg);color:var(--gray)'}">
            ${catIcons[f.category] || catIcons['General Feedback']}
          </div>
          <div class="sub-body">
            <div class="sub-title">${escapeHtml(f.subject)}</div>
            <div class="sub-meta">${escapeHtml(f.category)} · ${escapeHtml(f.module || 'WAMS')} · ${date}</div>
          </div>
          <div class="sub-status">${statusBadge(f.status)}</div>
        </li>
      `;
    }).join('');
  } catch(e){ console.error('Failed to load past submissions', e); }
}

function escapeHtml(s){
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// Load past submissions on page load
loadPastSubmissions();
