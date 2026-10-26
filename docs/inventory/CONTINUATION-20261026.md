# Inventory continuation — local review candidate

This records the remaining request before implementation. Inventory is not ready
for activation. No production access, Railway changes, deployment, merge, new
migration registration or automatic doctor debt/payroll adjustment is authorized
by this work. Publication is paused pending the parent's explicit clarification;
local implementation and synthetic tests continue.

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

Publication remains **pending explicit permission**, not attempted or denied by
GitHub. No PR, push, merge, deployment or flag change occurred. The source-only
handoff manifest records base/head/tree and the exact changed-file allowlist.
