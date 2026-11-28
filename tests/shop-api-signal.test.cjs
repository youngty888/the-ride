// Shop and /pay/ sign-in (shop/sh-api.js): no signal while renewing a sign-in
// must not be reported as "signed out".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'shop', 'sh-api.js'), 'utf8');

// A device holding an expired sign-in; `reply` answers the renewal request.
function api(reply) {
  const data = { 'sicc-ride-auth-session': JSON.stringify({ access_token: 'x.e30.x', refresh_token: 'r' }) };
  const ctx = { AbortSignal, atob, fetch: async () => reply(),
    SICC_RIDE_SUPABASE: { url: 'https://example.test', anonKey: 'anon' },
    RideSessionStore: { getItem: k => data[k] ?? null, setItem: (k, v) => { data[k] = v; }, removeItem: k => { delete data[k]; } } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.ShApi;
}
const answer = status => () => ({ ok: false, status, text: async () => '{}' });

test('no signal or a server error keeps the sign-in and is not a 401', async () => {
  for (const reply of [() => { throw new TypeError('Failed to fetch'); }, answer(500), answer(429)]) {
    const A = api(reply);
    await assert.rejects(A.verify(), e => e.status !== 401 && e.status !== 403);
    assert.ok(A.readSession());
  }
});

test('a rejected sign-in still asks to sign in again', async () => {
  for (const status of [400, 401]) {
    const A = api(answer(status));
    await assert.rejects(A.verify(), e => e.status === 401);
    assert.equal(A.readSession(), null);
  }
});
