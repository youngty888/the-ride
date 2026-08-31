/* ============================================
   The Ride — Route Planner (Phase 1, sections A1 + A2)

   Destination search  : Nominatim, 600 ms debounce, 1 req/sec queue, cached
   Routing             : OSRM public server, alternatives=true
   Fuel planning       : walks the decoded polyline against the bike's real
                         effective range and finds actual stations via Overpass
   Persistence         : Storage (localStorage with in-memory fallback)

   No API keys. No build step. Nothing here fires a request per keystroke.
   ============================================ */

const RouteModule = {
  NOMINATIM: 'https://nominatim.openstreetmap.org/search',
  OSRM: 'https://router.project-osrm.org/route/v1/driving/',

  // Nominatim usage policy is a hard 1 request per second — enforced globally.
  queue: null,
  debounceTimers: {},

  // --- Plan state ---
  from: null,          // {name, lat, lon}
  to: null,
  via: [],             // up to 5 {name, lat, lon}
  departAt: null,      // Date
  routes: [],          // OSRM alternatives, augmented
  selectedIdx: 0,
  layers: [],
  markers: [],
  fuelPlan: null,
  loadedRouteId: null,

  MAX_VIA: 5,

  init() {
    this.queue = Geo.makeQueue(1100);
    this.departAt = new Date();
  },

  /* ================= Geocoding ================= */

  cacheGet(q) {
    const cache = Storage.get(Storage.KEYS.GEOCACHE, {});
    const hit = cache[q.toLowerCase()];
    if (!hit) return null;
    if (Date.now() - hit.ts > 30 * 24 * 3600 * 1000) return null; // 30 day TTL
    return hit.results;
  },

  cacheSet(q, results) {
    const cache = Storage.get(Storage.KEYS.GEOCACHE, {});
    const keys = Object.keys(cache);
    if (keys.length > 120) keys.slice(0, 40).forEach(k => delete cache[k]);
    cache[q.toLowerCase()] = { ts: Date.now(), results };
    Storage.set(Storage.KEYS.GEOCACHE, cache);
  },

  async geocode(q) {
    const cached = this.cacheGet(q);
    if (cached) return cached;
    const url = `${this.NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=8&countrycodes=us`;
    const data = await this.queue(() => Geo.fetchJson(url, { headers: { Accept: 'application/json' } }));
    if (!Array.isArray(data)) throw new Error('Search failed');
    const results = data.map(r => ({
      name: r.display_name,
      short: (r.display_name || '').split(',').slice(0, 2).join(',').trim(),
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      type: r.type,
    }));
    this.cacheSet(q, results);
    return results;
  },

  /* Attach debounced autocomplete to an input.
     onPick receives {name, lat, lon}. 600 ms debounce, minimum 3 chars. */
  attachAutocomplete(input, resultsEl, onPick) {
    const key = input.id || Math.random().toString(36);
    input.addEventListener('input', () => {
      clearTimeout(this.debounceTimers[key]);
      const q = input.value.trim();
      input.dataset.picked = '';
      if (q.length < 3) { resultsEl.innerHTML = ''; return; }
      resultsEl.innerHTML = '<div class="geo-hint">Searching…</div>';
      this.debounceTimers[key] = setTimeout(async () => {
        try {
          const results = await this.geocode(q);
          if (!results.length) {
            resultsEl.innerHTML = '<div class="geo-hint">No match. Try a city, a park, or a full address.</div>';
            return;
          }
          resultsEl.innerHTML = results.map((r, i) =>
            `<button type="button" class="geo-result" data-i="${i}">
               <span class="geo-result-name">${App.escapeHtml(r.short)}</span>
               <span class="geo-result-full">${App.escapeHtml(r.name)}</span>
             </button>`).join('');
          resultsEl.querySelectorAll('.geo-result').forEach(btn => {
            btn.addEventListener('click', () => {
              const r = results[+btn.dataset.i];
              input.value = r.short;
              input.dataset.picked = '1';
              resultsEl.innerHTML = '';
              onPick({ name: r.short, fullName: r.name, lat: r.lat, lon: r.lon });
            });
          });
        } catch (e) {
          resultsEl.innerHTML = `<div class="geo-hint geo-hint-error">Search failed. <button type="button" class="geo-retry">Retry</button></div>`;
          const retry = resultsEl.querySelector('.geo-retry');
          if (retry) retry.addEventListener('click', () => input.dispatchEvent(new Event('input')));
        }
      }, 600);
    });
  },

  /* ================= Routing ================= */

  async fetchRoutes(points) {
    const coordStr = points.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const url = `${this.OSRM}${coordStr}?overview=full&geometries=polyline&steps=true&alternatives=true`;
    const data = await Geo.fetchJson(url, {}, 15000);
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new Error(data.message || 'No route found between those points.');
    }
    return data.routes.map((r, i) => {
      const coords = Geo.decodePolyline(r.geometry, 5);
      const cum = Geo.cumulative(coords);
      const steps = [];
      (r.legs || []).forEach(leg => (leg.steps || []).forEach(s => steps.push({
        name: s.name || '',
        distanceMi: (s.distance || 0) / 1609.34,
        type: (s.maneuver && s.maneuver.type) || '',
        modifier: (s.maneuver && s.maneuver.modifier) || '',
        exit: s.maneuver && s.maneuver.exit,
      })));
      return {
        idx: i,
        geometry: r.geometry,
        coords, cum, steps,
        distanceMi: (r.distance || 0) / 1609.34,
        durationSec: r.duration || 0,
        label: i === 0 ? 'Fastest' : `Alternate ${i}`,
      };
    });
  },

  /* ================= Fuel planning (A2) ================= */

  selectedBike() {
    const bikes = Storage.getBikes();
    if (!bikes.length) return null;
    const sel = document.getElementById('planBike');
    if (sel && sel.value) {
      const b = bikes.find(x => x.id === sel.value);
      if (b) return b;
    }
    return bikes[0];
  },

  // Effective range in miles, with the reserve factor applied.
  effectiveRange() {
    const bike = this.selectedBike();
    const settings = Storage.getRideSettings();
    const reserve = settings.reserveFactor || 0.80;
    let base = null;
    if (bike) {
      base = bike.tankRange || (bike.tankSize && bike.mpg ? bike.tankSize * bike.mpg : null);
    }
    if (!base) base = 120; // no bike on file — conservative touring default
    let eff = base * reserve;

    // Cap to the pack's gas interval if a pack is selected and it's tighter.
    const packSel = document.getElementById('planPack');
    let packInterval = null;
    if (packSel && packSel.value) {
      const pack = Storage.getPack(packSel.value);
      if (pack && pack.gasInterval) packInterval = pack.gasInterval;
    }
    const capped = packInterval != null && packInterval < eff;
    return {
      baseRange: base,
      reserve,
      rangeMi: capped ? packInterval : eff,
      packInterval,
      cappedByPack: capped,
      bike,
    };
  },

  /* Walk the polyline accumulating distance; at each multiple of the effective
     range take that coordinate as a target fuel point, then look for real
     stations near it. Warn loudly where no station exists inside range. */
  async computeFuelPlan(route) {
    const eff = this.effectiveRange();
    const total = route.cum[route.cum.length - 1];
    const targets = [];
    for (let m = eff.rangeMi; m < total - 5; m += eff.rangeMi) {
      const p = Geo.pointAtMile(route.coords, route.cum, m);
      targets.push({ targetMile: m, lat: p.lat, lon: p.lon });
    }

    const stops = [];
    const errors = [];
    for (const t of targets) {
      try {
        const { candidates, searchRadiusMi } = await PoiModule.fuelNear(t.lat, t.lon, route.coords, route.cum);
        stops.push({
          targetMile: t.targetMile,
          searchRadiusMi,
          chosen: candidates[0] || null,
          candidates: candidates.slice(0, 8),
        });
      } catch (e) {
        // Overpass is down or rate-limited. The rider still gets the mileage
        // math — we just can't name the station. Say which it is.
        errors.push(t.targetMile);
        stops.push({ targetMile: t.targetMile, chosen: null, candidates: [], failed: true });
      }
    }

    // Gap analysis: start → stop 1 → … → destination, using actual chosen
    // stations' mileage along the route, not the ideal target mileage.
    const marks = [0];
    stops.forEach(s => { if (s.chosen && s.chosen.routeMile != null) marks.push(s.chosen.routeMile); });
    marks.push(total);
    marks.sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < marks.length; i++) {
      const gap = marks[i] - marks[i - 1];
      if (gap > eff.rangeMi + 0.5) {
        gaps.push({ from: marks[i - 1], to: marks[i], gapMi: gap });
      }
    }

    this.fuelPlan = { eff, total, stops, gaps, errors, targets: targets.length };
    return this.fuelPlan;
  },

  /* ================= Drawing ================= */

  clearMap() {
    if (!MapModule.map) return;
    this.layers.forEach(l => MapModule.map.removeLayer(l));
    this.markers.forEach(m => MapModule.map.removeLayer(m));
    this.layers = [];
    this.markers = [];
  },

  drawRoutes(fit = true) {
    if (!MapModule.map) return;
    this.clearMap();

    // Alternates first so the selected route paints on top.
    this.routes.forEach((r, i) => {
      if (i === this.selectedIdx) return;
      const line = L.polyline(r.coords, {
        color: '#6b7280', weight: 4, opacity: 0.65, dashArray: '8 8',
      }).addTo(MapModule.map);
      line.on('click', () => { this.selectRoute(i); });
      this.layers.push(line);
    });

    const sel = this.routes[this.selectedIdx];
    if (sel) {
      const halo = L.polyline(sel.coords, { color: '#000', weight: 11, opacity: 0.45 }).addTo(MapModule.map);
      const line = L.polyline(sel.coords, { color: '#ff6b1a', weight: 6, opacity: 0.95 }).addTo(MapModule.map);
      this.layers.push(halo, line);
    }

    const pin = (p, label, cls) => {
      const icon = L.divIcon({
        className: 'route-pin-wrap',
        html: `<div class="route-pin ${cls}">${label}</div>`,
        iconSize: [30, 30], iconAnchor: [15, 15],
      });
      const m = L.marker([p.lat, p.lon], { icon }).addTo(MapModule.map);
      this.markers.push(m);
    };
    if (this.from) pin(this.from, 'A', 'route-pin-start');
    this.via.forEach((v, i) => pin(v, String(i + 1), 'route-pin-via'));
    if (this.to) pin(this.to, 'B', 'route-pin-end');

    if (fit && sel) {
      MapModule.map.fitBounds(L.latLngBounds(sel.coords), { padding: [40, 40] });
    }
  },

  /* ================= Panel UI ================= */

  openPanel(view = 'plan') {
    document.getElementById('overlay-plan').classList.add('active');
    this.showView(view);
    if (view === 'trips') this.renderTrips();
    if (view === 'saved') this.renderSaved();
  },

  showView(view) {
    document.querySelectorAll('#planTabs .toggle-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.view === view));
    ['plan', 'trips', 'saved'].forEach(v => {
      const el = document.getElementById(v + 'View');
      if (el) el.style.display = v === view ? 'block' : 'none';
    });
    if (view === 'trips') this.renderTrips();
    if (view === 'saved') this.renderSaved();
  },

  setupUI() {
    // Tabs
    document.querySelectorAll('#planTabs .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => this.showView(btn.dataset.view));
    });

    // Autocomplete on From / To
    this.attachAutocomplete(
      document.getElementById('planFrom'),
      document.getElementById('planFromResults'),
      (p) => { this.from = p; }
    );
    this.attachAutocomplete(
      document.getElementById('planTo'),
      document.getElementById('planToResults'),
      (p) => { this.to = p; }
    );

    // Use my location
    document.getElementById('btnUseGps').addEventListener('click', () => this.useGpsAsOrigin());

    // Via waypoints
    document.getElementById('btnAddVia').addEventListener('click', () => this.addViaRow());

    // Departure default = now
    const dep = document.getElementById('planDepart');
    dep.value = this.toLocalInput(new Date());
    dep.addEventListener('change', () => {
      const d = new Date(dep.value);
      this.departAt = isNaN(d) ? new Date() : d;
    });

    // Reserve slider
    const reserve = document.getElementById('planReserve');
    const settings = Storage.getRideSettings();
    reserve.value = Math.round((settings.reserveFactor || 0.8) * 100);
    this.updateReserveLabel();
    reserve.addEventListener('input', () => {
      const s = Storage.getRideSettings();
      s.reserveFactor = (+reserve.value) / 100;
      Storage.saveRideSettings(s);
      this.updateReserveLabel();
    });

    // Bike + pack selectors
    this.populateSelectors();

    // Submit
    document.getElementById('planForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.plan();
    });

    document.getElementById('closePlan').addEventListener('click', () => {
      document.getElementById('overlay-plan').classList.remove('active');
    });
  },

  updateReserveLabel() {
    const v = +document.getElementById('planReserve').value;
    const eff = this.effectiveRange();
    document.getElementById('planReserveLabel').textContent =
      `Use ${v}% of tank before fueling — about ${Math.round(eff.rangeMi)} mi between stops`;
  },

  populateSelectors() {
    const bikeSel = document.getElementById('planBike');
    const bikes = Storage.getBikes();
    bikeSel.innerHTML = bikes.length
      ? bikes.map(b => `<option value="${b.id}">${App.escapeHtml(b.nickname || (b.make + ' ' + b.model))} — ${b.tankRange || Math.round((b.tankSize || 0) * (b.mpg || 0)) || '?'} mi tank</option>`).join('')
      : '<option value="">No bike on file — assuming 120 mi</option>';

    const packSel = document.getElementById('planPack');
    const packs = Storage.getPacks();
    packSel.innerHTML = '<option value="">Riding solo</option>' +
      packs.map(p => `<option value="${p.id}">${App.escapeHtml(p.name)} — gas every ${p.gasInterval} mi</option>`).join('');

    bikeSel.addEventListener('change', () => this.updateReserveLabel());
    packSel.addEventListener('change', () => this.updateReserveLabel());
  },

  toLocalInput(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  useGpsAsOrigin() {
    const input = document.getElementById('planFrom');
    const loc = MapModule.currentLocation;
    if (loc) {
      this.from = { name: 'My location', lat: loc.lat, lon: loc.lon };
      input.value = 'My location';
      document.getElementById('planFromResults').innerHTML = '';
      return;
    }
    input.value = '';
    document.getElementById('planFromResults').innerHTML =
      '<div class="geo-hint geo-hint-error">No GPS fix yet. Type a starting point instead — the planner works fine without location permission.</div>';
    MapModule.requestOneFix(() => this.useGpsAsOrigin());
  },

  addViaRow(prefill) {
    const list = document.getElementById('viaList');
    if (list.querySelectorAll('.via-row').length >= this.MAX_VIA) {
      alert(`You can add up to ${this.MAX_VIA} stops along the way.`);
      return;
    }
    const i = Date.now().toString(36);
    const row = document.createElement('div');
    row.className = 'via-row';
    row.innerHTML = `
      <div class="via-row-top">
        <input type="text" class="via-input" id="via-${i}" placeholder="Stop along the way">
        <button type="button" class="via-remove" aria-label="Remove stop">✕</button>
      </div>
      <div class="geo-results" id="viaRes-${i}"></div>`;
    list.appendChild(row);
    const input = row.querySelector('.via-input');
    const res = row.querySelector('.geo-results');
    this.attachAutocomplete(input, res, (p) => { row.dataset.lat = p.lat; row.dataset.lon = p.lon; row.dataset.name = p.name; });
    row.querySelector('.via-remove').addEventListener('click', () => row.remove());
    if (prefill) {
      input.value = prefill.name;
      row.dataset.lat = prefill.lat; row.dataset.lon = prefill.lon; row.dataset.name = prefill.name;
    }
  },

  collectVia() {
    this.via = [];
    document.querySelectorAll('#viaList .via-row').forEach(row => {
      if (row.dataset.lat && row.dataset.lon) {
        this.via.push({ name: row.dataset.name || 'Stop', lat: +row.dataset.lat, lon: +row.dataset.lon });
      }
    });
  },

  status(html, kind = '') {
    const el = document.getElementById('planStatus');
    el.className = 'plan-status ' + kind;
    el.innerHTML = html;
  },

  /* ---------- The main action ---------- */
  async plan(opts = {}) {
    this.collectVia();

    // Fall back to GPS origin if the rider left "From" blank.
    if (!this.from) {
      const loc = MapModule.currentLocation;
      if (loc) this.from = { name: 'My location', lat: loc.lat, lon: loc.lon };
    }
    if (!this.from) {
      this.status('Set a starting point. Tap <strong>Use My Location</strong> or type an address.', 'plan-status-error');
      return;
    }
    if (!this.to) {
      this.status('Search a destination in the <strong>To</strong> field and tap a result.', 'plan-status-error');
      return;
    }

    const dep = document.getElementById('planDepart');
    const d = new Date(dep.value);
    this.departAt = isNaN(d) ? new Date() : d;

    this.status(`<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-line">Finding routes…</div>`, 'plan-status-loading');
    document.getElementById('planResults').innerHTML = '';

    let routes;
    try {
      routes = await this.fetchRoutes([this.from, ...this.via, this.to]);
    } catch (e) {
      this.status(`Couldn't get a route: ${App.escapeHtml(e.message || 'network error')}. <button type="button" class="btn-secondary plan-retry" id="planRetry">Retry</button>`, 'plan-status-error');
      const btn = document.getElementById('planRetry');
      if (btn) btn.addEventListener('click', () => this.plan(opts));
      return;
    }

    this.routes = routes;
    this.selectedIdx = 0;
    this.loadedRouteId = opts.loadedRouteId || null;
    this.status('', '');
    this.drawRoutes(true);
    this.renderResults();
    // Bring the results into view — the form is long and the rider shouldn't
    // have to hunt for the answer.
    const results = document.getElementById('planResults');
    if (results) results.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Fuel plan and hazards are cheap-ish; weather is opt-in per tap.
    this.renderFuelPlan(true);
    this.computeFuelPlan(this.routes[this.selectedIdx])
      .then(() => this.renderFuelPlan(false))
      .catch(() => this.renderFuelPlan(false, true));

    HazardModule.scanRoute(this.routes[this.selectedIdx])
      .then(() => this.renderHazards())
      .catch(() => this.renderHazards(true));

    App.updateRouteBar();
  },

  selectRoute(i) {
    if (i === this.selectedIdx || !this.routes[i]) return;
    this.selectedIdx = i;
    this.drawRoutes(false);
    this.renderResults();
    this.renderFuelPlan(true);
    this.computeFuelPlan(this.routes[i]).then(() => this.renderFuelPlan(false)).catch(() => this.renderFuelPlan(false, true));
    HazardModule.scanRoute(this.routes[i]).then(() => this.renderHazards()).catch(() => this.renderHazards(true));
    document.getElementById('weatherSection').innerHTML = this.weatherPromptHtml();
    this.bindWeatherButton();
    App.updateRouteBar();
  },

  /* ---------- Results rendering ---------- */
  renderResults() {
    const el = document.getElementById('planResults');
    const sel = this.routes[this.selectedIdx];
    const arrival = new Date(this.departAt.getTime() + sel.durationSec * 1000);

    el.innerHTML = `
      <div class="route-options" id="routeOptions">
        ${this.routes.map((r, i) => `
          <button type="button" class="route-option${i === this.selectedIdx ? ' active' : ''}" data-i="${i}">
            <span class="route-option-label">${r.label}</span>
            <span class="route-option-main">${Geo.fmtMi(r.distanceMi)} mi</span>
            <span class="route-option-sub">${Geo.fmtDuration(r.durationSec)} · ${Math.max(0, Math.floor(r.distanceMi / Math.max(1, this.effectiveRange().rangeMi)))} fuel stops</span>
          </button>`).join('')}
      </div>

      <div class="route-summary">
        <div class="route-summary-grid">
          <div class="rs-item"><div class="rs-value">${Geo.fmtMi(sel.distanceMi)}</div><div class="rs-label">Miles</div></div>
          <div class="rs-item"><div class="rs-value">${Geo.fmtDuration(sel.durationSec)}</div><div class="rs-label">Ride Time</div></div>
          <div class="rs-item"><div class="rs-value">${Geo.fmtClock(arrival)}</div><div class="rs-label">Arrive</div></div>
        </div>
        <div class="route-summary-route">${App.escapeHtml(this.from.name)} → ${this.via.length ? App.escapeHtml(this.via.map(v => v.name).join(' → ')) + ' → ' : ''}${App.escapeHtml(this.to.name)}</div>
      </div>

      <div class="route-actions">
        <button type="button" class="btn-primary" id="btnShowOnMap">Show On Map</button>
        <button type="button" class="btn-secondary" id="btnSaveRoute">Save Route</button>
      </div>

      <section class="plan-section" id="fuelSection"></section>
      <section class="plan-section" id="weatherSection"></section>
      <section class="plan-section" id="hazardSection"></section>

      <section class="plan-section">
        <button type="button" class="plan-section-toggle" id="stepsToggle" aria-expanded="false">
          <span>Turn-by-turn (${sel.steps.length} steps)</span><span class="chev">▾</span>
        </button>
        <div class="steps-list" id="stepsList" hidden></div>
      </section>
    `;

    el.querySelectorAll('.route-option').forEach(btn => {
      btn.addEventListener('click', () => this.selectRoute(+btn.dataset.i));
    });
    document.getElementById('btnShowOnMap').addEventListener('click', () => {
      document.getElementById('overlay-plan').classList.remove('active');
      App.switchScreen('map');
      setTimeout(() => this.drawRoutes(true), 150);
    });
    document.getElementById('btnSaveRoute').addEventListener('click', () => this.saveCurrent());

    // Turn-by-turn, collapsed by default, big text.
    const toggle = document.getElementById('stepsToggle');
    const stepsList = document.getElementById('stepsList');
    toggle.addEventListener('click', () => {
      const open = stepsList.hidden;
      stepsList.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.querySelector('.chev').textContent = open ? '▴' : '▾';
      if (open && !stepsList.dataset.filled) {
        stepsList.innerHTML = sel.steps.map((s, i) => `
          <div class="step-row">
            <div class="step-num">${i + 1}</div>
            <div class="step-body">
              <div class="step-text">${App.escapeHtml(this.stepText(s))}</div>
              <div class="step-dist">${s.distanceMi < 0.1 ? '' : Geo.fmtMi(s.distanceMi) + ' mi'}</div>
            </div>
          </div>`).join('');
        stepsList.dataset.filled = '1';
      }
    });

    document.getElementById('weatherSection').innerHTML = this.weatherPromptHtml();
    this.bindWeatherButton();
    this.renderFuelPlan(true);
    this.renderHazards();
  },

  stepText(s) {
    const road = s.name ? ` onto ${s.name}` : '';
    const mod = s.modifier ? s.modifier.replace(/_/g, ' ') : '';
    switch (s.type) {
      case 'depart': return `Start out${s.name ? ' on ' + s.name : ''}`;
      case 'arrive': return 'Arrive at your destination';
      case 'turn': return `Turn ${mod}${road}`;
      case 'merge': return `Merge ${mod}${road}`;
      case 'on ramp': return `Take the ramp${road}`;
      case 'off ramp': return `Take the exit${s.exit ? ' ' + s.exit : ''}${road}`;
      case 'fork': return `Keep ${mod}${road}`;
      case 'roundabout': return `Roundabout, exit ${s.exit || ''}${road}`;
      case 'continue': return `Continue ${mod}${road}`;
      case 'new name': return `Continue${road}`;
      case 'end of road': return `At the end of the road, turn ${mod}${road}`;
      default: return `${(s.type || 'Continue')} ${mod}${road}`.trim();
    }
  },

  /* ---------- Fuel plan strip ---------- */
  renderFuelPlan(loading, failed) {
    const el = document.getElementById('fuelSection');
    if (!el) return;
    const eff = this.effectiveRange();
    const head = `
      <h3 class="plan-section-title">Fuel Plan</h3>
      <p class="plan-section-note">
        ${eff.bike ? App.escapeHtml(eff.bike.nickname || (eff.bike.make + ' ' + eff.bike.model)) : 'No bike selected'} ·
        ${Math.round(eff.baseRange)} mi tank · ${Math.round(eff.reserve * 100)}% reserve rule
        → <strong>${Math.round(eff.rangeMi)} mi between stops</strong>${eff.cappedByPack ? ` (capped by your pack's ${eff.packInterval} mi gas interval)` : ''}
      </p>`;

    if (loading) {
      el.innerHTML = head + `<div class="skeleton-row"></div><div class="skeleton-line">Looking for real gas stations along the route…</div>`;
      return;
    }
    if (failed || !this.fuelPlan) {
      el.innerHTML = head + `<div class="err-box">Couldn't reach the map data server for fuel stops. <button type="button" class="btn-secondary" id="fuelRetry">Retry</button></div>`;
      const b = document.getElementById('fuelRetry');
      if (b) b.addEventListener('click', () => {
        this.renderFuelPlan(true);
        this.computeFuelPlan(this.routes[this.selectedIdx]).then(() => this.renderFuelPlan(false)).catch(() => this.renderFuelPlan(false, true));
      });
      return;
    }

    const fp = this.fuelPlan;
    const chips = [
      `<div class="fuel-chip fuel-chip-end"><div class="fuel-chip-name">${App.escapeHtml(this.from.name)}</div><div class="fuel-chip-meta">Start · full tank</div></div>`,
    ];
    fp.stops.forEach((s, i) => {
      if (s.chosen) {
        chips.push(`<button type="button" class="fuel-chip" data-stop="${i}">
          <div class="fuel-chip-name">${App.escapeHtml(s.chosen.name)}</div>
          <div class="fuel-chip-meta">Mile ${Math.round(s.chosen.routeMile)} · +${(s.chosen.detourMi || 0).toFixed(1)} mi off route</div>
          <div class="fuel-chip-swap">${s.candidates.length > 1 ? `Tap: ${s.candidates.length - 1} alternates` : 'Tap for details'}</div>
        </button>`);
      } else if (s.failed) {
        chips.push(`<div class="fuel-chip fuel-chip-unknown">
          <div class="fuel-chip-name">Fuel by mile ${Math.round(s.targetMile)}</div>
          <div class="fuel-chip-meta">Couldn't reach the station database — the mileage still holds, fill up here.</div>
        </div>`);
      } else {
        chips.push(`<div class="fuel-chip fuel-chip-none">
          <div class="fuel-chip-name">No station found</div>
          <div class="fuel-chip-meta">Near mile ${Math.round(s.targetMile)} — searched out to 20 mi</div>
        </div>`);
      }
    });
    chips.push(`<div class="fuel-chip fuel-chip-end"><div class="fuel-chip-name">${App.escapeHtml(this.to.name)}</div><div class="fuel-chip-meta">Mile ${Math.round(fp.total)}</div></div>`);

    const lookupFailed = fp.errors.length > 0;
    const warnings = (lookupFailed ? [] : fp.gaps).map(g => `
      <div class="warn-box">
        <strong>No fuel for ${Math.round(g.gapMi)} mi</strong> between mile ${Math.round(g.from)} and mile ${Math.round(g.to)}.
        Your effective range is ${Math.round(fp.eff.rangeMi)} mi. Carry fuel, top off early, or reroute.
      </div>`).join('');

    el.innerHTML = head +
      (fp.stops.length === 0 ? `<p class="plan-section-note">This ride is inside one tank. No fuel stop needed.</p>` : '') +
      (lookupFailed ? `<div class="warn-box">Couldn't reach the gas-station database for ${fp.errors.length} of ${fp.stops.length} stops, so the stations below aren't named. The <strong>${Math.round(fp.eff.rangeMi)} mi</strong> spacing is still right — plan to fill up at those mile marks. <button type="button" class="btn-secondary" id="fuelRetry2">Retry lookup</button></div>` : '') +
      warnings +
      `<div class="fuel-strip">${chips.join('<span class="fuel-arrow">→</span>')}</div>`;

    el.querySelectorAll('.fuel-chip[data-stop]').forEach(btn => {
      btn.addEventListener('click', () => this.showFuelStopOptions(+btn.dataset.stop));
    });
    const retry2 = document.getElementById('fuelRetry2');
    if (retry2) retry2.addEventListener('click', () => {
      this.renderFuelPlan(true);
      this.computeFuelPlan(this.routes[this.selectedIdx])
        .then(() => this.renderFuelPlan(false)).catch(() => this.renderFuelPlan(false, true));
    });
  },

  showFuelStopOptions(i) {
    const stop = this.fuelPlan.stops[i];
    if (!stop || !stop.candidates.length) return;
    const body = document.getElementById('poiSheetBody');
    body.innerHTML = `
      <div class="poi-card-head">
        <div class="poi-card-icon">⛽</div>
        <div class="poi-card-titles">
          <div class="poi-card-name">Fuel stop near mile ${Math.round(stop.targetMile)}</div>
          <div class="poi-card-sub">${stop.candidates.length} station${stop.candidates.length === 1 ? '' : 's'} within ${stop.searchRadiusMi} mi</div>
        </div>
      </div>
      <div class="poi-swap-list">
        ${stop.candidates.map((c, j) => `
          <button type="button" class="poi-row${stop.chosen && c.id === stop.chosen.id ? ' poi-row-active' : ''}" data-j="${j}">
            <span class="poi-row-icon">⛽</span>
            <span class="poi-row-body">
              <span class="poi-row-name">${App.escapeHtml(c.name)}</span>
              <span class="poi-row-meta">
                <span>+${(c.detourMi || 0).toFixed(1)} mi detour</span>
                <span class="poi-mile">Mile ${Math.round(c.routeMile || 0)}</span>
                <span class="${PoiModule.hoursBadge(c).cls}">${PoiModule.hoursBadge(c).text}</span>
              </span>
            </span>
            <span class="poi-row-chevron">›</span>
          </button>`).join('')}
      </div>
      <button class="btn-secondary poi-btn" id="poiSwapDetails">Open card for the selected station</button>
    `;
    document.getElementById('poiSheet').classList.add('active');
    body.querySelectorAll('.poi-row').forEach(btn => {
      btn.addEventListener('click', () => {
        stop.chosen = stop.candidates[+btn.dataset.j];
        this.renderFuelPlan(false);
        PoiModule.showCard(stop.chosen);
      });
    });
    document.getElementById('poiSwapDetails').addEventListener('click', () => {
      if (stop.chosen) PoiModule.showCard(stop.chosen);
    });
  },

  /* ---------- Weather section (delegates to weather.js) ---------- */
  weatherPromptHtml() {
    return `
      <h3 class="plan-section-title">Route Weather</h3>
      <p class="plan-section-note">
        Checks the forecast <em>for the time you'll actually be there</em>, not for right now.
        One batch of requests, then cached for 30 minutes.
      </p>
      <button type="button" class="btn-secondary btn-large" id="btnLoadWeather">Check weather along this route</button>`;
  },

  bindWeatherButton() {
    const btn = document.getElementById('btnLoadWeather');
    if (btn) btn.addEventListener('click', () => WeatherModule.loadForRoute(this.routes[this.selectedIdx], this.departAt));
  },

  /* ---------- Hazard section (delegates to hazards.js) ---------- */
  renderHazards(failed) {
    const el = document.getElementById('hazardSection');
    if (el) el.innerHTML = HazardModule.routeSectionHtml(failed);
    HazardModule.bindRouteSection();
  },

  /* ================= Save / load ================= */

  saveCurrent() {
    if (!this.routes.length) return;
    const sel = this.routes[this.selectedIdx];
    const name = prompt('Name this route:',
      `${this.from.name.split(',')[0]} → ${this.to.name.split(',')[0]}`);
    if (!name) return;
    const route = {
      id: this.loadedRouteId || Storage.genId(),
      name,
      from: this.from,
      to: this.to,
      waypoints: this.via,
      geometry: sel.geometry,
      distanceMi: sel.distanceMi,
      durationSec: sel.durationSec,
      departAt: this.departAt.toISOString(),
      createdAt: Date.now(),
      notes: '',
      rating: 0,
      ratingCount: 0,
      comments: [],
    };
    Storage.saveRoute(route);
    this.loadedRouteId = route.id;
    this.status(`Saved <strong>${App.escapeHtml(name)}</strong> to your routes.`, 'plan-status-ok');
    this.renderSaved();
  },

  renderSaved() {
    const el = document.getElementById('savedRoutesList');
    if (!el) return;
    const routes = Storage.getRoutes();
    if (!routes.length) {
      el.innerHTML = `<div class="empty-state-container"><p class="empty-state">No saved routes yet. Plan a ride and tap <strong>Save Route</strong>. Saved routes work offline.</p></div>`;
      return;
    }
    el.innerHTML = routes.map(r => `
      <div class="saved-route">
        <div class="saved-route-head">
          <div class="saved-route-name">${App.escapeHtml(r.name)}</div>
          <div class="saved-route-stats">${Geo.fmtMi(r.distanceMi)} mi · ${Geo.fmtDuration(r.durationSec)}</div>
        </div>
        <div class="saved-route-sub">${App.escapeHtml(r.from.name)} → ${App.escapeHtml(r.to.name)}${r.waypoints && r.waypoints.length ? ` · ${r.waypoints.length} stop${r.waypoints.length === 1 ? '' : 's'}` : ''}</div>
        ${r.notes ? `<div class="saved-route-notes">${App.escapeHtml(r.notes)}</div>` : ''}
        <div class="saved-route-actions">
          <button type="button" class="btn-primary saved-load" data-id="${r.id}">Load</button>
          <button type="button" class="btn-secondary saved-note" data-id="${r.id}">Notes</button>
          <button type="button" class="btn-secondary saved-del" data-id="${r.id}">Delete</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('.saved-load').forEach(b => b.addEventListener('click', () => this.loadSaved(b.dataset.id)));
    el.querySelectorAll('.saved-del').forEach(b => b.addEventListener('click', () => {
      if (confirm('Delete this saved route?')) { Storage.deleteRoute(b.dataset.id); this.renderSaved(); }
    }));
    el.querySelectorAll('.saved-note').forEach(b => b.addEventListener('click', () => {
      const r = Storage.getRoute(b.dataset.id);
      const notes = prompt('Notes for this route:', r.notes || '');
      if (notes === null) return;
      r.notes = notes; Storage.saveRoute(r); this.renderSaved();
    }));
  },

  /* Loading a saved route draws the stored geometry immediately (works
     offline), then re-routes in the background for live steps and fuel. */
  loadSaved(id) {
    const r = Storage.getRoute(id);
    if (!r) return;
    this.from = r.from; this.to = r.to; this.via = r.waypoints || [];
    this.departAt = new Date();

    document.getElementById('planFrom').value = r.from.name;
    document.getElementById('planTo').value = r.to.name;
    document.getElementById('viaList').innerHTML = '';
    this.via.forEach(v => this.addViaRow(v));
    document.getElementById('planDepart').value = this.toLocalInput(this.departAt);

    // Offline-first: paint the stored polyline right away.
    if (r.geometry) {
      const coords = Geo.decodePolyline(r.geometry, 5);
      this.routes = [{
        idx: 0, geometry: r.geometry, coords, cum: Geo.cumulative(coords), steps: [],
        distanceMi: r.distanceMi, durationSec: r.durationSec, label: 'Saved',
      }];
      this.selectedIdx = 0;
      this.drawRoutes(true);
    }
    this.showView('plan');
    this.plan({ loadedRouteId: id });
  },

  /* ================= Recommended trip library ================= */

  trips: null,

  async loadTrips() {
    if (this.trips) return this.trips;
    const data = await Geo.fetchJson('data/routes_seed.json');
    this.trips = data;
    return data;
  },

  async renderTrips() {
    const el = document.getElementById('tripsList');
    if (!el) return;
    if (!this.trips) {
      el.innerHTML = `<div class="skeleton-row"></div><div class="skeleton-row"></div>`;
      try { await this.loadTrips(); }
      catch (e) {
        el.innerHTML = `<div class="err-box">Couldn't load the trip library. <button type="button" class="btn-secondary" id="tripsRetry">Retry</button></div>`;
        const b = document.getElementById('tripsRetry');
        if (b) b.addEventListener('click', () => this.renderTrips());
        return;
      }
    }
    el.innerHTML = `<p class="plan-section-note">Real Southwest rides with actual coordinates. Tap <strong>Route It</strong> and the planner builds it from where you are.</p>` +
      this.trips.map(t => {
        const reviews = Storage.getTripReviews(t.id);
        const avg = reviews.length
          ? (reviews.reduce((a, r) => a + r.stars, 0) / reviews.length).toFixed(1) : null;
        return `
        <div class="trip-card">
          <div class="trip-card-head">
            <div class="trip-card-name">${App.escapeHtml(t.name)}</div>
            <div class="trip-card-badges">
              <span class="trip-badge trip-badge-${t.difficulty.toLowerCase()}">${t.difficulty}</span>
              <span class="trip-badge">${t.distanceMi} mi</span>
            </div>
          </div>
          <div class="trip-card-region">${App.escapeHtml(t.region)}</div>
          <p class="trip-card-desc">${App.escapeHtml(t.description)}</p>
          <div class="trip-card-season"><strong>Best season:</strong> ${App.escapeHtml(t.bestSeason)}</div>
          <div class="trip-card-rating">${avg ? `★ ${avg} from ${reviews.length} rider${reviews.length === 1 ? '' : 's'}` : 'No rider ratings yet'}</div>
          ${reviews.slice(0, 2).map(r => `<div class="trip-review">★${r.stars} <span>${App.escapeHtml(r.text || '')}</span> <em>— ${App.escapeHtml(r.author)}</em></div>`).join('')}
          <div class="trip-card-actions">
            <button type="button" class="btn-primary trip-route" data-id="${t.id}">Route It</button>
            <button type="button" class="btn-secondary trip-rate" data-id="${t.id}">Rate / Comment</button>
          </div>
        </div>`;
      }).join('') +
      `<p class="plan-section-note plan-attribution">Route geometry from the <a href="https://project-osrm.org/" target="_blank" rel="noopener">OSRM public routing server</a>; place data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>.</p>`;

    el.querySelectorAll('.trip-route').forEach(b => b.addEventListener('click', () => this.planTrip(b.dataset.id)));
    el.querySelectorAll('.trip-rate').forEach(b => b.addEventListener('click', () => this.rateTrip(b.dataset.id)));
  },

  planTrip(id) {
    const t = this.trips.find(x => x.id === id);
    if (!t) return;
    this.from = { name: t.from.name, lat: t.from.lat, lon: t.from.lon };
    this.to = { name: t.to.name, lat: t.to.lat, lon: t.to.lon };
    this.via = [];
    document.getElementById('planFrom').value = t.from.name;
    document.getElementById('planTo').value = t.to.name;
    document.getElementById('viaList').innerHTML = '';
    this.showView('plan');
    this.plan();
  },

  rateTrip(id) {
    const stars = parseInt(prompt('Rate this ride 1-5:', '5'), 10);
    if (!stars || stars < 1 || stars > 5) return;
    const text = prompt('Comment (optional):') || '';
    const profile = Storage.getProfile();
    Storage.saveTripReview(id, { stars, text, author: profile.name || 'Rider', date: new Date().toISOString().split('T')[0] });
    this.renderTrips();
  },

  /* ================= POI card hooks ================= */

  addWaypointFromPoi(poi) {
    this.openPanel('plan');
    this.addViaRow({ name: poi.name, lat: poi.lat, lon: poi.lon });
    if (this.from && this.to) this.plan();
  },

  setDestinationFromPoi(poi) {
    this.openPanel('plan');
    this.to = { name: poi.name, lat: poi.lat, lon: poi.lon };
    document.getElementById('planTo').value = poi.name;
    document.getElementById('planToResults').innerHTML = '';
    if (!this.from && MapModule.currentLocation) {
      this.from = { name: 'My location', lat: MapModule.currentLocation.lat, lon: MapModule.currentLocation.lon };
      document.getElementById('planFrom').value = 'My location';
    }
    if (this.from) this.plan();
  },

  activeRoute() {
    return this.routes[this.selectedIdx] || null;
  },
};
