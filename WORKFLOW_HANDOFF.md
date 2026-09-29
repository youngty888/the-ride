# RIDE by SIC Cycles — Command Hub Handoff

Updated: 2026-09-29

## Current verified checkpoint

- Authoritative working repository: `C:\Users\young\OneDrive\Documents\ChatGPT\Ride\the-ride`
- Branch: `main`
- Saved local commit: `8a3e127` — `Improve live ride tracking and nearby search`
- Working tree was clean immediately after that save.
- Automated verification: 154 tests passed.
- Public site: `https://ride.siccycles.com/`
- The new rider-functionality commit has **not** been pushed or deployed. The public site remains on the earlier verified release.

## What changed in the saved local build

1. Business searches such as Circle K are centered on the rider, limited to the local area, sorted closest-first, and de-duplicated.
2. Active rides show the next maneuver and remaining mileage, speak approaching turns, warn when off-route, request a wake lock, and recover GPS when the page returns to the foreground.
3. Route planning automatically uses the latest GPS location as the starting point.
4. Every accepted movement of the GPS dot increases ride mileage while rejecting parked GPS wobble, bad fixes, and impossible jumps.
5. Ride mileage is assigned to the selected Garage motorcycle and checkpoints its odometer during the ride.
6. A verified Bluetooth Low Energy motorcycle connection or native RIDE-screen connection automatically starts tracking; disconnecting stops and saves the automatic ride.
7. Ride Settings now includes motorcycle/screen connection controls and a visible connected-bike indicator.

## Verified browser evidence

- Local app loaded at `http://127.0.0.1:8765/` in the Codex in-app browser.
- Phone-sized QA used a 390 x 844 viewport.
- A simulated Tucson GPS fix showed `Current location` automatically in the route planner.
- A temporary, non-persistent motorcycle-screen simulation produced `Auto Tracking`, recorded approximately 0.5 miles, and updated a temporary motorcycle odometer from 1000.0 to 1000.5 miles.
- No real account records were changed by that simulation.
- Console warnings were limited to expected test-browser GPS-permission denial.

## Known limitations and blockers

- The actual motorcycle and RIDE screen have not been paired or road-tested.
- Hardware verification needs the screen model, the Bluetooth name shown by the device, and—if it uses BLE—the advertised service UUID.
- Browser Bluetooth supports Bluetooth Low Energy/GATT devices and requires a rider tap. A website cannot inspect an ordinary Bluetooth Classic audio pairing.
- Safari on iPhone does not provide the required Web Bluetooth support, and reliable locked-screen/background GPS still requires a native iPhone application with background-location capability.

## Next authorized work

Do not deploy, push, publish, spend money, contact outsiders, or change production without Tyler's approval.

When Tyler resumes:

1. Identify the motorcycle screen model and its Bluetooth details.
2. Pair and test automatic start, live mileage, disconnect stop, and reconnect on the real screen/motorcycle.
3. Run one real Android ride and one foreground iPhone ride.
4. Record reproducible failures before changing thresholds.
5. After Tyler approves the verified build, push/deploy it and confirm the public site serves the new release.

The authoritative detailed status remains in `PROJECT_CHECKLIST.md`.
