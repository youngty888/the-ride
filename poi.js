/* ============================================
   The Ride — POI Module (Phase 1, sections A3 + A4)

   - Split POI categories, each with its own Overpass filter + icon + chip
   - Overpass with mirror fallback, 10 s timeout, real error states
   - Opening-hours parsing with "Closing soon" / "Opens in Xm"
   - Preference presets: favorite brands ranked first, blocked brands hidden
   - Along-route corridor search with detour mileage
   - In-app bottom-sheet POI card. NOTHING here opens Google Maps except the
     one explicitly labeled "Navigate" button the rider has to tap on purpose.
   ============================================ */

const PoiModule = {
  ENDPOINTS: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter', // fallback mirror
  ],

  // --- Categories (spec A3) ---
  CATS: [
    { id: 'fuel',       label: 'Gas',        icon: '⛽', filters: ['nwr["amenity"="fuel"]'] },
    { id: 'fast_food',  label: 'Fast Food',  icon: '🍟', filters: ['nwr["amenity"="fast_food"]'] },
    { id: 'restaurant', label: 'Sit-Down',   icon: '🍽', filters: ['nwr["amenity"="restaurant"]'] },
    { id: 'cafe',       label: 'Coffee',     icon: '☕', filters: ['nwr["amenity"="cafe"]'] },
    { id: 'hotel',      label: 'Hotel',      icon: '🛏', filters: ['nwr["tourism"~"^(hotel|motel)$"]'] },
    { id: 'campsite',   label: 'Campsite',   icon: '⛺', filters: ['nwr["tourism"~"^(camp_site|caravan_site)$"]'] },
    { id: 'mechanic',   label: 'Mechanic',   icon: '🔧', filters: ['nwr["shop"~"^(motorcycle|motorcycle_repair|car_repair)$"]', 'nwr["amenity"="motorcycle_parking"]'] },
    { id: 'toilets',    label: 'Restroom',   icon: '🚻', filters: ['nwr["amenity"="toilets"]'] },
    { id: 'store',      label: 'Store',      icon: '🛒', filters: ['nwr["shop"~"^(convenience|supermarket)$"]'] },
    { id: 'viewpoint',  label: 'Scenic',     icon: '🏞', filters: ['nwr["tourism"="viewpoint"]'] },
    { id: 'hospital',   label: 'Hospital',   icon: '🏥', filters: ['nwr["amenity"~"^(hospital|clinic)$"]'] },
  ],

  cat(id) { return this.CATS.find(c => c.id === id) || this.CATS[0]; },

  // Current UI state
  activeCat: 'fuel',
  alongRoute: false,
  lastResults: [],
  markers: [],
  sheetPoi: null,

  /* ---------- Overpass ---------- */

  // One request, tried against each mirror in turn.
  async overpass(body) {
    let lastErr;
    for (const url of this.ENDPOINTS) {
      try {
        const res = await Geo.fetchTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(body),
        }, 25000);
        const json = await res.json();
        return json.elements || [];
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Overpass unavailable');
  },

  // around: [{lat,lon,radiusM}] — all bundled into ONE query to stay polite.
  buildAroundQuery(catIds, points, limit = 60) {
    const parts = [];
    catIds.forEach(id => {
      this.cat(id).filters.forEach(f => {
        points.forEach(p => {
          parts.push(`${f}(around:${Math.round(p.radiusM)},${p.lat.toFixed(5)},${p.lon.toFixed(5)});`);
        });
      });
    });
    return `[out:json][timeout:25];(${parts.join('')});out center ${limit};`;
  },

  elToPoi(el, catId) {
    const tags = el.tags || {};
    const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (lat == null || lon == null) return null;
    return {
      id: el.type + '/' + el.id,
      cat: catId,
      name: tags.name || tags.brand || tags.operator || this.cat(catId).label,
      brand: tags.brand || tags.operator || '',
      lat, lon,
      tags,
      hours: tags.opening_hours || tags['opening_hours:signed'] || '',
      phone: tags.phone || tags['contact:phone'] || '',
      address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'], tags['addr:state']]
        .filter(Boolean).join(' '),
    };
  },

  // Guess the category of an element from its tags (needed for multi-cat queries)
  guessCat(el) {
    const t = el.tags || {};
    for (const c of this.CATS) {
      for (const f of c.filters) {
        const m = f.match(/\["([a-z_:]+)"(?:~"\^?\(?([^")]+)\)?\$?"|="([^"]+)")\]/);
        if (!m) continue;
        const key = m[1], val = t[key];
        if (!val) continue;
        if (m[3] && val === m[3]) return c.id;
        if (m[2] && m[2].replace(/[()^$]/g, '').split('|').includes(val)) return c.id;
      }
    }
    return 'store';
  },

  /* ---------- Opening hours ----------
     OSM opening_hours is a whole grammar. This handles the shapes that
     actually show up on gas stations and restaurants, and returns
     "unknown" honestly rather than guessing when it can't parse. */
  parseHours(str, now = new Date()) {
    if (!str) return { state: 'unknown' };
    const s = str.toLowerCase().trim();
    if (s === '24/7' || s.includes('24/7') || s.includes('mo-su 00:00-24:00')) {
      return { state: 'open', always: true };
    }
    const dayKeys = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
    const today = dayKeys[now.getDay()];
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const appliesToday = (spec) => {
      if (!spec) return true;
      if (spec.includes('ph')) return false;
      const ranges = spec.split(',');
      for (const r of ranges) {
        const t = r.trim();
        const dash = t.match(/^(su|mo|tu|we|th|fr|sa)-(su|mo|tu|we|th|fr|sa)$/);
        if (dash) {
          let a = dayKeys.indexOf(dash[1]), b = dayKeys.indexOf(dash[2]);
          const idx = now.getDay();
          if (a <= b) { if (idx >= a && idx <= b) return true; }
          else { if (idx >= a || idx <= b) return true; }
        } else if (t === today) return true;
      }
      return false;
    };

    let sawTodayRule = false;
    let closesAt = null, opensAt = null;
    for (const chunk of s.split(';')) {
      const c = chunk.trim();
      if (!c) continue;
      const dayPart = (c.match(/^((?:su|mo|tu|we|th|fr|sa)(?:-(?:su|mo|tu|we|th|fr|sa))?(?:,(?:su|mo|tu|we|th|fr|sa)(?:-(?:su|mo|tu|we|th|fr|sa))?)*)/) || [])[1];
      if (dayPart && !appliesToday(dayPart)) continue;
      if (/off|closed/.test(c) && dayPart) { sawTodayRule = true; continue; }
      const times = [...c.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
      if (!times.length) continue;
      sawTodayRule = true;
      for (const m of times) {
        const open = (+m[1]) * 60 + (+m[2]);
        let close = (+m[3]) * 60 + (+m[4]);
        const overnight = close <= open;
        if (overnight) close += 1440;
        const cur = (overnight && nowMin < open) ? nowMin + 1440 : nowMin;
        if (cur >= open && cur <= close) {
          return { state: 'open', minsToClose: close - cur };
        }
        if (nowMin < open && (opensAt == null || open < opensAt)) opensAt = open;
      }
    }
    if (!sawTodayRule) return { state: 'unknown' };
    return { state: 'closed', minsToOpen: opensAt != null ? opensAt - nowMin : null };
  },

  hoursBadge(poi) {
    const h = this.parseHours(poi.hours);
    if (h.state === 'open') {
      if (h.always) return { cls: 'poi-open', text: 'Open 24/7' };
      if (h.minsToClose != null && h.minsToClose <= 60) {
        return { cls: 'poi-soon', text: `Closing in ${h.minsToClose}m` };
      }
      return { cls: 'poi-open', text: 'Open now' };
    }
    if (h.state === 'closed') {
      if (h.minsToOpen != null && h.minsToOpen > 0 && h.minsToOpen <= 180) {
        return { cls: 'poi-soon', text: `Opens in ${h.minsToOpen}m` };
      }
      return { cls: 'poi-closed', text: 'Closed' };
    }
    // Gas stations very often have no hours mapped; say so instead of lying.
    return { cls: 'poi-unknown', text: poi.cat === 'fuel' ? 'Hours not listed' : 'Hours unknown' };
  },

  /* ---------- Preferences ---------- */
  prefKey(poi) { return (poi.brand || poi.name || '').toLowerCase().trim(); },

  isFavorite(poi) {
    const p = Storage.getPoiPrefs();
    const k = this.prefKey(poi);
    return p.favorites.some(f => k.includes(f));
  },

  isBlocked(poi) {
    const p = Storage.getPoiPrefs();
    const k = this.prefKey(poi);
    return p.blocked.some(f => f && k.includes(f));
  },

  toggleFavorite(poi) {
    const p = Storage.getPoiPrefs();
    const k = this.prefKey(poi);
    if (!k) return;
    if (p.favorites.includes(k)) p.favorites = p.favorites.filter(f => f !== k);
    else { p.favorites.push(k); p.blocked = p.blocked.filter(f => f !== k); }
    Storage.savePoiPrefs(p);
  },

  toggleBlocked(poi) {
    const p = Storage.getPoiPrefs();
    const k = this.prefKey(poi);
    if (!k) return;
    if (p.blocked.includes(k)) p.blocked = p.blocked.filter(f => f !== k);
    else { p.blocked.push(k); p.favorites = p.favorites.filter(f => f !== k); }
    Storage.savePoiPrefs(p);
  },

  // Favorites first, then distance. Blocked entries are dropped.
  rank(list) {
    return list
      .filter(p => !this.isBlocked(p))
      .sort((a, b) => {
        const fa = this.isFavorite(a) ? 0 : 1, fb = this.isFavorite(b) ? 0 : 1;
        if (fa !== fb) return fa - fb;
        const ka = a.routeMile != null ? a.routeMile : a.distanceMi;
        const kb = b.routeMile != null ? b.routeMile : b.distanceMi;
        return ka - kb;
      });
  },

  /* ---------- Searches ---------- */

  // Nearby search around a point.
  async searchNearby(catId, lat, lon, radiusMi = 10) {
    const els = await this.overpass(this.buildAroundQuery([catId], [{ lat, lon, radiusM: radiusMi * 1609.34 }], 60));
    const seen = new Set();
    const out = [];
    els.forEach(el => {
      const poi = this.elToPoi(el, catId);
      if (!poi || seen.has(poi.id)) return;
      seen.add(poi.id);
      poi.distanceMi = Geo.distMi(lat, lon, poi.lat, poi.lon);
      poi.bearing = Geo.bearing(lat, lon, poi.lat, poi.lon);
      out.push(poi);
    });
    return this.rank(out);
  },

  /* Along-route corridor search (spec A3): sample the route every ~15 mi and
     query all sample points in a single Overpass request, then report each
     result's detour off the route and how far along the route it sits. */
  async searchAlongRoute(catId, coords, cum, corridorMi = 3, sampleEveryMi = 15) {
    const samples = Geo.sampleEvery(coords, cum, sampleEveryMi, 24);
    const points = samples.map(s => ({ lat: s.lat, lon: s.lon, radiusM: corridorMi * 1609.34 }));
    const els = await this.overpass(this.buildAroundQuery([catId], points, 120));
    const maxDetour = Storage.getPoiPrefs().maxDetourMi || 5;
    const seen = new Set();
    const out = [];
    els.forEach(el => {
      const poi = this.elToPoi(el, catId);
      if (!poi || seen.has(poi.id)) return;
      seen.add(poi.id);
      const near = Geo.nearestOnPath(coords, cum, poi.lat, poi.lon, 3);
      poi.detourMi = near.distMi;
      poi.routeMile = near.mile;
      if (poi.detourMi > maxDetour) return;
      out.push(poi);
    });
    return this.rank(out);
  },

  /* Fuel candidates near one target point, widening 5 → 10 → 20 mi.
     Used by the fuel planner in route.js. */
  async fuelNear(lat, lon, coords, cum) {
    for (const r of [5, 10, 20]) {
      let els = [];
      try {
        els = await this.overpass(this.buildAroundQuery(['fuel'], [{ lat, lon, radiusM: r * 1609.34 }], 40));
      } catch (e) { throw e; }
      const list = [];
      els.forEach(el => {
        const poi = this.elToPoi(el, 'fuel');
        if (!poi) return;
        poi.distanceMi = Geo.distMi(lat, lon, poi.lat, poi.lon);
        if (coords) {
          const near = Geo.nearestOnPath(coords, cum, poi.lat, poi.lon, 3);
          poi.detourMi = near.distMi;
          poi.routeMile = near.mile;
        }
        list.push(poi);
      });
      const ranked = this.rank(list).sort((a, b) => (a.detourMi ?? a.distanceMi) - (b.detourMi ?? b.distanceMi));
      if (ranked.length) return { candidates: ranked, searchRadiusMi: r };
    }
    return { candidates: [], searchRadiusMi: 20 };
  },

  /* ---------- Map markers ---------- */
  showMarkers(list) {
    this.clearMarkers();
    if (!MapModule.map) return;
    list.slice(0, 60).forEach(poi => {
      const c = this.cat(poi.cat);
      const fav = this.isFavorite(poi);
      const icon = L.divIcon({
        className: 'poi-marker',
        html: `<div class="poi-pin${fav ? ' fav' : ''}">${c.icon}</div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });
      const m = L.marker([poi.lat, poi.lon], { icon }).addTo(MapModule.map);
      // Tapping a marker opens the in-app card. No external maps handoff.
      m.on('click', () => this.showCard(poi));
      this.markers.push(m);
    });
  },

  clearMarkers() {
    if (MapModule.map) this.markers.forEach(m => MapModule.map.removeLayer(m));
    this.markers = [];
  },

  /* ---------- List rendering ---------- */
  poiRowHtml(poi, idx) {
    const c = this.cat(poi.cat);
    const badge = this.hoursBadge(poi);
    const fav = this.isFavorite(poi);
    const dist = poi.detourMi != null
      ? `+${poi.detourMi.toFixed(1)} mi detour`
      : `${Geo.fmtMi(poi.distanceMi)} mi ${Geo.compass(poi.bearing || 0)}`;
    const mile = poi.routeMile != null ? `<span class="poi-mile">Mile ${Math.round(poi.routeMile)}</span>` : '';
    return `
      <button class="poi-row" data-poi-idx="${idx}">
        <span class="poi-row-icon">${c.icon}</span>
        <span class="poi-row-body">
          <span class="poi-row-name">${fav ? '<span class="poi-fav-dot">♥</span> ' : ''}${App.escapeHtml(poi.name)}</span>
          <span class="poi-row-meta">
            <span>${dist}</span>
            ${mile}
            <span class="${badge.cls}">${badge.text}</span>
          </span>
        </span>
        <span class="poi-row-chevron">›</span>
      </button>`;
  },

  renderList(listEl, list, emptyMsg) {
    this.lastResults = list;
    if (!list.length) {
      listEl.innerHTML = `<div class="empty-state-container"><p class="empty-state">${App.escapeHtml(emptyMsg || 'Nothing found here. Try another category or a wider search.')}</p></div>`;
      return;
    }
    listEl.innerHTML = list.slice(0, 60).map((p, i) => this.poiRowHtml(p, i)).join('');
    listEl.querySelectorAll('.poi-row').forEach(btn => {
      btn.addEventListener('click', () => {
        const poi = this.lastResults[+btn.dataset.poiIdx];
        if (poi) this.showCard(poi);
      });
    });
  },

  /* ---------- In-app POI card (spec A4) ----------
     This replaces the old behaviour where tapping a stop threw the rider out
     to Google Maps. The ONLY external handoff left is the Navigate button. */
  showCard(poi) {
    this.sheetPoi = poi;
    const sheet = document.getElementById('poiSheet');
    const body = document.getElementById('poiSheetBody');
    const c = this.cat(poi.cat);
    const badge = this.hoursBadge(poi);
    const t = poi.tags || {};

    const here = MapModule.currentLocation;
    const distLine = here
      ? `${Geo.fmtMi(Geo.distMi(here.lat, here.lon, poi.lat, poi.lon))} mi ${Geo.compass(Geo.bearing(here.lat, here.lon, poi.lat, poi.lon))} of you`
      : 'Distance unavailable — no GPS fix';

    const facts = [];
    if (t.brand) facts.push(['Brand', t.brand]);
    if (t['fuel:diesel']) facts.push(['Diesel', t['fuel:diesel'] === 'yes' ? 'Yes' : 'No']);
    if (t['fuel:octane_91'] || t['fuel:octane_92'] || t['fuel:octane_93']) facts.push(['Premium', 'Yes']);
    if (t.internet_access) facts.push(['Wi-Fi', t.internet_access]);
    if (t.outdoor_seating) facts.push(['Outdoor seating', t.outdoor_seating]);
    if (t.drive_through) facts.push(['Drive-through', t.drive_through]);
    if (t.wheelchair) facts.push(['Wheelchair', t.wheelchair]);
    if (t.cuisine) facts.push(['Cuisine', t.cuisine.replace(/;/g, ', ')]);
    if (t.stars) facts.push(['Stars', t.stars]);
    if (t.tents || t.caravans) facts.push(['Sites', [t.tents ? 'tents' : '', t.caravans ? 'RV' : ''].filter(Boolean).join(', ')]);
    if (t.shower) facts.push(['Showers', t.shower]);
    if (t.compressed_air) facts.push(['Air pump', t.compressed_air]);

    const fav = this.isFavorite(poi);
    const blocked = this.isBlocked(poi);

    body.innerHTML = `
      <div class="poi-card-head">
        <div class="poi-card-icon">${c.icon}</div>
        <div class="poi-card-titles">
          <div class="poi-card-name">${App.escapeHtml(poi.name)}</div>
          <div class="poi-card-sub">${App.escapeHtml(c.label)} · <span class="${badge.cls}">${badge.text}</span></div>
        </div>
      </div>

      <div class="poi-card-lines">
        <div class="poi-card-line">${App.escapeHtml(distLine)}</div>
        ${poi.detourMi != null ? `<div class="poi-card-line">+${poi.detourMi.toFixed(1)} mi detour off your route${poi.routeMile != null ? ` · mile ${Math.round(poi.routeMile)}` : ''}</div>` : ''}
        ${poi.address ? `<div class="poi-card-line">${App.escapeHtml(poi.address)}</div>` : ''}
        ${poi.hours ? `<div class="poi-card-line poi-card-hours">${App.escapeHtml(poi.hours)}</div>` : ''}
      </div>

      ${facts.length ? `<div class="poi-facts">${facts.map(([k, v]) =>
        `<div class="poi-fact"><span class="poi-fact-k">${App.escapeHtml(k)}</span><span class="poi-fact-v">${App.escapeHtml(String(v))}</span></div>`).join('')}</div>` : ''}

      ${poi.phone ? `<a class="btn-secondary btn-large poi-btn" href="tel:${App.escapeHtml(poi.phone)}">Call ${App.escapeHtml(poi.phone)}</a>` : ''}

      <div class="poi-actions">
        <button class="btn-primary poi-btn" id="poiAddRoute">Add to Route</button>
        <button class="btn-secondary poi-btn" id="poiSetDest">Set as Destination</button>
        <button class="btn-secondary poi-btn${fav ? ' poi-btn-on' : ''}" id="poiFav">${fav ? '♥ Favorited' : '♡ Favorite'}</button>
        <button class="btn-secondary poi-btn${blocked ? ' poi-btn-off' : ''}" id="poiBlock">${blocked ? '⃠ Blocked' : 'Block'}</button>
      </div>

      <button class="btn-secondary poi-btn poi-nav-btn" id="poiNavigate">
        Navigate — opens outside The Ride
      </button>
      <p class="poi-nav-note">Everything above stays in the app. Only this button hands you off to your phone's maps app.</p>
    `;

    sheet.classList.add('active');

    document.getElementById('poiAddRoute').addEventListener('click', () => {
      RouteModule.addWaypointFromPoi(poi);
      this.hideCard();
    });
    document.getElementById('poiSetDest').addEventListener('click', () => {
      RouteModule.setDestinationFromPoi(poi);
      this.hideCard();
    });
    document.getElementById('poiFav').addEventListener('click', () => {
      this.toggleFavorite(poi); this.showCard(poi); this.refreshOpenList();
    });
    document.getElementById('poiBlock').addEventListener('click', () => {
      this.toggleBlocked(poi); this.showCard(poi); this.refreshOpenList();
    });
    document.getElementById('poiNavigate').addEventListener('click', () => {
      MapModule.navigateTo(poi.lat, poi.lon);
    });
  },

  hideCard() {
    document.getElementById('poiSheet').classList.remove('active');
    this.sheetPoi = null;
  },

  refreshOpenList() {
    const listEl = document.getElementById('stopsList');
    if (listEl && document.getElementById('overlay-addstop').classList.contains('active')) {
      this.renderList(listEl, this.rank(this.lastResults));
    }
  },
};
