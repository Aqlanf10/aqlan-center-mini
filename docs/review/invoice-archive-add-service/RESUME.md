# Local repair continuation — activation gates remain open

The saved checkpoint below is preserved as historical evidence. Its P1 archive
retirement defect has now been repaired locally; see `LOCAL_REPAIR.md`. Runtime
activation, reset integration, final composed-schema verification and browser/build
acceptance are still open gates. No publication or deployed database change occurred.

## Historical frozen checkpoint — not release-ready

The owner requested an immediate resource-saving checkpoint before the planned
build, browser/HTTP journey and broad core regressions. Public GitHub upload and
Draft PR creation are separately paused pending explicit publication permission.
No code was pushed, no PR was created, and no Railway deployment was attempted.

Base: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f`.
Branch: `codex/invoice-archive-add-service`.
The private resume package's manifest records the final local commit and tree.

## Known blocking defect to fix first

P1: an archive preview can become financially ineligible when a refund or period
closure occurs before POST. `changeInvoiceArchive` returns
`policy_decision_required` / `period_locked` without a durable rejection record.
`useInvoiceMaintenance` correctly refuses to clear an uncertain command on a
generic 409, but this leaves the patient's financial journal blocked indefinitely
while the archive version has not advanced. A delayed duplicate could otherwise
execute if the condition later changes, so clearing the journal locally is unsafe.

Resume by adding a durable, actor/body/key-bound terminal refusal or equivalent
server retirement proof under the same archive locks (unnumbered proposal only).
Test preview -> refund / period close -> POST -> retry/delayed duplicate, and
successful journal retirement without an archive event or financial mutation.
Do not relax unpaid-archive policy or infer cancellation/debt forgiveness.

## Validation actually completed

- Archive: 17 unit tests and 25 PostgreSQL 18.6 integration tests passed; targeted
  ESLint passed. This includes nonempty signed clinical, lab, commission/payroll
  and print fixtures, unchanged balances, concurrent/replayed/no-op archive,
  restore after refund, malformed schema and transactional audit rollback.
- Service addition: 25 PostgreSQL 18.6 integration tests passed after its final
  runtime changes; targeted ESLint passed. Includes three currencies, partial
  payment, concurrency, lost response, stale/cancelled/replaced/period refusal,
  inherited doctor, nonempty history, malformed schema and atomic rollback.
- UI/headless plus existing related unit regressions: 156 tests in five files
  passed before the final TypeScript currency-narrowing fix; targeted ESLint passed.
- Existing baseline print/correction/linkage/transport tests: 40 passed before
  implementation. This is baseline evidence, not final extracted-core regression.
- Money aggregation scanner and bounded request-body scanner passed.
- Last whole-worktree typecheck FAILED with two errors: the service test fixture
  lacked `surfaces`/`note`, and the UI preview currency remained `unknown`.
  Both source fixes are included, but typecheck was NOT rerun after the freeze.
- Chromium launch with `/usr/bin/chromium` succeeded; no application browser
  journey was executed. `invoice-maintenance-http.test.ts` contains seven pending
  built-app HTTP/browser tests (including two viewport cases), not passing evidence.
- No build, broad extracted-core regression run, full unit/PG suite, final HTTP
  journey, CI or final-head hosted verification was performed.

Initial red tests failed because the new modules did not exist; their behavioral
assertions were not reached. One intermediate PG red attempt coincided with npm
dependency installation and failed setup; it is not behavioral evidence.

## Resume boundaries

1. Fix the P1 archive retirement defect and add its synthetic regressions.
2. Run final typecheck, focused core invoice/linkage/settlement regressions, build,
   then the new HTTP/browser suite using disposable PostgreSQL 18 and Node 22.
3. Review and allocate schema versions before activation; both proposals remain
   unnumbered and absent from runtime schema initialization/manifests. 0073–0080
   are reserved. Missing schema intentionally refuses feature writes.
4. Obtain explicit public-publication permission before any GitHub push or PR.
   If authorized, create a Draft PR and inspect CI for that exact pushed head.
5. Never merge main, deploy Railway, access live patient data, or send messages.

Unpaid/partly paid invoice archival remains an explicit policy question. The
implementation refuses it without affecting debt. Existing consented/approved
plan and completed-work rules are retained. No settlement-button, statement
redesign or multiple-filling scope is included.
