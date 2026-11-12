# Current clinical responsibility → return appointments (local combined candidate)

## Approved policy

All specialty returns belong to the **current responsible clinician for the exact
case/work**, not the receptionist, logged-in administrator, first roster doctor,
or the doctor historically attributed to an invoice/item. Booking staff cannot
substitute a different doctor for one appointment. Missing/inactive responsibility
requires administrative setup; ambiguous clinical work requires exact source choice.

Existing date/time rescheduling preserves the stored clinician. Clinician transfer
is a separate explicit action with a fresh current-context preview and the full
capacity/availability/overlap checks. Settings never rewrite existing appointments. The final reschedule SQL also
compares the previously observed doctor (including null), so a stale time-only
move cannot undo a concurrent same-slot explicit doctor transfer.

## Existing model, no migration

- `clinical_cases.responsible_party_id` is current non-Ortho responsibility.
- `ortho_cases.responsible_doctor_id` is canonical Ortho responsibility. Only when
  null may a unique same-patient orthodontic bridge's explicit current owner apply.
- Billed item, invoice, visit, commission, and plan attribution is not repurposed.
- The shared resolver verifies adjustment/visit/planned/item/lab provenance and
  same-patient relationships. Linked source disambiguation retains and validates
  its origin; an unrelated case cannot replace it.
- Current source rows are locked with NOWAIT and reread before admission. Fresh
  fingerprints include the scoped durable responsibility audit-event ID, so even
  A→B→A invalidates an old preview/settings command. No timestamp-only freshness,
  whole-table locking, or backfill.

## Administrative responsibility settings

An authenticated, currently active **admin** can establish/reassign current case
responsibility with expected-source fingerprint, active incoming doctor and reason.
Authority is revalidated in the same transaction; source changes and audit commit
atomically. Canonical Ortho and its unique valid bridge are updated together.
Malformed, foreign, multiple, or nonorthodontic bridges fail closed, not normalized.

Initial assignment was audited before adding access witnesses: creation/baseline
now require real authenticated context for a nonnull responsibility. A doctor may
initially assign only their own verified active party, with preexisting patient
access checked before insertion. No actor-string or test-only bypass exists.
Financial correction's separate current-admin authority remains unchanged, but
financial provider/service/tooth corrections never assign or overwrite current
clinical responsibility. A newly created canonical Ortho case cannot bridge an
already-owned shell with a different owner; the whole baseline write rolls back.

Current active-case responsibility is now a positive patient-access witness in
single, batch, and search paths; existing historical access witnesses are retained.
A stale Ortho bridge cannot grant access against a nonnull canonical owner. The
null-canonical bridge witness locks both rows during composed authorization.

## Entry paths

- Direct appointment creation / Quick booking and saved Ortho adjustment invite.
- Exact lab-work return booking.
- Visit next-session booking, including walk-in patient resolution.
- Planned scheduling and replacement rebooking.
- Waiting-list conversion and staff approval of follow-up booking requests.
- Explicit existing-appointment clinician transfer.

A return with no catalogue service still consumes its assigned clinician for
availability/capacity. Explicit service concurrency policy remains unchanged.
The nearby-patient D/D+1/D+2 confirmation checkpoint is preserved, including hard
patient-overlap refusal and fresh actor/proposal/snapshot-bound acknowledgement.

## Verification boundaries

Tests cover persisted clinician/name and authenticated `/api/appointments/mine`,
admin reassignment A→B while historical item/invoice/appointment A stays unchanged,
patient access before new booking, blocked/stale/missing/ambiguous sources,
initial assignment authority, and real PostgreSQL lock/concurrency behavior.

The owner-requested combined upload is not performed here. No migration, install,
full build, messaging send, or production operation is part of this local work.
The genuine browser visual gate remains outstanding: the known Chromium Unix IPC
denial is not bypassed, and DOM/handler tests are not claimed as browser acceptance.

## Focused evidence (synthetic local data)

- Relevant UI/API/resolver/nearby suites: **411/411**, 25 files,
  `/tmp/return-combined-final-unit.log`.
- Audit coverage and HTTP permissions inventory: **34/34**,
  `/tmp/return-root-route-inventory.log`.
- Current-responsibility real PostgreSQL suite: **22/22**, including both audited
  ABA and observed two-client transfer/time-move races; toggling only these two
  safeguards produced **2 failures**, then byte-exact restoration produced **2 passes**:
  `/tmp/return-aba-cas-{mutated-red,restored-green,mutation-proof}.log`.
- Financial amendment regression failed before the fix: current owner B became A.
  `/tmp/invoice-owner-clobber-red.log`.
- An actual hosted browser journey is authored in
  `__tests__/security-http/return-booking-responsibility-browser.test.ts`: admin
  saves Ortho adjustment, opens suggested return, sees responsible doctor,
  cancels nearby warning with draft retained, explicitly confirms one extra
  appointment, and verifies the doctor's personal schedule. **Not run locally**.
- Final broad PostgreSQL, lint and full typecheck results are recorded in the
  handoff; no empty/in-progress log is counted as a pass. A 2048 MiB typecheck
  exhausted the heap and is not a pass.

### Final local aggregate

- Broad real PostgreSQL: **285/285 across 18 files** (204 + 81), including every
  initial-assignment caller suite, invoice revision, referral lock races, Ortho
  lifecycle, return ownership, and nearby warning. Logs
  `/tmp/return-final-broad-pg.log`, `/tmp/return-final-callers-extra-pg.log`.
- Additional Ortho unit/route/integrity suites: **156/156 across 6 files**,
  `/tmp/return-final-ortho-unit.log`.
- Full project TypeScript: **exit 0** at 3072 MiB, serialized by common lock,
  `/tmp/return-responsibility-final-types-green.log`. No files/checks skipped.
- Bridge bypass regression: before **1 failed / 18 passed**, after **19/19**,
  `/tmp/ortho-bridge-owner-{red,green}.log`.
- Browser test is included automatically by the existing hosted security-HTTP
  glob and CI Chromium installation; execution remains a hosted gate.
- Final scoped ESLint: **exit 0**, 72 TypeScript/TSX files, 0 errors and 13
  existing/lifecycle warnings; the fully mocked test-hook harness uses an actual rendered component without
  hooks-rule suppression. Its **8/8 tests** reran successfully.
  `/tmp/return-final-scoped-lint-complete.log`.
- Final rendered hook harness (no suppression): **8/8**, scoped ESLint exit 0,
  then full project typecheck exit 0; `/tmp/return-final-rendered-hook.log`.
