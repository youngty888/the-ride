(() => {
  const sessionKey = 'sicc-ride-auth-session';
  const redirectToLogin = () => location.replace('auth.html');

  let session;
  try {
    session = JSON.parse(sessionStorage.getItem(sessionKey));
  } catch {
    session = null;
  }

  if (!session?.access_token) {
    redirectToLogin();
    return;
  }

  const config = window.SICC_RIDE_SUPABASE || {};
  fetch(`${config.url}/auth/v1/user`, {
    headers: {
      apikey: config.anonKey,
      Authorization: `Bearer ${session.access_token}`
    }
  }).then(response => {
    if (!response.ok) throw new Error('Invalid session');
    document.documentElement.classList.remove('auth-pending');
  }).catch(() => {
    sessionStorage.removeItem(sessionKey);
    redirectToLogin();
  });
})();
