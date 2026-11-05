const adminToken = getAdminAuthToken();
let adminRows = [];
let invitationRows = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function displayDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function getInvitationStatus(invitation) {
  if (Number(invitation.used)) return { label: 'Registered', className: 'bdg-green' };
  if (Number(invitation.expires_at) <= Date.now()) return { label: 'Expired', className: 'bdg-gray' };
  return { label: 'Pending', className: 'bdg-amber' };
}

function initials(name) {
  return String(name || 'Admin').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
}

function renderAdmins() {
  const query = document.getElementById('adminSearch').value.trim().toLowerCase();
  const filtered = adminRows.filter(admin =>
    [admin.name, admin.username, admin.email].some(value => String(value || '').toLowerCase().includes(query))
  );
  const body = document.getElementById('adminRows');
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty-state">No administrators match your search.</div></td></tr>';
    return;
  }

  body.innerHTML = filtered.map(admin => `
    <tr>
      <td><div class="admin-name"><span class="admin-avatar">${escapeHtml(initials(admin.name))}</span><span>${escapeHtml(admin.name)}</span></div></td>
      <td>${escapeHtml(admin.username || '—')}</td>
      <td>${escapeHtml(admin.email || '—')}</td>
      <td>${escapeHtml(displayDate(admin.created_at))}</td>
      <td>${admin.username === 'admin'
        ? '<span class="bdg bdg-blue">Seeded admin</span>'
        : '<span class="bdg bdg-green">Active</span>'}</td>
    </tr>
  `).join('');
}

function renderInvitations() {
  const body = document.getElementById('invitationRows');
  if (!invitationRows.length) {
    body.innerHTML = '<tr><td colspan="5"><div class="empty-state">No admin invitations have been sent yet.</div></td></tr>';
    return;
  }

  body.innerHTML = invitationRows.map(invitation => {
    const status = getInvitationStatus(invitation);
    const sender = adminRows.find(admin => String(admin.id) === String(invitation.created_by));
    return `
      <tr>
        <td>${escapeHtml(invitation.email)}</td>
        <td>${escapeHtml(sender?.name || 'Administrator')}</td>
        <td>${escapeHtml(displayDate(invitation.created_at))}</td>
        <td>${escapeHtml(displayDate(Number(invitation.expires_at)))}</td>
        <td><span class="bdg ${status.className}">${status.label}</span></td>
      </tr>
    `;
  }).join('');
}

async function loadAdminList() {
  const response = await fetch('/api/admin/admins', {
    headers: { Authorization: `Bearer ${adminToken}` },
    cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    clearAdminAuthSession(adminToken);
    window.location.href = 'wams-admin-log-in.html';
    return;
  }
  if (!response.ok) throw new Error(data.error || 'Unable to load the admin list.');

  adminRows = data.admins || [];
  invitationRows = data.invitations || [];
  document.getElementById('adminCount').textContent = adminRows.length;
  document.getElementById('pendingCount').textContent = invitationRows.filter(invitation => getInvitationStatus(invitation).label === 'Pending').length;
  document.getElementById('topAvName').textContent = localStorage.getItem('adminName') || 'System Administrator';
  renderAdmins();
  renderInvitations();
}

document.getElementById('inviteForm').addEventListener('submit', async event => {
  event.preventDefault();
  const emailInput = document.getElementById('inviteEmail');
  const notice = document.getElementById('inviteNotice');
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  notice.className = 'notice';
  notice.textContent = '';
  if (!emailInput.checkValidity()) {
    emailInput.reportValidity();
    return;
  }

  submitButton.disabled = true;
  try {
    const response = await fetch('/api/admin/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ email: emailInput.value.trim().toLowerCase() })
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      clearAdminAuthSession(adminToken);
      window.location.href = 'wams-admin-log-in.html';
      return;
    }
    if (!response.ok) throw new Error(data.error || 'The invitation could not be sent.');
    notice.textContent = data.message;
    emailInput.value = '';
    await loadAdminList();
  } catch (error) {
    notice.classList.add('error');
    notice.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

document.getElementById('adminSearch').addEventListener('input', renderAdmins);

function toggleSb() {
  document.body.classList.toggle('mini');
  document.getElementById('sb').classList.toggle('mini');
}

function confirmLogout(event) {
  event.preventDefault();
  if (!confirm('Sign out of the admin portal?')) return;
  clearAdminAuthSession(adminToken);
  localStorage.removeItem('adminName');
  window.location.href = 'wams-admin-log-in.html';
}

(async () => {
  const user = await verifyAdminAuth();
  if (!user) return;
  try {
    await loadAdminList();
  } catch (error) {
    console.error('Unable to load admin list:', error);
    document.getElementById('adminRows').innerHTML = `<tr><td colspan="5"><div class="empty-state">${escapeHtml(error.message)}</div></td></tr>`;
    document.getElementById('invitationRows').innerHTML = '<tr><td colspan="5"><div class="empty-state">Unable to load invitations.</div></td></tr>';
  }
})();
