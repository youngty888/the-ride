# RIDE by SIC Cycles — Project Checklist

Last reconciled: 2026-09-29 against `main` at `e5d55b2` plus the current uncommitted rider-functionality worktree.

Status key: **Done** = present in current source and covered by current evidence; **Partial** = useful implementation exists but an owner/device/live-system check remains; **Planned** = not implemented in the current source; **Blocked** = requires an external system, credential, approval, or production change.

## Current checkpoint

- **Done** — One canonical GitHub source: `youngty888/the-ride`, branch `main`.
- **Done** — Static mobile-first rider app with authenticated access, map, routing, nearby stops, weather, hazards, ride tracking, Garage, Profile, packs, feed, events, and SIC Cycles Shop/quote path.
- **Done** — Profile and Garage account snapshots with rider isolation, conflict protection, retry queue, and explicit import of legacy local data.
- **Done in source** — Ride history, saved routes, and Stop Preferences account sync, including offline queues, conflict handling, deletion handling, and rider isolation.
- **Done** — Arrival/end-of-ride prompts, GPS-jitter filtering, persistent sign-in, place-type search, and one shared cloud-status banner.
- **Done locally** — Automated suite: 154 passing tests covering nearby-first brand search, automatic current-location origins, motorcycle-linked mileage, active turn guidance, duplicate suppression, and the nine prior walkthrough issues. The public release still corresponds to the earlier 145-test checkpoint.
- **Done in source** — The nine recorded walkthrough issues are corrected locally: signed-out controls, dismissible cloud review prompt, pack counts, leaderboard order, event dates, ride-history separators, sample-post labels, hazard confirmation, and visible overlay close controls.
- **Done locally, not deployed** — Brand/business searches such as “Circle K” are bounded around the rider, filtered to 25 miles, sorted closest-first, and de-duplicated. A visible Tucson simulation returned nearby stores from 3.2 miles outward instead of worldwide matches.
- **Done locally, not deployed** — An active ride now shows the next maneuver and remaining distance, speaks approaching turns, warns when off-route, requests a screen wake lock, and restarts GPS when the page returns to the foreground.
- **Done locally, not deployed** — Route planning automatically starts from the latest GPS location. A verified motorcycle Bluetooth or native RIDE-screen connection automatically starts mileage tracking, assigns movement to the selected Garage motorcycle, checkpoints its odometer, and stops the automatic ride on disconnect.
- **Hardware verification required** — Browser Bluetooth supports BLE/GATT devices only and requires a rider tap. The exact motorcycle/display model and its advertised Bluetooth service still need device testing; ordinary Classic Bluetooth audio pairing is not visible to the website.
- **Blocked for the current web build** — Reliable iPhone tracking while the screen is locked or RIDE is backgrounded requires a native iOS app with background-location capability. The web build can only guide while it remains visible and awake.
- **Partial** — Cloud migrations for rides, routes, and preferences are included in `sql/`; current production application of those migrations was not re-verified during this reconciliation.
- **Done** — Release `5df20dd` is public at `ride.siccycles.com`; the production HTML, desktop/mobile rendering, app shell, console health, account-navigation interaction, and cloud-reminder dismissal were verified on 2026-09-29.

## Ordered build checklist

### 1. Protect the current release

- [x] Recover and preserve the authoritative GitHub repository.
- [x] Keep source files and tests in one repository with no framework build step.
- [x] Add a complete automated test command (`npm test`).
- [x] Add safe cache-version stamping (`npm run bump`).
- [x] Correct the nine reproducible issues recorded in the 2026-09-29 live walkthrough and add regression checks.
- [x] Confirm the live site is serving documented successor `5df20dd`.
- [ ] Confirm the production Supabase schema contains `rider_rides`, `rider_routes`, and `rider_prefs` with owner-only RLS.

### 2. Finish real-owner cloud verification

- [x] Verify Profile/Garage schema and isolation with temporary riders.
- [x] Verify Profile/Garage restore in browser QA with empty local storage.
- [ ] Tyler reviews the correct Profile and Garage records and selects **Save reviewed data online**.
- [ ] Restore Tyler's data on a second real device and confirm the records match.
- [ ] Complete one real-account, two-device check for ride history, saved routes, and Stop Preferences.
- [ ] Verify offline edits retry successfully on a real phone after connectivity returns.

### 3. Field-test rider-critical behavior

- [x] Correct brand/business search to use rider location, sort nearest-first, and remove duplicate place results in the local build.
- [x] Add active-ride next-turn display, spoken turn warnings, off-route warning, and automatic wake-lock request in the local build.
- [x] Default every newly built route to the rider's latest current location.
- [x] Connect accepted GPS movement to the selected motorcycle odometer and add Bluetooth/native-screen automatic start-stop hooks.
- [ ] Test Add Stop and fuel planning against live Overpass results on a phone.
- [ ] Test ride distance, parked GPS jitter, arrival prompts, and return-to-start prompts on a real ride.
- [ ] Test voice callouts, vibration, wake lock, battery behavior, and background/foreground recovery on Android.
- [ ] Pair the actual motorcycle and RIDE screen, record their Bluetooth names/service UUIDs, and verify automatic start, live mileage, disconnect stop, and reconnect behavior.
- [ ] Test foreground guidance on iPhone/Safari; do not count locked-screen/background operation as supported by the web build.
- [ ] Build and device-test a native iPhone version with background location before claiming iPhone ride navigation works with the phone locked.
- [ ] Record failures with phone model, OS, browser, route, time, and screenshots before changing thresholds.

### 4. Complete shared rider features

- [ ] Build moderated cross-rider hazard/report sync; the current report outbox has no server endpoint.
- [ ] Add report abuse controls, expiry enforcement, moderation, and rider-visible verification state.
- [ ] Move Packs and invitations from browser-local records to owner/member-scoped cloud tables.
- [ ] Replace local-only feed likes/comments with authenticated cloud records and privacy controls.
- [ ] Add shared event submission/review instead of treating static/local calendar data as a complete network feature.
- [ ] Add trip ratings/comments to cloud storage with ownership and moderation rules.

### 5. Harden reliability and recovery

- [ ] Add an owner-readable export for cloud and browser-local rider data.
- [ ] Define backup, restore, retention, and deletion procedures for production rider data.
- [ ] Add production error monitoring without collecting unnecessary location or personal data.
- [ ] Add a privacy policy, terms, safety disclaimer, and account/data-deletion path.
- [ ] Verify accessibility: keyboard operation, labels, focus order, contrast, large text, and motion settings.

### 6. Validate the SIC Cycles revenue path

- [x] Keep RIDE free and connect Shop requests to SIC Cycles installation/fitment service.
- [x] Provide Garage-assisted fitment context, installed-quote email, and one-tap calling.
- [ ] Confirm quote emails arrive with enough bike/part context to act on.
- [ ] Track quote starts, completed inquiries, booked installs, and completed sales without exposing private service data.
- [ ] Add affiliate or sponsor placements only after disclosure, attribution, and measurable rider value are defined.
- [ ] Keep labor, margins, work orders, staff notes, payments, signatures, and customer records out of the public rider app.

### 7. Release gate

- [ ] All production migrations verified and reversible.
- [ ] Real-owner two-device cloud verification passed.
- [ ] Android and iPhone ride tests passed for the critical path.
- [ ] No unresolved high-severity privacy, authentication, data-loss, or ride-safety defects.
- [x] Live deployment commit `5df20dd` recorded and public smoke test passed on 2026-09-29.
- [ ] Tyler gives final approval before any public launch claim, paid promotion, outside contact, or sensitive publication.

## Next implementation target

The next priority is **prove the rider-critical loop before adding more community features**: deploy the nearby-search and active-guidance corrections after Tyler approves them, run a real Android ride and a foreground iPhone ride, and record every failure. Reliable iPhone locked-screen/background navigation is then a native-app workstream; moderated cross-rider hazard/report sync remains queued until the core ride experience is proven useful.
