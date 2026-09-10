/* Profile + Garage only. Local durable outbox, explicit legacy import, revision checks. */
const RiderCloud = {
  account: '', meta: null, busy: false, timer: null, phase: 'loading', remote: null,
  key: 'rideflow_cloud_v1',
  status(message, actions = []) {
    const box = document.getElementById('cloudStatus');
    if (!box) return;
    box.replaceChildren();
    const label = document.createElement('span');
    label.textContent = message;
    box.append(label);
    for (const [text, action] of actions) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = text;
      button.addEventListener('click', action); box.append(button);
    }
  },
  snapshot() { return { profile: Storage.getProfile(), bikes: Storage.getBikes() }; },
  same(a, b) { return JSON.stringify(a) === JSON.stringify(b); },
  persist() {
    if (getAccountId() !== this.account) throw new Error('Account changed. Reload Ride.');
    if (!_ls) throw new Error('Persistent browser storage is unavailable. Enable it before saving rider data.');
    if (!Storage.set(this.key, this.meta)) throw new Error('Browser storage is full. Keep this page open and retry.');
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
    const data = await response.json();
    if (getAccountId() !== this.account) throw new Error('Account changed. Reload Ride.');
    return data;
  },
  async read() {
    const rows = await this.request(`rider_app_state?owner_id=eq.${encodeURIComponent(this.account)}&select=payload,revision,updated_at`);
    return rows[0] || null;
  },
  apply(payload) {
    if (!payload || !payload.profile || !Array.isArray(payload.bikes)) throw new Error('Invalid cloud record. Local data kept.');
    this.applying = true;
    try {
      if (!Storage.set(Storage.KEYS.PROFILE, payload.profile) || !Storage.set(Storage.KEYS.BIKES, payload.bikes)) {
        throw new Error('Browser storage is full. Cloud copy is safe; free space and retry.');
      }
    } finally { this.applying = false; }
    if (this.started) { App.renderProfile(); App.renderGarage(); App.renderEmergencyContacts(); App.updateTotalMiles(); }
  },
  async init() {
    this.account = (await RideAuth.session()).user.id;
    this.meta = Storage.get(this.key);
    this.phase = this.meta ? 'ready' : 'import';
    if (!this.meta) {
      const existing = Storage.get(Storage.KEYS.PROFILE) !== null || Storage.get(Storage.KEYS.BIKES) !== null;
      this.meta = { revision: 0, dirty: false, approved: !existing, base: null, pending: null };
      this.persist();
    }
    // Recover the durable outbox before reading remote state (including interrupted two-key writes).
    if (this.meta.dirty && this.meta.pending) this.apply(this.meta.pending);
    else if (this.meta.base && !this.same(this.snapshot(), this.meta.base)) {
      // Recover a local write interrupted before the outbox metadata was saved.
      this.meta.pending = this.snapshot(); this.meta.dirty = true; this.persist();
    }
    await this.reconcile();
    this.started = true;
    window.addEventListener('online', () => this.reconcile());
    window.addEventListener('focus', () => this.reconcile());
    window.addEventListener('beforeunload', event => {
      if (this.meta?.dirty) { event.preventDefault(); event.returnValue = ''; }
    });
  },
  changed() {
    if (!this.meta || this.applying || getAccountId() !== this.account) return;
    this.meta.pending = this.snapshot(); this.meta.dirty = true;
    try { this.persist(); } catch (error) { this.status(error.message); return; }
    if (!this.meta.approved) return this.importPrompt();
    if (this.phase === 'conflict') return this.conflictPrompt();
    this.status('Profile & Garage: saved on this device; waiting to save online.');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reconcile(), 500);
  },
  importPrompt() {
    this.phase = 'import';
    this.status('Profile & Garage: review the data on this device, including old samples, before saving it online.', [
      ['Save reviewed data online', () => this.importLocal()],
      ...(this.remote ? [['Load account copy', () => this.useCloud()]] : [])
    ]);
  },
  async importLocal() {
    this.meta.approved = true; this.meta.pending = this.snapshot(); this.meta.dirty = true;
    try { this.persist(); } catch (error) { return this.status(error.message); }
    this.phase = 'ready'; await this.reconcile();
  },
  conflictPrompt() {
    this.phase = 'conflict';
    this.status('Profile & Garage: this device and your account have different changes. Neither copy was overwritten.', [
      ['Load account copy', () => this.useCloud()],
      ['Replace account copy with this device', () => this.useLocal()]
    ]);
  },
  async backup(payload) {
    if (!Storage.set('rideflow_cloud_conflict_backup', payload)) throw new Error('Cannot preserve the previous copy. Free browser space first.');
  },
  async useCloud() {
    if (this.busy || !confirm('Load Profile and Garage from your account? The current device copy will be kept as a local backup.')) return;
    this.busy = true;
    try {
      const row = await this.read();
      if (!row) throw new Error('No account copy was found. Device data kept.');
      await this.backup(this.snapshot());
      this.apply(row.payload);
      this.meta = { approved: true, revision: row.revision, base: row.payload, dirty: false, pending: null };
      this.persist(); this.phase = 'ready'; this.saved();
    } catch (error) { this.failed(error); } finally { this.busy = false; }
  },
  async useLocal() {
    if (this.busy || !confirm('Replace the account Profile and Garage with this device’s copy?')) return;
    if (!this.remote) return this.reconcile();
    try {
      await this.backup(this.remote.payload);
      // Use the revision shown to the rider, never a newer unseen revision.
      this.meta.revision = this.remote.revision; this.meta.base = this.remote.payload;
      this.meta.pending = this.snapshot(); this.meta.dirty = true; this.meta.approved = true;
      this.persist(); this.phase = 'ready'; await this.reconcile();
    } catch (error) { this.failed(error); }
  },
  saved() { this.status('Profile & Garage: saved to your account. Rides and quote drafts are still device-only.'); },
  failed(error) {
    this.status(`${error.message} Profile & Garage changes are not confirmed online.`, [['Retry', () => this.reconcile()]]);
  },
  async reconcile() {
    if (this.busy || getAccountId() !== this.account) return;
    this.busy = true;
    let followUp = false;
    try {
      const remote = await this.read(); this.remote = remote;
      if (!this.meta.approved) { this.importPrompt(); return; }
      if (this.meta.dirty) {
        if ((remote?.revision || 0) !== this.meta.revision) {
          // A prior write may have succeeded while its response was lost.
          if (remote && this.same(remote.payload, this.meta.pending)) {
            this.meta.revision = remote.revision; this.meta.base = remote.payload;
            this.meta.dirty = false; this.meta.pending = null; this.persist(); this.phase = 'ready'; this.saved(); return;
          }
          this.conflictPrompt(); return;
        }
        const pending = JSON.parse(JSON.stringify(this.meta.pending));
        const rows = await this.request('rpc/save_rider_app_state', {
          method: 'POST', body: JSON.stringify({ expected_revision: this.meta.revision, new_payload: pending })
        });
        if (!rows.length) { this.remote = await this.read(); this.conflictPrompt(); return; }
        this.meta.revision = rows[0].revision; this.meta.base = pending;
        this.meta.dirty = !this.same(this.meta.pending, pending);
        if (!this.meta.dirty) this.meta.pending = null;
        this.persist(); this.phase = 'ready';
        followUp = this.meta.dirty;
        if (this.meta.dirty) { this.status('Profile & Garage: saving latest changes…'); }
        else this.saved();
      } else if (remote) {
        this.apply(remote.payload);
        this.meta.revision = remote.revision; this.meta.base = remote.payload; this.persist();
        this.phase = 'ready'; this.saved();
      } else if (this.meta.revision > 0) {
        throw new Error('Account copy is missing. Device data kept.');
      } else {
        this.phase = 'ready'; this.status('Profile & Garage: ready to save to your account when you make a change.');
      }
    } catch (error) { this.failed(error); }
    finally {
      this.busy = false;
      if (followUp) this.timer = setTimeout(() => this.reconcile(), 0);
    }
  }
};
