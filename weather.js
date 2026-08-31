/* ============================================
   The Ride — Route Weather (Phase 2, section B)

   Keyless NWS / api.weather.gov. Two things make this useful to a rider:

   1. TIME SHIFT. Every sample point is checked for the hour the rider will
      actually be there (departure + cumulative OSRM duration to that point),
      not for right now.
   2. POTENTIAL ADVISORIES. The NWS will not issue an alert for a 28 mph
      crosswind or a 104F afternoon, but both matter a great deal on two
      wheels. Those are computed locally from the hourly forecast.

   Battery note: this is a one-shot batch, fired only when the rider taps the
   button, with every response cached in Storage for 30 minutes. It never
   polls.
   ============================================ */

const WeatherModule = {
  SAMPLE_EVERY_MI: 40,
  MAX_SAMPLES: 12,
  TTL_MS: 30 * 60 * 1000,
  CONCURRENCY: 3,

  legs: [],
  loading: false,

  /* ---------- cache ---------- */
  cacheKey(kind, lat, lon, hourIso) {
    return `${kind}:${lat.toFixed(2)},${lon.toFixed(2)}${hourIso ? '@' + hourIso : ''}`;
  },

  cacheGet(key) {
    const c = Storage.get(Storage.KEYS.WEATHER_CACHE, {});
    const hit = c[key];
    if (!hit) return null;
    if (Date.now() - hit.ts > this.TTL_MS) return null;
    return hit.v;
  },

  cacheSet(key, v) {
    const c = Storage.get(Storage.KEYS.WEATHER_CACHE, {});
    const keys = Object.keys(c);
    if (keys.length > 200) keys.slice(0, 80).forEach(k => delete c[k]);
    c[key] = { ts: Date.now(), v };
    Storage.set(Storage.KEYS.WEATHER_CACHE, c);
  },

  /* ---------- fetchers ---------- */
  async fetchAlerts(lat, lon) {
    const key = this.cacheKey('alerts', lat, lon);
    const hit = this.cacheGet(key);
    if (hit) return hit;
    const data = await Geo.fetchJson(
      `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`,
      { headers: { Accept: 'application/geo+json' } }
    );
    const out = (data.features || []).map(f => ({
      event: f.properties.event,
      severity: f.properties.severity,
      headline: f.properties.headline,
      instruction: f.properties.instruction || '',
      description: (f.properties.description || '').slice(0, 400),
      onset: f.properties.onset,
      ends: f.properties.ends,
    }));
    this.cacheSet(key, out);
    return out;
  },

  async fetchHourly(lat, lon) {
    const key = this.cacheKey('hourly', lat, lon);
    const hit = this.cacheGet(key);
    if (hit) return hit;
    // Two-step: /points gives the gridpoint forecast URL.
    const pKey = this.cacheKey('pointmeta', lat, lon);
    let hourlyUrl = this.cacheGet(pKey);
    if (!hourlyUrl) {
      const pt = await Geo.fetchJson(
        `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
        { headers: { Accept: 'application/geo+json' } }
      );
      hourlyUrl = pt.properties && pt.properties.forecastHourly;
      if (!hourlyUrl) throw new Error('No forecast grid for this point');
      this.cacheSet(pKey, hourlyUrl);
    }
    const fc = await Geo.fetchJson(hourlyUrl, { headers: { Accept: 'application/geo+json' } });
    const periods = ((fc.properties && fc.properties.periods) || []).slice(0, 60).map(p => ({
      startTime: p.startTime,
      temperature: p.temperature,
      tempUnit: p.temperatureUnit,
      pop: p.probabilityOfPrecipitation ? p.probabilityOfPrecipitation.value : null,
      windSpeed: p.windSpeed,
      windDirection: p.windDirection,
      shortForecast: p.shortForecast,
      dewpointC: p.dewpoint ? p.dewpoint.value : null,
      humidity: p.relativeHumidity ? p.relativeHumidity.value : null,
    }));
    this.cacheSet(key, periods);
    return periods;
  },

  // Pick the hourly period covering a given time.
  periodAt(periods, when) {
    if (!periods || !periods.length) return null;
    const t = when.getTime();
    let best = periods[0], bestDiff = Infinity;
    periods.forEach(p => {
      const d = Math.abs(new Date(p.startTime).getTime() - t);
      if (d < bestDiff) { bestDiff = d; best = p; }
    });
    return bestDiff <= 3 * 3600 * 1000 ? best : null;
  },

  // "10 to 20 mph" → 20. "15 mph" → 15.
  peakWind(str) {
    if (!str) return null;
    const nums = String(str).match(/\d+/g);
    if (!nums) return null;
    return Math.max(...nums.map(Number));
  },

  windDirDeg(d) {
    const map = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
      S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
    return map[String(d || '').toUpperCase()] ?? null;
  },

  /* ---------- rider-specific "potential" advisories ---------- */
  potentialAdvisories(p, ctx) {
    const out = [];
    if (!p) return out;
    const wind = this.peakWind(p.windSpeed);
    const temp = p.temperature;
    const pop = p.pop;

    if (wind != null && wind >= 35) {
      out.push({ level: 'severe', title: `Wind to ${wind} mph`,
        text: 'Severe crosswind. A full fairing or loaded bags will get shoved hard. Slow down, loosen your grip, and expect gusts around trucks and cuts.' });
    } else if (wind != null && wind >= 25) {
      out.push({ level: 'warn', title: `Crosswind to ${wind} mph`,
        text: 'Expect a steady push, especially on high-profile bikes and bagger fairings. Watch for gusts when you clear an overpass or a hill cut.' });
    }

    if (pop != null && pop >= 60) {
      out.push({ level: 'severe', title: `Rain likely — ${pop}% chance`, text: 'Pack rain gear and plan for it, not around it. First 10 minutes of rain is the slickest.' });
    } else if (pop != null && pop >= 30) {
      out.push({ level: 'warn', title: `Rain possible — ${pop}% chance`, text: 'Pack gear. Desert roads get greasy with oil on the first wet pass.' });
    }

    if (temp != null && temp >= 105) {
      out.push({ level: 'severe', title: `Extreme heat — ${temp}°F`, text: 'This is dangerous in gear. Ride early, carry more water than you think you need, plan shade stops every 45 minutes.' });
    } else if (temp != null && temp >= 100) {
      out.push({ level: 'warn', title: `Heat — ${temp}°F`, text: 'Hydrate before you are thirsty and plan shade stops. Black gear on hot asphalt adds real degrees.' });
    }

    if (temp != null && temp <= 45) {
      const wc = Geo.windChill(temp, 70);
      out.push({ level: temp <= 35 ? 'severe' : 'warn', title: `Cold — ${temp}°F`,
        text: `At 70 mph that feels like about ${wc}°F on exposed skin. Layer up, cover your neck, watch for ice in shaded corners and on bridges.` });
    }

    if (temp != null && p.dewpointC != null) {
      const dewF = p.dewpointC * 9 / 5 + 32;
      if (Math.abs(temp - dewF) <= 4) {
        out.push({ level: 'warn', title: 'Fog risk', text: `Temperature and dewpoint are within ${Math.round(Math.abs(temp - dewF))}°F. Expect fog patches in low spots and river bottoms — visor fogging too.` });
      }
    }

    // Wet crossing / wash note — real Southwest hazard.
    if (pop != null && pop >= 30 && ctx.crossesWash) {
      out.push({ level: 'severe', title: 'Flooded wash risk',
        text: 'This route crosses dips and washes. Southwest washes fill in minutes and the water hides scoured pavement. Never ride a flowing crossing.' });
    }

    // Sun glare: is the sun low AND roughly down the road?
    if (ctx.heading != null) {
      const sol = Geo.solar(ctx.lat, ctx.lon, ctx.arrival);
      const { azimuth, elevation } = sol.azimuthAt(ctx.arrival);
      const mins = ctx.arrival.getHours() * 60 + ctx.arrival.getMinutes();
      const nearSunrise = sol.sunriseMin != null && Math.abs(mins - sol.sunriseMin) <= 45;
      const nearSunset = sol.sunsetMin != null && Math.abs(mins - sol.sunsetMin) <= 45;
      if ((nearSunrise || nearSunset) && elevation > -2 && elevation < 15 &&
          Geo.angleDiff(azimuth, ctx.heading) <= 30) {
        out.push({ level: 'warn', title: 'Sun straight in your eyes',
          text: `Around ${Geo.fmtClock(ctx.arrival)} you'll be heading ${Geo.compass(ctx.heading)} with the sun at ${Math.round(azimuth)}° and only ${Math.round(elevation)}° up. Clean your visor, and remember oncoming drivers can't see you either.` });
      }
    }

    return out;
  },

  rideScore(p, advisories, realAlerts) {
    if (!p) return { score: 'Unknown', cls: 'score-unknown' };
    let pts = 0;
    realAlerts.forEach(a => {
      const s = (a.severity || '').toLowerCase();
      pts += (s === 'extreme' || s === 'severe') ? 5 : 3;
    });
    advisories.forEach(a => { pts += a.level === 'severe' ? 3 : 1; });
    if (pts === 0) return { score: 'Great', cls: 'score-great' };
    if (pts <= 2) return { score: 'Good', cls: 'score-good' };
    if (pts <= 5) return { score: 'Rough', cls: 'score-rough' };
    return { score: "Don't", cls: 'score-dont' };
  },

  /* ---------- main ---------- */
  async loadForRoute(route, departAt) {
    if (!route) return;
    const section = document.getElementById('weatherSection');
    section.innerHTML = `
      <h3 class="plan-section-title">Route Weather</h3>
      <div class="skeleton-row"></div><div class="skeleton-row"></div>
      <div class="skeleton-line">Checking the National Weather Service for your arrival times…</div>`;

    const total = route.cum[route.cum.length - 1];
    const samples = Geo.sampleEvery(route.coords, route.cum, this.SAMPLE_EVERY_MI, this.MAX_SAMPLES);
    const crossesWash = HazardModule.routeCrossesWash(route);

    const legs = samples.map(s => {
      const frac = total > 0 ? s.mile / total : 0;
      const arrival = new Date(departAt.getTime() + route.durationSec * frac * 1000);
      const idx = Geo.pointAtMile(route.coords, route.cum, s.mile).idx;
      const nxt = route.coords[Math.min(idx + 25, route.coords.length - 1)];
      const heading = nxt ? Geo.bearing(s.lat, s.lon, nxt[0], nxt[1]) : null;
      return { ...s, arrival, heading, crossesWash };
    });

    // Bounded concurrency so we stay polite and don't blow up the radio.
    let cursor = 0;
    const worker = async () => {
      while (cursor < legs.length) {
        const leg = legs[cursor++];
        try {
          const [alerts, periods] = await Promise.all([
            this.fetchAlerts(leg.lat, leg.lon).catch(() => []),
            this.fetchHourly(leg.lat, leg.lon).catch(() => []),
          ]);
          leg.alerts = alerts;
          leg.period = this.periodAt(periods, leg.arrival);
          leg.potential = this.potentialAdvisories(leg.period, leg);
          leg.rideScore = this.rideScore(leg.period, leg.potential, leg.alerts);
        } catch (e) {
          leg.error = true;
          leg.alerts = []; leg.potential = []; leg.rideScore = { score: 'Unknown', cls: 'score-unknown' };
        }
      }
    };
    await Promise.all(Array.from({ length: this.CONCURRENCY }, worker));

    this.legs = legs;
    this.render();
  },

  render() {
    const section = document.getElementById('weatherSection');
    const legs = this.legs;
    if (!legs.length) {
      section.innerHTML = `<h3 class="plan-section-title">Route Weather</h3><div class="err-box">No forecast returned. <button type="button" class="btn-secondary" id="wxRetry">Retry</button></div>`;
      this.bindRetry();
      return;
    }
    const anyData = legs.some(l => l.period);
    const realAlerts = [];
    const seenAlert = new Set();
    legs.forEach(l => (l.alerts || []).forEach(a => {
      const k = a.event + '|' + a.headline;
      if (!seenAlert.has(k)) { seenAlert.add(k); realAlerts.push({ ...a, mile: l.mile }); }
    }));

    const potentialCards = [];
    const seenPot = new Set();
    legs.forEach(l => (l.potential || []).forEach(a => {
      const k = a.title;
      if (!seenPot.has(k)) { seenPot.add(k); potentialCards.push({ ...a, mile: l.mile, arrival: l.arrival }); }
    }));

    section.innerHTML = `
      <h3 class="plan-section-title">Route Weather</h3>
      <p class="plan-section-note">Forecast for when you'll be there, based on a ${Geo.fmtClock(legs[0].arrival)} departure. ${legs.length} check points.</p>

      ${!anyData ? `<div class="err-box">The National Weather Service returned no hourly data for this route (it only covers the US). <button type="button" class="btn-secondary" id="wxRetry">Retry</button></div>` : ''}

      <div class="wx-strip">
        ${legs.map(l => {
          const p = l.period;
          return `
          <div class="wx-leg">
            <div class="wx-leg-mile">Mile ${Math.round(l.mile)}</div>
            <div class="wx-leg-time">${Geo.fmtClock(l.arrival)}</div>
            <div class="wx-leg-icon">${this.icon(p)}</div>
            <div class="wx-leg-temp">${p ? p.temperature + '°' : '—'}</div>
            <div class="wx-leg-rows">
              <div>${p ? (this.peakWind(p.windSpeed) || 0) + ' mph ' + (p.windDirection || '') : '—'}</div>
              <div>${p && p.pop != null ? p.pop + '% rain' : '0% rain'}</div>
            </div>
            <div class="wx-leg-cond">${p ? App.escapeHtml(p.shortForecast) : 'No data'}</div>
            <div class="wx-score ${l.rideScore.cls}">${l.rideScore.score}</div>
          </div>`;
        }).join('')}
      </div>

      ${realAlerts.length ? `
        <h4 class="wx-subhead">Active NWS advisories on this route</h4>
        ${realAlerts.map(a => `
          <div class="wx-alert ${(a.severity || '').toLowerCase() === 'severe' || (a.severity || '').toLowerCase() === 'extreme' ? 'wx-alert-severe' : 'wx-alert-warn'}">
            <div class="wx-alert-head">${App.escapeHtml(a.event)} <span class="wx-alert-sev">${App.escapeHtml(a.severity || '')}</span></div>
            <div class="wx-alert-headline">${App.escapeHtml(a.headline || '')}</div>
            ${a.instruction ? `<div class="wx-alert-instr">${App.escapeHtml(a.instruction)}</div>` : ''}
            <div class="wx-alert-meta">Near mile ${Math.round(a.mile)}</div>
          </div>`).join('')}
      ` : `<h4 class="wx-subhead">Active NWS advisories on this route</h4><p class="plan-section-note">None active right now.</p>`}

      ${potentialCards.length ? `
        <h4 class="wx-subhead">Potential rider advisories</h4>
        <p class="plan-section-note">The NWS won't issue a warning for these. On two wheels they still matter.</p>
        ${potentialCards.map(a => `
          <div class="wx-alert ${a.level === 'severe' ? 'wx-alert-severe' : 'wx-alert-warn'}">
            <div class="wx-alert-head">${App.escapeHtml(a.title)}</div>
            <div class="wx-alert-instr">${App.escapeHtml(a.text)}</div>
            <div class="wx-alert-meta">Near mile ${Math.round(a.mile)} · about ${Geo.fmtClock(a.arrival)}</div>
          </div>`).join('')}
      ` : '<h4 class="wx-subhead">Potential rider advisories</h4><p class="plan-section-note">Nothing flagged. Wind, heat, cold, rain, fog and sun glare all check out for your timing.</p>'}

      <p class="plan-section-note plan-attribution">Forecasts and advisories from the <a href="https://www.weather.gov/documentation/services-web-api" target="_blank" rel="noopener">NOAA / National Weather Service API</a>. Cached 30 minutes. <button type="button" class="wx-refresh-link" id="wxRetry">Refresh now</button></p>
    `;
    this.bindRetry();
  },

  bindRetry() {
    const b = document.getElementById('wxRetry');
    if (b) b.addEventListener('click', () => {
      Storage.set(Storage.KEYS.WEATHER_CACHE, {});
      WeatherModule.loadForRoute(RouteModule.activeRoute(), RouteModule.departAt);
    });
  },

  icon(p) {
    if (!p) return '·';
    const s = (p.shortForecast || '').toLowerCase();
    if (s.includes('thunder')) return '⛈';
    if (s.includes('snow') || s.includes('sleet')) return '❄';
    if (s.includes('rain') || s.includes('shower')) return '🌧';
    if (s.includes('fog') || s.includes('haze')) return '🌫';
    if (s.includes('mostly cloudy') || s.includes('overcast')) return '☁';
    if (s.includes('partly') || s.includes('cloud')) return '⛅';
    if (s.includes('wind')) return '🌬';
    if (p.temperature >= 100) return '🔥';
    return '☀';
  },
};
