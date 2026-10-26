# Inventory continuation — local review candidate

Current continuation: supplier invoice finance, command retirement and sourced
patient consumption cost
**prepared cores** are now implemented and locally verified; see
`SUPPLIER-FINANCE-20261026.md`, `COMMAND-RETIREMENT-20261026.md` and
`PATIENT-CONSUMPTION-COST-20261026.md`. The default
principal resolver refuses writes, no HTTP/UI command is exposed, and its
additive schema remains unnumbered and unregistered. The initial inventory below
records the starting gaps; later sections record what has actually changed.

This records the remaining request before implementation. Inventory is not ready
for activation. No production access, Railway changes, deployment, merge, new
migration registration or automatic doctor debt/payroll adjustment is authorized
by this work. The initial publication hold was subsequently lifted by explicit
owner consent for operational source code only. The continuation is published as
Draft PR #481; secrets, real patient data and backups remain excluded.

## Verified starting point and branch relationship

- Current remote `main`, fetched 2026-10-26:
  `dc1be92eb17b4714d02caa32f9b6e3f848016a4f`, matching the supplied release.
- Work branch: `feat/inventory-continuation-20261026`, directly from that commit.
  No other branch is merged or cherry-picked into this continuation.
- PR #452 currently has head `672181a9893ecb2084ee70bc00d89d397afca7e3`
  on `feat/appointment-fixture-contracts-20261023`, targeting #450. Its scope is
  guarded appointment browser fixtures and the migration-tail expectation, not
  an inventory implementation. Its 0070–0072 dependencies are not adopted here.
- #467 held-stock/locking and #468 dormant legacy-writer protections were
  composed in #470 (`90831fded8e74bb4ae69174f5a49f69d61abd113`).
- #473 receipt adapter (`f9e15e1ebce2cfb48c020bcaffb0fd84c86e0ff1`) was composed
  in `7fd81d43` before the current release. Comparing its inventory-domain and
  inventory test paths with `main` gives no differences. Reimplementing it would
  duplicate already published work.
- `main` has registered migrations through 0069. 0070–0072 are reserved in other
  work and 0073–0080 are also reserved by the supplied coordination instruction.
  The resumed parent coordination additionally owns 0081/0082, with 0078 locally
  added, 0079 reserved and 0080 under examination; none is reused here.
  Any new schema remains an **unnumbered proposal**, never an assigned number.

## Inventory and priorities

| Priority | Area | Present evidence / remaining work |
|---|---|---|
| P0 | Gate and schema | Exact private opt-in remains closed by default; 29 proposed tables and operational reference data are not registered. Presence of pages, fixtures or the receipt adapter is not activation. |
| P0 | Requests and approval | Persisted request revisions, approval limits and configured self-approval rules exist. Review stale revision, live actor, currency and allocation races under the current policy; no new roles or owner definition. |
| P0 | Receipt | Caller-owned receipt core, durable server operation replay, partial receipt, quarantine/excess and mandatory audit already exist. Receipt adds stock only and does not create supplier debt. |
| P0 | Supplier invoice and debt | Matching reserves accepted quantities and records `pending_shared_finance_review`; it creates no payable. `createPayable` currently uses separate pool queries. Extract the existing writer into a caller-owned transaction primitive, preserving its finance contract. Invoice correction, approved source linkage and credit/reversal lifecycle remain necessary before exposing financial posting. |
| P0 | Consumption and returns | Tracked custody has lot/capacity/expiry checks and verified clinical ownership; legacy tracked-stock writers are blocked behind the gate. Validate malformed clinical IDs and report saved attribution status truthfully. Unused custody return is a transfer, not reversal of previously consumed patient material. |
| P0 | Client retry/recovery | Server success replay exists; current hook loses the exact command on reload. Add actor-bound persisted-before-send recovery and exact acknowledgement; do not manufacture a fresh operation after an uncertain result. |
| P0 | Full acceptance | Exercise synthetic PostgreSQL concurrency, mandatory audit failure, stale preview inputs, lost response, authorization and gate-off compatibility. A focused pass is not a complete purchase-to-payment/reversal or restore acceptance pass. |
| P1 | Actual cost | Known/estimated/missing costs must stay distinct. Native invoice quotes cannot become final YER cost; unused/unissued material has no actual treatment cost. Shared financial readers and final valuation remain unconnected. |
| P1 | Doctor material comparison | Existing pure `D − A` calculations and provisional custody proposals are available. `D` requires actual posted deductions net linked reversals; `A` requires attributable net consumed cost. No purchase/transfer, service name or theoretical material percentage substitutes for either. |

## Unresolved decisions and integration boundaries

The owner must define how actual manual usage interacts with automatic service
templates, who may issue from each clinic/doctor location, and whether/how actual
material costs reconcile with the existing commission allowance. That decision
must identify the period, contract version, covered costs, reversals and approved
financial writer. This task does not create a doctor's debt, salary deduction,
refund or settlement posting from an inventory variance.

Supplier invoice revision/cancellation needs source-linked immutable financial
compensation with the existing payment/void guards. Opening-balance corrections
are not supplier credit notes. A transaction primitive alone does not establish
that lifecycle or justify activation. Source-linked return of consumed material,
final lot valuation, complete clinical cost readers, operational master-data
setup, additive upgrade and restoration rehearsal remain explicit dependencies.

## Verification record

Only a fresh disposable loopback PostgreSQL 18.6 container with synthetic data
was used. No live credentials, database rows or backup exports were read. Hosted
CI and a Draft PR cannot be claimed while publication is paused.

## Frozen checkpoint and actual validation

The parent requested an immediate local checkpoint to preserve the remaining
usage allowance. No new scope or full test round starts after that instruction.

- Node 22.23.3; fresh locked `npm ci` succeeded.
- The already-running PostgreSQL round completed successfully: **20 files /
  505 tests**, 262.14 seconds. This includes all inventory PostgreSQL suites,
  supplier payable transaction/overpayment, party statements/opening balances
  and lab full-allocation regressions. A pg concurrent-query deprecation warning
  was emitted; it was not suppressed.
- Focused recovery tests: **3 files / 31 cases passed**. These are protocol and
  headless hook tests, not a real IndexedDB/browser acceptance claim.
- Focused custody unit/form tests: **78 passed**. Focused payable and existing
  adjacent route tests: **70 passed**, including five new transaction-probe cases.
- Agent-owned changed-file lint passed; db.ts retained eight existing warnings.
  Aggregate `git diff --check` passed.
- Initial targeted PostgreSQL: **33 passed, 1 failed** because a new test fixture
  supplied an `undefined` JSON property. That fixture was corrected before the
  successful broader run. A later test-only custody assertion refinement may
  postdate loading that test file, so no exact-final-head full acceptance is claimed.
- An initial typecheck found a test-case union typing error, subsequently fixed.
  The root's final typecheck was **interrupted (exit 143)** at the freeze request;
  no final typecheck pass is claimed.
- Chromium download was denied with HTTP 403 `Domain forbidden`; it was not
  retried through another source. Existing `/usr/bin/chromium` 151 launched a
  local synthetic smoke successfully. The expanded real-browser test (reload,
  generic 403, simultaneous tabs and same-key replay) is **written but unrun**.
- Build, full unit suite, full PostgreSQL suite, built HTTP/browser, upgrade /
  restore rehearsal and hosted CI were **not run for the final candidate**.

Implementation consists of a caller-owned payable primitive, strict custody
clinical references and truthful attribution status, safe hidden form fields,
and durable inventory command recovery with actor binding. No supplier invoice
posting command, operational credit/reversal lifecycle or new schema was added.
Recovery intentionally retains commands after generic 403/409: durable terminal
rejection/retirement and an authoritative principal realm contract are still
required. The real-browser test and final typecheck must be completed on resume.

At the frozen checkpoint publication was **pending explicit permission**, not
attempted or denied by GitHub. No PR, push, merge, deployment or flag change had
occurred. Its source-only handoff manifest records base/head/tree and the exact
changed-file allowlist.

## Resumed acceptance, 2026-10-26

This section supersedes the frozen checkpoint's publication and unrun-check
status above. The owner authorized public source publication and then renewed
the execution allowance, requesting GPT-6 Astra at Medium reasoning. The resumed
verification was delegated to that model. Draft PR:
https://github.com/Aqlanf10/aqlan-center-mini/pull/481 . No merge or deployment.

The initial published head was `4f06af06908a3eb38f42b43fde6ac3f3ac53221b`.
Resume fixes affect tests only: the custody form mock follows the current
recovery hook contract, and the browser recovery assertion waits for both
confirmations to finish instead of using an already-visible request heading.
No product permission, financial writer, schema, flag or policy was changed by
these acceptance repairs.

Local Node 22.23.3 / PostgreSQL 18.6 / existing Chromium 151 evidence:

- Full TypeScript check and production build passed. The build retained its
  dynamic migration-file tracing warnings; they were not suppressed.
- Focused units: **63/63**. The first round had three stale test-mock failures;
  the mock was corrected and all 63 rerun successfully.
- Focused PostgreSQL payable/custody: **34/34** on the current product sources.
- Gate-off built HTTP/browser: **4 files / 31 tests**, 51.46 seconds.
- Gate-on isolated procurement/custody fixture: **17/17**, 41.29 seconds, using
  the same compiled artifact and a fresh synthetic database. The first round's
  16/17 result was a test synchronization failure, not the accepted result.
- The real-browser recovery case now proves persisted-before-retry recovery
  after reload, no automatic send on reload, preservation after a generic 403,
  simultaneous exact-key/body retries in two tabs, matching committed replies,
  one request/operation record and an editable cleared form after confirmation.
- Final responsive recovery rerun: **2/2 at 390px and 1280px**, 15.12 seconds,
  after parameterizing that case. The preceding full opt-in run was 17 cases;
  the now-expanded 18-case file was not rerun in full. Screenshots at both widths
  were visually inspected: the center logo, blue/orange identity and navigation
  are retained; the saved-command summary wraps on mobile and retry remains
  visible, with no horizontal overflow. No design tokens or layout styles changed.
- Changed-file lint and whitespace checks passed. Hosted CI is tracked on the
  PR's current head; local results do not substitute for hosted completion.

Both browser rounds use disposable synthetic fixtures. Screenshots, PDFs and
runtime logs are local evidence outside the committed source handoff. Full
supplier-invoice posting/reversal, clinical cost integration, command retirement,
canonical realm identity and upgrade/restore acceptance remain incomplete.
The private activation gate therefore remains closed.

## Supplier invoice finance continuation

This slice follows published head
`f574aa089397f9839e1a29615d8ba25fc7b48d8b` without merging another branch. It adds
immutable pre-posting invoice revisions, exact accepted-receipt reservation
readers, source-linked posting to canonical supplier payables, and full unpaid
cancellation through a source-guarded append-only operational adjustment.
Original amounts/FX, receipt reservations and stock remain intact. Payment
reversal must use the existing authorized void path first; no automatic refund,
doctor debt, payroll writer or permission definition is introduced.

Actual verification: 9 PostgreSQL files / 164 tests passed, including supplier,
procurement, payment and opening/statement regressions. The final 18 supplier
cases were rerun successfully after adding historical replay-after-cancellation
assertions. Four focused unit files / 104 tests, typecheck, money aggregation
guard, changed-file lint and whitespace checks passed. Eight pre-existing
`db.ts` lint warnings and existing pg query deprecation warnings remain visible.
No new build/browser acceptance is claimed for this core, which exposes no UI
or HTTP dispatch. Earlier UI screenshots belong to the recovery slice.

At this checkpoint hosted CI run 40400242472 is still evaluating **f574aa08**:
quality/typecheck/unit/audit/build succeeded; PostgreSQL and hosted browser jobs
remain in progress. Those results cannot accept a subsequent head. The next
push is deferred until that run completes because CI cancels superseded runs.

Canonical realm/subject identity, operational financial UI/API integration,
durable command retirement, patient consumption valuation, coordinated schema
registration/master data and upgrade/restoration acceptance remain incomplete.
The gate stays closed. Detailed source and test limits are recorded in the
supplier finance document; no complete inventory-readiness claim is made.

## Durable command decision continuation

Following local supplier commit `e7ee46af5d46400604c7e7970ce4ea544b1ae62a`,
the next slice adds immutable, separately committed admission and explicit
retirement under the existing execution key lock. The central execution helper
fences retired commands and requires the same authoritative principal for any
bound command. Success always returns its historical acknowledgement; a generic
error never becomes terminal proof. Shared principal projection excludes mutable
permission metadata. No browser/API adapter or legacy adoption is exposed.

Synthetic verification: 17 lifecycle cases passed within 4 PostgreSQL files /
76 tests covering supplier, procurement and custody regressions; 5 recovery,
gate and receipt unit files / 51 tests passed. Typecheck and changed-file lint
passed. The composed run initially exposed a test fixture that assumed all
workbench documents were SAR. Its assertion now verifies the exact owned source,
quantity, currency and value; the same 76 cases then passed.

Hosted checks for **f574aa08**, not this local successor, now show 695 unit files /
12,172 tests and 300 PostgreSQL files / 3,569 tests passed, plus build, schema and
operational journeys. HTTP/browser remains running. The supplier checkpoint's
source-only patch was also restored in an isolated worktree: its tree exactly
matched `04ecfe2e8136b29df399b1d8964a83c7e7071e31`. This is source restoration
evidence, not a database restoration rehearsal.

Legacy unresolved browser commands still remain held until canonical identity
and the reviewed transport/adoption contract are supplied. Patient consumption
valuation and full operational acceptance remain unfinished; activation stays
closed.

## Sourced patient cost and isolated restore continuation

Patient cost commit `3df63540eddb1ba068123b3aa414196fa1da59ed` adds a read-only
adapter over actual consumed movements, lot allocations, verified saved clinical
references and posted invoice/receipt valuation. It preserves native currencies
and frozen FX, rounds selected proportional totals once, and never values an
unissued item or infers consumption from a service. Partial, cancelled or
unproven valuation remains missing; saved order quotes remain estimates.

The adapter requires a coherent read-only snapshot and an explicit canonical
patient/financial read grant. It has no admin-role fallback or HTTP/UI dispatch.
Full treatment totals remain null because completeness of material registration
is unproven. Historical doctor identity is not inferred from current assignments.
No doctor debt, deduction, refund or payroll/commission policy is introduced.

Final composed verification on fresh synthetic PostgreSQL: **5 files / 99 tests**
including 23 cost-reader cases and supplier, custody, lifecycle and procurement
regressions. Three unit files / **164 tests**, typecheck, money scan and whitespace
checks passed. Full lint passed with zero errors and 209 existing warnings,
none in the changed files. Detailed initial errors and their corrections are
recorded in the cost document; no product guard was relaxed.

A separate synthetic PostgreSQL 18.6 dump/restore drill passed. All data came from
the disposable loopback fixture database. Seventeen stock, custody, supplier,
financial, command and audit tables retained identical counts and full logical
row hashes. After restore, a committed command replayed without another effect,
a retired command remained fenced, and a separately admitted pending command
resumed once with one result/audit and no stock or financial change. Preparation
and restored verification each passed one focused canary test. Original fixture
databases were preserved locally; the temporary synthetic dump was removed and
never uploaded. This proves the isolated fixture restore, not production backup,
point-in-time recovery, failover or activation across an unverified realm.

The full hosted run for **f574aa08** completed successfully, including HTTP/browser
and the final required CI gate. Its HTTP log download failed twice with a
transport-closed error; success was verified from Actions job/gate metadata,
and no exact HTTP count is inferred from the unavailable log. All new commits
require their own hosted run on the final published head.

Final local build of the new product sources succeeded, including Next's full
TypeScript check. The existing dynamic migration-file tracing warnings remain.
Using that exact build, the opt-in procurement/custody HTTP and browser suite
passed **18/18**, 69.98 seconds. A fresh gate-off run passed **4 files / 31 tests**,
53.51 seconds, including legacy purchase recovery. Both runs used disposable
synthetic databases; the harness stopped each server and dropped its test DB.
The 390px and 1280px saved-command screenshots were visually reviewed again:
the center identity, blue/orange styling and navigation remain intact, the
summary wraps, and retry stays visible without horizontal overflow. New prepared
financial/retirement/cost cores still have no UI or endpoint acceptance claim.

Remaining activation dependencies are explicit canonical realm/subject and
patient-cost read adapters; a reviewed transport/adoption contract for legacy
pending commands; coordinated unnumbered schema/reference-data integration;
partial supplier credit/replacement and source-linked consumed-material reversal
lifecycles; complete registration evidence and historical doctor attribution;
and full operational acceptance of that integrated release. Any future doctor
material comparison must specify period, agreement version, covered costs,
actual posted deductions net reversals and an authorized settlement writer.
This task creates none of that doctor liability or payroll policy implicitly.
