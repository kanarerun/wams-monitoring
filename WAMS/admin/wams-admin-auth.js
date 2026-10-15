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
    window.location.href = 'wams-admin-log-in.html';
    return null;
  }

  try {
    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if(res.status === 401){
      clearAdminAuthSession(token);
      window.location.href = 'wams-admin-log-in.html';
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
      window.location.href = 'wams-admin-log-in.html';
      return null;
    }

    localStorage.setItem('adminToken', token);
    return me;
  } catch (error) {
    console.error('Unable to verify admin session:', error);
    return null;
  }
}