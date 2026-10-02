# Finance summary visibility containment

## Scope and original defect

The `GET /api/finance/report` endpoint admitted a doctor with either effective
`canViewClinicRevenue` or `canViewClinicFinance`, then serialized the complete
`FinanceSummary`. That exposed expenses, opening-debt settlements and net cash
movement even when those independent permission flags were off. The only UI
consumer is `app/finance/reports/page.tsx`. Database callers and the internal
`FinanceSummary` calculation/type remain unchanged.

## Response contract

`lib/finance-report-visibility.ts` is a pure, typed, explicit-field projection:

- Admin and an accountant allowed to view reports retain the full existing response
- An accountant with the existing `financeAccess.viewReports = false` is denied
- Doctor admission preserves `canViewClinicRevenue || canViewClinicFinance`
- Revenue access includes receipts, refunds, invoice totals/counts, patient counts
  and service totals; it does not imply expense or profit access
- Expenses and opening-debt settlements require `canViewExpenses`
- Net requires revenue, expenses and the existing profit helper, which recognizes
  `canViewClinicProfits || canViewAdminReports`
- Unauthorized properties are omitted entirely, not replaced by zero or empty data
- Other roles remain denied, even if handed doctor-like permission fields
- New unclassified top-level or nested scalar fields do not automatically pass through

The page uses the projected type, conditionally renders restricted sections, and
preserves legitimate zero values. Every new load clears the previous result. Both
fetch and JSON completion are guarded against obsolete requests, including after
401/403, errors and unmount. After a new request or an observed denial, the old
report cannot persist into printed output. This does not instantly erase data
already delivered to an idle page without a new request/session event; broader
session-policy versioning and revocation propagation remain separate work.

## Verification

Local Node 22 checks:

- 49 new tests: pure permission/projection matrix, actual GET handler with mocked
  trusted session/data dependencies, and real page render/effect regressions
- Existing role-route, HTTP-permission and session-revocation tests pass with the
  new tests (73 tests total)
- Focused ESLint passed
- Focused TypeScript covers changed production code, all new tests and Next ambient
  declarations: passed

Six synthetic built-browser cases are part of the mandatory security-HTTP CI suite:
revenue-only desktop/mobile/print, authorized expense and zero-net display, 401 and
403 with old headers/JSON completing late, and an older full-access response racing
with a newer reduced-access response. They use the built Next page and an isolated
synthetic harness session; all report data is fixture-backed, unexpected API and
external requests are blocked, and no live role/permission changes occur.

The local full TypeScript process was terminated by shared memory pressure. Local
built-browser execution was not attempted due to the established server/browser
socket restriction. Full CI, including build, complete TypeScript and the synthetic
browser suite, remains mandatory before release; focused checks are not a full pass.

## Boundaries

This is endpoint containment, not completion of customizable staff permissions.
No permission editor, new grants, revocation workflow, ownership binding, schema,
database calculation, clinician/party identity, credentials, Production records or
AI/Dot feature changes are included. Other composite API payloads need separate
coverage before expanding the permission-management interface.
