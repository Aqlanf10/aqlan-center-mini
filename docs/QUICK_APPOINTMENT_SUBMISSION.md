# Quick appointment submission integrity

## Released request guard: PR #181

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

- A synchronous ref claims the complete booking before its first asynchronous
  request; later submissions return immediately
- `busy` includes patient creation and appointment creation, so confirmation,
  cancel, close and native-dialog Escape guards cover both stages
- One outer `finally` releases the ref and busy state on every failure/success
- If patient creation succeeds but booking fails, the existing selected-patient
  and new-patient flags remain intact, so retry does not create another patient

PR #181 merged as `c556a6efa1fdd1dc40b0393647f9da1ed41b38c5`.
[Exact-head CI](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/36997709956)
passed 3,036 unit, 757 PostgreSQL and 542 HTTP tests, including its five synthetic
browser cases. Railway Production deployment
`40ad4b7a-7568-45c9-81f5-83e175abd80d` reached SUCCESS at 11:17:06 UTC on
2026-10-02; the post-release health request returned HTTP 200/ready:true.
This release verified the duplicate-submission guard only. Editable draft fields
were explicitly retained as separate follow-up work.

## Bounded follow-up: freeze the pending draft

The follow-up starts from the exact tree shared by released main `c556a6e` and
local `6c3bddc`: `3b91d2c856b7b719eaf42095a30a7334897b29c5`.

While the captured request remained unchanged, the previous UI allowed the visible
patient name, date, time, note and other booking fields to change during the wait.
The screen could therefore display a draft different from the request being saved.
The original unit regression established payload capture, not disabled controls.

The modal's content container is now a native `fieldset` disabled by the same
full-operation `busy` state. Native disabling covers keyboard and pointer input
and exposes disabled semantics to assistive technology. The existing labelled
modal and `aria-busy` indication remain in place. `min-w-0` avoids the fieldset's
intrinsic minimum width expanding the mobile dialog.

The reviewed control surface includes:

- New-patient name/phone, search-result buttons and the change-patient button
- Fallback appointment-type buttons and catalog-service buttons
- Date/time, duration, doctor, doctor-slot buttons, chair and visit notes
- Conflict override reason and waiting-list controls outside the booking form,
  including already-open day/shift/same-day preferences and save/back buttons
- Confirmation and both close/cancel buttons; native dialog dismissal keeps its
  existing guard

All current interactive descendants are native form controls. There are no links,
custom role buttons, portalled menus or controls inside a `legend` that would
escape fieldset disabling. Tests explicitly check this boundary. Existing
unavailable-slot/no-chair disabling still applies when the form is idle. Failures
release the group without discarding the entered draft; success keeps the existing
reset/close behavior. No fetch handler or request payload was changed.

This is an in-flight UI guard. It does not supply server-side idempotency or
resolve an ambiguous network failure after the server may already have committed.
It does not merge/remove historical records or change backend validations,
capacity/override permissions, schema or financial services. It does not redesign
an independently pending waiting-list operation.

## Follow-up verification and release boundary

- The 10 original unit cases passed on the released source before test edits.
  With the strengthened tests but before the fieldset correction, 10/11 failed
  because the native control group was absent; the same-render guard still passed
- `__tests__/quick-appointment-submission.test.ts`: 11/11 pass after the correction,
  including both request stages, conflict/override/preferences outside the form,
  patient-create response/network/JSON failures, booking conflict/server/network
  failures, editable retry and success reset. This hook harness checks rendered
  structure and handlers; it does not claim to execute native DOM disabling
- Related appointment, availability, service, schedule and waiting-list checks:
  198/198 pass across eight files, including the 11 focused cases
- Focused ESLint and TypeScript for the component, both test files and imported
  dependencies pass; `git diff --check` passes
- `__tests__/security-http/quick-appointment-submission-ui.test.ts`: eight built-app
  browser cases prepared, with synthetic intercepted patient/appointment/waiting
  writes only. Four variants cover 1280px/390px RTL and fallback/catalog service
  controls, attempted field edits and patient/slot/type changes, disabled keyboard
  focus, both pending stages, success/reset. Additional cases cover patient-create
  rejection/edit/retry, booking conflict/edit/retry, override/open waiting-list
  preferences and a same-turn existing-patient booking. The catalog variants
  capture only their synthetic pending form panels at 1280px and 390px; CI uploads
  exactly those two allowlisted PNG files as `quick-booking-frozen-ui-screenshots`.
  These captures still require visual review after CI; none has been seen locally
- The follow-up browser suite has not been run locally: the executor's browser
  socket restriction was already established and was not bypassed or retried.
  No new full-repository typecheck/build/browser pass is claimed. Independent
  review, exact-head CI, merge and Railway verification for this follow-up remain
  required; the successful PR #181 checks do not cover it

No Production patient, appointment, waiting-list, financial or schema data was
written by this follow-up.
