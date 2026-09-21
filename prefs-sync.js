/* Stop Preferences sync. Favorites, blocked brands, Add Stop start group, detour limit and
   the learned "usual" stops are one small record per rider (table rider_prefs), and the
   most recent edit wins, judged by prefs.updatedAt (ms, stamped by Storage.savePoiPrefs).
   First sync on a device that already has preferences from before syncing existed (no
   updatedAt) MERGES with the account copy instead of overwriting it, so a phone and a
   tablet that each built their own favorites keep both.
   Errors are shown on the Stop Preferences screen only (no banner over the map), and
   preferences keep working on the device when the cloud is unreachable.
   Requires the `rider_prefs` table (see sql/2026-09-21-rider-prefs.sql). */
const PrefsCloud = {
  account: '', busy: false, timer: null, message: '',
  LIST_MAX: 40, LEARNED_MAX: 60,

  request(path, options) { return CloudRest.call(this.account, path, options); },

  say(message) {
    this.message = message;
    const el = document.getElementById('prefsSyncNote');
    if (el) el.textContent = message;
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

  // Combine two copies: brand lists are unioned (a brand this device favorited stays a
  // favorite even if the other copy blocked it), learned counts keep the higher number.
  // Settings (start group, detour, learning on/off) come from `mine`, the device in use.
  merge(mine, theirs) {
    const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
    const favorites = union(mine.favorites, theirs.favorites).slice(0, this.LIST_MAX);
    const blocked = union(mine.blocked, theirs.blocked).filter(k => !favorites.includes(k)).slice(0, this.LIST_MAX);
    const learned = { ...(theirs.learned || {}) };
    for (const [key, entry] of Object.entries(mine.learned || {})) {
      if (!learned[key] || (entry.n || 0) >= (learned[key].n || 0)) learned[key] = entry;
    }
    const keys = Object.keys(learned);
    if (keys.length > this.LEARNED_MAX) {
      keys.sort((a, b) => (learned[b].n - learned[a].n) || ((learned[b].last || 0) - (learned[a].last || 0)));
      keys.slice(this.LEARNED_MAX).forEach(k => delete learned[k]);
    }
    return { ...theirs, ...mine, favorites, blocked, learned };
  },

  async push(data, stamp) {
    await this.request('rider_prefs?on_conflict=owner_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ owner_id: this.account, data, updated_ms: stamp })
    });
  },

  // Put the account copy on this device and refresh anything on screen that shows it.
  adopt(data, stamp) {
    Storage.set(Storage.KEYS.POI_PREFS, { ...data, updatedAt: stamp });
    try { if (typeof PrefsModule !== 'undefined') PrefsModule.renderIfOpen(); } catch (e) { /* view not ready */ }
    try { if (typeof App !== 'undefined' && App.applyStartGroupIfIdle) App.applyStartGroupIfIdle(); } catch (e) { /* view not ready */ }
  },

  async reconcile() {
    if (this.busy || getAccountId() !== this.account) return;
    this.busy = true;
    try {
      const rows = await this.request(`rider_prefs?owner_id=eq.${encodeURIComponent(this.account)}&select=data,updated_ms`);
      const remote = rows[0] || null;
      const local = Storage.get(Storage.KEYS.POI_PREFS, null);
      const localMs = local ? Number(local.updatedAt) || 0 : 0;
      const remoteMs = remote ? Number(remote.updated_ms) || 0 : 0;

      if (!remote && !local) {
        // nothing to sync yet
      } else if (!remote) {
        const stamp = localMs || Date.now();
        await this.push({ ...local, updatedAt: stamp }, stamp);
        if (!localMs) Storage.set(Storage.KEYS.POI_PREFS, { ...local, updatedAt: stamp });
      } else if (!local) {
        this.adopt(remote.data, remoteMs);
      } else if (!localMs) {
        // Preferences made before syncing existed: combine, then save the result both places.
        const merged = this.merge(local, remote.data);
        // Strictly newer than the account copy, even if this device's clock is behind or ties
        // with the other device's: otherwise the other device could later overwrite the merge.
        const stamp = Math.max(Date.now(), remoteMs + 1);
        await this.push({ ...merged, updatedAt: stamp }, stamp);
        this.adopt(merged, stamp);
      } else if (remoteMs > localMs) {
        this.adopt(remote.data, remoteMs);
      } else if (localMs > remoteMs) {
        await this.push(local, localMs);
      }
      this.say('Synced to your account.');
    } catch (error) {
      this.say(`${error.message} Your preferences are safe on this device and will sync when it works.`);
    } finally { this.busy = false; }
  }
};
