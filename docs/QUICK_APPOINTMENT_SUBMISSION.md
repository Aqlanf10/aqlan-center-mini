# Quick appointment submission integrity

## Verified defect

Audited against the source tree shared by local `7a7012f` and remote main
`060ecca529adae8c2f96d945c6fd79823902aa7d` on 2026-10-02 UTC.

`QuickAppointmentModal` creates a new patient before it creates their appointment.
Previously it set `busy` only after the patient request completed. A slow patient
request therefore left confirmation and dismissal enabled; another submission
started another patient creation. State alone also did not prevent two submit
handlers from the same render from starting two existing-patient bookings.

The component-handler regression, run before editing the component, reproduced
three patient POSTs from three submissions while the first response was held,
and two appointment POSTs for an existing patient submitted twice in one render.
These are synthetic request-count reproductions, not a claim of historical or
Production duplicate records.

## Bounded correction

- A synchronous ref claims the complete booking before its first asynchronous
  request; later submissions return immediately
- `busy` now includes patient creation and appointment creation, so the existing
  confirmation, cancel, close and native-dialog Escape guards cover both stages
- One outer `finally` releases the ref and busy state on every failure/success
- If patient creation succeeds but booking fails, the existing selected-patient
  and new-patient flags remain intact, so retry does not create another patient
- Existing request payloads, backend validations, capacity/override decisions,
  waiting-list behavior, schema and financial services remain unchanged

This is an in-flight UI guard. It does not supply server-side idempotency or
resolve an ambiguous network failure after the server may already have committed.
It does not merge or remove existing patients or appointments.

Pre-existing limitation: patient and booking-detail fields remain editable while
a request is pending, although the submitted operation retains its original
captured payload. A regression verifies that editing the visible name/date/time/
note during patient creation cannot retarget or change that request. Freezing
editable controls and addressing the resulting draft/display divergence remain
separate follow-up work; this change does not claim those stale-field issues are
solved.

## Verification and release boundary

- `__tests__/quick-appointment-submission.test.ts`: 10/10 passed after the fix;
  in the initial before-fix run the two repetition regressions failed and seven
  recovery tests passed. The tests call the component's rendered handlers with a small hook
  harness; they do not claim a DOM/browser pass
- Related appointment, availability, service, schedule and waiting-list unit
  checks: 185/185 passed across eight files, including the ten new cases
- Focused ESLint and TypeScript (component and both new test files with their
  imported dependencies) passed; `git diff --check` passed
- `__tests__/security-http/quick-appointment-submission-ui.test.ts`: five built-app
  browser cases added for CI, with synthetic intercepted patient/appointment
  writes only. Covers desktop/390px, pending Escape/close, same-turn repeat,
  success/reopen/cancel, create rejection and booking conflict/retry
- Browser execution was not retried locally because the executor's browser socket
  restriction is already established. Full repository typecheck was killed
  twice without a TypeScript diagnostic; no full typecheck/build/browser pass is
  claimed. Exact-head CI, review, merge and Railway release verification remain
  pending

No Production patient, appointment, financial or schema data was written.
