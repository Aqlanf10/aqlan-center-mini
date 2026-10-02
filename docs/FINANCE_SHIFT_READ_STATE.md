# Finance shift read-state containment

## Scope

`/finance`, its cash KPIs, and `/finance/reconciliation` distinguish a pending
or failed shift read from a successfully confirmed closed shift. Only an
explicit successful `open: null` / `openShift: null` response means closed.

- Pending/error reads show unknown status instead of closed labels or zero
  cash/receipt/expense totals
- The existing parallel finance fetch scope remains in place. A rejected shift
  request has its own visible error; an unrelated successful read cannot clear it
- Request generations reject stale response and JSON-body completions
- Cash mutation entry guards reject stale reads immediately. Role checks and
  the financial request payloads are unchanged
- An already-loaded cash tab stays mounted under `hidden` plus `inert` during a
  refresh/error. This keeps the same shift's opening, expense, counted-cash,
  and nested correction drafts while making stale UI invisible and unfocusable
- Cash form identity includes the session principal/role and confirmed shift ID
  (or confirmed closed state). A changed identity resets old draft context;
  previous counted cash cannot silently apply to another shift or principal
- Reconciliation similarly preserves same-context parent-held drafts and clears
  them when the confirmed shift/principal changes
- Read-only Refresh/Retry buttons are a small usability addition. They only run
  the existing GET loaders, are disabled while loading/busy, and make recovery
  possible without navigating away or discarding same-shift drafts

No API, database, ledger, amount calculation, permission grant, or financial
mutation semantics are changed. Reports and accounting projections are outside
this change. This is not a full API payload-schema validation change.

## Local evidence

Node 22.23.3:

- 63 mocked shift lifecycle/draft-boundary cases plus 19 existing cash KPI cases
- 172 passing tests across 11 pure/mock suites, including shift close, money,
  expenses, governance, aggregation guards, role routes, and HTTP permissions
- Focused TypeScript check including Next ambient types and the authored browser
  fixture passes
- Focused ESLint has no errors; the reconciliation page retains two pre-existing
  unused-variable warnings (`isAdmin`, `baseCurrency`)
- Independent source review found and then verified the fix for refresh-driven
  draft loss; `git diff --check` passes

The mocked suite performs no financial writes or financial handler calls.
Collection-triggered refresh is exercised through a synthetic success callback.

## Mandatory browser gate

`__tests__/security-http/finance-shift-read-state-ui.test.ts` adds eight built-app
cases to the existing mandatory security-HTTP CI suite. All browser API reads
are intercepted with synthetic responses; all writes, print routes and external
requests are blocked. Tests use real GET-only Refresh/Retry controls and only
open/edit financial drafts. No financial submit button is clicked.

Coverage includes initial pending/HTTP/network failures, confirmed-null recovery,
accountant read-only controls, actual hidden/inert visibility and focus behavior,
same-shift opening/expense/count draft retention, and changed-shift draft reset.
Principal-change behavior is covered by the mocked page tests.

CI allowlists `finance-shift-unavailable.png` and
`finance-shift-draft-restored.png` as synthetic screenshots. These browser cases
were authored and type/lint checked locally but were **not run locally**. Their
runtime result, full build/CI, and any release verification remain pending.
No Production operation was performed for this work.

## Combined accounting integration

The integration with the separately reviewed accounting carry-forward change
uses one `financeRequest` generation for the shared GET loader. Cash readiness
and accounting readiness/error remain separate. Both response bodies decode
concurrently after the existing fetch settlement, so a pending/failed body in
one domain cannot promote, overwrite, or block the other domain's read state.
The accounting payload validation and successful-empty distinction are retained.
Both domains withhold stale presentation across a principal change.

The combined hook regressions exercise each domain's HTTP/network/malformed
failure independently, deferred JSON bodies, late successful and failed JSON
completion after a newer load, and old-principal accounting completion. All
requests remain mocked GET-only. This integration has no publication authority;
release ordering and final CI/review are still required.

The legacy whole-page first-load placeholder explicitly excludes the accounting
tab, whose own read state controls its loading/error/ready presentation. Three
first-load cases (cash JSON body pending while accounting is loading, ready or
failed) reproduced the hidden-tab issue before that one-condition correction.
The existing `viewReports` revocation behavior remains unchanged: no accounting
request, stale figures or successful-empty message when access is absent.

Cash Refresh/Retry is disabled by cash loading (or an active mutation), rather
than unrelated global loading. A failed cash read can therefore recover even
if accounting JSON remains pending. A regression reproduced the previous
blocked-retry state and verifies that the late accounting body cannot overwrite
the replacement generation. Same-principal report permission revocation also
rejects late accounting data without issuing a new accounting GET.

Final combined local evidence: **239/239 tests across 14 pure/mock suites** pass
on Node 22, including all original cash and accounting cases. Focused Next-
ambient type checking (both browser fixtures included) and the combined
callback/test lint check pass. No local browser/server/Production verification
was performed; mandatory CI browser execution remains pending publication.

## Deliberately retained fetch-settlement limitation

The existing `Promise.allSettled(promises)` still waits for every fetch response
before either critical response body is decoded. A hanging response from an
unrelated endpoint can therefore keep cash and accounting loading, even when
their own response headers have arrived. Both remain safely non-actionable and
show no stale cash or accounting figures. The new concurrency boundary applies
to body decoding **after** fetch settlement; it is not independent endpoint
scheduling, cancellation, or a timeout policy. A mocked deferred `/api/parties`
response characterizes this boundary. Broadening the fetch scope is deferred.

The separate integration branch also retains PR191's report visibility work and
all of its roadmap/screenshot artifacts alongside the refreshed PR192 changes.

## Optional permission-skipped responses

A separately reproduced existing defect parsed the empty HTTP 204 placeholders
for permission-disabled lab reconciliation and commissions as JSON. Both
accountant and cashier fixtures displayed `Unexpected end of JSON input` despite
successful required reads. The bounded correction adds each existing feature
permission to its response-parsing guard. Disabled feature bodies are not parsed;
enabled requests and their real error behavior are unchanged. The two formerly
failing role regressions are retained; no additional endpoint scheduling change
is included.

Post-refresh validation with PR191 and refreshed PR192: **291/291 tests across
17 pure/mock suites pass** on Node 22, including the two optional-204 role
regressions. Accounting-owner review approved the two guards and independently
reran all 29 projection tests. The original, independently reviewed shared-
generation and draft-preservation logic is unchanged by this correction.
