function getAdminAuthToken(){
  return localStorage.getItem('adminToken') || localStorage.getItem('token') || localStorage.getItem('wamsToken');
}

function clearAdminAuthSession(token = getAdminAuthToken()){
  if(localStorage.getItem('adminToken') === token){
    localStorage.removeItem('adminToken');
  }
  ['token', 'wamsToken', 'adminRole', 'adminName'].forEach(key => {
    if(key === 'adminRole' || key === 'adminName' || (token && localStorage.getItem(key) === token)){
      localStorage.removeItem(key);
    }
  });
}

async function verifyAdminAuth(){
  const token = getAdminAuthToken();
  if(!token){
    window.location.href = '/';
    return null;
  }

  try {
    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if(res.status === 401){
      clearAdminAuthSession(token);
      window.location.href = '/';
      return null;
    }
    if(!res.ok){
      console.error('Unable to verify admin session:', res.status);
      return null;
    }

    const me = await res.json();
    // Accept both admin roles; anything else is not an admin session.
    if (!me || (me.role !== 'admin' && me.role !== 'super_admin')) {
      if (localStorage.getItem('adminToken') === token) {
        localStorage.removeItem('adminToken');
      }
      window.location.href = '/';
      return null;
    }

    // Redirect Co-Admins away from Super-Admin-only pages (Admin List, Audit Logs).
    if (me.role !== 'super_admin' && SUPER_ADMIN_ONLY_PAGES.has(currentPage)) {
      window.location.href = 'wams-admin-dashboard.html';
      return null;
    }
    localStorage.setItem('adminToken', token);
    localStorage.setItem('adminRole', me.role);
    applyCoAdminSidebarVisibility(me.role);
    return me;
  } catch (error) {
    console.error('Unable to verify admin session:', error);
    return null;
  }
}

// Strict RBAC: Admin Management (Admin List) and the Audit Logs page are
// Super-Admin-only. Hide the sidebar entries from Co-Admins everywhere.
// (The inline wams-role-guard script in each page hides them pre-paint using
// the cached role; this re-checks against the live session.)
function applyCoAdminSidebarVisibility(role){
  if (role === 'super_admin') return;
  ['sbAdminList', 'sbAuditLogs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
}

// Block Co-Admins from opening Super-Admin-only pages directly by URL.
const SUPER_ADMIN_ONLY_PAGES = new Set(['wams-admin-admin-list.html', 'wams-admin-audit-logs.html']);
const currentPage = (window.location.pathname.split('/').pop() || '').toLowerCase();

function requireSuperAdminPage(user){
  if (user && user.role === 'super_admin') return true;
  if (user && user.role === 'admin' && SUPER_ADMIN_ONLY_PAGES.has(currentPage)) {
    window.location.href = 'wams-admin-dashboard.html';
  }
  return false;
}