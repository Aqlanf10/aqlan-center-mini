# Invoice service addition: bounded implementation

Base: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f`. Draft only; no deployment.

The current correction command accepts existing item IDs. A new service is instead
one dated supplementary invoice, containing only the new service, linked to the
unchanged original by an immutable evidence row and exact acknowledgement. Existing
payments, signatures, visits, laboratory orders and historical commissions remain
on the original identities. New clinical work uses the existing invoice linkage
writer and starts planned; its consent and compatible-master restrictions remain.

Admin-only GET context and PUT preview precede POST with the exact same body. The
command has one active catalogue service, quantity one, original currency, explicit
price/discount, optional doctor/tooth/surfaces/scope/case/plan, reason, source hash and
idempotency key. Existing price authority and linkage preview/save rules are reused.
Original and current issue dates must be in an open accounting period. A source
snapshot includes settlement proof, account position, source visits and earlier
supplements. No source visit is reassigned to the additional invoice.

The writer owns the patient/shift/visit/plan/item/invoice locks, then calls the same
transaction-owned clinical invoice core and appends its receipt before commit. The
per-key advisory lock resolves replay before catalogue parsing; a different body or
actor cannot use that key. A committed stale-attempt rejection prevents a delayed
old request from writing after the client refreshes. Unknown replies retain their
body/key. Preview returns the writer's request hash for acknowledgement validation.

`migrations/proposals/invoice-service-additions.sql` is deliberately unnumbered.
It is not loaded by runtime schema initialization or migration manifests. The API
fails closed until this proposal is separately reviewed and adopted. 0073–0080
remain untouched. Tests apply this proposal only to the isolated synthetic database.

No approved-agreement delta, refund policy, patient-statement redesign, settlement
button or multiple-filling behavior is introduced. A consented/incompatible master
is refused by the existing clinical contract; no duplicate plan is manufactured.
