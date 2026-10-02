# Financial report selected-period identity

## Bounded defect and fix

The report page cleared its old summary inside the date-dependent `useEffect`.
A render with newly selected dates could therefore retain the previous report
until that passive effect ran. An old fetch or JSON body that completed before
cleanup could also briefly render values for the old selection. This is separate
from PR191's server-side permission projection and post-cleanup async guards.

The loaded state now stores the request-start `from` and `to` with its summary.
Every render checks both against the current selected dates before using any
report values or offering the print action. A mismatched result shows the pending
state instead; browser printing also has no old report values in the rendered
page. The server may normalize reversed dates, so identity uses the raw requested
pair rather than requiring response dates to equal input order.

The existing abort controller, active checks after response headers and JSON,
load-time clearing, and 401/403/error clearing are preserved. A matching result
retains the existing authorized-zero and independent expense visibility rules.

## Local verification

- Five new regression cases fail against the pre-fix page and pass with the fix:
  either date changing before the new passive effect, old response headers/body
  completing before cleanup, and changed request order with a normalized payload
- All 15 finance page tests pass, including stale completions after cleanup,
  401/403 with readable and unreadable bodies, unmount, authorized zero/partial
  expenses, and repeated rendering of the same requested period
- 68 focused tests pass across finance page, actual report route, permission
  projection, accounting summary UI and finance governance UI
- Changed-file ESLint and focused TypeScript with Next ambient declarations pass
- The whole-repository TypeScript process exited 137 before diagnostics; this is
  not a pass. No local build/browser, PostgreSQL, full CI or Production checks
  were attempted for this slice

The same 68 focused tests and changed-file lint passed after refreshing onto
PR198-equivalent local `91a2128` (including PR194 and PR195). The focused Next-ambient typecheck includes the
updated mandatory security-HTTP browser fixture. Original runtime changes have
root/independent review; root review approved the DOM-snapshot browser extension; exact-head CI remains required.

Two additional mandatory built-browser cases (desktop 1280px and mobile 390px)
capture the report DOM synchronously at fetch entry, before the passive effect's
queued state clear can commit. Each changes both date inputs in turn, asserts
that selected input dates match the request while summary/print are already
absent, verifies the pending print DOM, then accepts and renders the matching
result. This snapshot intentionally does not poll away the transient defect.
These cases are prepared and typechecked, not locally browser-executed.

Focused render/effect tests execute the actual page with controlled hook state
and mocked child components. They cover the otherwise brief pre-effect boundary;
they do not replace the required built-browser and exact-head full CI release
checks. PR193's existing DOM-polling correction is preserved; the new request-entry snapshot is a separate earlier-boundary assertion in the same fixture.

## Release and data boundary

Status remains PARTIAL pending exact-head full CI/browser verification, merge and Production
verification. No API, backend, schema, calculation, permission rules or data
changes are included. This does not erase data already delivered to an idle page
without a new request or session event, and does not implement staff permissions
or future AI/Dot features.
