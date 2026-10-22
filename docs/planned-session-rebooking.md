# Explicit rebooking of an unfinished planned session

The patient summary offers **إعادة حجز** instead of Start when the server confirms a
scheduled/planned session is linked to a no-show or cancelled appointment, with no
arrival, visit, execution or completion evidence. `ended_at` alone is terminal
closure, not attendance evidence. Inconsistent patient/plan/session links, ambiguous
or missing inverse pointers, and an unavailable referral fail closed.

## API and transaction

`POST /api/planned-visits/:id/rebook` accepts only:

- `expectedAppointmentId`: the displayed terminal appointment ID.
- `expectedGeneration`: the server-projected reset-generation version, frozen with the attempt.
- `date`, `time`: future clinic-local `YYYY-MM-DD` and `HH:mm`.
- `reason`: 3–500 trimmed characters.
- `requestId`: stable random identity for this exact attempt.

Existing admin/reception/doctor permissions apply. The locked transaction rechecks
current account credentials, role, activity and patient access. Referrals additionally
use the canonical receiving-doctor/reception authority and the shared client-bound
referral validation/audit writer. No new permission is introduced.

Lock order is shared existing reset fence, destination day, all discovered old/referral appointments by ID,
planned visit, current authorization/clinical witnesses, service/provider, then
referral. Rebooking-only ownership witnesses and clinical plan/item/session reads use SHARE NOWAIT locks to fail closed
instead of deadlocking with a concurrent clinical signer. The canonical day writer,
capacity gate and appointment insert writer create the replacement. Only the live
planned-appointment pointers move. The original status, reason, timestamps, referral
identity and status log remain in patient history. No invoice, payment, plan, item,
session or visit is created or updated by rebooking.

The existing immutable `audit_log` stores action `planned_visit.rebook`, normalized
intent, actor user ID, both appointment IDs and snapshots, and original response.
The rebooking-only shared reset fence is acquired before the day lock or any transaction table read, preventing reset/foreign-key lock inversion without changing reset behavior or other booking writers.

The generation is the digest of the latest immutable `system.reset` ID and full-precision database timestamp (a version, not a secret). It is validated after row locks, which conflict with reset table locks, before replay or creation. Old saved or unsaved requests are rejected after reset, even when clinical IDs are reused. Reset audit failure rolls back both the wipe and generation.

Identity is scoped to `(planned visit, actor user ID, request ID)` and serialized by
the planned row lock. No migration or new counter is needed. Identical retries return
200 with the original replacement; first creation returns 201; changed payloads or
stale competing attempts return 409. Replay still checks current session and patient
read access, but does not repeat scheduling/referral writes or current capacity checks.
Audit or referral failure rolls the entire transaction back.

## UI recovery

The Arabic inline date/time form adds the required reason and a history-preservation
notice. A synchronous guard prevents double submissions. An uncertain network/500
reply retains the exact body and attempt ID, locks edits/cancellation, and offers
retry of the same request or full-file refresh. Patient/workflow ownership changes
cannot apply an old response to a different file. Current clinic timezone is sent by
the server and retained by the patient page.

## Verification

- Unit: `__tests__/planned-visit-rebooking-route.test.ts`,
  `planned-visit-rebooking-ui.test.tsx`, `planned-visit-projection.test.ts`, plus
  patient summary/owner/workflow/plan projection regression suites.
- PostgreSQL: `__tests__/postgres/planned-visit-rebooking.test.ts` and
  `planned-visit-rebooking-reset.test.ts`, plus existing
  absence, internal referral, arrival and reschedule suites. Synthetic financial and
  clinical fingerprints, concurrency barriers, session revocation/expiry, audit
  rollback, capacity, history, replay, reset-generation/ID reuse, and both
  reset/rebook lock interleavings are covered.
- Built HTTP/proxy: `__tests__/security-http/planned-visit-rebooking-http.test.ts`
  uses the existing isolated harness, including role and referral receiver checks.
- Hosted visual acceptance still requires the permitted hosted environment: RTL and
  narrow-screen layout, terminal status copy, reason validation, busy state,
  unknown-response same-request retry, and refreshed original-plus-new history.
  No local-browser execution is implied by the unit/HTTP evidence.

This is appointment recovery only, not automated reminders, WhatsApp follow-up,
a follow-up work queue, clinical execution, or financial correction.
