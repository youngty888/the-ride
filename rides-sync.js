/* Ride history sync. Append-only rows: each completed ride is pushed once and
   never edited remotely, so unlike RiderCloud (a single replaceable Profile+Garage
   record) there is no revision/conflict logic here — just push-unsynced / pull-missing.
   Requires the `rider_rides` table (see sql/2026-09-19-rider-rides.sql) — NOT yet
   applied to the live database, so this module is inert until that migration runs. */
const RidesCloud = {
  account: '', busy: false, timer: null,
  status(message) {
    const box = document.getElementById('ridesCloudStatus');
    if (!box) return;
    box.textContent = message;
  },
  async request(path, options = {}) {
    if (getAccountId() !== this.account) throw new Error('Account changed. Reload Ride.');
    const session = await RideAuth.session();
    if (session.user.id !== this.account) throw new Error('Account changed. Reload Ride.');
    const config = window.SICC_RIDE_SUPABASE;
    const response = await fetch(`${config.url}/rest/v1/${path}`, {
      ...options, signal: AbortSignal.timeout(15000),
      headers: { apikey: config.anonKey, Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json', ...options.headers }
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to save online.' : `Cloud unavailable (${response.status}).`);
    return response.status === 204 ? [] : response.json();
  },
  toRow(ride) {
    return { id: ride.id, owner_id: this.account, bike_id: ride.bikeId || null,
      ride_date: ride.date, distance_miles: ride.distance, duration_seconds: ride.duration || null };
  },
  fromRow(row) {
    return { id: row.id, date: row.ride_date, distance: row.distance_miles,
      duration: row.duration_seconds, bikeId: row.bike_id, synced: true };
  },
  async init() {
    this.account = (await RideAuth.session()).user.id;
    await this.reconcile();
    window.addEventListener('online', () => this.reconcile());
    window.addEventListener('focus', () => this.reconcile());
  },
  changed() {
    if (getAccountId() !== this.account) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reconcile(), 500);
  },
  async pull() {
    const rows = await this.request(`rider_rides?owner_id=eq.${encodeURIComponent(this.account)}&select=id,ride_date,distance_miles,duration_seconds,bike_id`);
    const local = Storage.getRides();
    const localIds = new Set(local.map(r => r.id));
    const missing = rows.filter(row => !localIds.has(row.id)).map(row => this.fromRow(row));
    if (missing.length) {
      const merged = [...local, ...missing].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      Storage.set(Storage.KEYS.RIDES, merged);
    }
  },
  async push() {
    const unsynced = Storage.getRides().filter(r => !r.synced);
    if (!unsynced.length) return;
    for (const ride of unsynced) {
      await this.request('rider_rides', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(this.toRow(ride))
      });
    }
    const rides = Storage.getRides().map(r => unsynced.some(u => u.id === r.id) ? { ...r, synced: true } : r);
    Storage.set(Storage.KEYS.RIDES, rides);
  },
  async reconcile() {
    if (this.busy || getAccountId() !== this.account) return;
    this.busy = true;
    try {
      await this.pull();
      await this.push();
      const stillUnsynced = Storage.getRides().some(r => !r.synced);
      this.status(stillUnsynced ? 'Ride history: saving…' : 'Ride history: saved to your account.');
    } catch (error) {
      this.status(`${error.message} Ride history will retry automatically.`);
    } finally { this.busy = false; }
  }
};
