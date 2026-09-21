/* One REST call to the rider's account database, shared by the sync modules (ride
   history, saved routes, stop preferences). Keeping it in one place means the sign-in
   check and the response handling cannot drift apart between them; an earlier copy
   failed on the empty body that a write with return=minimal answers with.
   `account` is the signed-in rider's id the module was started for. If the signed-in
   account changed since (another tab, a new sign-in), nothing is sent. */
const CloudRest = {
  async call(account, path, options = {}) {
    if (getAccountId() !== account) throw new Error('Account changed. Reload Ride.');
    const session = await RideAuth.session();
    if (session.user.id !== account) throw new Error('Account changed. Reload Ride.');
    const config = window.SICC_RIDE_SUPABASE;
    const response = await fetch(`${config.url}/rest/v1/${path}`, {
      ...options, signal: AbortSignal.timeout(15000),
      headers: { apikey: config.anonKey, Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json', ...options.headers }
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to save online.' : `Cloud unavailable (${response.status}).`);
    // Writes with return=minimal answer 201/204 with no body; only parse when there is one.
    const text = await response.text();
    return text ? JSON.parse(text) : [];
  }
};
