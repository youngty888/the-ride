(() => {
  const forms = [...document.querySelectorAll('.auth-form')];
  const status = document.getElementById('authStatus');
  const signOut = document.getElementById('signOutButton');
  const config = window.SICC_RIDE_SUPABASE || {};
  const sessionKey = 'sicc-ride-auth-session';
  const readSession = () => { try { return JSON.parse(sessionStorage.getItem(sessionKey)); } catch { return null; } };
  const saveSession = value => value?.access_token && sessionStorage.setItem(sessionKey, JSON.stringify(value));
  const configured = () => /^https:\/\//.test(config.url || '') && config.anonKey && !config.anonKey.startsWith('PASTE_');

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
    status.hidden = false;
  }

  function show(view) {
    forms.forEach(form => { form.hidden = form.dataset.view !== view; });
    status.hidden = true;
    history.replaceState(null, '', view === 'login' ? 'auth.html' : `auth.html?mode=${view}`);
    document.querySelector(`[data-view="${view}"] input`)?.focus();
  }

  async function request(path, { token, ...options } = {}) {
    if (!configured()) throw new Error('SETUP_REQUIRED');
    const response = await fetch(`${config.url}${path}`, {
      ...options,
      headers: {
        apikey: config.anonKey,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.msg || body.message || body.error_description || 'Request failed.');
    return body;
  }

  document.querySelectorAll('[data-show]').forEach(button => {
    button.addEventListener('click', () => show(button.dataset.show));
  });

  forms.forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(form);
    const button = form.querySelector('[type="submit"]');
    const view = form.dataset.view;

    if (['signup', 'invite'].includes(view) && values.get('password') !== values.get('confirmPassword')) {
      return message('Passwords do not match.', true);
    }

    button.disabled = true;

    try {
      if (view === 'login') {
        const result = await request('/auth/v1/token?grant_type=password', {
          method: 'POST',
          body: JSON.stringify({ email: values.get('email'), password: values.get('password') })
        });
        saveSession(result);
        signOut.hidden = false;
        message('Signed in securely. Opening Ride…');
        setTimeout(() => location.replace('./'), 500);

      } else if (view === 'signup') {
        const result = await request('/auth/v1/signup', {
          method: 'POST',
          body: JSON.stringify({
            email: values.get('email'),
            password: values.get('password'),
            data: { role: 'rider' }
          })
        });

        if (result?.access_token) {
          saveSession(result);
          signOut.hidden = false;
          message('Rider account created. Opening Ride…');
          setTimeout(() => location.replace('./'), 700);
        } else {
          message('Rider account created. Check your email to confirm your account, then sign in.');
        }

      } else if (view === 'recovery') {
        await request('/auth/v1/recover', {
          method: 'POST',
          body: JSON.stringify({
            email: values.get('email'),
            redirect_to: `${location.origin}/auth.html?mode=invite`
          })
        });
        message('If that account exists, a private reset link has been sent.');

      } else if (view === 'invite') {
        const active = readSession();
        if (!active?.access_token) throw new Error('This private invitation or reset link is missing or expired.');
        await request('/auth/v1/user', {
          method: 'PUT',
          token: active.access_token,
          body: JSON.stringify({ password: values.get('password') })
        });
        sessionStorage.removeItem(sessionKey);
        message('Password saved. Sign in to continue.');
        setTimeout(() => show('login'), 900);
      }

    } catch (error) {
      message(error.message === 'SETUP_REQUIRED'
        ? 'Secure connection setup is incomplete. No information was sent.'
        : error.message, true);
    } finally {
      button.disabled = false;
    }
  }));

  signOut.addEventListener('click', async () => {
    const active = readSession();
    try {
      if (active?.access_token) await request('/auth/v1/logout', { method: 'POST', token: active.access_token });
    } catch {}
    sessionStorage.removeItem(sessionKey);
    signOut.hidden = true;
    message('Signed out.');
  });

  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('access_token')) {
    saveSession(Object.fromEntries(hash));
    history.replaceState(null, '', `${location.pathname}?mode=invite`);
  }

  const mode = new URLSearchParams(location.search).get('mode');
  show(['signup', 'invite', 'recovery'].includes(mode) ? mode : 'login');
  signOut.hidden = !readSession()?.access_token;
})();
