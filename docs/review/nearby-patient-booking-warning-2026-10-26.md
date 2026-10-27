# Nearby patient booking warning — local review

## Owner-approved behavior

For a proposed clinic date D, warn about this patient's active (`booked`, `arrived`)
appointments on D, D+1, D+2. These are calendar dates in the clinic's existing date
representation, not 48 elapsed hours, not a symmetric window, and not a ban on
intentional additional visits. Completed/cancelled/no-show appointments and the
appointment being rescheduled do not trigger this warning. Existing hard patient
overlap and capacity/doctor/clinical admission checks remain authoritative.

Authenticated booking UI shows prior date, time and doctor and offers cancellation
or explicit confirmation. Rejection/cancellation preserves the draft. Anonymous
booking requests do not invoke or receive this warning. Patient authorization is
checked before returning appointment details, including direct appointment creation.

## Integrity design

- All guarded day writers acquire sorted D..D+2 advisory day locks before reading;
  rescheduling also locks its source day. Adjacent-date writers therefore serialize.
- The server re-reads active appointments in the same transaction as insertion or
  movement, after the existing hard admission guards.
- A ten-minute HMAC token contains only a proposal/snapshot hash and expiry, not
  appointment details. It binds authenticated actor, patient, entry/resource,
  submitted proposal, and current appointment snapshot. A changed/expired/tampered
  token yields a fresh warning. No role escalation is granted by confirmation.
- The client retains the exact rejected request only in memory and retries once
  after explicit confirmation, never automatically confirming a second warning.
- Concurrent confirmations cannot create duplicate appointments: the next writer
  sees the committed appointment (and hard overlap refuses an identical slot).
- No migration, messaging/WhatsApp action, production data operation, or AI/Dot
  feature is included.

## Local verification

New real PostgreSQL tests cover directional date bounds, month/year/leap boundaries,
active lifecycle, self exclusion, changed actor/patient/proposal/snapshot, preserved
rejected reschedules, explicit confirmation and concurrent duplicate confirmation.
A held PostgreSQL insertion trigger proves a D proposal waits for the competing
D+2 writer and sees its committed appointment, rather than relying on scheduling
luck in `Promise.all`.

Baseline: the new real PostgreSQL suite failed 8 cases before implementation;
new route tests failed 4 cases; transport tests failed 2 behavior assertions.

Browser visual acceptance remains a distinct gate: the current local Chromium
Unix IPC denial must not be bypassed. DOM/transport tests are not visual browser
acceptance. No publication or deployment is part of this local implementation.

Passing local runs (Node 22.23.3, 3072MB heap, shared heavy-test lock):
- Core/API/unit regression: 275/275 tests across 16 files.
- UI/transport regression: 171/171 tests across 8 files.
- New PostgreSQL warning/concurrency: 18/18.
- PostgreSQL lifecycle/doctor/reschedule regression: 58/58.
- PostgreSQL planned/waiting-list/capacity/service regression: 78/78.
- Two old concurrency fixtures now use dates more than two days apart to retain
  their independent service/auth lock-order tests; assertions were not weakened.

The patient/date/time index already exists (`appointments_patient_history_idx`),
so this bounded patient query needs no migration. Route-handler API tests and
DOM tests are explicitly distinct from real HTTP/browser acceptance.

Walk-in next-session bookings resolve and lock the actual phone-matched patient
inside the same transaction before authorization and warning. Rejection rolls
back any provisional file/link; real PostgreSQL proves no duplicate patient or
appointment. Ownership witness locks use NOWAIT with safe retry on contention.
