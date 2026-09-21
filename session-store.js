/* Where the rider's sign-in (access + refresh token) lives.
   It used to be sessionStorage, which the browser wipes when the tab or installed app
   is closed, so riders had to sign in every time. It now lives in localStorage so the
   sign-in survives closing the app; Sign out clears it. Same getItem/setItem/removeItem
   shape as sessionStorage.
   - A session left in sessionStorage by an older version is moved over on first read,
     so nobody is signed out by this update.
   - If localStorage is unavailable (private mode, blocked storage) it falls back to
     sessionStorage, i.e. the old behaviour. */
const RideSessionStore = {
  persistent() { try { return window.localStorage || null; } catch { return null; } },
  tab() { try { return window.sessionStorage || null; } catch { return null; } },
  getItem(key) {
    const keep = this.persistent(), tab = this.tab();
    try { const value = keep && keep.getItem(key); if (value) return value; } catch { /* fall through */ }
    let legacy = null;
    try { legacy = tab && tab.getItem(key); } catch { /* ignore */ }
    if (legacy && keep) {
      try { keep.setItem(key, legacy); tab.removeItem(key); } catch { /* keep using the tab copy */ }
    }
    return legacy || null;
  },
  setItem(key, value) {
    const keep = this.persistent(), tab = this.tab();
    try {
      if (!keep) throw new Error('no persistent storage');
      keep.setItem(key, value);
      try { tab && tab.removeItem(key); } catch { /* ignore */ }
    } catch {
      if (tab) tab.setItem(key, value);
    }
  },
  removeItem(key) {
    try { this.persistent()?.removeItem(key); } catch { /* ignore */ }
    try { this.tab()?.removeItem(key); } catch { /* ignore */ }
  }
};
