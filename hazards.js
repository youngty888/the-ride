/* ============================================
   The Ride — Crash Hazard Layer (Phase 2, section C)

   Data source: NHTSA Fatality Analysis Reporting System (FARS), 2021-2023,
   filtered to crashes involving a motorcycle. Pre-processed and committed to
   data/ — nothing is generated at runtime and nothing is fetched from NHTSA.

     data/moto_hotspots.json  — 304 nationwide clusters (loaded once, ~30 KB)
     data/pts_{State}.json    — individual crash points, LAZY-loaded only when
                                the rider is actually looking at that state

   This is history, not prediction. Copy in the UI says so plainly.
   ============================================ */

const HazardModule = {
  ATTRIBUTION: 'NHTSA Fatality Analysis Reporting System (FARS), 2021-2023',
  ATTRIBUTION_URL: 'https://www.nhtsa.gov/file-downloads?p=nhtsa/downloads/FARS/',
  STATES: ['Arizona', 'California', 'Colorado', 'Nevada', 'New_Mexico', 'Texas', 'Utah'],
  CORRIDOR_MI: 2.5,

  hotspots: null,
  statePoints: {},     // 'Arizona' -> array
  layerGroup: null,
  pointsLayer: null,
  visible: false,
  routeHits: [],
  routeScanFailed: false,

  /* ---------- data loading ---------- */
  async loadHotspots() {
    if (this.hotspots) return this.hotspots;
    const data = await Geo.fetchJson('data/moto_hotspots.json');
    this.hotspots = Array.isArray(data) ? data : [];
    return this.hotspots;
  },

  async loadState(state) {
    const key = state.replace(/ /g, '_');
    if (this.statePoints[key]) return this.statePoints[key];
    if (!this.STATES.includes(key)) return [];
    const data = await Geo.fetchJson(`data/pts_${key}.json`);
    this.statePoints[key] = Array.isArray(data) ? data : [];
    return this.statePoints[key];
  },

  /* ---------- map layer ---------- */
  async toggleLayer() {
    if (this.visible) { this.hideLayer(); return; }
    await this.showLayer();
  },

  async showLayer() {
    const btn = document.getElementById('btnHazardToggle');
    if (btn) { btn.classList.add('loading'); btn.setAttribute('aria-busy', 'true'); }
    try {
      await this.loadHotspots();
    } catch (e) {
      App.toast("Couldn't load the crash data files. Try again.");
      if (btn) { btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); }
      return;
    }
    if (!MapModule.map) return;

    if (!this.layerGroup) this.layerGroup = L.layerGroup();
    this.layerGroup.clearLayers();

    this.hotspots.forEach(h => {
      const radius = 8 + Math.min(14, h.n * 1.4);
      const marker = L.circleMarker([h.lat, h.lon], {
        radius,
        color: '#e53e3e',
        weight: 2,
        fillColor: '#e53e3e',
        fillOpacity: 0.28,
      });
      marker.on('click', () => this.showHotspotCard(h));
      this.layerGroup.addLayer(marker);
    });

    this.layerGroup.addTo(MapModule.map);
    this.visible = true;
    if (btn) {
      btn.classList.remove('loading');
      btn.removeAttribute('aria-busy');
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
    }
    this.maybeLoadStateDetail();
    MapModule.map.on('moveend', this.onMoveEnd);
  },

  hideLayer() {
    if (this.layerGroup && MapModule.map) MapModule.map.removeLayer(this.layerGroup);
    if (this.pointsLayer && MapModule.map) MapModule.map.removeLayer(this.pointsLayer);
    this.visible = false;
    const btn = document.getElementById('btnHazardToggle');
    if (btn) { btn.classList.remove('active'); btn.setAttribute('aria-pressed', 'false'); }
    if (MapModule.map) MapModule.map.off('moveend', this.onMoveEnd);
  },

  onMoveEnd() { HazardModule.maybeLoadStateDetail(); },

  /* Individual crash points are only worth drawing when zoomed in, and only
     for states actually on screen. Zoomed out they'd be 5000 dots and a
     wasted download. */
  async maybeLoadStateDetail() {
    if (!this.visible || !MapModule.map) return;
    const zoom = MapModule.map.getZoom();
    if (!this.pointsLayer) this.pointsLayer = L.layerGroup();
    if (zoom < 9) {
      if (MapModule.map.hasLayer(this.pointsLayer)) MapModule.map.removeLayer(this.pointsLayer);
      return;
    }
    const b = MapModule.map.getBounds();
    // Which of our detail states overlap the view? Use hotspot coords as a
    // cheap proxy for "this state is on screen".
    const states = new Set();
    (this.hotspots || []).forEach(h => {
      if (b.contains([h.lat, h.lon])) states.add(h.st.replace(/ /g, '_'));
    });
    // Always include whatever state the center is nearest to among our set.
    if (!states.size) {
      const c = MapModule.map.getCenter();
      let nearest = null, nd = Infinity;
      (this.hotspots || []).forEach(h => {
        if (!this.STATES.includes(h.st.replace(/ /g, '_'))) return;
        const d = Geo.distMi(c.lat, c.lng, h.lat, h.lon);
        if (d < nd) { nd = d; nearest = h.st.replace(/ /g, '_'); }
      });
      if (nearest && nd < 250) states.add(nearest);
    }

    let added = false;
    for (const st of states) {
      if (!this.STATES.includes(st)) continue;
      let pts;
      try { pts = await this.loadState(st); } catch (e) { continue; }
      pts.forEach(p => {
        if (!b.contains([p.lat, p.lon])) return;
        if (p._drawn) return;
        p._drawn = true;
        const dark = /dark/i.test(p.lgt || '');
        const m = L.circleMarker([p.lat, p.lon], {
          radius: 4, weight: 1,
          color: dark ? '#f5a623' : '#e53e3e',
          fillColor: dark ? '#f5a623' : '#e53e3e',
          fillOpacity: 0.85,
        });
        m.on('click', () => this.showCrashCard(p));
        this.pointsLayer.addLayer(m);
        added = true;
      });
    }
    if (added || this.pointsLayer.getLayers().length) this.pointsLayer.addTo(MapModule.map);
  },

  /* ---------- cards ---------- */

  /* FARS uses bureaucratic label text. Riders need plain English. */
  COLL_PLAIN: {
    'The First Harmful Event was Not a Collision with a Motor Vehicle in Transport': 'Single vehicle — no other car involved',
    'Angle': 'Angle collision — someone crossed or turned across the rider',
    'Front-to-Rear': 'Rear-end',
    'Front-to-Front': 'Head-on',
    'Sideswipe - Same Direction': 'Sideswipe, same direction',
    'Sideswipe - Opposite Direction': 'Sideswipe, oncoming',
    'Not Reported': 'Not reported',
    'Reported as Unknown': 'Unknown',
  },
  HARM_PLAIN: {
    'Motor Vehicle In-Transport': 'Another moving vehicle',
    'Rollover/Overturn': 'Went down / rolled over',
    'Guardrail Face': 'Guardrail',
    'Concrete Traffic Barrier': 'Concrete barrier',
    'Bridge Rail (Includes parapet)': 'Bridge rail',
    'Tree (Standing Only)': 'Tree',
    'Fell/Jumped from Vehicle': 'Rider came off the bike',
    'Other Object (not fixed)': 'Loose object in the road',
    'Other Fixed Object': 'A fixed roadside object',
  },
  plainColl(v) { return v ? (this.COLL_PLAIN[v] || v) : '—'; },
  plainHarm(v) { return v ? (this.HARM_PLAIN[v] || v) : '—'; },

  hourLabel(h) {
    if (h == null) return 'unknown time';
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr} ${ampm}`;
  },

  showHotspotCard(h) {
    const body = document.getElementById('poiSheetBody');
    body.innerHTML = `
      <div class="poi-card-head">
        <div class="poi-card-icon hz-icon">⚠</div>
        <div class="poi-card-titles">
          <div class="poi-card-name">${App.escapeHtml(h.way || 'Crash cluster')}</div>
          <div class="poi-card-sub">${App.escapeHtml(h.cty || '')} County, ${App.escapeHtml(h.st)}</div>
        </div>
      </div>
      <div class="hz-count">${h.n} fatal motorcycle crashes here, 2021-2023</div>
      <div class="poi-facts">
        <div class="poi-fact"><span class="poi-fact-k">What happened</span><span class="poi-fact-v">${App.escapeHtml(this.plainColl(h.coll))}</span></div>
        <div class="poi-fact"><span class="poi-fact-k">First thing hit</span><span class="poi-fact-v">${App.escapeHtml(this.plainHarm(h.top))}</span></div>
        <div class="poi-fact"><span class="poi-fact-k">Worst hour</span><span class="poi-fact-v">${this.hourLabel(h.hr)}</span></div>
        <div class="poi-fact"><span class="poi-fact-k">In the dark</span><span class="poi-fact-v">${Math.round((h.dark || 0) * 100)}% of them</span></div>
      </div>
      <p class="hz-note">${this.riderAdvice(h)}</p>
      <p class="hz-attr">Source: ${this.ATTRIBUTION}. This is what already happened here — not a prediction about today.</p>
    `;
    document.getElementById('poiSheet').classList.add('active');
  },

  riderAdvice(h) {
    const bits = [];
    const coll = (h.coll || '').toLowerCase();
    if (coll.includes('angle')) bits.push('Mostly angle collisions — that is cars pulling out and turning across the lane. Cover your brakes through intersections and driveways here.');
    else if (coll.includes('front-to-front')) bits.push('Head-on crashes. Somebody crossed the line. Hold the outside third of your lane and watch for passing traffic.');
    else if (coll.includes('rear')) bits.push('Rear-end crashes. Leave more space and use your brake light early when traffic bunches.');
    else if (coll.includes('not a collision')) bits.push('Mostly single-vehicle — rider ran off or went down alone. Read this as a corner or surface that punishes entry speed.');
    if ((h.dark || 0) >= 0.5) bits.push(`More than half were after dark. If you can time this stretch for daylight, do.`);
    if (h.hr != null) bits.push(`The clustered hour is around ${this.hourLabel(h.hr)}.`);
    return bits.join(' ') || 'Ride it like traffic cannot see you.';
  },

  showCrashCard(p) {
    const body = document.getElementById('poiSheetBody');
    body.innerHTML = `
      <div class="poi-card-head">
        <div class="poi-card-icon hz-icon">⚠</div>
        <div class="poi-card-titles">
          <div class="poi-card-name">${App.escapeHtml(p.way || 'Unnamed road')}</div>
          <div class="poi-card-sub">${App.escapeHtml(p.cty || '')} County, ${App.escapeHtml(p.st)} · ${p.y}</div>
        </div>
      </div>
      <div class="poi-facts">
        <div class="poi-fact"><span class="poi-fact-k">When</span><span class="poi-fact-v">${this.monthName(p.mo)} ${p.y}, ${this.dowName(p.dw)} around ${this.hourLabel(p.hr)}</span></div>
        <div class="poi-fact"><span class="poi-fact-k">Light</span><span class="poi-fact-v">${App.escapeHtml(p.lgt || '—')}</span></div>
        <div class="poi-fact"><span class="poi-fact-k">Weather</span><span class="poi-fact-v">${App.escapeHtml(p.wx || '—')}</span></div>
        <div class="poi-fact"><span class="poi-fact-k">Hit</span><span class="poi-fact-v">${App.escapeHtml(this.plainHarm(p.harm))}</span></div>
        <div class="poi-fact"><span class="poi-fact-k">Where</span><span class="poi-fact-v">${App.escapeHtml(p.itype || '—')} · ${App.escapeHtml(p.rd || '—')} · ${App.escapeHtml(p.rur || '')}</span></div>
        <div class="poi-fact"><span class="poi-fact-k">Fatalities</span><span class="poi-fact-v">${p.fat}</span></div>
      </div>
      <p class="hz-attr">Source: ${this.ATTRIBUTION}.</p>
    `;
    document.getElementById('poiSheet').classList.add('active');
  },

  monthName(m) {
    return ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'][m] || '';
  },
  dowName(d) {
    // FARS day-of-week: 1 = Sunday
    return ['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d] || 'a weekday';
  },

  /* ---------- route scan ---------- */
  async scanRoute(route) {
    this.routeHits = [];
    this.routeScanFailed = false;
    if (!route) return [];
    try {
      await this.loadHotspots();
    } catch (e) {
      this.routeScanFailed = true;
      throw e;
    }
    // Pad in degrees (~69 mi per degree) so the cheap box test can't reject a
    // cluster that is actually inside the corridor.
    const box = Geo.bbox(route.coords, (this.CORRIDOR_MI + 1) / 69);
    const hits = [];
    this.hotspots.forEach(h => {
      if (h.lat < box.south || h.lat > box.north || h.lon < box.west || h.lon > box.east) return;
      const near = Geo.nearestOnPath(route.coords, route.cum, h.lat, h.lon, 4);
      if (near.distMi <= this.CORRIDOR_MI) {
        hits.push({ ...h, routeMile: near.mile, offRouteMi: near.distMi });
      }
    });
    hits.sort((a, b) => a.routeMile - b.routeMile);
    this.routeHits = hits;
    return hits;
  },

  routeSectionHtml(failed) {
    const attr = `<p class="plan-section-note plan-attribution">Crash data: <a href="${this.ATTRIBUTION_URL}" target="_blank" rel="noopener">${this.ATTRIBUTION}</a>, motorcycle-involved crashes only.</p>`;
    if (failed || this.routeScanFailed) {
      return `<h3 class="plan-section-title">Crash History On This Route</h3>
        <div class="err-box">Couldn't read the crash data file. <button type="button" class="btn-secondary" id="hzRetry">Retry</button></div>`;
    }
    const hits = this.routeHits;
    if (!hits.length) {
      return `<h3 class="plan-section-title">Crash History On This Route</h3>
        <p class="plan-section-note">No fatal-motorcycle-crash clusters within ${this.CORRIDOR_MI} miles of this route in the 2021-2023 record. That is good news, not a guarantee.</p>${attr}`;
    }
    const totalN = hits.reduce((a, h) => a + h.n, 0);
    return `
      <h3 class="plan-section-title">Crash History On This Route</h3>
      <p class="plan-section-note"><strong>${hits.length} cluster${hits.length === 1 ? '' : 's'}</strong> within ${this.CORRIDOR_MI} mi of your line, ${totalN} fatal motorcycle crashes total, 2021-2023. Tap one to see what actually happened there.</p>
      <div class="hz-list">
        ${hits.slice(0, 12).map((h, i) => `
          <button type="button" class="hz-row" data-i="${i}">
            <span class="hz-row-badge">${h.n}</span>
            <span class="hz-row-body">
              <span class="hz-row-name">${App.escapeHtml(h.way || 'Unnamed road')}</span>
              <span class="hz-row-meta">Mile ${Math.round(h.routeMile)} · ${App.escapeHtml(h.cty || '')} Co, ${App.escapeHtml(h.st)} · ${App.escapeHtml(this.plainColl(h.coll))}</span>
            </span>
            <span class="poi-row-chevron">›</span>
          </button>`).join('')}
      </div>
      ${hits.length > 12 ? `<p class="plan-section-note">+ ${hits.length - 12} more further along.</p>` : ''}
      ${attr}`;
  },

  bindRouteSection() {
    const sec = document.getElementById('hazardSection');
    if (!sec) return;
    sec.querySelectorAll('.hz-row').forEach(btn => {
      btn.addEventListener('click', () => this.showHotspotCard(this.routeHits[+btn.dataset.i]));
    });
    const retry = document.getElementById('hzRetry');
    if (retry) retry.addEventListener('click', () => {
      HazardModule.scanRoute(RouteModule.activeRoute())
        .then(() => RouteModule.renderHazards())
        .catch(() => RouteModule.renderHazards(true));
    });
  },

  /* Heuristic used by the weather module. OSM/OSRM step names are the only
     wash signal available without another data source, so this is name-based
     and deliberately conservative in what it claims. */
  routeCrossesWash(route) {
    if (!route || !route.steps) return false;
    return route.steps.some(s => /\b(wash|arroyo|dip|draw|creek|river)\b/i.test(s.name || ''));
  },
};
