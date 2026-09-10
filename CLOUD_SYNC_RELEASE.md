# Profile and Garage cloud saving — release checkpoint

Prepared 2026-09-09. LOCAL ONLY: not applied to production or deployed.

## Implementation
- Complete Profile and Garage snapshots stored in a new rider-owned rider_app_state table.
- Uses the existing Supabase public browser key and signed-in rider token; no administrative key.
- Snapshot storage preserves existing field names, legacy bike IDs, photos, emergency contacts, specifications and embedded service notes without a lossy normalized-table conversion.
- Existing normalized rider tables remain unchanged and are not synchronized by this release. rider_app_state is the source for this Profile/Garage client.
- Atomic revision-checked writes; stale devices must choose which copy to retain. The replaced copy is kept locally under the account-scoped rideflow_cloud_conflict_backup key.
- Account-scoped durable outbox retries on edits, reconnect, focus or manual Retry.
- Existing local records require the rider to review and explicitly import them. New accounts start empty; App no longer calls seedDemoData.
- Session refresh is supported and initialization waits for verified authentication.
- Cloud confirmation is limited to Profile and Garage. Rides, quote drafts and other features remain browser-local.
- Full offline reload still requires online authentication; this change supports queued edits after a page has loaded. Unsynced data can still be lost if browser storage is cleared.
- Snapshot limit: 8 MiB. Oversized photos cause a visible save error, never a false cloud confirmation.
- This does not add management access or a backup service.

## Verification
- node --test tests/cloud-sync.test.cjs tests/auth-guard.test.cjs: 9 passed.
- PostgreSQL/PGlite migration tests: initial save/update, duplicate and stale revision rejection, cross-rider read/update/insert denial, anonymous table/RPC denial, invalid payload rejection passed.
- Browser QA with a fake local API: Profile save, motorcycle save, cloud confirmation, restore from separate localhost origin with empty browser storage passed.
- Desktop and 390x844 viewport checked. No relevant browser errors; one unrelated GPS timeout.
- Production API/schema and actual multi-device save remain unverified until deployment.

## Exact next steps
1. Reopen Hostinger Web console for VPS 1947716. Old terminal is disconnected and now returns 403.
2. Read-only verify live schema does not already contain an incompatible rider_app_state table or save_rider_app_state function. Verify ownership policies and server health.
3. Follow project live-change approval gate; preserve database backup before applying supabase/migrations/002_profile_garage_sync.sql.
4. Apply migration, verify policies and API schema reload. Run fake-rider integration test without uploading real user data.
5. Publish this tested checkout through the existing GitHub Pages flow, verify deployment.
6. Have Tyler review existing Profile/Garage, select Save reviewed data online, and verify restore on a second device.

Rollback frontend through Git to its previous release. Preserve rider_app_state and cloud records; do not drop the table to roll back the UI.
