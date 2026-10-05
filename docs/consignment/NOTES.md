# Consignment module — scoping notes (not started)

Captured from Tyler, not yet designed or built. Consignment is still
unscoped overall — this is just what's been said so far.

- Customers can submit a part or motorcycle for consignment via a request
  intake form, reached from their siccycles.com profile (rider-facing, not
  staff-facing — this is the customer-submission side; staff then review it
  in the Consignment section of the staff admin app).
- Staff side: same unified staff app as Warehouse/Shop, flat admin for
  Tyler/Garrett/Fang (see docs/shop/PHASE0.md for the shared permission
  decision).

Open questions for when this gets scoped: what fields the intake form
collects, how a submission becomes a staff-reviewable record, approval/
rejection flow, how it connects to the siccycles.com customer profile/auth
system.
