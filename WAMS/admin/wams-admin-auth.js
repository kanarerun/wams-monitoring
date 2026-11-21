function getAdminAuthToken(){
  return localStorage.getItem('adminToken') || localStorage.getItem('token') || localStorage.getItem('wamsToken');
}

function clearAdminAuthSession(token = getAdminAuthToken()){
  if(localStorage.getItem('adminToken') === token){
    localStorage.removeItem('adminToken');
  }
  ['token', 'wamsToken'].forEach(key => {
    if(token && localStorage.getItem(key) === token){
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
    if(!me || me.role !== 'admin'){
      if(localStorage.getItem('adminToken') === token){
        localStorage.removeItem('adminToken');
      }
      window.location.href = '/';
      return null;
    }

    localStorage.setItem('adminToken', token);
    applyCoAdminSidebarVisibility(me.role);
    return me;
  } catch (error) {
    console.error('Unable to verify admin session:', error);
    return null;
  }
}

// Strict RBAC: Admin Management (Admin List) and the Audit Logs page are
// Super-Admin-only. Hide the sidebar entries from Co-Admins everywhere.
function applyCoAdminSidebarVisibility(role){
  if (role === 'super_admin') return;
  ['sbAdminList', 'sbAuditLogs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
}

// Block Co-Admins from opening Super-Admin-only pages directly by URL.
function requireSuperAdminPage(user){
  if (user && user.role === 'super_admin') return true;
  window.location.href = 'wams-admin-dashboard.html';
  return false;
}