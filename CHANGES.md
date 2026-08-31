# The Ride — Phase 1 + Phase 2

Everything below is vanilla HTML/CSS/JS. No build step, no npm, no API keys, no
server. It still runs by opening `index.html` (or from GitHub Pages) exactly
like it did before.

---

## What you can actually do now

### Search and plan a route (this did not exist before)

- **Where to?** bar at the top of the map opens the planner.
- Type a town, park, or address — suggestions appear as you type, from
  [Nominatim / OpenStreetMap](https://nominatim.openstreetmap.org/). Results are
  cached for 30 days so repeat searches are instant and cost no requests.
- **Use My Location** fills the origin from GPS with one tap.
- Add as many **stops along the way** as you want.
- Pick a **departure time**, your **bike** (from Garage), and who you're
  **riding with** (a pack caps your gas interval to the pack's setting).
- **Build My Route** returns the fastest route plus alternates from
  [OSRM](https://router.project-osrm.org/). Tap any option to switch; the map
  redraws with the chosen line solid and the others dashed.
- Verified: Tucson → Las Vegas returns **453 mi / 8h 23m** with a 456 mi
  alternate.
- Turn-by-turn directions are there in a collapsible section.

### Fuel stops computed from your tank, not guessed

- **Fuel reserve rule** slider: how much of the tank you'll actually use before
  filling. Default 80%.
- A 160 mi tank at 80% = **128 mi between stops**. On the 453 mi Vegas run that
  puts targets at mile 128, 256, and 384, and the app searches for real gas
  stations near each one (widening 5 → 10 → 20 mi until it finds some).
- Each stop is a tappable chip. Tap it to see up to 8 alternates near that mile
  with the detour distance off your line, and swap the chosen one.
- **No-fuel-gap warning**: if the real stations found leave a stretch longer
  than your effective range, you get an orange warning naming the gap, e.g.
  *"No fuel for 325 mi between mile 128 and mile 453. Your effective range is
  128 mi. Carry fuel, top off early, or reroute."*
- If the gas-station database is unreachable, you still get the mileage math —
  the strip says *"Fuel by mile 128 — couldn't reach the station database, the
  mileage still holds"* instead of silently pretending there's nothing there.

### Save routes and a recommended trip library

- **Save Route** names and stores a route in your browser. It survives reload,
  and **Load** rebuilds it.
- **Trip Library** tab ships 12 real Southwest rides with actual coordinates —
  Mt. Lemmon / Catalina Highway, Coronado Trail (US-191), Salt River Canyon,
  Apache Trail, Oak Creek Canyon, Kingman → Oatman on Route 66, Valley of Fire,
  Zion Mt. Carmel, Gila Cliff Dwellings, Mt. Graham, Chiricahua, Tucson →
  Bisbee. Each has difficulty, mileage, best season, and a real description.
  **Route It** builds the ride from where you actually are.
- You can rate and comment on a trip; ratings are stored locally.

### Stops split into the categories you asked for

11 categories, all separate: **Gas, Fast Food, Sit-Down, Coffee, Hotel,
Camping, Mechanic, Restroom, Store, Viewpoint, Hospital**. Data from
[OpenStreetMap via Overpass](https://overpass-api.de/).

- Toggle between **Near me** and **Along my route** (searches a 3 mi corridor
  along the whole line, sampling every 15 mi).
- **Open Now Only** filter with real `opening_hours` parsing — rows are badged
  *Open*, *Closes in 25 min*, *Closed*, or *Hours not listed*. If everything is
  closed you're told so instead of shown an empty list.
- **Favorite** and **Block** a place; favorites rank higher, blocked places
  disappear.

### POI taps stay inside the app

Tapping any place opens an in-app bottom sheet with the name, hours, distance
and bearing from you, detour off your route, address, phone (tap to call),
and OSM facts like diesel, premium, air pump, Wi-Fi, drive-through, cuisine,
star rating, showers, tent/RV sites.

From that sheet: **Add to Route**, **Set as Destination**, **Favorite**,
**Block**. There is exactly one button that leaves the app — *"Navigate — opens
outside The Ride"* — and it says so. Nothing auto-redirects to Google Maps
anymore.

### Weather that's checked for when you'll be there

From the [National Weather Service API](https://api.weather.gov/) (public, no key).

- Samples the route every 40 mi (max 12 points), works out your ETA at each
  point from your departure time, and pulls the hourly forecast **for that
  hour**, not for right now.
- Per-leg cards: mile, clock time, icon, temp, wind speed and direction, rain
  chance, conditions, and a **ride score** — Great / Good / Rough / Don't.
- **Active NWS advisories** on the route are listed with severity (verified live:
  a real Flood Watch surfaced on the Tucson → Vegas line).
- **"Potential" rider advisories** the NWS won't issue but a rider needs —
  crosswind at 25 and 35 mph, rain chance over 30% and 60%, heat over 100 °F and
  105 °F, cold under 45 °F and 35 °F (with wind chill computed at 70 mph), fog
  risk when temp minus dewpoint is under 4 °F, flooded-wash risk when the route
  name contains a wash and rain is likely, and **sun glare** when the sun is low
  and within 25° of your heading — computed from real solar position.
- One batch of requests, then cached 30 minutes. Three requests in flight max.

### Motorcycle crash hazard layer

From **NHTSA Fatality Analysis Reporting System (FARS), 2021–2023**,
motorcycle-involved crashes only
([source](https://www.nhtsa.gov/file-downloads?p=nhtsa/downloads/FARS/)).

- **CRASHES** button on the map toggles 304 nationwide fatal-crash clusters.
  Per-state detail files (AZ, CA, CO, NV, NM, TX, UT) lazy-load only when you
  zoom in to 9 or closer, so you never download data you're not looking at.
- Tap a cluster: road name, county, how many died there, what actually happened
  in plain English (*"Single vehicle — no other car involved"*, not the raw FARS
  code), what got hit first, the worst hour of day, and what share happened in
  the dark — plus a rider-specific read on what that pattern means.
- Planning a route **scans it automatically**: the Vegas run surfaced 11
  clusters within 2.5 mi of the line, 35 fatal crashes total, each with the mile
  marker it sits at.

### Rider-reported alerts — battery first

**REPORT** button on the map. Two taps, no typing: pick **Officer**, **Crash**,
**Road Hazard**, or **Closed**. It drops at your GPS position, confirms with a
tone and a short buzz, and expires on its own (officer 45 min, crash 2 hr,
hazard 12 hr, closure 24 hr).

Approaching a report you didn't file, you get a voice callout, a distinct tone,
a vibration, and a banner: *"Officer reported ahead, 0.4 miles. Reported just
now."* Verified: it only fires for reports **ahead of your heading** (within
35°), inside 0.6 mi, and never for a report you filed yourself.

**The twelve things done specifically so this does not drain your battery like
Waze:**

1. No polling loop. Nothing runs on a timer by default — auto-refresh is **off**
   until you turn it on in Settings.
2. GPS accuracy is tiered. Idle on the map: coarse fixes, 15 s stale allowed.
   Actually navigating: high accuracy, 5 s. Battery Saver: coarse, 30 s stale.
3. Above 45 mph the proximity check skips work between fixes (2.5 s minimum gap
   instead of 1.2 s).
4. The GPS watch is torn down and restarted with cheaper options rather than
   left running at high accuracy.
5. Backgrounding the app (`visibilitychange`) stops all map redraws and marker
   work immediately.
6. Map marker redraws are throttled to once every 3 s and skipped entirely when
   the map screen isn't the visible screen.
7. Reports are bucketed into a 0.02° grid, so a proximity check looks at ~9
   cells instead of every report.
8. Alerts are heading-filtered before any audio, speech, or vibration fires.
9. Ten-minute per-report dedupe plus a 30-second global cooldown — no alert
   storms.
10. Below 20% battery (`navigator.getBattery`) the app drops into low-power mode
    on its own: coarse GPS, no map redraws.
11. The Wake Lock (screen stays on) is **opt-in**, off by default, and released
    the moment you background the app.
12. Route hazards are prefetched once when you start a ride, then the ride runs
    with zero further network requests.

All of it is visible and switchable in **Settings** (gear button on the map),
along with a live battery badge.

---

## What is stubbed, and why

Everything here needs a server the project doesn't have yet. Each one is a
clearly commented constant, not a fake.

| Stub | Where | What happens today | What it needs |
| --- | --- | --- | --- |
| Cross-rider report sync | `alerts.js` → `SYNC_ENDPOINT: null` | Reports are yours alone. They're written to an **outbox** in local storage exactly as they'd be POSTed, so the day an endpoint exists they flush without a data migration. | A server that accepts and geo-queries reports |
| Rider accounts / login | — | Not built | Auth + a database |
| Real database | `storage.js` | Everything is browser `localStorage` — per-device, cleared if you clear site data | A server-side DB |
| AI / LLM route suggestions | — | Not built. The Trip Library is hand-curated real routes, not generated | An LLM API and a key |
| Cross-rider matching | — | Not built | Accounts plus a server |
| Trip ratings and comments | `route.js` | Stored locally, so only you see them | The same server |

---

## Known limits

- **Everything is per-device.** Clear your browser data and your saved routes,
  reports, and favorites are gone. There is no cloud copy.
- **Overpass (the places database) is a free public service** and it does go
  down or rate-limit. Four mirrors are tried in order, then you get an error
  with a **Retry** button rather than a blank list. The fuel plan degrades to
  mileage-only rather than failing outright.
- **NWS covers the United States only.** Ride into Mexico and the weather
  section will come back empty.
- **FARS data is 2021–2023 fatal crashes only.** It is history, not a prediction
  about today, and it does not include non-fatal crashes. The card says so.
- **OSM hours are often missing or wrong.** "Hours not listed" means OSM has no
  data, not that the place is closed. Call before you count on it.
- **Sun glare, fog, and flooded-wash advisories are heuristics** computed from
  forecast numbers and solar geometry. They're a heads-up, not a forecast the
  NWS stands behind.
- **Reports are unmoderated and unverified** — one rider's tap, nothing more.
- **No offline maps.** Saved routes and their geometry work offline; the map
  tiles under them do not.

---

## Not yet verified

- **Real Overpass responses.** The sandbox this was built in cannot reach
  `overpass-api.de` (network-blocked), so the POI list, the 11 categories, the
  in-app POI sheet, the along-route corridor search, and the fuel-stop station
  lookup were all verified against a mock server returning real OSM-shaped
  payloads. The query syntax and endpoints were verified separately against the
  spec. **Please check the Add Stop list and a fuel plan on your phone first
  thing** — that's the one path that hasn't touched the live service.
- **Real device behavior for the battery measures.** The battery logic, GPS
  tiering, visibility handling, and wake lock are all written and wired, and the
  code paths were exercised in a desktop browser, but headless Chromium has no
  real battery, no real GPS radio, and no wake lock. Actual battery savings on
  your phone are unmeasured.
- **Voice callouts and vibration.** `speechSynthesis` and `navigator.vibrate`
  are called correctly but headless Chromium produces no audio or haptics.
- **iOS Safari specifically.** Tested in headless Chromium at 375 px and
  1280 px only.

Verified live against the real services: Nominatim geocoding and autocomplete,
OSRM routing with alternates (453 / 456 mi Tucson → Vegas), the NWS points and
hourly forecast endpoints, the NWS active-alerts endpoint (a real Flood Watch
came back), all 304 FARS hotspot clusters and the Arizona/Nevada detail files,
the route hazard scan (11 clusters), save-reload-load round trip, the report
flow, and heading-filtered proximity alerting.

---

## Files changed

New:

- `geo.js` — geodesy and formatting: distance, bearing, compass points, polyline
  decoding, cumulative mileage, point-at-mile, route sampling, nearest-point-on-
  path, bounding boxes, a fetch with timeout, a rate-limit queue, solar position,
  and wind chill.
- `poi.js` — Overpass client, the 11 categories, `opening_hours` parsing, open/
  closed badges, favorites and blocks, nearby and along-route search, the fuel
  station search with widening radius, map markers, list rendering, and the
  in-app POI card.
- `route.js` — geocoding with cache and autocomplete, OSRM routing with
  alternates, effective range and the fuel plan, map drawing, the whole planner
  UI, results, fuel strip, save/load, and the trip library.
- `weather.js` — NWS alerts and hourly forecast, ETA-aligned lookups, the
  potential-advisory rules, the ride score, and the weather strip.
- `hazards.js` — FARS hotspot layer, lazy per-state detail loading, hotspot and
  crash cards with plain-English translation, the route scan, and attribution.
- `alerts.js` — report types and TTLs, the report sheet, the sync outbox, the
  spatial index, corridor prefetch, proximity alerting, audio/speech/vibration,
  the settings panel, and all twelve battery measures.
- `data/routes_seed.json` — the 12 curated Southwest routes.

Modified:

- `index.html` — route bar, battery badge, Report FAB, side controls (Crashes /
  Settings / Me), alert banner, the whole Plan a Ride overlay with its three
  tabs, the Settings overlay, the POI sheet, the Report sheet, a toast, and the
  11 category chips with the near/route scope toggle.
- `app.js` — planner and alert wiring, the scope toggle, a rewritten `loadStops`
  that renders in-app instead of redirecting to Google Maps, the route bar
  summary, toasts, and ride start/stop hooks into the GPS and prefetch logic.
- `map.js` — tiered GPS options, watch restart, navigating mode, one-shot fixes,
  heading and speed tracking, redraw suppression when hidden or off-screen, and
  the hook that feeds positions to the alert engine.
- `storage.js` — new keys and accessors for routes, trip reviews, POI
  preferences, the geocode cache, the weather cache, hazard reports, the sync
  outbox, and ride settings.
- `styles.css` — one appended section for all the new UI, built entirely from
  the existing design tokens, plus a 640 px breakpoint. No token was changed and
  no existing rule was replaced.

Unchanged: `CNAME`, `README.md`, `data/moto_hotspots.json`, `data/pts_*.json`.
The crash data was already committed and was not regenerated.

---

## Data sources and attribution

- Routing: [OSRM](https://router.project-osrm.org/) on
  [OpenStreetMap](https://www.openstreetmap.org/copyright) data
- Geocoding: [Nominatim](https://nominatim.openstreetmap.org/)
- Places: [Overpass API](https://overpass-api.de/) on OpenStreetMap data
- Weather: [NOAA / National Weather Service](https://api.weather.gov/)
- Crash history: [NHTSA Fatality Analysis Reporting System (FARS), 2021–2023](https://www.nhtsa.gov/file-downloads?p=nhtsa/downloads/FARS/)
- Map tiles: OpenStreetMap contributors, via Leaflet

On the legality of noting police you actually saw in public, see the
[ACLU of Northern California](https://www.aclunorcal.org/news/waze-blog/), linked
inside the Report sheet.
