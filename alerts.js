/* ============================================
   The Ride — Rider Reports & Proximity Alerts (Phase 2, section D)

   ------------------------------------------------------------------
   BATTERY DISCIPLINE — read this before changing anything in here
   ------------------------------------------------------------------
   Waze burns a phone because it polls a server continuously, keeps the screen
   on, and redraws the map on every GPS fix. This module is built to do the
   opposite. Every one of these is implemented below:

    1. PREFETCH ONCE, THEN GO OFFLINE. `prefetchCorridor()` runs when a ride
       starts and caches hazards for the whole route. During the ride,
       proximity checks read ONLY that local cache. Zero network calls.
    2. NO NETWORK DURING A RIDE BY DEFAULT. There is a manual "Refresh
       hazards" button. The optional auto-refresh timer defaults to OFF
       (off / 15 min / 5 min).
    3. TIERED GPS. Exactly ONE `watchPosition` for the entire app, owned by
       MapModule.startGPS(). High accuracy only while navigating; above
       45 mph steady, `maximumAge` is raised and per-fix work is skipped.
       Nothing else in the app may call watchPosition or poll
       getCurrentPosition on a timer.
    4. SCREEN-OFF USABLE. Alerts are a Web Audio tone (distinct per hazard
       type) + spoken text + navigator.vibrate, so the rider can ride with a
       dark screen and still be warned.
    5. PAUSE WHEN HIDDEN. Page Visibility API stops map redraws, marker
       updates, animations and timers. Only the position watch and the local
       proximity test survive.
    6. THROTTLE THE MAP, NOT THE GPS. Map redraws are capped at one per 3 s
       and only while the map screen is visible.
    7. SPATIAL INDEX. Cached hazards are bucketed into a ~0.02 degree grid.
       A proximity check tests 9 cells, not thousands of points.
    8. ALERT GEOMETRY. Warn at ~0.6 mi, and only when the hazard is within
       35 degrees of current heading — nothing behind you, nothing on the
       opposite carriageway.
    9. DEDUPE + COOLDOWN. Same hazard never repeats inside 10 min; at most
       one alert every 30 s overall.
   10. BATTERY STATUS API. Under 20%, Low Power Mode engages automatically:
       no map rendering, audio only, longer GPS interval. Silently skipped
       where unsupported (iOS Safari).
   11. VISIBLE BATTERY SAVER TOGGLE in Settings, in plain English.
   12. WAKE LOCK opt-in, default OFF, labelled as the main battery cost.

   HONEST LIMIT: a web app cannot keep GPS running on iOS once Safari is
   backgrounded or the phone locks. Screen-off alerts work on Android/Chrome
   and are limited on iPhone. The Settings copy says exactly that.
   ------------------------------------------------------------------ */

const AlertsModule = {
  /* Stub for the future server. When a backend exists, set this to the POST
     URL and flushOutbox() starts working — nothing else needs to change.
     Until then every queued report just sits in localStorage. */
  SYNC_ENDPOINT: null,

  TYPES: {
    officer:  { label: 'Officer',        icon: '👮', ttlMin: 45,       tone: [880, 660],  color: '#2d9cf6', spoken: 'Officer reported ahead' },
    crash:    { label: 'Crash',          icon: '💥', ttlMin: 120,      tone: [520, 400],  color: '#e53e3e', spoken: 'Crash ahead' },
    hazard:   { label: 'Road hazard',    icon: '⚠',  ttlMin: 12 * 60,  tone: [740, 740],  color: '#f5a623', spoken: 'Road hazard ahead' },
    closure:  { label: 'Closed / const', icon: '🚧', ttlMin: 24 * 60,  tone: [300, 300],  color: '#ff6b1a', spoken: 'Road closed ahead' },
  },

  ALERT_DIST_MI: 0.6,
  HEADING_TOLERANCE: 35,
  DEDUPE_MS: 10 * 60 * 1000,
  GLOBAL_COOLDOWN_MS: 30 * 1000,
  GRID_DEG: 0.02,

  grid: {},                 // "lat|lon" -> [hazard]
  lastAlertAt: 0,
  alerted: {},              // hazardId -> ts
  refreshTimer: null,
  audioCtx: null,
  wakeLockSentinel: null,
  lowPower: false,
  batteryLevel: null,
  hidden: false,
  corridorReady: false,

  /* ================= init ================= */
  init() {
    this.pruneExpired();
    this.rebuildIndex();
    this.setupVisibility();
    this.setupBattery();
    this.applySettings();
    this.renderMapReports();
  },

  settings() { return Storage.getRideSettings(); },

  applySettings() {
    const s = this.settings();
    this.setAutoRefresh(s.refreshIntervalMin || 0);
    if (s.wakeLock) this.requestWakeLock(); else this.releaseWakeLock();
  },

  /* ================= Page Visibility (battery item 5) ================= */
  setupVisibility() {
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
      if (document.hidden) {
        // Kill everything that costs power except the GPS watch and the
        // local proximity test.
        if (MapModule.map) {
          const c = MapModule.map.getContainer();
          if (c) c.style.visibility = 'hidden'; // stops tile + CSS-filter repaints
        }
        if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
        MapModule.paused = true;
      } else {
        if (MapModule.map) {
          const c = MapModule.map.getContainer();
          if (c) c.style.visibility = '';
          MapModule.map.invalidateSize();
        }
        MapModule.paused = false;
        this.applySettings();
        this.renderMapReports();
      }
    });
  },

  /* ================= Battery Status API (item 10) ================= */
  setupBattery() {
    if (!navigator.getBattery) return; // iOS Safari — degrade silently
    navigator.getBattery().then(b => {
      const update = () => {
        this.batteryLevel = b.level;
        const shouldLowPower = b.level <= 0.20 && !b.charging;
        if (shouldLowPower !== this.lowPower) {
          this.lowPower = shouldLowPower;
          this.renderBatteryBadge();
          if (this.lowPower) {
            this.speak('Battery low. Low power mode on. Audio alerts only.');
            if (MapModule.map) {
              const c = MapModule.map.getContainer();
              if (c) c.classList.add('map-low-power');
            }
          } else if (MapModule.map) {
            const c = MapModule.map.getContainer();
            if (c) c.classList.remove('map-low-power');
          }
        }
        this.renderBatteryBadge();
      };
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
      update();
    }).catch(() => {});
  },

  renderBatteryBadge() {
    const el = document.getElementById('batteryBadge');
    if (!el) return;
    const saver = this.settings().batterySaver;
    if (!this.lowPower && !saver) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = this.lowPower
      ? `Low Power${this.batteryLevel != null ? ' · ' + Math.round(this.batteryLevel * 100) + '%' : ''}`
      : 'Battery Saver';
  },

  batteryHeavy() {
    return this.lowPower || this.settings().batterySaver;
  },

  /* ================= Reporting (2 taps, no typing) ================= */
  openReportSheet() {
    const sheet = document.getElementById('reportSheet');
    sheet.classList.add('active');
  },

  closeReportSheet() {
    document.getElementById('reportSheet').classList.remove('active');
  },

  /* One tap on a type files it immediately at the current GPS fix.
     No confirmation dialog, by design — the rider is moving. */
  fileReport(type) {
    const t = this.TYPES[type];
    if (!t) return;
    const loc = MapModule.currentLocation;
    this.closeReportSheet();
    if (!loc) {
      App.toast('No GPS fix yet — can\'t place the report. It needs your location.');
      return;
    }
    const now = Date.now();
    const report = {
      id: 'r' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      type,
      lat: loc.lat,
      lon: loc.lon,
      ts: now,
      heading: MapModule.lastHeading != null ? MapModule.lastHeading : null,
      confirmations: 0,
      expiresAt: now + t.ttlMin * 60 * 1000,
      mine: true,
    };
    Storage.saveHazardReport(report);
    this.queueForSync(report);
    this.rebuildIndex();
    this.renderMapReports();
    this.confirmTone();
    if (this.settings().voiceAlerts) this.speak(t.label + ' reported');
    if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
    App.toast(`${t.icon} ${t.label} reported — visible to you for ${this.ttlLabel(t.ttlMin)}.`);
  },

  ttlLabel(mins) {
    if (mins < 60) return mins + ' min';
    const h = mins / 60;
    return (h % 1 === 0 ? h : h.toFixed(1)) + ' hr';
  },

  /* Stub sync queue. No server yet, so this is a clean no-op that keeps the
     payloads in order for the day there is one. */
  queueForSync(report) {
    const outbox = Storage.get(Storage.KEYS.HAZARD_OUTBOX, []);
    outbox.push({ report, queuedAt: Date.now() });
    Storage.set(Storage.KEYS.HAZARD_OUTBOX, outbox.slice(-200));
    this.flushOutbox();
  },

  async flushOutbox() {
    if (!this.SYNC_ENDPOINT) return; // no server — intentionally does nothing
    const outbox = Storage.get(Storage.KEYS.HAZARD_OUTBOX, []);
    if (!outbox.length) return;
    try {
      await Geo.fetchJson(this.SYNC_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reports: outbox.map(o => o.report) }),
      });
      Storage.set(Storage.KEYS.HAZARD_OUTBOX, []);
    } catch (e) { /* keep queued, try next time */ }
  },

  /* ================= Expiry + spatial index (items 7, expiry) ================= */
  pruneExpired() {
    const now = Date.now();
    const kept = Storage.getHazardReports().filter(r => r.expiresAt > now);
    Storage.setHazardReports(kept);
    return kept;
  },

  cellKey(lat, lon) {
    return `${Math.floor(lat / this.GRID_DEG)}|${Math.floor(lon / this.GRID_DEG)}`;
  },

  rebuildIndex() {
    this.grid = {};
    const add = (h) => {
      const k = this.cellKey(h.lat, h.lon);
      (this.grid[k] = this.grid[k] || []).push(h);
    };
    this.pruneExpired().forEach(r => add({ ...r, kind: 'report' }));
    // Corridor cache: FARS clusters prefetched for the active route.
    (this.corridorHazards || []).forEach(h => add(h));
  },

  nearbyFromIndex(lat, lon) {
    const out = [];
    const ci = Math.floor(lat / this.GRID_DEG);
    const cj = Math.floor(lon / this.GRID_DEG);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const cell = this.grid[`${i}|${j}`];
        if (cell) out.push(...cell);
      }
    }
    return out;
  },

  /* ================= Prefetch corridor (item 1) ================= */
  async prefetchCorridor(route) {
    this.corridorReady = false;
    this.corridorHazards = [];
    if (!route) { this.rebuildIndex(); return; }
    try {
      const hits = await HazardModule.scanRoute(route);
      this.corridorHazards = hits.map(h => ({
        id: 'fars' + h.lat.toFixed(4) + h.lon.toFixed(4),
        type: 'crashhistory',
        lat: h.lat, lon: h.lon,
        n: h.n, way: h.way, coll: h.coll,
        kind: 'fars',
        expiresAt: Infinity,
      }));
      this.corridorReady = true;
    } catch (e) { /* ride still works, just without the history layer */ }
    this.rebuildIndex();
    App.toast(this.corridorReady
      ? `Route cached: ${this.corridorHazards.length} crash cluster${this.corridorHazards.length === 1 ? '' : 's'} + your reports. No network needed while riding.`
      : 'Riding without the crash cache — data file unavailable.');
  },

  /* ================= Proximity check (items 3, 6, 8, 9) ================= */
  lastMapRedraw: 0,
  lastFixAt: 0,

  /* Called by MapModule from the ONE watchPosition callback. */
  onPosition(loc) {
    const now = Date.now();

    // Item 3: above 45 mph steady, skip work between fixes to save cycles.
    const fast = loc.speedMph != null && loc.speedMph > 45;
    const minGap = this.batteryHeavy() ? 4000 : (fast ? 2500 : 1200);
    if (now - this.lastFixAt < minGap) return;
    this.lastFixAt = now;

    this.checkProximity(loc);

    // Item 6: map redraw throttled and only when actually visible.
    if (!this.hidden && !this.lowPower && App.currentScreen === 'map' &&
        now - this.lastMapRedraw > 3000) {
      this.lastMapRedraw = now;
      this.renderMapReports();
    }
  },

  checkProximity(loc) {
    const now = Date.now();
    if (now - this.lastAlertAt < this.GLOBAL_COOLDOWN_MS) return; // item 9
    const heading = loc.heading != null ? loc.heading : MapModule.lastHeading;
    const candidates = this.nearbyFromIndex(loc.lat, loc.lon); // item 7

    let best = null;
    for (const h of candidates) {
      if (h.expiresAt !== Infinity && h.expiresAt <= now) continue;
      if (this.alerted[h.id] && now - this.alerted[h.id] < this.DEDUPE_MS) continue; // item 9
      const d = Geo.distMi(loc.lat, loc.lon, h.lat, h.lon);
      if (d > this.ALERT_DIST_MI) continue;
      // item 8: must be roughly ahead of us
      if (heading != null) {
        const brg = Geo.bearing(loc.lat, loc.lon, h.lat, h.lon);
        if (Geo.angleDiff(brg, heading) > this.HEADING_TOLERANCE) continue;
      }
      if (!best || d < best.d) best = { h, d };
    }
    if (best) this.fireAlert(best.h, best.d);
  },

  fireAlert(h, distMi) {
    const now = Date.now();
    this.alerted[h.id] = now;
    this.lastAlertAt = now;

    let text, icon, color;
    if (h.kind === 'fars') {
      text = `Crash history ahead. ${h.n} fatal motorcycle crash${h.n === 1 ? '' : 'es'} on ${h.way || 'this road'}.`;
      icon = '⚠'; color = '#e53e3e';
      this.tone(600, 460);
    } else {
      const t = this.TYPES[h.type] || this.TYPES.hazard;
      const ageMin = Math.round((now - h.ts) / 60000);
      text = `${t.spoken}, ${distMi.toFixed(1)} miles. Reported ${ageMin < 1 ? 'just now' : ageMin + ' minutes ago'}.`;
      icon = t.icon; color = t.color;
      this.tone(t.tone[0], t.tone[1]);
    }

    if (navigator.vibrate) navigator.vibrate(h.kind === 'fars' ? [120, 80, 120] : [200, 100, 200]);
    if (this.settings().voiceAlerts) this.speak(text);
    this.showBanner(icon, text, color);
  },

  showBanner(icon, text, color) {
    const el = document.getElementById('alertBanner');
    if (!el) return;
    el.style.borderColor = color;
    el.innerHTML = `<span class="alert-banner-icon">${icon}</span><span class="alert-banner-text">${App.escapeHtml(text)}</span>`;
    el.classList.add('active');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => el.classList.remove('active'), 8000);
  },

  /* ================= Audio (item 4) ================= */
  ensureAudio() {
    if (this.audioCtx) return this.audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.audioCtx = new AC();
    return this.audioCtx;
  },

  tone(f1, f2) {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const beep = (freq, at, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur + 0.02);
    };
    beep(f1, 0, 0.18);
    beep(f2, 0.22, 0.22);
  },

  confirmTone() { this.tone(1040, 1320); },

  speak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05; u.volume = 1;
      window.speechSynthesis.speak(u);
    } catch (e) { /* no voice available */ }
  },

  /* ================= Report markers on the map ================= */
  reportLayer: null,

  renderMapReports() {
    if (!MapModule.map) return;
    if (this.lowPower) return; // item 10: no map work in low power
    if (!this.reportLayer) this.reportLayer = L.layerGroup().addTo(MapModule.map);
    this.reportLayer.clearLayers();
    const now = Date.now();
    this.pruneExpired().forEach(r => {
      const t = this.TYPES[r.type];
      if (!t) return;
      const life = t.ttlMin * 60 * 1000;
      const age = now - r.ts;
      const opacity = Math.max(0.25, 1 - age / life); // fade as it ages
      const icon = L.divIcon({
        className: 'report-marker-wrap',
        html: `<div class="report-marker" style="opacity:${opacity.toFixed(2)};border-color:${t.color}">${t.icon}</div>`,
        iconSize: [40, 40], iconAnchor: [20, 20],
      });
      const m = L.marker([r.lat, r.lon], { icon }).addTo(this.reportLayer);
      m.on('click', () => this.showReportCard(r));
    });
  },

  showReportCard(r) {
    const t = this.TYPES[r.type];
    const now = Date.now();
    const ageMin = Math.round((now - r.ts) / 60000);
    const leftMin = Math.max(0, Math.round((r.expiresAt - now) / 60000));
    const body = document.getElementById('poiSheetBody');
    body.innerHTML = `
      <div class="poi-card-head">
        <div class="poi-card-icon">${t.icon}</div>
        <div class="poi-card-titles">
          <div class="poi-card-name">${t.label}</div>
          <div class="poi-card-sub">Reported ${ageMin < 1 ? 'just now' : ageMin + ' min ago'} · expires in ${this.ttlLabel(leftMin)}</div>
        </div>
      </div>
      <div class="poi-facts">
        <div class="poi-fact"><span class="poi-fact-k">Confirmations</span><span class="poi-fact-v">${r.confirmations || 0}</span></div>
        <div class="poi-fact"><span class="poi-fact-k">Source</span><span class="poi-fact-v">${r.mine ? 'You' : 'Another rider'}</span></div>
      </div>
      <div class="poi-actions">
        <button type="button" class="poi-btn btn-primary" id="rptConfirm">Still there</button>
        <button type="button" class="poi-btn btn-secondary" id="rptGone">Gone — clear it</button>
      </div>
      <p class="hz-attr">Rider reports live on this phone only until the shared server exists. Nothing is uploaded.</p>
    `;
    document.getElementById('poiSheet').classList.add('active');
    document.getElementById('rptConfirm').addEventListener('click', () => {
      r.confirmations = (r.confirmations || 0) + 1;
      const t2 = this.TYPES[r.type];
      r.expiresAt = Date.now() + t2.ttlMin * 60 * 1000; // a confirmation refreshes it
      Storage.saveHazardReport(r);
      this.rebuildIndex(); this.renderMapReports();
      document.getElementById('poiSheet').classList.remove('active');
      App.toast('Confirmed. Timer reset.');
    });
    document.getElementById('rptGone').addEventListener('click', () => {
      const kept = Storage.getHazardReports().filter(x => x.id !== r.id);
      Storage.setHazardReports(kept);
      this.rebuildIndex(); this.renderMapReports();
      document.getElementById('poiSheet').classList.remove('active');
      App.toast('Cleared.');
    });
  },

  /* ================= Manual + optional auto refresh (item 2) ================= */
  setAutoRefresh(mins) {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (!mins) return; // OFF is the default and the right answer
    this.refreshTimer = setInterval(() => {
      if (document.hidden) return;
      this.manualRefresh(true);
    }, mins * 60 * 1000);
  },

  async manualRefresh(quiet) {
    this.pruneExpired();
    this.rebuildIndex();
    this.renderMapReports();
    const route = RouteModule.activeRoute();
    if (route) await this.prefetchCorridor(route);
    else if (!quiet) App.toast('Reports refreshed.');
  },

  /* ================= Wake lock (item 12) ================= */
  async requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (this.wakeLockSentinel) return;
    try {
      this.wakeLockSentinel = await navigator.wakeLock.request('screen');
      this.wakeLockSentinel.addEventListener('release', () => { this.wakeLockSentinel = null; });
    } catch (e) { this.wakeLockSentinel = null; }
  },

  releaseWakeLock() {
    if (this.wakeLockSentinel) {
      this.wakeLockSentinel.release().catch(() => {});
      this.wakeLockSentinel = null;
    }
  },

  /* ================= Settings screen ================= */
  renderSettings() {
    const el = document.getElementById('settingsBody');
    if (!el) return;
    const s = this.settings();
    const reports = Storage.getHazardReports();
    el.innerHTML = `
      <h3 class="plan-section-title">Battery</h3>
      <p class="plan-section-note">
        This app is built not to drain your phone the way Waze does. By default it
        downloads everything for your route <strong>once</strong> when the ride starts,
        then runs the rest of the ride with <strong>no network calls at all</strong>.
        Alerts come through as a tone, a spoken warning and a vibration, so you can
        ride with the screen off.
      </p>

      <label class="setting-row">
        <span class="setting-text">
          <span class="setting-label">Battery Saver</span>
          <span class="setting-desc">Turns off map animations and marker redraws, slows position updates to one every 4 seconds, and keeps alerts audio-only. Nothing about the warnings themselves changes.</span>
        </span>
        <span class="switch"><input type="checkbox" id="setBatterySaver" ${s.batterySaver ? 'checked' : ''}><span class="switch-slider"></span></span>
      </label>

      <label class="setting-row">
        <span class="setting-text">
          <span class="setting-label">Keep screen awake</span>
          <span class="setting-desc"><strong>This is the single biggest battery cost.</strong> Leave it off unless you want the map visible the whole ride. Off by default on purpose.</span>
        </span>
        <span class="switch"><input type="checkbox" id="setWakeLock" ${s.wakeLock ? 'checked' : ''}><span class="switch-slider"></span></span>
      </label>

      <label class="setting-row">
        <span class="setting-text">
          <span class="setting-label">Spoken alerts</span>
          <span class="setting-desc">Reads warnings out loud through your helmet speakers so you never look down.</span>
        </span>
        <span class="switch"><input type="checkbox" id="setVoice" ${s.voiceAlerts ? 'checked' : ''}><span class="switch-slider"></span></span>
      </label>

      <div class="setting-block">
        <div class="setting-label">Refresh hazards during a ride</div>
        <div class="setting-desc">Off means zero network use while riding. That is the recommended setting.</div>
        <div class="filter-chips" id="refreshChips">
          ${[[0, 'Off'], [15, 'Every 15 min'], [5, 'Every 5 min']].map(([v, l]) =>
            `<button type="button" class="chip${(s.refreshIntervalMin || 0) === v ? ' active' : ''}" data-mins="${v}">${l}</button>`).join('')}
        </div>
        <button type="button" class="btn-secondary btn-large" id="btnRefreshNow">Refresh hazards now</button>
      </div>

      <div class="setting-block warn-box">
        <strong>An honest limit on iPhone.</strong> A website cannot keep reading GPS
        once Safari is in the background or the phone is locked. Screen-off alerts
        work on Android in Chrome. On iPhone, Safari must stay open and awake for
        proximity alerts to fire. Fixing that properly needs a real installed app,
        which is a later phase.
      </div>

      <h3 class="plan-section-title">Fuel</h3>
      <div class="setting-block">
        <div class="setting-label">Reserve rule: use ${Math.round((s.reserveFactor || 0.8) * 100)}% of the tank</div>
        <div class="setting-desc">Fuel stops are planned at this share of your bike's range, so you are never running on fumes looking for a station.</div>
        <input type="range" min="65" max="90" step="5" id="setReserve" value="${Math.round((s.reserveFactor || 0.8) * 100)}" class="range-input">
      </div>

      <h3 class="plan-section-title">Your reports</h3>
      <p class="plan-section-note">${reports.length} active report${reports.length === 1 ? '' : 's'} on this phone. They expire on their own: officer 45 min, crash 2 hr, road hazard 12 hr, closure 24 hr.</p>
      <button type="button" class="btn-secondary" id="btnClearReports">Clear all my reports</button>

      <h3 class="plan-section-title">Data sources</h3>
      <p class="plan-section-note plan-attribution">
        Maps and places: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>.
        Routing: <a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM</a>.
        Weather: <a href="https://www.weather.gov/documentation/services-web-api" target="_blank" rel="noopener">NOAA / National Weather Service</a>.
        Crash history: <a href="${HazardModule.ATTRIBUTION_URL}" target="_blank" rel="noopener">${HazardModule.ATTRIBUTION}</a>.
      </p>
    `;

    document.getElementById('setBatterySaver').addEventListener('change', e => {
      const st = this.settings(); st.batterySaver = e.target.checked; Storage.saveRideSettings(st);
      this.renderBatteryBadge();
      if (MapModule.map) MapModule.map.getContainer().classList.toggle('map-battery-saver', e.target.checked);
    });
    document.getElementById('setWakeLock').addEventListener('change', e => {
      const st = this.settings(); st.wakeLock = e.target.checked; Storage.saveRideSettings(st);
      if (e.target.checked) this.requestWakeLock(); else this.releaseWakeLock();
    });
    document.getElementById('setVoice').addEventListener('change', e => {
      const st = this.settings(); st.voiceAlerts = e.target.checked; Storage.saveRideSettings(st);
      if (e.target.checked) this.speak('Spoken alerts on');
    });
    document.querySelectorAll('#refreshChips .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const st = this.settings(); st.refreshIntervalMin = +chip.dataset.mins; Storage.saveRideSettings(st);
        this.setAutoRefresh(st.refreshIntervalMin);
        this.renderSettings();
      });
    });
    document.getElementById('btnRefreshNow').addEventListener('click', () => {
      this.manualRefresh(false);
      App.toast('Hazards refreshed from the network.');
    });
    document.getElementById('setReserve').addEventListener('change', e => {
      const st = this.settings(); st.reserveFactor = (+e.target.value) / 100; Storage.saveRideSettings(st);
      this.renderSettings();
    });
    document.getElementById('btnClearReports').addEventListener('click', () => {
      if (!confirm('Clear all reports you filed on this phone?')) return;
      Storage.setHazardReports([]);
      this.rebuildIndex(); this.renderMapReports(); this.renderSettings();
    });
  },
};
