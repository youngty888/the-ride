# The Ride by SIC Cycles

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
- **Invitation-only access** — Authenticated owner pilot with account-isolated browser data
- **Leaderboards** — Local, regional, and national mileage rankings

## Run It

1. Download all files to the same folder
2. Open `index.html` in any browser
3. That's it. No server required.

## Tech Stack

- Vanilla HTML/CSS/JS (no framework)
- Leaflet.js for maps (free, no API key)
- OpenStreetMap tiles with dark CSS filter
- Overpass API for place search

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
