# Patient lab list read states and ownership

## Confirmed defect and bounded contract

At baseline `1fec393281c309ecb1ca6333ed6540254406dcf3`,
`components/PatientLabOrders.tsx` retried every failed scoped GET by requesting
`/api/lab` without a patient. If both responses were non-successful it cleared
the error, stopped loading, and displayed an empty list or retained old rows.
It also cast success bodies without checking their shape. A delayed old read
could update state after a newer request or component lifetime.

The existing `app/api/lab/route.ts` supports `patientId` and returns
`{ orders, labs }`. Both scoped and unscoped requests use the same session
guard. This is a read-truthfulness/lifetime repair; it is not evidence of an
authorization bypass or production disclosure.

The component now has three read states:

- Loading: no count, order cards, or empty-list claim while headers or the
  accepted JSON body are pending.
- Success: display the accepted current response's count and rows; only a
  validated empty response displays zero and the existing empty copy.
- Error: display a dedicated read alert and explicit scoped retry. HTTP
  refusals do not request all orders or wait for an error body. Network,
  invalid JSON and invalid list payloads use the same contained error state.

Read errors are separate from create/cancel/status errors. A completed read
does not clear those mutation messages. The retry button repeats only the
GET, never an uncertain or refused mutation. Retry is unavailable while the
current mutation owns its existing lock.

## Ownership and validation

The owner scope includes patient ID, username, role and permissions, matching
the values used by the parent patient workspace. A display-name-only change
or equivalent principal object does not refetch. Patient/principal changes
create a new owner even for A-to-B-to-A, retire the old owner in layout cleanup,
abort its current read, reset patient-specific draft fields (including dates),
and discard its modal selections. The parent already keys its workspace by
patient route ID and separately gates patient/principal snapshots; the
component guard is defense in depth for direct reuse and late callbacks.

The read snapshot and modal selections are owner-tagged, so a new render cannot
reuse another owner's list or modal. Each read has a monotonically increasing
sequence and its own abort controller. The code checks ownership, sequence and
signal after headers and again after JSON. The guards remain necessary when a
transport does not honor abort or a response was already being decoded.

A missing principal or invalid patient ID (including zero, negative,
fractional and nonfinite values) displays a blocked-context error and makes no
lab or laboratory-directory request. Create and retry controls are disabled
until valid context is restored. This also prevents the API's permissive
handling of an invalid patient query from broadening a component read.

The payload boundary accepts the existing object envelope, requires both
arrays, rejects duplicate/invalid order IDs and wrong-patient rows, recognizes
the current status union, and checks the scalar fields used to display list
rows and lab suggestions. Optional/null financial display values keep their
existing semantics. It does not transform values, recalculate money or claim
to be an exhaustive validation schema for every LabOrder/modal field.

Compatibility was checked against the existing `LabOrder` type,
`lib/db.ts`'s `LabOrderRow`, `toLabOrder`, `listLabOrders`, and `listLabNames`.
The exact baseline database module blob is
`6ada75e986e739a215fe1cb586cd801c6fdf08a9`: IDs are numbers, displayed amounts
are mapped to number/null, dates are strings, and lab phone is string/null.
The optional laboratory directory read retains its existing fail-soft
creation behavior while gaining ownership/abort guards for suggestions.

## Preserved mutation contract

The previous status-refusal repair is retained: server/fallback refusal text,
the exact conflict-text correction, uncertain network outcome wording,
synchronous duplicate/competing mutation lock, creation/cancellation
payloads and cancellation confirmation are unchanged.

While the owner is current, a successful receipt still awaits its refresh and
then opens booking for the captured order marked received. A failed refresh
now visibly reports unavailable list data but does not undo the confirmed
receipt or turn its success into a refusal. Successful delivery does not open
booking. Retired create/cancel/status continuations cannot initiate a stale
refresh, attach messages or booking, or release another owner's mutation lock.
Already-sent mutations are not aborted, reversed, repeated or made idempotent.

## Known boundary left unchanged

The API currently calls `listLabOrders()` without passing its patient filter,
then filters the default globally limited result in memory. Its default
`LIMIT 300` means a successful empty response is the endpoint's returned
result, not proof of full historical absence. This source-only UI slice does
not fix or endorse that independent backend completeness limitation.

No API, database query, permission, schema, currency, accounting rule, writer,
workflow, package, or future AI/Dot feature changes are included.

## Regression source and execution status

`__tests__/patient-lab-read-state.test.tsx` uses the existing lightweight
component hook-harness style with separate layout/passive queues and fully
controlled header/body promises. It covers:

- Pending headers and bodies, confirmed zero, current populated rows, every
  current status and optional/null financial display fields.
- 401/403/404/409/500, rejected fetch, invalid JSON, malformed envelopes,
  malformed rows/suggestions, duplicates and wrong-patient results.
- Explicit recovery and same-tick competing retries with no unscoped GET.
- Superseded headers/body against a newer success, error or pending state;
  obsolete failures, A-to-B-to-A, username/role/permissions changes, null
  principal, invalid patient IDs, restored context and unmount.
- Late registered-laboratory suggestions, independent mutation errors,
  accepted-write/failed-refresh semantics, retired mutation lock ownership,
  modal retirement and clearing the patient-specific draft including dates.

`__tests__/security-http/patient-lab-read-state-ui.test.ts` defines eight
actual-built-page cases at 390px and 1280px using the existing disposable
security-HTTP harness and its synthetic login. Native `Response` and
`ReadableStream` split headers from body completion. The tests exercise the
real count/error/retry/empty/populated presentation and late responses after
leaving and reopening the panel. Exact scoped and AppShell summary reads are
synthetic before dispatch. Every write, external request and broadened lab
request is rejected. Remaining reads use only the existing disposable harness.

Existing `patient-lab-status-refusal.test.tsx` gains only a layout-effect mock;
its assertions are preserved. The existing built-browser status suite's old
post-unmount success expectation is updated to require no obsolete GET and
the returning panel's fresh read. Its refusal, lock, payload and booking
assertions are retained.

These files are prepared source only. No local install, test, typecheck, lint,
application build/server, PostgreSQL, browser, or Production run occurred.
The repo's installed Next documentation is unavailable in this source-only
workspace; no Next APIs or routing behavior are modified. Before publication:

1. Independently review the final source hashes and recheck the then-current
   main delta, preserving the complete previously merged mutation repair.
2. In an authorized isolated runner, run both focused component test files,
   TypeScript and lint. Run a bounded baseline counterfactual with this new
   read suite, preserve true exit statuses, then restore candidate bytes and
   establish its focused success. Do not weaken assertions to obtain a pass.
3. Run both built-browser lab suites through the existing security-HTTP setup;
   require isolation and real 390/1280 rendering/interaction evidence.
4. Require the unchanged full CI gates on the exact reviewed release commit,
   no review blockers, and the separately authorized merge/Railway verification.

Source inspection or a hash/diff check is not an executed test or CI pass.
