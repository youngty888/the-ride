/* Fangs Warehouse: sign-in and data calls. Uses the same Supabase backend, public browser
   key and sign-in session as the Ride app (../supabase-config.js, ../session-store.js).
   The browser never holds a secret key; every permission is checked by the database. */
(function (root) {
  'use strict';
  const KEY = 'sicc-ride-auth-session';
  const cfg = () => root.SICC_RIDE_SUPABASE || {};
  // session-store.js declares a top-level const, so it is a global binding but not a window property.
  const store = () => (typeof RideSessionStore !== 'undefined' ? RideSessionStore : root.RideSessionStore);

  class ApiError extends Error {
    constructor(message, status, body) { super(message); this.status = status; this.body = body; }
  }

  function readSession() { try { return JSON.parse(store().getItem(KEY)); } catch { return null; } }
  function saveSession(s) { if (s?.access_token) store().setItem(KEY, JSON.stringify(s)); }
  function clearSession() { store().removeItem(KEY); }
  const jwtExp = t => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || 0; } catch { return 0; } };

  async function raw(path, { method = 'GET', body, token, headers = {}, timeout = 20000, rawBody } = {}) {
    const c = cfg();
    if (!/^https?:\/\//.test(c.url || '') || !c.anonKey) throw new ApiError('Ride backend is not configured.', 0);
    const res = await fetch(c.url + path, {
      method, signal: AbortSignal.timeout(timeout),
      headers: { apikey: c.anonKey, ...(rawBody ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: rawBody || (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && (data.message || data.msg || data.error_description || data.error)) || `Request failed (${res.status}).`;
      throw new ApiError(res.status === 401 ? 'Your sign-in expired. Sign in again.' : msg, res.status, data);
    }
    return data;
  }

  let refreshing = null;
  async function session() {
    const s = readSession();
    if (!s?.access_token) throw new ApiError('Sign in to continue.', 401);
    if (jwtExp(s.access_token) * 1000 > Date.now() + 60000 && s.user?.id) return s;
    if (!s.refresh_token) throw new ApiError('Sign in to continue.', 401);
    if (!refreshing) {
      refreshing = raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } })
        .then(next => { saveSession(next); return next; })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  const Api = {
    ApiError, readSession, clearSession,
    async signIn(email, password) {
      const s = await raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
      saveSession(s); return s;
    },
    async signOut() {
      const s = readSession();
      try { if (s?.access_token) await raw('/auth/v1/logout', { method: 'POST', token: s.access_token }); } catch { /* ignore */ }
      clearSession();
    },
    async verify() {
      const s = await session();
      const user = await raw('/auth/v1/user', { token: s.access_token });
      s.user = user; saveSession(s); return s;
    },
    async select(table, query = '') {
      const s = await session();
      return raw(`/rest/v1/${table}?${query}`, { token: s.access_token });
    },
    async rpc(fn, args = {}) {
      const s = await session();
      return raw(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args, token: s.access_token });
    },
    // Upload one file to a storage bucket. Paths are never overwritten (x-upsert false).
    async upload(bucket, path, blob, contentType) {
      const s = await session();
      const p = path.split('/').map(encodeURIComponent).join('/');
      return raw(`/storage/v1/object/${bucket}/${p}`, { method: 'POST', token: s.access_token, rawBody: blob,
        headers: { 'Content-Type': contentType || blob.type || 'application/octet-stream', 'x-upsert': 'false', 'cache-control': '31536000' }, timeout: 180000 });
    },
    publicUrl(bucket, path) {
      return `${cfg().url}/storage/v1/object/public/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
    },
    baseUrl() { return cfg().url; },
    // A signed, time-limited link to a private original (staff only).
    async signedUrl(bucket, path, seconds = 600) {
      const s = await session();
      const p = path.split('/').map(encodeURIComponent).join('/');
      const r = await raw(`/storage/v1/object/sign/${bucket}/${p}`, { method: 'POST', body: { expiresIn: seconds }, token: s.access_token });
      return cfg().url + '/storage/v1' + (r.signedURL || r.signedUrl);
    },
  };
  root.WhApi = Api;
})(typeof window !== 'undefined' ? window : globalThis);
