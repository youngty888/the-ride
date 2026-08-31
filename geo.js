/* ============================================
   The Ride — Geo & Network Utilities
   Shared by route.js, poi.js, weather.js, hazards.js, alerts.js

   No dependencies. No API keys. Everything here is pure JS.
   ============================================ */

const Geo = {
  R_MI: 3958.7613, // Earth radius in miles

  toRad(d) { return (d * Math.PI) / 180; },
  toDeg(r) { return (r * 180) / Math.PI; },

  // --- Haversine distance in miles between [lat,lon] pairs ---
  distMi(lat1, lon1, lat2, lon2) {
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * this.R_MI * Math.asin(Math.min(1, Math.sqrt(a)));
  },

  // --- Initial bearing in degrees (0 = north) ---
  bearing(lat1, lon1, lat2, lon2) {
    const p1 = this.toRad(lat1), p2 = this.toRad(lat2);
    const dl = this.toRad(lon2 - lon1);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (this.toDeg(Math.atan2(y, x)) + 360) % 360;
  },

  compass(deg) {
    const pts = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return pts[Math.round(((deg % 360) / 45)) % 8];
  },

  // Smallest absolute difference between two headings, 0-180
  angleDiff(a, b) {
    let d = Math.abs(((a - b) % 360 + 360) % 360);
    return d > 180 ? 360 - d : d;
  },

  /* --- Google-style encoded polyline decoder (precision 5) ---
     Written inline on purpose: OSRM returns encoded geometry and we refuse
     to add a dependency for ~20 lines of shifting. */
  decodePolyline(str, precision = 5) {
    const factor = Math.pow(10, precision);
    let index = 0, lat = 0, lon = 0;
    const coords = [];
    while (index < str.length) {
      let shift = 0, result = 0, byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      lon += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lat / factor, lon / factor]);
    }
    return coords;
  },

  // --- Cumulative mileage along a [[lat,lon],...] path ---
  cumulative(coords) {
    const out = [0];
    for (let i = 1; i < coords.length; i++) {
      out.push(out[i - 1] + this.distMi(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    }
    return out;
  },

  // --- Coordinate at a given mileage along the path ---
  pointAtMile(coords, cum, mile) {
    if (!coords.length) return null;
    if (mile <= 0) return { lat: coords[0][0], lon: coords[0][1], idx: 0 };
    for (let i = 1; i < cum.length; i++) {
      if (cum[i] >= mile) {
        const span = cum[i] - cum[i - 1] || 1;
        const t = (mile - cum[i - 1]) / span;
        return {
          lat: coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
          lon: coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
          idx: i,
        };
      }
    }
    const last = coords[coords.length - 1];
    return { lat: last[0], lon: last[1], idx: coords.length - 1 };
  },

  // --- Sample a path every N miles (returns {lat,lon,mile}) ---
  sampleEvery(coords, cum, everyMi, maxSamples = 999) {
    const total = cum[cum.length - 1] || 0;
    const out = [];
    const step = Math.max(everyMi, total / maxSamples);
    for (let m = 0; m <= total + 0.01; m += step) {
      const p = this.pointAtMile(coords, cum, m);
      if (p) out.push({ lat: p.lat, lon: p.lon, mile: Math.min(m, total) });
      if (out.length >= maxSamples) break;
    }
    const last = coords[coords.length - 1];
    if (out.length && Math.abs(out[out.length - 1].mile - total) > 1) {
      out.push({ lat: last[0], lon: last[1], mile: total });
    }
    return out;
  },

  /* --- Nearest point on a path to a coordinate ---
     Returns { distMi (detour as crow-flies), mile (distance along route), idx }.
     Coarse scan: steps through vertices, which is fine at OSRM's ~10 m spacing. */
  nearestOnPath(coords, cum, lat, lon, stride = 1) {
    let best = { distMi: Infinity, mile: 0, idx: 0 };
    for (let i = 0; i < coords.length; i += stride) {
      const d = this.distMi(lat, lon, coords[i][0], coords[i][1]);
      if (d < best.distMi) best = { distMi: d, mile: cum[i], idx: i };
    }
    return best;
  },

  // --- Bounding box of a path, padded in degrees ---
  bbox(coords, padDeg = 0) {
    let s = 90, n = -90, w = 180, e = -180;
    coords.forEach(([la, lo]) => {
      if (la < s) s = la; if (la > n) n = la;
      if (lo < w) w = lo; if (lo > e) e = lo;
    });
    return { south: s - padDeg, north: n + padDeg, west: w - padDeg, east: e + padDeg };
  },

  /* --- fetch with a hard 10 s AbortController timeout ---
     Every network call in this app goes through here so nothing can hang
     forever and drain the battery waiting on a dead radio. */
  async fetchTimeout(url, opts = {}, ms = 10000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res;
    } finally {
      clearTimeout(t);
    }
  },

  async fetchJson(url, opts = {}, ms = 10000) {
    const res = await this.fetchTimeout(url, opts, ms);
    return res.json();
  },

  /* --- Rate-limited request queue ---
     Nominatim's usage policy is a hard 1 request/second. This enforces it
     app-wide instead of trusting each caller. */
  makeQueue(minGapMs) {
    let last = 0;
    let chain = Promise.resolve();
    return function enqueue(fn) {
      chain = chain.then(async () => {
        const wait = Math.max(0, minGapMs - (Date.now() - last));
        if (wait) await new Promise(r => setTimeout(r, wait));
        last = Date.now();
        return fn();
      }).catch(() => {});
      return chain;
    };
  },

  // --- Formatting helpers ---
  fmtMi(mi) {
    if (mi == null || isNaN(mi)) return '—';
    return mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString();
  },

  fmtDuration(sec) {
    if (sec == null || isNaN(sec)) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  },

  fmtClock(date) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  },

  /* --- NOAA solar position (no API) ---
     Returns { sunriseMin, sunsetMin, azimuthAt(date) } in local time minutes.
     Good to ~1 minute, which is plenty for "is the sun in your eyes". */
  solar(lat, lon, date) {
    const rad = Math.PI / 180;
    const start = new Date(date.getFullYear(), 0, 1);
    const dayOfYear = Math.floor((date - start) / 86400000) + 1;
    const tzOffsetHrs = -date.getTimezoneOffset() / 60;

    const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (date.getHours() - 12) / 24);
    const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
      - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
    const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
      - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
      - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);

    const latR = lat * rad;
    const cosHa = Math.cos(90.833 * rad) / (Math.cos(latR) * Math.cos(decl)) - Math.tan(latR) * Math.tan(decl);
    let sunriseMin = null, sunsetMin = null;
    if (cosHa >= -1 && cosHa <= 1) {
      const ha = Math.acos(cosHa) / rad;
      sunriseMin = 720 - 4 * (lon + ha) - eqTime + tzOffsetHrs * 60;
      sunsetMin = 720 - 4 * (lon - ha) - eqTime + tzOffsetHrs * 60;
    }

    const azimuthAt = (when) => {
      const minutes = when.getHours() * 60 + when.getMinutes();
      const trueSolarTime = (minutes + eqTime + 4 * lon - 60 * tzOffsetHrs + 1440) % 1440;
      let hourAngle = trueSolarTime / 4 - 180;
      if (hourAngle < -180) hourAngle += 360;
      const haR = hourAngle * rad;
      const zenith = Math.acos(Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(haR));
      let az;
      const denom = Math.sin(zenith) * Math.cos(latR);
      if (Math.abs(denom) < 1e-8) {
        az = hourAngle > 0 ? 180 : 0;
      } else {
        let c = (Math.sin(latR) * Math.cos(zenith) - Math.sin(decl)) / denom;
        c = Math.max(-1, Math.min(1, c));
        az = 180 - Math.acos(c) / rad;
        if (hourAngle > 0) az = 360 - az;
      }
      return { azimuth: (az + 360) % 360, elevation: 90 - zenith / rad };
    };

    return { sunriseMin, sunsetMin, azimuthAt };
  },

  // --- Wind chill at speed (NWS formula, degF, mph) ---
  windChill(tempF, mph) {
    if (tempF > 50 || mph < 3) return Math.round(tempF);
    return Math.round(
      35.74 + 0.6215 * tempF - 35.75 * Math.pow(mph, 0.16) + 0.4275 * tempF * Math.pow(mph, 0.16)
    );
  },
};
