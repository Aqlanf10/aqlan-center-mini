# Slice 41 — scoped plan-item case and priority command

Base: `15bacdb7a0b4de242b928545b72eb480b0212c39`, on the same WORK branch. This local slice admits only `PUT /api/plan-items/[id]/case`; it does not activate case creation, dependency writes, funding or the rich legacy plan reader. Publication, exact-head CI and independent acceptance remain separate.

## Acceptance matrix

| Requirement | Implementation | Actual evidence |
|---|---|---|
| Current authority and patient scope | Existing `clinical.plans.edit` and its view prerequisite; own/all/none; outside equals missing; no canonical fallback | Baseline HTTP 401→200 failure; final PG and built HTTP |
| Fresh checks after waiting | Patient then item locks, fresh scope/session, plan ownership, locked positive own witness and fresh final assertion | Real PG barriers for expiry at both locks, revoked authority, removed responsibility and two competing commands |
| Retain historical financial attribution | Shared caller-owned writer preserves original invoice/source/agreement checks; priority remains editable | Existing commission/specialty regressions; zero/cancelled retained source and concurrent invoice commit |
| Independent ortho visibility | Both existing and requested ortho links require `clinical.ortho.view`; no blind unlink | PG grant and foreign-reference refusals |
| Atomic effect and audit | One operation transaction and connection; real actor from proof; audit failure rolls back | PG trigger witness, no initializer or pool escape |
| Prevent stale overwrites | Exact expected case/priority comparison; same-state no-op has no extra audit | Stale/concurrent comparisons, immediate old retry refusal |
| Ambiguous response recovery | Pending tab intent before PUT; no automatic replay; fresh read and explicit new intent; closed editor ignores delayed reply | Real Chromium lost reply after commit, reload, malformed success, late reply, revocation and unavailable storage |
| Existing workflow and accessible form | Legacy wrapper delegates unchanged writer; old handler tail preserved; explicit input labels and RTL 390px | 11 source witnesses, legacy PG tests and visually inspected synthetic screenshot |

The state comparison is **not durable idempotency**. A later state returning to the same values is not a permanent request identity. The UI never automatically retries a mutation. Fresh matching values prove the current record, not which request produced them. If sessionStorage is unavailable, memory prevents replay in that mounted editor, but recovery after reload is not guaranteed; the UI states this limitation. No migration or receipt schema was added.

The old patient lock is `FOR NO KEY UPDATE`. A first implementation used the stronger `FOR UPDATE`; the invoice-wait witness exposed an incompatible patient FK lock and transaction conflict. The final command matches the original compatible lock, then rechecks retained invoice sources after acquiring the item lock. No invoice filtering, money rules or clinical history were weakened.

## Completed local checks

- **86/86 PostgreSQL**, four files: 23 new command cases, 35 case-reader cases and the existing commission-attribution/specialty regressions.
- **24/24 HTTP/browser**, two files: 13 command journeys and 11 reader journeys, against final build `Z4wYy2FZw9n0uE6uSHSgO`. One additional screenshot-only run passed its selected test with 12 filtered tests; it is not counted again.
- **36/36 unit**, two files; **10/10 map/readiness guards**, two files. Typecheck, focused lint (zero errors/warnings) and production build passed.
- **11 source-preservation checks**, including exact writer-body comparison after removing only transaction ownership and indentation, unchanged legacy route tail, financial calculation engine, case engine and migrations. **455 historical source hashes** verified at their own pinned revisions.
- The synthetic 390px editor screenshot was inspected for legible RTL labels, controls and layout. No real patient data is present.

Failed attempts remain archived: baseline 401; first PG 47 pass/3 fail (invalid prerequisite expected code, the actual blocked waiter chain and the stronger-lock defect); corrected PG 50/50 followed by the expanded 86/86. First browser group 17 pass/4 fail exposed labels including select-option text; explicit `htmlFor` labels fixed the accessibility defect before rebuild and 24/24. First map guard 9 pass/1 fail required explicitly adding the admitted existing action to its pinned list; the guard and `NOT_READY` assertion remain intact. An initial lint warning was removed by lazy pending-state restoration and derived read verification; final focused lint is clean. No failed or filtered check is reported as a pass.

## Boundaries and next work

Full batch unit/PG/HTTP checks and final published-head CI have not yet run for this slice. The previous published head `8e12f959` has its own pending CI, separate from these results. Dependency add/remove is the next separable contract; case creation and rich financial plan/proposal reads remain held. The source map now has 61 canonical-done and 283 existing ordinary entries, not a system completion percentage; inventory remains `NOT_READY`.

The parent's limited source review of `8e12f959` covers the finance conflict, migration union and race witness. It does not cover all 35 main-integration conflicts. Login/photo/session, backup/restore, settings and the remaining UI/inventory/lab-print integration need independent review. Local compatibility checks are evidence, not that review. WORK Docker remains blocked by enforced Alpine CONNECT HTTP403; no bypass or package-source change was attempted. A proposed WORK-only image workflow is outside the repository for review, not enabled or executed. No deployment, live permission or data change.
