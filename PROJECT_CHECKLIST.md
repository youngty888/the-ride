# RIDE by SIC Cycles — Project Checklist

Last reconciled: 2026-09-29 against `main` at `115c36e`.

Status key: **Done** = present in current source and covered by current evidence; **Partial** = useful implementation exists but an owner/device/live-system check remains; **Planned** = not implemented in the current source; **Blocked** = requires an external system, credential, approval, or production change.

## Current checkpoint

- **Done** — One canonical GitHub source: `youngty888/the-ride`, branch `main`.
- **Done** — Static mobile-first rider app with authenticated access, map, routing, nearby stops, weather, hazards, ride tracking, Garage, Profile, packs, feed, events, and SIC Cycles Shop/quote path.
- **Done** — Profile and Garage account snapshots with rider isolation, conflict protection, retry queue, and explicit import of legacy local data.
- **Done in source** — Ride history, saved routes, and Stop Preferences account sync, including offline queues, conflict handling, deletion handling, and rider isolation.
- **Done** — Arrival/end-of-ride prompts, GPS-jitter filtering, persistent sign-in, place-type search, and one shared cloud-status banner.
- **Done** — Automated suite: 145 passing tests on 2026-09-29, including regression checks for all nine issues recorded during the live walkthrough.
- **Done in source** — The nine recorded walkthrough issues are corrected locally: signed-out controls, dismissible cloud review prompt, pack counts, leaderboard order, event dates, ride-history separators, sample-post labels, hazard confirmation, and visible overlay close controls.
- **Partial** — Cloud migrations for rides, routes, and preferences are included in `sql/`; current production application of those migrations was not re-verified during this reconciliation.
- **Partial** — Public deployment exists at `ride.siccycles.com`; the nine corrections are approved for release, but the deployed commit and live smoke test must be recorded before this item is marked done.

## Ordered build checklist

### 1. Protect the current release

- [x] Recover and preserve the authoritative GitHub repository.
- [x] Keep source files and tests in one repository with no framework build step.
- [x] Add a complete automated test command (`npm test`).
- [x] Add safe cache-version stamping (`npm run bump`).
- [x] Correct the nine reproducible issues recorded in the 2026-09-29 live walkthrough and add regression checks.
- [ ] Confirm the live site is serving commit `115c36e` or a documented successor.
- [ ] Confirm the production Supabase schema contains `rider_rides`, `rider_routes`, and `rider_prefs` with owner-only RLS.

### 2. Finish real-owner cloud verification

- [x] Verify Profile/Garage schema and isolation with temporary riders.
- [x] Verify Profile/Garage restore in browser QA with empty local storage.
- [ ] Tyler reviews the correct Profile and Garage records and selects **Save reviewed data online**.
- [ ] Restore Tyler's data on a second real device and confirm the records match.
- [ ] Complete one real-account, two-device check for ride history, saved routes, and Stop Preferences.
- [ ] Verify offline edits retry successfully on a real phone after connectivity returns.

### 3. Field-test rider-critical behavior

- [ ] Test Add Stop and fuel planning against live Overpass results on a phone.
- [ ] Test ride distance, parked GPS jitter, arrival prompts, and return-to-start prompts on a real ride.
- [ ] Test voice callouts, vibration, wake lock, battery behavior, and background/foreground recovery on Android.
- [ ] Test the same critical path on iPhone/Safari.
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
- [ ] Live deployment commit recorded and public smoke test passed.
- [ ] Tyler gives final approval before any public launch claim, paid promotion, outside contact, or sensitive publication.

## Next implementation target

The next code feature should be **moderated cross-rider hazard/report sync**. The current app already creates a durable local outbox in `alerts.js`, but `SYNC_ENDPOINT` is intentionally unset. Before production deployment, define the server contract, owner/location privacy rules, report expiration, rate limiting, abuse handling, and moderation workflow; then implement and independently test the endpoint and client flush path.
