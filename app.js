/* ============================================
   The Ride — Main App Logic
   Screen navigation, event handlers, rendering
   ============================================ */

const App = {
  currentScreen: 'map',
  currentStopType: 'fuel',
  stopScope: 'near',
  currentBlogCategory: 'all',
  emergencyContacts: [],
  currentRating: { safe: 0, formation: 0, comms: 0, onTime: 0, withinAbility: 0 },

  // --- Init ---
  init() {
    // Seed demo data on first load
    Storage.seedDemoData();

    // Init map
    MapModule.init();

    // Phase 1 + 2 modules (planner, POIs, weather, crash data, alerts)
    RouteModule.init();
    RouteModule.setupUI();
    HazardModule.hotspots = null;
    AlertsModule.init();
    this.setupRideButtons();

    // Set up navigation
    this.setupNavigation();

    // Set up map buttons
    this.setupMapButtons();

    // Set up overlays
    this.setupOverlays();

    // Set up garage
    this.setupGarage();

    // Set up packs
    this.setupPacks();

    // Set up blog
    this.setupBlog();

    // Set up community toggle
    this.setupCommunityToggle();

    // Set up pack rating
    this.setupPackRating();

    // Set up profile
    this.setupProfile();

    // Render initial screens
    this.renderGarage();
    this.renderPacks();
    this.renderBlog();
    this.renderEvents();
    this.renderProfile();
    this.updateTotalMiles();

    // Check for profile setup
    const profile = Storage.getProfile();
    if (profile.name === 'Rider' && !profile.region) {
      // Show profile on first load
      setTimeout(() => this.switchScreen('profile'), 500);
    }
  },

  // --- Navigation ---
  setupNavigation() {
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        const screen = item.dataset.screen;
        this.switchScreen(screen);
      });
    });
  },

  switchScreen(screenName) {
    this.currentScreen = screenName;
    // Update nav
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.screen === screenName);
    });

    // Show screen
    document.querySelectorAll('.screen').forEach((screen) => {
      screen.classList.toggle('active', screen.id === 'screen-' + screenName);
    });

    // Invalidate map if switching back to map
    if (screenName === 'map' && MapModule.map) {
      setTimeout(() => MapModule.map.invalidateSize(), 100);
    }
  },

  // --- Map Buttons ---
  setupMapButtons() {
    // GPS center
    document.getElementById('btnGpsCenter').addEventListener('click', () => {
      MapModule.centerOnUser();
    });

    // Start/Stop ride
    document.getElementById('btnRide').addEventListener('click', () => {
      const btn = document.getElementById('btnRide');
      const label = document.getElementById('btnRideLabel');
      const idleStats = document.getElementById('idleStats');
      const rideStats = document.getElementById('rideStats');

      if (MapModule.isTracking) {
        // Stop ride
        const result = MapModule.stopRideTracking();
        MapModule.setNavigating(false);
        btn.classList.remove('recording');
        label.textContent = 'Start Ride';
        idleStats.style.display = '';
        rideStats.style.display = 'none';

        if (result.miles > 0) {
          // Update profile total miles
          const profile = Storage.getProfile();
          profile.totalMiles = (profile.totalMiles || 0) + result.miles;
          Storage.saveProfile(profile);
          this.updateTotalMiles();
          this.renderProfile();

          // Show confirmation
          alert(`Ride saved: ${result.miles} miles, ${result.duration} min`);
        }
      } else {
        // Start ride. BATTERY: this is the one place high-accuracy GPS turns
        // on, and the one place we hit the network — everything for the route
        // is cached up front so the ride itself needs zero requests.
        MapModule.startRideTracking();
        MapModule.setNavigating(true);
        AlertsModule.prefetchCorridor(RouteModule.activeRoute());
        btn.classList.add('recording');
        label.textContent = 'Stop Ride';
        idleStats.style.display = 'none';
        rideStats.style.display = '';
      }
    });

    // Add Stop
    document.getElementById('btnAddStop').addEventListener('click', () => {
      this.showOverlay('overlay-addstop');
      this.loadStops();
    });

    // Report a hazard — the whole flow is two taps and no typing
    document.getElementById('btnReport').addEventListener('click', () => {
      AlertsModule.openReportSheet();
    });

    // Emergency
    document.getElementById('btnEmergency').addEventListener('click', () => {
      this.showOverlay('overlay-emergency');
      this.renderEmergencyContacts();
    });
  },

  // --- Overlays ---
  setupOverlays() {
    // Close buttons
    document.querySelectorAll('.overlay-close').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const overlay = e.target.closest('.overlay');
        if (overlay) overlay.classList.remove('active');
      });
    });

    // Add Stop filters
    document.querySelectorAll('#stopFilters .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#stopFilters .chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        this.currentStopType = chip.dataset.type;
        this.loadStops();
      });
    });

    // Near me / along my route
    document.querySelectorAll('#stopScope .toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#stopScope .toggle-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.stopScope = btn.dataset.scope;
        this.loadStops();
      });
    });

    // Open now toggle
    document.getElementById('openNowToggle').addEventListener('change', () => {
      PoiModule.refreshOpenList();
    });

    // Emergency actions
    document.getElementById('btnCall911').addEventListener('click', () => {
      window.location.href = 'tel:911';
    });

    document.getElementById('btnShareLocation').addEventListener('click', () => {
      this.shareLocation();
    });

    document.getElementById('btnNotifyPack').addEventListener('click', () => {
      this.notifyPack();
    });

    document.getElementById('btnAddEmergencyContact').addEventListener('click', () => {
      this.addEmergencyContact();
    });

    // Pack gas interval custom toggle
    document.getElementById('packGasInterval').addEventListener('change', (e) => {
      const custom = document.getElementById('customGasGroup');
      custom.style.display = e.target.value === 'custom' ? '' : 'none';
    });
  },

  showOverlay(id) {
    document.getElementById(id).classList.add('active');
  },

  hideOverlay(id) {
    document.getElementById(id).classList.remove('active');
  },

  /* --- Add Stop -> POI search (in-app cards, no Google redirect) ---
     The old version rendered its own list and auto-opened Google Maps when
     you tapped a row. PoiModule now owns the list and shows an in-app card. */
  async loadStops() {
    const listEl = document.getElementById('stopsList');
    const has = PoiModule.CATS.some(c => c.id === this.currentStopType);
    const cat = has ? this.currentStopType : 'fuel';
    const catLabel = PoiModule.cat(cat).label.toLowerCase();

    if (this.stopScope === 'route') {
      const route = RouteModule.activeRoute();
      if (!route) {
        listEl.innerHTML = `<div class="empty-state-container"><p class="empty-state">No route planned yet. Tap <strong>Where to?</strong> on the map to build one, then come back and I'll find ${catLabel} along the whole line.</p></div>`;
        return;
      }
      listEl.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-line">Searching along your route…</div>';
      try {
        const pois = await PoiModule.searchAlongRoute(cat, route.coords, route.cum);
        PoiModule.display(listEl, pois, `No ${catLabel} found within 3 miles of your route.`);
        PoiModule.showMarkers(pois);
      } catch (e) {
        this.poiError(listEl, e);
      }
      return;
    }

    const loc = MapModule.currentLocation;
    if (!loc) {
      listEl.innerHTML = `<div class="empty-state-container"><p class="empty-state">No GPS fix yet, so I can't search around you. Allow location access, or switch to <strong>Along my route</strong> after you plan a ride.</p></div>`;
      MapModule.requestOneFix(() => this.loadStops());
      return;
    }

    listEl.innerHTML = '<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-line">Searching nearby…</div>';
    try {
      const pois = await PoiModule.searchNearby(cat, loc.lat, loc.lon, 15);
      PoiModule.display(listEl, pois, `No ${catLabel} found within 15 miles.`);
      PoiModule.showMarkers(pois);
    } catch (e) {
      this.poiError(listEl, e);
    }
  },

  poiError(listEl, e) {
    listEl.innerHTML = `<div class="err-box">Couldn't reach the map data server${e && e.message ? ' (' + this.escapeHtml(e.message) + ')' : ''}. <button type="button" class="btn-secondary" id="poiRetry">Retry</button></div>`;
    const btn = document.getElementById('poiRetry');
    if (btn) btn.addEventListener('click', () => this.loadStops());
  },

  /* --- Phase 1 + 2 buttons: planner, sheets, crash layer, settings --- */
  setupRideButtons() {
    document.getElementById('routeBar').addEventListener('click', () => {
      RouteModule.openPanel(RouteModule.routes.length ? 'plan' : 'plan');
    });

    document.getElementById('btnHazardToggle').addEventListener('click', () => {
      HazardModule.toggleLayer();
    });

    document.getElementById('btnMapSettings').addEventListener('click', () => {
      this.showOverlay('overlay-settings');
      AlertsModule.renderSettings();
    });

    document.getElementById('closePoiSheet').addEventListener('click', () => {
      document.getElementById('poiSheet').classList.remove('active');
    });
    document.getElementById('poiSheet').addEventListener('click', (e) => {
      if (e.target.id === 'poiSheet') e.target.classList.remove('active');
    });

    // Escape closes whichever sheet is up — handy on desktop, harmless on a phone.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const poi = document.getElementById('poiSheet');
      if (poi && poi.classList.contains('active')) { poi.classList.remove('active'); return; }
      const rep = document.getElementById('reportSheet');
      if (rep && rep.classList.contains('active')) AlertsModule.closeReportSheet();
    });

    document.getElementById('closeReportSheet').addEventListener('click', () => {
      AlertsModule.closeReportSheet();
    });
    document.getElementById('reportSheet').addEventListener('click', (e) => {
      if (e.target.id === 'reportSheet') AlertsModule.closeReportSheet();
    });
    document.querySelectorAll('.report-btn').forEach((btn) => {
      btn.addEventListener('click', () => AlertsModule.fileReport(btn.dataset.report));
    });
  },

  /* Reflects the planned route on the map screen's top bar. */
  updateRouteBar() {
    const bar = document.getElementById('routeBar');
    const title = document.getElementById('routeBarTitle');
    const sub = document.getElementById('routeBarSub');
    const route = RouteModule.activeRoute();
    if (!route || !RouteModule.to) {
      bar.classList.remove('has-route');
      title.textContent = 'Where to?';
      sub.textContent = 'Plan a ride, fuel stops and all';
      return;
    }
    bar.classList.add('has-route');
    title.textContent = RouteModule.to.name;
    const stops = RouteModule.fuelPlan ? RouteModule.fuelPlan.stops.length : 0;
    sub.textContent = `${Geo.fmtMi(route.distanceMi)} mi · ${Geo.fmtDuration(route.durationSec)}` +
      (stops ? ` · ${stops} fuel stop${stops === 1 ? '' : 's'}` : '');
  },

  toast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('active');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('active'), 4500);
  },

  // --- Emergency ---
  shareLocation() {
    if (!MapModule.currentLocation) {
      alert('Unable to get your location. Please enable location services.');
      return;
    }

    const { lat, lon } = MapModule.currentLocation;
    const link = `https://www.google.com/maps?q=${lat},${lon}`;
    const locationLink = document.getElementById('locationLink');
    const locationDisplay = document.getElementById('locationDisplay');
    const coordsEl = document.getElementById('locationCoords');

    locationLink.href = link;
    coordsEl.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    locationDisplay.style.display = '';

    // Try to use Web Share API
    if (navigator.share) {
      navigator.share({
        title: 'Emergency — My Location',
        text: `I need help. This is my current location: ${link}`,
        url: link,
      }).catch(() => {});
    } else {
      // Fallback: copy to clipboard
      navigator.clipboard?.writeText(link).then(() => {
        alert('Location link copied to clipboard. Share it with your contacts.');
      }).catch(() => {});
    }
  },

  notifyPack() {
    const packs = Storage.getPacks();
    if (packs.length === 0) {
      alert('You have no packs yet. Create a pack first to notify your riding group.');
      return;
    }

    if (!MapModule.currentLocation) {
      alert('Unable to get your location.');
      return;
    }

    const { lat, lon } = MapModule.currentLocation;
    const link = `https://www.google.com/maps?q=${lat},${lon}`;

    // Get emergency contacts from profile
    const profile = Storage.getProfile();
    const contacts = profile.emergencyContacts || [];

    let message = `EMERGENCY ALERT: Your pack member needs help.\nLocation: ${link}`;
    if (contacts.length > 0) {
      message += `\n\nEmergency contacts:\n${contacts.map(c => `${c.name}: ${c.phone}`).join('\n')}`;
    }

    // Try Web Share
    if (navigator.share) {
      navigator.share({
        title: 'Emergency Alert',
        text: message,
      }).catch(() => {});
    } else {
      alert(message);
    }
  },

  renderEmergencyContacts() {
    const profile = Storage.getProfile();
    const contacts = profile.emergencyContacts || [];
    const listEl = document.getElementById('emergencyContactsList');

    if (contacts.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No emergency contacts added. Go to Profile to add contacts.</p>';
      return;
    }

    listEl.innerHTML = contacts
      .map((c) => `
        <div class="contact-item">
          <div class="contact-info">
            <div class="contact-name">${this.escapeHtml(c.name)}</div>
            <div class="contact-phone">${this.escapeHtml(c.phone)}</div>
          </div>
          <a href="tel:${c.phone}" class="contact-call">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </a>
        </div>
      `)
      .join('');
  },

  addEmergencyContact() {
    const name = prompt('Contact name:');
    if (!name) return;
    const phone = prompt('Phone number:');
    if (!phone) return;

    const profile = Storage.getProfile();
    if (!profile.emergencyContacts) profile.emergencyContacts = [];
    profile.emergencyContacts.push({ name, phone });
    Storage.saveProfile(profile);
    this.renderEmergencyContacts();
    this.renderProfile();
  },

  // --- Garage ---
  setupGarage() {
    document.getElementById('btnAddBike').addEventListener('click', () => {
      document.getElementById('bikeFormTitle').textContent = 'Add Bike';
      document.getElementById('bikeForm').reset();
      document.getElementById('bikeId').value = '';
      this.showOverlay('overlay-bike-form');
    });

    document.getElementById('closeBikeForm').addEventListener('click', () => {
      this.hideOverlay('overlay-bike-form');
    });

    document.getElementById('bikeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveBike();
    });

    document.getElementById('closeBikeDetail').addEventListener('click', () => {
      this.hideOverlay('overlay-bike-detail');
    });
  },

  saveBike() {
    const id = document.getElementById('bikeId').value || Storage.genId();
    const bike = {
      id,
      make: document.getElementById('bikeMake').value,
      model: document.getElementById('bikeModel').value,
      year: parseInt(document.getElementById('bikeYear').value) || null,
      tankRange: parseInt(document.getElementById('bikeTankRange').value) || 100,
      color: document.getElementById('bikeColor').value || '',
      nickname: document.getElementById('bikeNickname').value || '',
      mileage: parseInt(document.getElementById('bikeMileage').value) || 0,
      engineSize: document.getElementById('bikeEngineSize').value || '',
      tankSize: parseFloat(document.getElementById('bikeTankSize').value) || null,
      mpg: parseInt(document.getElementById('bikeMpg').value) || null,
      horsepower: parseInt(document.getElementById('bikeHorsepower').value) || null,
      weight: parseInt(document.getElementById('bikeWeight').value) || null,
      mods: document.getElementById('bikeMods').value || '',
      serviceRecords: [],
    };

    // Preserve existing service records if editing
    const existing = Storage.getBike(id);
    if (existing && existing.serviceRecords) {
      bike.serviceRecords = existing.serviceRecords;
    }

    Storage.saveBike(bike);
    this.hideOverlay('overlay-bike-form');
    this.renderGarage();
  },

  renderGarage() {
    const bikes = Storage.getBikes();
    const listEl = document.getElementById('garageList');

    if (bikes.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state-container">
          <p class="empty-state">No bikes in your garage yet. Tap + to add your first bike.</p>
        </div>
      `;
      this.renderRideHistory();
      return;
    }

    listEl.innerHTML = bikes
      .map((bike) => `
        <div class="bike-card" data-bike-id="${bike.id}">
          <div class="bike-card-header">
            <div class="bike-card-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="5.5" cy="17.5" r="3.5"/>
                <circle cx="18.5" cy="17.5" r="3.5"/>
                <path d="M15 6a5 5 0 0 1 5 5"/>
                <path d="M4 12a8 8 0 0 1 8-8"/>
                <path d="M8.5 17.5L12 7l3.5 10.5"/>
              </svg>
            </div>
            <div class="bike-card-info">
              <div class="bike-card-title">${this.escapeHtml(bike.nickname || `${bike.make} ${bike.model}`)}</div>
              <div class="bike-card-subtitle">${bike.year || ''} ${this.escapeHtml(bike.make)} ${this.escapeHtml(bike.model)}</div>
            </div>
          </div>
          <div class="bike-card-stats">
            <div class="bike-stat">
              <div class="bike-stat-value">${bike.mileage.toLocaleString()}</div>
              <div class="bike-stat-label">Miles</div>
            </div>
            <div class="bike-stat">
              <div class="bike-stat-value">${bike.tankRange}</div>
              <div class="bike-stat-label">Tank Range</div>
            </div>
          </div>
        </div>
      `)
      .join('');

    // Click to view detail
    listEl.querySelectorAll('.bike-card').forEach((card) => {
      card.addEventListener('click', () => {
        this.showBikeDetail(card.dataset.bikeId);
      });
    });

    this.renderRideHistory();
  },

  showBikeDetail(bikeId) {
    const bike = Storage.getBike(bikeId);
    if (!bike) return;

    document.getElementById('bikeDetailTitle').textContent = bike.nickname || `${bike.make} ${bike.model}`;

    const content = document.getElementById('bikeDetailContent');
    content.innerHTML = `
      <div class="bike-card" style="border:none;margin-bottom:0;">
        <div class="bike-card-header">
          <div class="bike-card-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="5.5" cy="17.5" r="3.5"/>
              <circle cx="18.5" cy="17.5" r="3.5"/>
              <path d="M15 6a5 5 0 0 1 5 5"/>
              <path d="M4 12a8 8 0 0 1 8-8"/>
              <path d="M8.5 17.5L12 7l3.5 10.5"/>
            </svg>
          </div>
          <div class="bike-card-info">
            <div class="bike-card-title">${bike.year || ''} ${this.escapeHtml(bike.make)} ${this.escapeHtml(bike.model)}</div>
            <div class="bike-card-subtitle">${bike.color ? this.escapeHtml(bike.color) : ''}</div>
          </div>
        </div>
        <div class="bike-card-stats">
          <div class="bike-stat">
            <div class="bike-stat-value">${bike.mileage.toLocaleString()}</div>
            <div class="bike-stat-label">Total Miles</div>
          </div>
          <div class="bike-stat">
            <div class="bike-stat-value">${bike.tankRange}</div>
            <div class="bike-stat-label">Tank Range (mi)</div>
          </div>
        </div>
      </div>

      ${this.getServiceRemindersHTML(bike)}

      ${bike.engineSize || bike.tankSize || bike.mpg || bike.horsepower || bike.weight ? `
        <hr class="divider">
        <h3 class="section-title">Bike Specs</h3>
        <div class="bike-specs">
          ${bike.engineSize ? `<div class="bike-spec-item"><div class="bike-spec-label">Engine</div><div class="bike-spec-value">${this.escapeHtml(bike.engineSize)}</div></div>` : ''}
          ${bike.tankSize ? `<div class="bike-spec-item"><div class="bike-spec-label">Tank</div><div class="bike-spec-value">${bike.tankSize} gal</div></div>` : ''}
          ${bike.mpg ? `<div class="bike-spec-item"><div class="bike-spec-label">MPG</div><div class="bike-spec-value">${bike.mpg}</div></div>` : ''}
          ${bike.horsepower ? `<div class="bike-spec-item"><div class="bike-spec-label">HP</div><div class="bike-spec-value">${bike.horsepower}</div></div>` : ''}
          ${bike.weight ? `<div class="bike-spec-item"><div class="bike-spec-label">Weight</div><div class="bike-spec-value">${bike.weight} lbs</div></div>` : ''}
          ${bike.tankSize && bike.mpg ? `<div class="bike-spec-item"><div class="bike-spec-label">Est. Range</div><div class="bike-spec-value">${Math.round(bike.tankSize * bike.mpg)} mi</div></div>` : ''}
        </div>
        ${bike.mods ? `<div class="bike-mods">${this.escapeHtml(bike.mods)}</div>` : ''}
      ` : ''}

      <hr class="divider">

      <h3 class="section-title">Service Records</h3>
      <div id="serviceRecordsList">
        ${bike.serviceRecords && bike.serviceRecords.length > 0
          ? bike.serviceRecords.map((r) => `
              <div class="service-record">
                <div class="service-record-info">
                  <div class="service-record-type">${this.escapeHtml(r.type)}</div>
                  <div class="service-record-date">${r.date} · ${r.miles.toLocaleString()} mi${r.cost ? ' · $' + r.cost : ''}</div>
                  ${r.notes ? `<div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px;">${this.escapeHtml(r.notes)}</div>` : ''}
                </div>
              </div>
            `).join('')
          : '<p class="empty-state">No service records yet.</p>'
        }
      </div>

      <button class="btn-secondary btn-large" id="btnAddService" style="width:100%;margin-top:var(--space-4);">
        Add Service Record
      </button>
      <button class="btn-secondary btn-large" id="btnEditBike" style="width:100%;margin-top:var(--space-2);">
        Edit Bike
      </button>
      <button class="btn-secondary btn-large" id="btnDeleteBike" style="width:100%;margin-top:var(--space-2);color:var(--color-error);">
        Delete Bike
      </button>
    `;

    this.showOverlay('overlay-bike-detail');

    // Service record
    document.getElementById('btnAddService').addEventListener('click', () => {
      this.addServiceRecord(bikeId);
    });

    // Edit
    document.getElementById('btnEditBike').addEventListener('click', () => {
      this.hideOverlay('overlay-bike-detail');
      document.getElementById('bikeFormTitle').textContent = 'Edit Bike';
      document.getElementById('bikeId').value = bike.id;
      document.getElementById('bikeMake').value = bike.make || '';
      document.getElementById('bikeModel').value = bike.model || '';
      document.getElementById('bikeYear').value = bike.year || '';
      document.getElementById('bikeTankRange').value = bike.tankRange || '';
      document.getElementById('bikeColor').value = bike.color || '';
      document.getElementById('bikeNickname').value = bike.nickname || '';
      document.getElementById('bikeMileage').value = bike.mileage || '';
      document.getElementById('bikeEngineSize').value = bike.engineSize || '';
      document.getElementById('bikeTankSize').value = bike.tankSize || '';
      document.getElementById('bikeMpg').value = bike.mpg || '';
      document.getElementById('bikeHorsepower').value = bike.horsepower || '';
      document.getElementById('bikeWeight').value = bike.weight || '';
      document.getElementById('bikeMods').value = bike.mods || '';
      this.showOverlay('overlay-bike-form');
    });

    // Delete
    document.getElementById('btnDeleteBike').addEventListener('click', () => {
      if (confirm('Delete this bike? This cannot be undone.')) {
        Storage.deleteBike(bikeId);
        this.hideOverlay('overlay-bike-detail');
        this.renderGarage();
      }
    });
  },

  addServiceRecord(bikeId) {
    const type = prompt('Service type (e.g., Oil Change, Tire Replacement):');
    if (!type) return;
    const miles = prompt('Mileage at service:');
    if (!miles) return;
    const notes = prompt('Notes (optional):') || '';

    const bike = Storage.getBike(bikeId);
    if (!bike.serviceRecords) bike.serviceRecords = [];
    bike.serviceRecords.unshift({
      id: Storage.genId(),
      type,
      date: new Date().toISOString().split('T')[0],
      miles: parseInt(miles) || 0,
      notes,
    });

    Storage.saveBike(bike);
    this.showBikeDetail(bikeId); // Re-render
  },

  // --- Packs ---
  setupPacks() {
    document.getElementById('btnCreatePack').addEventListener('click', () => {
      document.getElementById('packForm').reset();
      this.showOverlay('overlay-pack-form');
    });

    document.getElementById('closePackForm').addEventListener('click', () => {
      this.hideOverlay('overlay-pack-form');
    });

    document.getElementById('packForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.savePack();
    });

    document.getElementById('closePackDetail').addEventListener('click', () => {
      this.hideOverlay('overlay-pack-detail');
    });
  },

  savePack() {
    let gasInterval = document.getElementById('packGasInterval').value;
    if (gasInterval === 'custom') {
      gasInterval = parseInt(document.getElementById('packGasCustom').value) || 100;
    } else {
      gasInterval = parseInt(gasInterval);
    }

    const profile = Storage.getProfile();
    const pack = {
      id: Storage.genId(),
      name: document.getElementById('packName').value,
      gasInterval,
      captain: profile.name || 'You',
      createdAt: Date.now(),
      members: [
        {
          id: 'me',
          name: profile.name || 'You',
          level: profile.level || 'Novice',
          miles: profile.totalMiles || 0,
          isCaptain: true,
          isYou: true,
        },
      ],
    };

    Storage.savePack(pack);
    this.hideOverlay('overlay-pack-form');
    this.renderPacks();
  },

  renderPacks() {
    const packs = Storage.getPacks();
    const listEl = document.getElementById('packList');

    if (packs.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state-container">
          <p class="empty-state">No packs yet. Tap + to create a pack and invite riders.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = packs
      .map((pack) => {
        const member = pack.members.find((m) => m.isYou);
        const isCaptain = member && member.isCaptain;

        return `
        <div class="pack-card" data-pack-id="${pack.id}">
          <div class="pack-card-header">
            <div class="pack-card-title">${this.escapeHtml(pack.name)}</div>
            <span class="pack-badge ${isCaptain ? 'captain' : 'member'}">
              ${isCaptain ? 'Road Captain' : 'Member'}
            </span>
          </div>
          <div class="pack-members">
            ${pack.members.slice(0, 5).map((m) => `
              <div class="pack-member-avatar">${(m.name || '?')[0].toUpperCase()}</div>
            `).join('')}
            ${pack.members.length > 5 ? `<div class="pack-member-avatar">+${pack.members.length - 5}</div>` : ''}
          </div>
          <div class="pack-card-footer">
            <span>${pack.members.length} ${pack.members.length === 1 ? 'member' : 'members'}</span>
            <span>Gas every ${pack.gasInterval} mi</span>
          </div>
        </div>
      `;
      })
      .join('');

    listEl.querySelectorAll('.pack-card').forEach((card) => {
      card.addEventListener('click', () => {
        this.showPackDetail(card.dataset.packId);
      });
    });
  },

  showPackDetail(packId) {
    const pack = Storage.getPack(packId);
    if (!pack) return;

    document.getElementById('packDetailTitle').textContent = pack.name;

    const content = document.getElementById('packDetailContent');
    content.innerHTML = `
      <div class="pack-card" style="border:none;">
        <div class="pack-card-header">
          <div class="pack-card-title">Gas Stop Interval</div>
          <span class="pack-badge captain">Every ${pack.gasInterval} mi</span>
        </div>
        <p style="font-size:var(--text-sm);color:var(--color-text-muted);">
          Road Captain sets gas stops based on the lowest tank range in the pack.
        </p>
      </div>

      <h3 class="section-title">Pack Members</h3>
      ${pack.members.map((m) => `
        <div class="pack-member-row">
          <div class="member-avatar">${(m.name || '?')[0].toUpperCase()}</div>
          <div class="member-info">
            <div class="member-name">
              ${this.escapeHtml(m.name)} ${m.isYou ? '(You)' : ''}
              ${m.isCaptain ? '<span style="font-size:var(--text-xs);color:var(--color-primary);margin-left:4px;">★ Captain</span>' : ''}
            </div>
            <div class="member-meta">
              <span class="member-level-badge ${m.level}">${m.level}</span>
              <span>${(m.miles || 0).toLocaleString()} mi</span>
            </div>
          </div>
        </div>
      `).join('')}

      <h3 class="section-title">Pack Stats</h3>
      <div class="profile-stats">
        <div class="profile-stat">
          <div class="profile-stat-value">${pack.members.length}</div>
          <div class="profile-stat-label">Members</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${pack.ridesLed || 0}</div>
          <div class="profile-stat-label">Rides Led</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${pack.gasInterval}</div>
          <div class="profile-stat-label">Gas Every</div>
        </div>
      </div>

      <h3 class="section-title">Emergency Contacts</h3>
      <p style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:var(--space-3);">
        If a rider goes down, pack members can see their emergency contacts here.
      </p>
      ${pack.members.map((m) => {
        const profile = Storage.getProfile();
        const contact = m.isYou ? (profile.emergencyContacts || []).map(c => `${c.name}: ${c.phone}`).join(', ') : (m.emergencyContact || 'Not set');
        return `
        <div class="pack-member-row">
          <div class="member-avatar">${(m.name || '?')[0].toUpperCase()}</div>
          <div class="member-info">
            <div class="member-name">${this.escapeHtml(m.name)} ${m.isYou ? '(You)' : ''}</div>
            <div class="member-meta">Emergency: ${this.escapeHtml(contact)}</div>
          </div>
        </div>
      `;
      }).join('')}

      <button class="btn-secondary btn-large" id="btnInviteRider" style="width:100%;margin-top:var(--space-4);">
        Invite Rider
      </button>
      <button class="btn-secondary btn-large" id="btnRateRider" style="width:100%;margin-top:var(--space-2);">
        Rate a Rider
      </button>
      <button class="btn-primary btn-large" id="btnStartGroupRide" style="margin-top:var(--space-2);">
        Start Group Ride
      </button>
      <button class="btn-secondary btn-large" id="btnDeletePack" style="width:100%;margin-top:var(--space-2);color:var(--color-error);">
        Delete Pack
      </button>
    `;

    this.showOverlay('overlay-pack-detail');

    document.getElementById('btnInviteRider').addEventListener('click', () => {
      const name = prompt('Rider name:');
      if (!name) return;
      const level = prompt('Riding level (Novice/Expert/Demon):', 'Novice') || 'Novice';
      const miles = parseInt(prompt('Total miles:', '0') || '0');

      pack.members.push({
        id: Storage.genId(),
        name,
        level: ['Novice', 'Expert', 'Demon'].includes(level) ? level : 'Novice',
        miles,
        isCaptain: false,
        isYou: false,
      });

      Storage.savePack(pack);
      this.showPackDetail(packId);
      this.renderPacks();
    });

    document.getElementById('btnStartGroupRide').addEventListener('click', () => {
      this.hideOverlay('overlay-pack-detail');
      this.switchScreen('map');
      // If not already tracking, start
      if (!MapModule.isTracking) {
        document.getElementById('btnRide').click();
      }
    });

    document.getElementById('btnDeletePack').addEventListener('click', () => {
      if (confirm('Delete this pack?')) {
        Storage.deletePack(packId);
        this.hideOverlay('overlay-pack-detail');
        this.renderPacks();
      }
    });

    document.getElementById('btnRateRider').addEventListener('click', () => {
      const otherMembers = pack.members.filter(m => !m.isYou);
      if (otherMembers.length === 0) {
        alert('No other riders to rate. Invite riders to your pack first.');
        return;
      }
      const riderList = otherMembers.map((m, i) => `${i + 1}. ${m.name}`).join('\n');
      const choice = prompt(`Which rider would you like to rate?\n\n${riderList}`, '1');
      if (!choice) return;
      const idx = parseInt(choice) - 1;
      if (idx < 0 || idx >= otherMembers.length) {
        alert('Invalid selection.');
        return;
      }
      const rider = otherMembers[idx];
      this.hideOverlay('overlay-pack-detail');
      this.showPackRating(rider.name, new Date().toISOString().split('T')[0], pack.name);
    });
  },

  // --- Blog ---
  setupBlog() {
    document.getElementById('btnCreatePost').addEventListener('click', () => {
      document.getElementById('postForm').reset();
      document.getElementById('photoPreview').innerHTML = '';
      this.showOverlay('overlay-post-form');
      this.setupPhotoPreview();
    });

    document.getElementById('closePostForm').addEventListener('click', () => {
      this.hideOverlay('overlay-post-form');
    });

    document.getElementById('postForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.savePost();
    });

    document.querySelectorAll('#blogFilters .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#blogFilters .chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        this.currentBlogCategory = chip.dataset.cat;
        this.renderBlog();
      });
    });
  },

  savePost() {
    const profile = Storage.getProfile();
    const photoInput = document.getElementById('postPhoto');
    let photoData = null;

    // Handle photo upload
    if (photoInput.files && photoInput.files[0]) {
      const reader = new FileReader();
      reader.onload = (e) => {
        photoData = e.target.result;
        this._savePostWithPhoto(profile, photoData);
      };
      reader.readAsDataURL(photoInput.files[0]);
    } else {
      this._savePostWithPhoto(profile, null);
    }
  },

  _savePostWithPhoto(profile, photoData) {
    const post = {
      id: Storage.genId(),
      title: document.getElementById('postTitle').value,
      category: document.getElementById('postCategory').value,
      content: document.getElementById('postContent').value,
      author: profile.name || 'Anonymous',
      authorLevel: profile.level || 'Novice',
      date: new Date().toISOString().split('T')[0],
      photo: photoData,
      likes: 0,
      liked: false,
      comments: [],
    };

    Storage.savePost(post);
    this.hideOverlay('overlay-post-form');
    this.renderBlog();
  },

  // Photo preview handler
  setupPhotoPreview() {
    const photoInput = document.getElementById('postPhoto');
    const preview = document.getElementById('photoPreview');
    if (!photoInput) return;
    photoInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          preview.innerHTML = `<img src="${ev.target.result}" style="width:100%;border-radius:var(--radius-md);margin-top:var(--space-2);">`;
        };
        reader.readAsDataURL(e.target.files[0]);
      } else {
        preview.innerHTML = '';
      }
    });
  },

  toggleLike(postId) {
    const posts = Storage.getPosts();
    const post = posts.find(p => p.id === postId);
    if (!post) return;

    if (post.liked) {
      post.likes = (post.likes || 0) - 1;
      post.liked = false;
    } else {
      post.likes = (post.likes || 0) + 1;
      post.liked = true;
    }
    Storage.set(Storage.KEYS.POSTS, posts);
    this.renderBlog();
  },

  addComment(postId) {
    const comment = prompt('Add a comment:');
    if (!comment) return;

    const profile = Storage.getProfile();
    const posts = Storage.getPosts();
    const post = posts.find(p => p.id === postId);
    if (!post) return;

    if (!post.comments) post.comments = [];
    post.comments.push({
      author: profile.name || 'Anonymous',
      text: comment,
      date: new Date().toISOString().split('T')[0],
    });
    Storage.set(Storage.KEYS.POSTS, posts);
    this.renderBlog();
  },

  renderBlog() {
    const posts = Storage.getPosts();
    const listEl = document.getElementById('blogList');

    const filtered = this.currentBlogCategory === 'all'
      ? posts
      : posts.filter((p) => p.category === this.currentBlogCategory);

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state-container">
          <p class="empty-state">No posts yet. Tap + to share your bike, pack, or ride photos.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered
      .map((post) => {
        const catLabels = { bike: 'My Bike', pack: 'My Pack', ride: 'Ride Photos', event: 'Event', destination: 'Destination', rides: 'Ride', events: 'Event', destinations: 'Destination' };
        const catLabel = catLabels[post.category] || post.category;
        const authorInitial = (post.author || '?')[0].toUpperCase();
        const likeClass = post.liked ? 'liked' : '';
        const likeIcon = post.liked ? '♥' : '♡';

        return `
        <div class="social-post" data-post-id="${post.id}">
          <div class="social-post-header">
            <div class="social-avatar">${authorInitial}</div>
            <div class="social-author">
              <div class="social-author-name">${this.escapeHtml(post.author)}</div>
              <div class="social-post-date">${post.date} · ${catLabel}</div>
            </div>
          </div>
          ${post.photo ? `<div class="social-post-photo"><img src="${post.photo}" alt="${this.escapeHtml(post.title)}"></div>` : ''}
          <div class="social-post-body">
            <div class="social-post-title">${this.escapeHtml(post.title)}</div>
            <div class="social-post-caption">${this.escapeHtml(post.content)}</div>
          </div>
          <div class="social-post-actions">
            <button class="social-action like-btn ${likeClass}" data-post-id="${post.id}">
              <span class="like-icon">${likeIcon}</span>
              <span class="like-count">${post.likes || 0}</span>
            </button>
            <button class="social-action comment-btn" data-post-id="${post.id}">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span>${(post.comments || []).length}</span>
            </button>
          </div>
          ${(post.comments || []).length > 0 ? `
            <div class="social-comments">
              ${post.comments.map(c => `
                <div class="social-comment">
                  <span class="comment-author">${this.escapeHtml(c.author)}:</span>
                  <span class="comment-text">${this.escapeHtml(c.text)}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
      })
      .join('');

    // Like buttons
    listEl.querySelectorAll('.like-btn').forEach(btn => {
      btn.addEventListener('click', () => this.toggleLike(btn.dataset.postId));
    });

    // Comment buttons
    listEl.querySelectorAll('.comment-btn').forEach(btn => {
      btn.addEventListener('click', () => this.addComment(btn.dataset.postId));
    });
  },

  // --- Profile ---
  setupProfile() {
    // Edit profile button is rendered dynamically
    document.getElementById('closeProfileForm').addEventListener('click', () => {
      this.hideOverlay('overlay-profile-form');
    });

    document.getElementById('profileForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveProfile();
    });

    // Profile pic upload
    this.setupProfilePicUpload();
  },

  renderProfile() {
    const profile = Storage.getProfile();
    const contentEl = document.getElementById('profileContent');
    let accountEmail = '';
    try {
      accountEmail = JSON.parse(sessionStorage.getItem('sicc-ride-auth-session'))?.user?.email || '';
    } catch {}

    const initials = (profile.name || 'R')[0].toUpperCase();

    contentEl.innerHTML = `
      <div class="profile-header">
        ${profile.profilePic
          ? `<div class="profile-avatar" style="background:url('${profile.profilePic}')center/cover;width:80px;height:80px;"></div>`
          : `<div class="profile-avatar">${initials}</div>`
        }
        <div class="profile-name">${this.escapeHtml(profile.name || 'Rider')}</div>
        <div class="profile-level ${profile.level || 'Novice'}">${profile.level || 'Novice'}</div>
        <div class="profile-region">${this.escapeHtml(profile.region || 'Set your region')}</div>
        ${accountEmail ? `<div class="profile-account">Signed in as ${this.escapeHtml(accountEmail)}</div>` : ''}
      </div>

      <div class="profile-stats">
        <div class="profile-stat">
          <div class="profile-stat-value">${(profile.totalMiles || 0).toLocaleString()}</div>
          <div class="profile-stat-label">Total Miles</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${profile.packsRidden || 0}</div>
          <div class="profile-stat-label">Packs Ridden</div>
        </div>
        <div class="profile-stat">
          <div class="profile-stat-value">${profile.packsLed || 0}</div>
          <div class="profile-stat-label">Packs Led</div>
        </div>
      </div>

      ${profile.bio ? `<p style="font-size:var(--text-sm);color:var(--color-text-muted);text-align:center;margin-bottom:var(--space-4);">${this.escapeHtml(profile.bio)}</p>` : ''}

      <button class="btn-primary btn-large" id="btnEditProfile">Edit Profile</button>
      <button class="btn-secondary btn-large" id="btnManageContacts" style="margin-top:var(--space-2);">Emergency Contacts</button>
      <button class="btn-secondary btn-large btn-sign-out" id="btnSignOut" style="margin-top:var(--space-2);">Sign Out</button>

      <div class="leaderboard-section">
        <h3>Leaderboard</h3>
        <div class="leaderboard-tabs">
          <button class="chip active" id="lbLocal">Local</button>
          <button class="chip" id="lbRegional">Regional</button>
          <button class="chip" id="lbNational">National</button>
        </div>
        <div id="leaderboardList"></div>
      </div>
    `;

    // Edit profile
    document.getElementById('btnEditProfile').addEventListener('click', () => {
      document.getElementById('profileName').value = profile.name || '';
      document.getElementById('profileLevel').value = profile.level || 'Novice';
      document.getElementById('profileGasInterval').value = profile.gasInterval || 100;
      document.getElementById('profileRegion').value = profile.region || '';
      document.getElementById('profileBio').value = profile.bio || '';
      this.showOverlay('overlay-profile-form');
    });

    // Emergency contacts
    document.getElementById('btnManageContacts').addEventListener('click', () => {
      this.showOverlay('overlay-emergency');
      this.renderEmergencyContacts();
    });

    document.getElementById('btnSignOut').addEventListener('click', () => this.signOut());

    // Leaderboard
    this.renderLeaderboard('local');

    document.getElementById('lbLocal').addEventListener('click', () => {
      this.setLeaderboardTab('local');
    });
    document.getElementById('lbRegional').addEventListener('click', () => {
      this.setLeaderboardTab('regional');
    });
    document.getElementById('lbNational').addEventListener('click', () => {
      this.setLeaderboardTab('national');
    });
  },

  async signOut() {
    const sessionKey = 'sicc-ride-auth-session';
    let session;
    try {
      session = JSON.parse(sessionStorage.getItem(sessionKey));
    } catch {
      session = null;
    }

    const config = window.SICC_RIDE_SUPABASE || {};
    try {
      if (session?.access_token) {
        await fetch(`${config.url}/auth/v1/logout`, {
          method: 'POST',
          headers: {
            apikey: config.anonKey,
            Authorization: `Bearer ${session.access_token}`
          }
        });
      }
    } finally {
      sessionStorage.removeItem(sessionKey);
      location.replace('auth.html');
    }
  },

  setLeaderboardTab(scope) {
    document.querySelectorAll('.leaderboard-tabs .chip').forEach((c) => c.classList.remove('active'));
    document.getElementById('lb' + scope.charAt(0).toUpperCase() + scope.slice(1)).classList.add('active');
    this.renderLeaderboard(scope);
  },

  renderLeaderboard(scope) {
    const riders = Storage.getLeaderboard(scope);
    const listEl = document.getElementById('leaderboardList');

    listEl.innerHTML = riders
      .map((rider, idx) => {
        const rank = idx + 1;
        const rankClass = rank <= 3 ? `top-${rank}` : '';
        return `
          <div class="leaderboard-row" ${rider.isYou ? 'style="border:1px solid var(--color-primary);"' : ''}>
            <div class="leaderboard-rank ${rankClass}">${rank}</div>
            <div class="leaderboard-name">
              ${this.escapeHtml(rider.name)}
              ${rider.isYou ? '<span style="font-size:var(--text-xs);color:var(--color-primary);margin-left:4px;">(You)</span>' : ''}
              <span class="member-level-badge ${rider.level}" style="margin-left:4px;font-size:9px;">${rider.level}</span>
            </div>
            <div class="leaderboard-miles">${rider.miles.toLocaleString()} mi</div>
          </div>
        `;
      })
      .join('');
  },

  saveProfile() {
    const profile = Storage.getProfile();
    profile.name = document.getElementById('profileName').value;
    profile.level = document.getElementById('profileLevel').value;
    profile.gasInterval = parseInt(document.getElementById('profileGasInterval').value);
    profile.region = document.getElementById('profileRegion').value;
    profile.bio = document.getElementById('profileBio').value;
    Storage.saveProfile(profile);
    this.hideOverlay('overlay-profile-form');
    this.renderProfile();
    this.updateTotalMiles();
  },

  setupProfilePicUpload() {
    const picInput = document.getElementById('profilePic');
    const preview = document.getElementById('profilePicPreview');
    if (!picInput) return;
    picInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          preview.innerHTML = `<img src="${ev.target.result}" style="width:100%;border-radius:var(--radius-md);margin-top:var(--space-2);">`;
          const profile = Storage.getProfile();
          profile.profilePic = ev.target.result;
          Storage.saveProfile(profile);
        };
        reader.readAsDataURL(e.target.files[0]);
      } else {
        preview.innerHTML = '';
      }
    });
  },

  updateTotalMiles() {
    const profile = Storage.getProfile();
    const el = document.getElementById('totalMiles');
    if (el) el.textContent = (profile.totalMiles || 0).toLocaleString();
  },

  // --- Service Reminders ---
  getServiceRemindersHTML(bike) {
    const reminders = [];
    const mileage = bike.mileage || 0;

    // Find last oil change
    const services = bike.serviceRecords || [];
    const lastOil = services.find(s => s.type.toLowerCase().includes('oil'));
    if (lastOil) {
      const milesSinceOil = mileage - (lastOil.miles || 0);
      if (milesSinceOil >= 4000) {
        reminders.push({
          text: `Oil change overdue — ${milesSinceOil.toLocaleString()} miles since last change`,
          urgent: milesSinceOil >= 5000,
        });
      } else if (milesSinceOil >= 3500) {
        reminders.push({
          text: `Oil change due soon — ${milesSinceOil.toLocaleString()} miles since last change`,
          urgent: false,
        });
      }
    } else {
      reminders.push({
        text: 'No oil change recorded — add a service record',
        urgent: true,
      });
    }

    // Find last tire replacement
    const lastTire = services.find(s => s.type.toLowerCase().includes('tire'));
    if (lastTire) {
      const milesSinceTire = mileage - (lastTire.miles || 0);
      if (milesSinceTire >= 8000) {
        reminders.push({
          text: `Tire replacement due — ${milesSinceTire.toLocaleString()} miles on current tires`,
          urgent: milesSinceTire >= 10000,
        });
      }
    }

    // Brake check
    const lastBrake = services.find(s => s.type.toLowerCase().includes('brake'));
    if (lastBrake) {
      const milesSinceBrake = mileage - (lastBrake.miles || 0);
      if (milesSinceBrake >= 12000) {
        reminders.push({
          text: `Brake check recommended — ${milesSinceBrake.toLocaleString()} miles since last brake service`,
          urgent: false,
        });
      }
    }

    if (reminders.length === 0) return '';

    return `
      <hr class="divider">
      <h3 class="section-title">Service Reminders</h3>
      ${reminders.map(r => `
        <div class="service-reminder" style="${r.urgent ? '' : 'background:rgba(150,66,25,0.08);border-color:rgba(150,66,25,0.2);'}">
          <div class="service-reminder-icon" style="${r.urgent ? '' : 'background:var(--color-warning);'}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
          </div>
          <div class="service-reminder-text">${this.escapeHtml(r.text)}</div>
        </div>
      `).join('')}
    `;
  },

  // --- Ride History ---
  renderRideHistory() {
    const rides = Storage.getRides();
    const sectionEl = document.getElementById('rideHistorySection');
    const listEl = document.getElementById('rideHistoryList');
    if (!sectionEl || !listEl) return;

    if (rides.length === 0) {
      sectionEl.style.display = 'none';
      return;
    }

    sectionEl.style.display = 'block';
    listEl.innerHTML = rides.slice(0, 10).map(ride => `
      <div class="ride-history-card">
        <div class="ride-history-info">
          <div class="ride-history-route">${this.escapeHtml(ride.route || 'Unknown route')}</div>
          <div class="ride-history-meta">${ride.date} · ${this.escapeHtml(ride.bikeName || '')} · ${ride.duration || ''}</div>
        </div>
        <div class="ride-history-distance">
          <div class="ride-history-miles">${ride.distance.toFixed(1)}</div>
          <div class="ride-history-label">MI</div>
        </div>
      </div>
    `).join('');
  },

  // --- Community Toggle (Feed / Events) ---
  setupCommunityToggle() {
    document.querySelectorAll('#communityToggle .toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#communityToggle .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const view = btn.dataset.view;
        document.getElementById('feedView').style.display = view === 'feed' ? 'block' : 'none';
        document.getElementById('eventsView').style.display = view === 'events' ? 'block' : 'none';
      });
    });
  },

  // --- Events ---
  renderEvents() {
    const events = Storage.getEvents();
    const listEl = document.getElementById('eventsList');
    if (!listEl) return;

    if (events.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No events yet.</p>';
      return;
    }

    // Sort by date
    events.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

    listEl.innerHTML = events.map(event => {
      const d = new Date(event.startDate);
      const month = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
      const day = d.getDate();

      return `
        <div class="event-card" data-event-id="${event.id}">
          <div class="event-date-box">
            <div class="event-date-month">${month}</div>
            <div class="event-date-day">${day}</div>
          </div>
          <div class="event-info">
            <div class="event-type">${this.escapeHtml(event.type)}</div>
            <div class="event-name">${this.escapeHtml(event.name)}</div>
            <div class="event-location">${this.escapeHtml(event.location)}</div>
            <div class="event-desc">${this.escapeHtml(event.description)}</div>
            <div class="event-going">
              <button class="event-going-btn ${event.isGoing ? 'going' : ''}" data-event-id="${event.id}">
                ${event.isGoing ? 'Going' : 'I\'m Going'}
              </button>
              <span class="event-going-count">${event.goingCount} going</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Going button handlers
    listEl.querySelectorAll('.event-going-btn').forEach(btn => {
      btn.addEventListener('click', () => this.toggleEventGoing(btn.dataset.eventId));
    });
  },

  toggleEventGoing(eventId) {
    const events = Storage.getEvents();
    const event = events.find(e => e.id === eventId);
    if (!event) return;

    event.isGoing = !event.isGoing;
    event.goingCount = (event.goingCount || 0) + (event.isGoing ? 1 : -1);
    Storage.set(Storage.KEYS.EVENTS, events);
    this.renderEvents();
  },

  // --- Pack Rating System ---
  setupPackRating() {
    document.getElementById('closePackRating').addEventListener('click', () => {
      this.hideOverlay('overlay-pack-rating');
    });
  },

  showPackRating(riderName, rideDate, rideRoute) {
    this.currentRating = { safe: 0, formation: 0, comms: 0, onTime: 0, withinAbility: 0 };
    const content = document.getElementById('packRatingContent');

    const criteria = [
      { key: 'safe', label: 'Safe Rider' },
      { key: 'formation', label: 'Keeps Formation' },
      { key: 'comms', label: 'Communicates Well' },
      { key: 'onTime', label: 'On Time' },
      { key: 'withinAbility', label: 'Rides Within Ability' },
    ];

    content.innerHTML = `
      <div style="text-align:center;margin-bottom:var(--space-4);">
        <div style="font-size:var(--text-lg);font-weight:700;">${this.escapeHtml(riderName)}</div>
        <div style="font-size:var(--text-sm);color:var(--color-text-muted);">${rideDate} · ${this.escapeHtml(rideRoute || '')}</div>
      </div>

      <div class="rating-criteria">
        ${criteria.map(c => `
          <div class="rating-criteria-item">
            <div class="rating-criteria-label">${c.label}</div>
            <div class="rating-stars" data-criteria="${c.key}">
              ${[1,2,3,4,5].map(n => `<button class="rating-star" data-value="${n}" data-criteria="${c.key}">\u2605</button>`).join('')}
            </div>
          </div>
        `).join('')}
      </div>

      <div class="form-group" style="padding:0 var(--space-4);">
        <label>Written Note (optional)</label>
        <textarea class="rating-note-input" id="ratingNote" placeholder="Great rider, stays in formation..."></textarea>
      </div>

      <div style="padding:0 var(--space-4);">
        <button class="btn-primary btn-large" id="btnSubmitRating" style="width:100%;">Submit Rating</button>
      </div>

      <hr class="divider" style="margin:var(--space-4) 0;">

      <h3 class="section-title" style="padding:0 var(--space-4);">Existing Ratings for ${this.escapeHtml(riderName)}</h3>
      <div id="existingRatings" style="padding:0 var(--space-4);">
        ${this.renderRatingsSummary(riderName)}
      </div>
    `;

    this.showOverlay('overlay-pack-rating');

    // Star handlers
    content.querySelectorAll('.rating-star').forEach(star => {
      star.addEventListener('click', () => {
        const criteria = star.dataset.criteria;
        const value = parseInt(star.dataset.value);
        this.currentRating[criteria] = value;

        // Update stars
        const starsContainer = content.querySelector(`.rating-stars[data-criteria="${criteria}"]`);
        starsContainer.querySelectorAll('.rating-star').forEach(s => {
          s.classList.toggle('active', parseInt(s.dataset.value) <= value);
        });
      });
    });

    // Submit handler
    document.getElementById('btnSubmitRating').addEventListener('click', () => {
      const total = Object.values(this.currentRating).reduce((a, b) => a + b, 0);
      if (total === 0) {
        alert('Please rate at least one category.');
        return;
      }

      const profile = Storage.getProfile();
      const rating = {
        id: Storage.genId(),
        riderName,
        ratedBy: profile.name || 'You',
        rideDate,
        rideRoute,
        ...this.currentRating,
        note: document.getElementById('ratingNote').value || '',
      };

      Storage.saveRating(rating);
      this.hideOverlay('overlay-pack-rating');

      // Re-render pack detail to show updated ratings
      const packDetail = document.getElementById('packDetailContent');
      if (packDetail) {
        // Find the pack and re-render
        const packs = Storage.getPacks();
        // Just re-render the pack detail if it was open
      }
    });
  },

  renderRatingsSummary(riderName) {
    const ratings = Storage.getRatingsForRider(riderName);
    if (ratings.length === 0) {
      return '<p class="empty-state">No ratings yet. This rider is new.</p>';
    }

    // Calculate averages
    const avg = (key) => {
      const vals = ratings.map(r => r[key] || 0).filter(v => v > 0);
      return vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '0.0';
    };

    const overallAvg = ((parseFloat(avg('safe')) + parseFloat(avg('formation')) + parseFloat(avg('comms')) + parseFloat(avg('onTime')) + parseFloat(avg('withinAbility'))) / 5).toFixed(1);

    return `
      <div style="margin-bottom:var(--space-3);">
        <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-2);">
          <span style="font-size:var(--text-xl);font-weight:700;color:#ffc553;">\u2605 ${overallAvg}</span>
          <span style="font-size:var(--text-sm);color:var(--color-text-muted);">from ${ratings.length} rating${ratings.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      ${ratings.map(r => {
        const avgStars = Math.round((r.safe + r.formation + r.comms + r.onTime + r.withinAbility) / 5);
        return `
          <div class="rating-summary">
            <div class="rating-summary-header">
              <div class="rating-summary-name">${this.escapeHtml(r.ratedBy)}</div>
              <div class="rating-summary-stars">
                ${[1,2,3,4,5].map(n => `<span class="rating-summary-star ${n <= avgStars ? '' : 'empty'}">\u2605</span>`).join('')}
              </div>
            </div>
            ${r.note ? `<div class="rating-summary-note">"${this.escapeHtml(r.note)}"</div>` : ''}
            <div class="rating-summary-meta">${r.rideDate} · ${this.escapeHtml(r.rideRoute || '')}</div>
          </div>
        `;
      }).join('')}
    `;
  },

  // --- Utility ---
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};

// --- Boot ---
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
