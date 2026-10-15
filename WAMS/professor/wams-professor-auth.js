function getProfessorAuthToken(){
  return localStorage.getItem('wamsProfessorToken') ||
    localStorage.getItem('wamsToken') ||
    localStorage.getItem('token');
}

function rememberProfessorAuthToken(token){
  localStorage.setItem('wamsProfessorToken', token);
  if(localStorage.getItem('wamsToken') === token) localStorage.removeItem('wamsToken');
  if(localStorage.getItem('token') === token) localStorage.removeItem('token');
}

function clearProfessorAuthToken(token = getProfessorAuthToken()){
  const currentToken = getProfessorAuthToken();
  if(token && currentToken !== token) return false;
  if(currentToken && localStorage.getItem('wamsProfessorToken') === currentToken) localStorage.removeItem('wamsProfessorToken');
  if(currentToken && localStorage.getItem('wamsToken') === currentToken) localStorage.removeItem('wamsToken');
  if(currentToken && localStorage.getItem('token') === currentToken) localStorage.removeItem('token');
  localStorage.removeItem('wamsProfessorName');
  localStorage.removeItem('wamsProfessorDept');
  return true;
}

function handleProfessorAuthExpired(token){
  if(!clearProfessorAuthToken(token)) return false;
  window.location.href = 'wams-professor-log-in.html';
  return true;
}

async function verifyProfessorAuth(onAuthenticated){
  const token = getProfessorAuthToken();
  if(!token){
    window.location.href = 'wams-professor-log-in.html';
    return;
  }

  try {
    const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if(res.status === 401){
      handleProfessorAuthExpired(token);
      return;
    }
    if(!res.ok){
      console.error('Unable to verify professor session:', res.status);
      return;
    }

    const user = await res.json();
    if(!user || user.role !== 'professor'){
      window.location.href = 'wams-professor-log-in.html';
      return;
    }

    rememberProfessorAuthToken(token);
    if(user.name) localStorage.setItem('wamsProfessorName', user.name);
    if(user.department) localStorage.setItem('wamsProfessorDept', user.department);
    if(onAuthenticated) onAuthenticated(user);
  } catch (error) {
    console.error('Unable to verify professor session:', error);
  }
}