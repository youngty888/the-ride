# RIDE by SIC Cycles

An intuitive social network built for motorcycle riders. Connect with riders, plan group rides, discover events, share routes, and build your riding community.

## Features

- **Interactive Map** — GPS tracking with dark theme (Leaflet + OpenStreetMap)
- **Add Stop** — Find gas, food, mechanics, restrooms nearby
- **Emergency Mode** — One-tap SOS, share location, notify your pack
- **Garage** — Bike profiles with specs, service records, and mileage-based reminders
- **Ride History** — Track miles, routes, and bike usage
- **Pack Management** — Create packs, invite riders, set gas stop intervals
- **Road Captain Mode** — See rider levels, miles, and emergency contacts
- **Pack Rating System** — Rate riders on safety, formation, comms, and more
- **Social Feed** — Post your bike, pack, and ride photos with likes and comments
- **Event Calendar** — Motorcycle rallies, charity rides, and local bike nights
- **Profile** — Picture upload and riding stats
- **SIC Cycles Shop** — Garage-assisted fitment requests, installed-quote email, and one-tap calling
- **Authenticated rider access** — Public signup and private invitation flows with account-isolated browser data
- **Leaderboards** — Local, regional, and national mileage rankings

## Run It

1. Keep all files and the `data/` directory together.
2. Serve the folder from a static web host or local HTTP server.
3. Configure the public Supabase URL and anonymous browser key in `supabase-config.js` for authenticated use.

Opening `index.html` directly may provide only a partial preview. Authentication and Profile/Garage cloud saving require the configured Supabase service; routing, maps, weather, geocoding, and place discovery also depend on their public network services.

## Tech Stack

- Vanilla HTML/CSS/JS (no framework)
- Leaflet.js for maps (free, no API key)
- OpenStreetMap tiles with dark CSS filter
- Overpass API for place search
- Supabase Auth for rider accounts
- Supabase rider-owned snapshots for Profile and Garage cloud saving

## Data boundaries

- Profile and Garage save to an authenticated, rider-owned cloud snapshot with an account-scoped retry queue.
- Loading the account copy refuses to overwrite edits made on the device while the download is pending.
- Rides, packs, quote drafts, route preferences, reports, and several other features remain browser-local.
- Browser-local information can be lost if site data is cleared. GitHub source control is not a rider-data backup.

## License

MIT

## Data sources

- Routing: OSRM (https://router.project-osrm.org/) on OpenStreetMap data
- Geocoding: Nominatim (https://nominatim.openstreetmap.org/)
- Places: Overpass API (https://overpass-api.de/) on OpenStreetMap data
- Weather: NOAA / National Weather Service (https://api.weather.gov/)
- Motorcycle crash history: NHTSA Fatality Analysis Reporting System (FARS),
  2021-2023, motorcycle-involved crashes only
  (https://www.nhtsa.gov/file-downloads?p=nhtsa/downloads/FARS/)
- Map tiles: (c) OpenStreetMap contributors
