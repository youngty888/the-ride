const RideAuth = {
  key: 'sicc-ride-auth-session', refreshing: null,
  read() { try { return JSON.parse(sessionStorage.getItem(this.key)); } catch { return null; } },
  async session() {
    const session = this.read();
    if (!session?.access_token) throw new Error('Sign in again to continue.');
    let expires = 0;
    try { expires = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp; } catch {}
    if (expires * 1000 > Date.now() + 60000 && session.user?.id) return session;
    if (!session.refresh_token) throw new Error('Sign in again to continue.');
    if (!this.refreshing) {
      const original = session.access_token;
      const config = window.SICC_RIDE_SUPABASE;
      this.refreshing = fetch(`${config.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      }).then(async response => {
        if (!response.ok) throw new Error('Sign in again to continue.');
        const next = await response.json();
        if (this.read()?.access_token !== original) throw new Error('Account changed. Reload Ride.');
        sessionStorage.setItem(this.key, JSON.stringify(next)); return next;
      }).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  },
  async verify() {
    const session = await this.session();
    const config = window.SICC_RIDE_SUPABASE;
    const response = await fetch(`${config.url}/auth/v1/user`, {
      signal: AbortSignal.timeout(15000),
      headers: { apikey: config.anonKey, Authorization: `Bearer ${session.access_token}` }
    });
    if (!response.ok) throw new Error('Sign in again to continue.');
    const user = await response.json();
    if (this.read()?.access_token !== session.access_token) throw new Error('Account changed. Reload Ride.');
    session.user = user; sessionStorage.setItem(this.key, JSON.stringify(session));
    return session;
  }
};
RideAuth.ready = RideAuth.verify().catch(() => {
  location.replace('auth.html'); return null;
});
