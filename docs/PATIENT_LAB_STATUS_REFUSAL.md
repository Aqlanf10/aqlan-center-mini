# Patient lab receipt and delivery refusal handling

## Bounded change

`PatientLabOrders` previously ignored any non-success response to its receipt
or delivery PATCH. A rejected fetch escaped the handler without a controlled
message. This change handles those two actions in the existing component:

- A refused PATCH displays a nonempty server string, or a safe fallback when
  the response body is absent, malformed or contains a non-string message.
- The existing API conflict text claims that the list was refreshed. For that
  exact HTTP 409 text only, the component instead asks the user to reload and
  review the list. This refusal path does not issue a success refresh.
- A rejected fetch reports that the update could not be confirmed. It does not
  assert that the server rolled back or that retrying is idempotent.
- Failure leaves displayed order status unchanged, does not open delivery
  booking, and does not automatically repeat the PATCH. A later user click is
  an explicit attempt with the selected order ID and requested status.
- Status-command errors have separate state so a finishing list read cannot
  erase them. A new explicit mutation clears that command error.
- One synchronous ref complements the existing disabled/busy state. It blocks
  repeated and competing create/cancel/status calls before React re-renders,
  through refusal-body decoding and through the successful-write refresh.
  Current handlers release the lock in `finally`; retired handlers cannot release
  another patient's lock. Cancellation still requires its
  existing confirmation; creation and cancellation payloads are unchanged.
- A successful receipt still refreshes the list, then opens delivery booking
  for the exact captured order with `received` status. Successful delivery
  refreshes without opening booking. A success response need not have a JSON
  body. The manual booking button is disabled while a mutation is pending.
- The alert wraps long prose and uninterrupted text without clipping it.

This is UI refusal containment. It does not change backend authorization,
status transitions, money, writers, invoices, schemas, currency, visits or
plans. Read truthfulness and lifetime handling are documented separately in
[PATIENT_LAB_READ_STATES.md](PATIENT_LAB_READ_STATES.md).
It does not establish general mutation idempotency or clinical persistence.

## Dedicated regression source

`__tests__/patient-lab-status-refusal.test.tsx` exercises the actual component's
handlers/effects using the repository's lightweight hook-harness pattern.
All fetch responses, orders and session fields are synthetic; no database or
actual network is used by these focused tests.

The cases cover sent-to-received, in-progress-to-received and
received-to-delivered identities, 401/403/404/409/500 refusals, invalid and
unreadable bodies, the conflict-text correction, transport uncertainty,
explicit retry, delayed body decoding, same-tick competing actions, lock
ownership through refresh, canonical row updates, received-only booking,
booking dismissal, unrelated delayed read completion, and unchanged creation
and cancellation payloads/confirmation.

The hook harness does not prove real React scheduling or browser layout.
`__tests__/security-http/patient-lab-status-refusal-ui.test.ts` separately
defines 12 actual-built-page acceptance cases at 390px and 1280px. They use
the existing disposable security-HTTP harness and its real synthetic login.
Only the selected patient's scoped lab reads, the exact AppShell summary GET
and synthetic order status commands are intercepted, before network dispatch; all unexpected browser
writes, external requests and broadened lab reads are rejected. No lab or
appointment writer is called.

Six cases exercise all three order/status identities through repeated
401/403/409/500 refusals, long prose and uninterrupted text, malformed refusal
JSON, a lost response, explicit retry, real DOM double clicks, pending control
locks, canonical refresh, received-only booking and dismissal. Native viewport
screenshots and text/control geometry are limited to six explicitly named
synthetic files in the shared CI upload step. No app/test gate is changed.

Six more cases leave the lab panel with a pending receipt command and settle
it successfully, with refusal, or with a lost response. They check no modal or
error is attached to the Files panel, no repeated PATCH occurs, and returning
to Lab uses its fresh scoped read. Retired command continuations now avoid
starting an obsolete scoped read after unmount. This does not abort an already
sent mutation, establish its server result, preserve pending state across
navigation, or establish mutation idempotency.

## Validation gate and test plan

This source-only candidate has not been executed locally. Before publication,
an independent reviewer must approve the exact candidate and isolated GitHub
CI execution plan. Required evidence on the reviewed exact source:

1. Run the focused test file, TypeScript and lint in the isolated runner.
2. Establish a bounded counterfactual: run this test source with the exact
   base component, require demonstrated refusal/lock regression failures,
   restore the candidate byte-for-byte and require the focused suite to pass.
   Preserve real process statuses and unmodified logs for all three phases.
3. Review and run the built-browser acceptance source in the existing isolated
   security-HTTP harness before claiming real UI acceptance. Inspect the
   native viewport screenshots and geometry, including all alert text lines.
4. Require the repository's unchanged complete CI gates on the final head,
   no unresolved review blockers, and parent-owned merge/release verification.

No local package installation, executable tests, application build/server,
PostgreSQL or Production operation is part of source preparation.
The pinned counterfactual script and its exact-branch workflow belong only
to a separate temporary proof branch; neither is included in the release tree.
