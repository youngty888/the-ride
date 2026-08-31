/* ============================================
   RideFlow — Map Module
   Leaflet + OpenStreetMap + GPS + Overpass API
   ============================================ */

const MapModule = {
  map: null,
  userMarker: null,
  userCircle: null,
  stopMarkers: [],
  watchId: null,
  currentLocation: null,
  isTracking: false,
  rideStartTime: null,
  rideDistance: 0,
  lastPosition: null,
  speed: 0,
  lastHeading: null,
  paused: false,          // set by AlertsModule on Page Visibility change
  navigating: false,      // high-accuracy GPS only while true
  ridePath: null,
  ridePathCoords: [],

  // --- Init ---
  init() {
    if (this.map) return;

    this.map = L.map('map', {
      center: [32.2226, -110.9747], // Tucson, AZ default
      zoom: 14,
      zoomControl: false,
      attributionControl: true,
    });

    // Dark theme — OSM tiles with CSS filter for dark mode
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      subdomains: 'abc',
      maxZoom: 19,
    }).addTo(this.map);

    // Start GPS
    this.startGPS();
  },

  /* --- GPS ---
     BATTERY: this is the ONE and ONLY watchPosition in the whole app.
     Nothing else may open a watch or poll getCurrentPosition on a timer.
     High accuracy is requested only while actively navigating a route;
     otherwise we accept coarser, cheaper fixes and reuse cached ones. */
  startGPS() {
    if (!navigator.geolocation) {
      console.warn('Geolocation not supported');
      return;
    }
    this.restartWatch();
  },

  gpsOptions() {
    const saver = typeof AlertsModule !== 'undefined' && AlertsModule.batteryHeavy && AlertsModule.batteryHeavy();
    if (saver) {
      // Cheapest useful tier: coarse fixes, happily reuse a 30 s old one.
      return { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 };
    }
    if (this.navigating) {
      return { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 };
    }
    return { enableHighAccuracy: false, maximumAge: 15000, timeout: 15000 };
  },

  restartWatch() {
    if (!navigator.geolocation) return;
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.onPositionUpdate(pos),
      (err) => console.warn('GPS error:', err.message),
      this.gpsOptions()
    );
  },

  setNavigating(on) {
    if (this.navigating === !!on) return;
    this.navigating = !!on;
    this.restartWatch();
  },

  /* One-shot fix for a user-initiated action (Use My Location, Center on me).
     Never called on a timer. */
  requestOneFix(cb) {
    if (!navigator.geolocation) return;
    if (this._oneFixPending) return;
    this._oneFixPending = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this._oneFixPending = false;
        this.onPositionUpdate(pos);
        if (cb) cb(this.currentLocation);
      },
      () => { this._oneFixPending = false; },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
    );
  },

  onPositionUpdate(pos) {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const accuracy = pos.coords.accuracy || 0;
    this.speed = pos.coords.speed ? Math.round(pos.coords.speed * 2.23694) : 0; // m/s to mph
    if (pos.coords.heading != null && !isNaN(pos.coords.heading)) {
      this.lastHeading = pos.coords.heading;
    } else if (this.currentLocation && typeof Geo !== 'undefined') {
      const moved = Geo.distMi(this.currentLocation.lat, this.currentLocation.lon, lat, lon);
      if (moved > 0.01) this.lastHeading = Geo.bearing(this.currentLocation.lat, this.currentLocation.lon, lat, lon);
    }
    this.currentLocation = { lat, lon, accuracy, speedMph: this.speed, heading: this.lastHeading };

    // BATTERY: marker redraws are skipped while the page is hidden or the map
    // screen isn't the one on screen.
    if (!this.paused && App.currentScreen === 'map') {
      this.updateUserMarker(lat, lon, accuracy);
    }

    // Local, network-free proximity check against the prefetched cache.
    if (typeof AlertsModule !== 'undefined') AlertsModule.onPosition(this.currentLocation);

    // If tracking a ride, update distance
    if (this.isTracking) {
      this.updateRideTracking(lat, lon);
    }
  },

  updateUserMarker(lat, lon, accuracy) {
    if (this.userMarker) {
      this.userMarker.setLatLng([lat, lon]);
    } else {
      const icon = L.divIcon({
        className: 'user-location-marker',
        html: '',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      this.userMarker = L.marker([lat, lon], { icon }).addTo(this.map);
    }

    if (this.userCircle) {
      this.userCircle.setLatLng([lat, lon]).setRadius(accuracy);
    } else {
      this.userCircle = L.circle([lat, lon], {
        radius: accuracy,
        color: '#ff6b1a',
        fillColor: '#ff6b1a',
        fillOpacity: 0.1,
        weight: 1,
      }).addTo(this.map);
    }
  },

  centerOnUser() {
    if (this.currentLocation) {
      this.map.setView([this.currentLocation.lat, this.currentLocation.lon], 16, {
        animate: true,
      });
    } else {
      this.requestOneFix((loc) => {
        if (loc) this.map.setView([loc.lat, loc.lon], 16, { animate: true });
        else App.toast('Unable to get your location. Make sure location services are enabled.');
      });
    }
  },

  // --- Add Stop (Overpass API) ---
  async findNearbyStops(type, openNow = true) {
    if (!this.currentLocation) {
      // Try one-shot
      await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            this.currentLocation = {
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            };
            resolve();
          },
          () => resolve(),
          { enableHighAccuracy: true, timeout: 8000 }
        );
      });
    }

    if (!this.currentLocation) {
      return { error: 'Unable to determine your location. Please enable location services.' };
    }

    const { lat, lon } = this.currentLocation;
    const radius = 16000; // 10 miles in meters

    // Build Overpass query
    const queries = {
      fuel: `node["amenity"="fuel"](around:${radius},${lat},${lon});out body;`,
      restaurant: `node["amenity"="restaurant"](around:${radius},${lat},${lon});out body 30;`,
      cafe: `node["amenity"="cafe"](around:${radius},${lat},${lon});out body 20;`,
      car_repair: `node["shop"="car_repair"](around:${radius},${lat},${lon});node["craft"="mechanic"](around:${radius},${lat},${lon});out body 20;`,
      convenience: `node["shop"="convenience"](around:${radius},${lat},${lon});out body 20;`,
      toilets: `node["amenity"="toilets"](around:${radius},${lat},${lon});out body 20;`,
    };

    const query = queries[type] || queries.fuel;

    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent('[out:json];' + query),
      });

      if (!response.ok) throw new Error('Overpass API error');

      const data = await response.json();
      const stops = this.parseOverpassResults(data.elements, type, openNow, lat, lon);

      return { stops, lat, lon };
    } catch (err) {
      console.error('Overpass error:', err);
      return { error: 'Unable to search for nearby stops. Check your internet connection.' };
    }
  },

  parseOverpassResults(elements, type, openNow, userLat, userLon) {
    const stops = elements
      .map((el) => {
        const tags = el.tags || {};
        const name = tags.name || tags.brand || this.getDefaultName(type);
        const lat = el.lat;
        const lon = el.lon;

        if (!lat || !lon) return null;

        const distance = this.calculateDistance(userLat, userLon, lat, lon);
        const distanceMi = (distance * 0.621371).toFixed(1);

        // Check if open
        let isOpen = null;
        let hours = tags.opening_hours || tags['opening_hours:signed'] || '';

        if (hours) {
          isOpen = this.checkOpenNow(hours);
        } else {
          // No hours listed — assume open (common for gas stations)
          if (type === 'fuel') isOpen = true;
        }

        return {
          name,
          lat,
          lon,
          distance: distanceMi,
          isOpen,
          hours,
          type,
          phone: tags.phone || tags['contact:phone'] || '',
          brand: tags.brand || '',
        };
      })
      .filter((s) => s !== null)
      .sort((a, b) => parseFloat(a.distance) - parseFloat(b.distance));

    // Filter by open now
    if (openNow) {
      return stops.filter((s) => s.isOpen !== false);
    }

    return stops;
  },

  getDefaultName(type) {
    const names = {
      fuel: 'Gas Station',
      restaurant: 'Restaurant',
      cafe: 'Coffee Shop',
      car_repair: 'Mechanic Shop',
      convenience: 'Convenience Store',
      toilets: 'Restroom',
    };
    return names[type] || 'Stop';
  },

  // --- Opening Hours Parser (simplified) ---
  checkOpenNow(hoursStr) {
    if (!hoursStr) return null;

    const now = new Date();
    const day = now.getDay(); // 0=Sun
    const hours = now.getHours();
    const mins = now.getMinutes();
    const currentTime = hours * 60 + mins;

    // Simplified: check for 24/7
    if (hoursStr.toLowerCase().includes('24/7') || hoursStr.toLowerCase().includes('mo-su 00:00-24:00')) {
      return true;
    }

    // Very simplified parser — handles common formats
    // This is a basic implementation; production would use a proper library
    try {
      const dayMap = { 'mo': 1, 'tu': 2, 'we': 3, 'th': 4, 'fr': 5, 'sa': 6, 'su': 0 };
      const dayStr = Object.keys(dayMap).find(k => dayMap[k] === day);

      // Look for patterns like "Mo-Sa 06:00-22:00" or "Mo-Fr 08:00-20:00; Sa 09:00-18:00"
      const parts = hoursStr.toLowerCase().split(';');
      for (const part of parts) {
        const trimmed = part.trim();
        // Check if this part applies to today
        if (trimmed.includes(dayStr) || trimmed.includes('mo-su') || trimmed.includes('ph')) {
          // Extract time range
          const timeMatch = trimmed.match(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
          if (timeMatch) {
            const openTime = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
            const closeTime = parseInt(timeMatch[3]) * 60 + parseInt(timeMatch[4]);
            if (closeTime < openTime) {
              // Overnight (e.g., open past midnight)
              return currentTime >= openTime || currentTime <= closeTime;
            }
            return currentTime >= openTime && currentTime <= closeTime;
          }
        }
      }
    } catch (e) {
      // Can't parse — return null (unknown)
      return null;
    }

    return null;
  },

  // --- Haversine distance ---
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // km
  },

  toRad(deg) {
    return (deg * Math.PI) / 180;
  },

  // --- Stop Markers ---
  showStopMarkers(stops) {
    this.clearStopMarkers();

    stops.forEach((stop) => {
      const icon = L.divIcon({
        className: 'stop-marker',
        html: `<div style="width:32px;height:32px;border-radius:50%;background:${stop.isOpen === false ? '#e53e3e' : '#ff6b1a'};display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;border:2px solid #fff;">${this.getStopIcon(stop.type)}</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });

      const marker = L.marker([stop.lat, stop.lon], { icon }).addTo(this.map);
      marker.bindPopup(`
        <div style="color:#000;">
          <strong>${stop.name}</strong><br>
          ${stop.distance} mi away<br>
          ${stop.isOpen === true ? '<span style="color:green;">Open Now</span>' : stop.isOpen === false ? '<span style="color:red;">Closed</span>' : 'Hours unknown'}
        </div>
      `);
      this.stopMarkers.push(marker);
    });
  },

  getStopIcon(type) {
    const icons = {
      fuel: '⛽',
      restaurant: '🍔',
      cafe: '☕',
      car_repair: '🔧',
      convenience: '🛒',
      toilets: '🚻',
    };
    return icons[type] || '📍';
  },

  clearStopMarkers() {
    this.stopMarkers.forEach((m) => this.map.removeLayer(m));
    this.stopMarkers = [];
  },

  // --- Ride Tracking ---
  startRideTracking() {
    this.isTracking = true;
    this.rideStartTime = Date.now();
    this.rideDistance = 0;
    this.ridePathCoords = [];
    this.lastPosition = null;

    // Draw ride path
    this.ridePath = L.polyline([], {
      color: '#ff6b1a',
      weight: 4,
      opacity: 0.8,
    }).addTo(this.map);
  },

  updateRideTracking(lat, lon) {
    if (!this.isTracking) return;

    this.ridePathCoords.push([lat, lon]);
    this.ridePath.setLatLngs(this.ridePathCoords);

    if (this.lastPosition) {
      const dist = this.calculateDistance(
        this.lastPosition.lat,
        this.lastPosition.lon,
        lat,
        lon
      );
      this.rideDistance += dist; // km
    }

    this.lastPosition = { lat, lon };

    // Update stats display
    const speedEl = document.getElementById('statSpeed');
    const distEl = document.getElementById('statDistance');
    const timeEl = document.getElementById('statTime');

    if (speedEl) speedEl.textContent = this.speed || 0;
    if (distEl) distEl.textContent = (this.rideDistance * 0.621371).toFixed(1);

    // Update timer
    if (timeEl && this.rideStartTime) {
      const elapsed = Math.floor((Date.now() - this.rideStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      timeEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
  },

  stopRideTracking() {
    this.isTracking = false;

    const miles = Math.round(this.rideDistance * 0.621371);
    const duration = this.rideStartTime ? Math.floor((Date.now() - this.rideStartTime) / 60000) : 0;

    // Save ride
    if (miles > 0) {
      const ride = {
        id: Storage.genId(),
        date: new Date().toISOString().split('T')[0],
        distance: miles,
        duration: duration,
        bikeId: null, // Will be set by caller
      };
      Storage.saveRide(ride);
    }

    // Reset display
    this.rideDistance = 0;
    this.rideStartTime = null;
    this.lastPosition = null;

    // Remove ride path
    if (this.ridePath) {
      this.map.removeLayer(this.ridePath);
      this.ridePath = null;
      this.ridePathCoords = [];
    }

    return { miles, duration };
  },

  // --- Navigate to a stop ---
  navigateTo(lat, lon) {
    // Open in device's default maps app
    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
      window.open(`maps://maps.apple.com/?daddr=${lat},${lon}`, '_blank');
    } else {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`, '_blank');
    }
  },
};
