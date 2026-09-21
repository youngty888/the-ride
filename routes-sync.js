/* Saved-route sync. Unlike rides (append-only), a saved route can be edited (notes,
   re-saved) and deleted, so each route is one whole record and the most recent edit
   wins, judged by route.updatedAt (ms).
   Deletes: a delete made here is queued in Storage.KEYS.ROUTES_DELETED so it works
   offline. A delete made on another device shows up as "we synced this route before,
   but the cloud no longer has it" (Storage.KEYS.ROUTES_SYNCED remembers what this
   device has synced), and the route is removed here instead of being re-uploaded.
   Requires the `rider_routes` table (see sql/2026-09-20-rider-routes.sql). */
const RoutesCloud = {
  account: '', busy: false, timer: null,
  MAX_BYTES: 900000,
  status(message) {
    SyncStatus.set('routes', message);
  },
  request(path, options) { return CloudRest.call(this.account, path, options); },
  // Routes saved before updatedAt existed fall back to createdAt.
  stamp(route) { return Number(route.updatedAt) || Number(route.createdAt) || 0; },
  toRow(route) {
    if (!route || !route.id || !route.from || !route.to) return null;
    const updated = this.stamp(route);
    const data = { ...route, updatedAt: updated };
    if (JSON.stringify(data).length > this.MAX_BYTES) return null;
    return { id: route.id, owner_id: this.account, name: String(route.name || 'Route').slice(0, 200),
      data, updated_ms: updated };
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
  owner() { return `owner_id=eq.${encodeURIComponent(this.account)}`; },
  async pushDeletes() {
    for (const id of Storage.get(Storage.KEYS.ROUTES_DELETED, [])) {
      await this.request(`rider_routes?${this.owner()}&id=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      Storage.set(Storage.KEYS.ROUTES_DELETED, Storage.get(Storage.KEYS.ROUTES_DELETED, []).filter(d => d !== id));
    }
  },
  async download(need) {
    if (!need.length) return [];
    const ids = need.map(id => `"${String(id).replace(/["\\]/g, '')}"`).join(',');
    return this.request(`rider_routes?${this.owner()}&id=in.(${encodeURIComponent(ids)})&select=id,data`);
  },
  async reconcile() {
    if (this.busy || getAccountId() !== this.account) return;
    this.busy = true;
    try {
      await this.pushDeletes();
      const remote = await this.request(`rider_routes?${this.owner()}&select=id,updated_ms`);
      const remoteMs = new Map(remote.map(r => [r.id, Number(r.updated_ms)]));
      const synced = Storage.get(Storage.KEYS.ROUTES_SYNCED, {});
      const deleted = new Set(Storage.get(Storage.KEYS.ROUTES_DELETED, []));
      const local = new Map(Storage.getRoutes().map(r => [r.id, r]));

      // Routes new here or newer in the cloud.
      const need = remote.filter(r => !deleted.has(r.id) &&
        !(local.has(r.id) && this.stamp(local.get(r.id)) >= Number(r.updated_ms))).map(r => r.id);
      const rows = await this.download(need);

      // Apply against a fresh read: the rider may have edited while requests were in flight.
      const current = new Map(Storage.getRoutes().map(r => [r.id, r]));
      let changed = false;
      for (const [id] of current) {
        if (synced[id] !== undefined && !remoteMs.has(id)) { current.delete(id); changed = true; } // deleted elsewhere
      }
      for (const row of rows) {
        const mine = current.get(row.id);
        if (!mine || this.stamp(row.data) > this.stamp(mine)) { current.set(row.id, row.data); changed = true; }
      }
      if (changed) {
        Storage.set(Storage.KEYS.ROUTES, [...current.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
        try { if (typeof RouteModule !== 'undefined') RouteModule.renderSaved(); } catch (e) { /* view not ready */ }
      }

      // Upload routes that are new here or newer than the cloud copy.
      const pushed = new Map();
      for (const route of current.values()) {
        if (deleted.has(route.id) || !this.toRow(route)) continue;
        const stamp = this.stamp(route);
        if (remoteMs.has(route.id) ? stamp <= remoteMs.get(route.id) : synced[route.id] !== undefined) continue;
        await this.request('rider_routes?on_conflict=owner_id,id', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(this.toRow(route))
        });
        pushed.set(route.id, stamp);
      }

      // Remember what this device has now synced.
      const next = {};
      for (const route of Storage.getRoutes()) {
        const stamp = this.stamp(route);
        if (pushed.get(route.id) === stamp || (remoteMs.has(route.id) && remoteMs.get(route.id) >= stamp)) next[route.id] = stamp;
        else if (synced[route.id] !== undefined) next[route.id] = synced[route.id];
      }
      for (const [id, stamp] of pushed) if (next[id] === undefined) next[id] = stamp;
      Storage.set(Storage.KEYS.ROUTES_SYNCED, next);
      this.status('');
    } catch (error) {
      this.status(`${error.message} Saved routes will retry automatically.`);
    } finally { this.busy = false; }
  }
};
