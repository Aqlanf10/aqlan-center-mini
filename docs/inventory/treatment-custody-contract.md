# Treatment cost and doctor custody domain contract

## Checkpoint and scope

- Base/HEAD: `148fcbeac229cb279848e6ea37049d1599a4fafe`; local branch `feat/inventory-procurement-custody`.
- Authoritative attachment: Library `libfile_05f8e16e32508191aefa2093c44f9a21`, consumer materialization `/workspace/inventory-task/source/scope-read.md`, 499 lines. SHA-256 `ed47678714550343cc489825db47686bbbf36c2446b8344229c8d2a90ac53e81`.
- This checkpoint implements pure domain contracts in `lib/inventory-domain/treatment-cost.ts` and `lib/inventory-domain/custody.ts`, with synthetic unit tests in `__tests__/inventory-treatment-custody.test.ts`.
- These modules do not write a stock ledger, supplier balance, payable, expense, commission, wage deduction, or cash payment. They are not wired to the existing application. No migration number is selected or reserved by this work.
- Only the two modules, their test file, and this contract document are owned by this subtask. Other working-tree changes belong to parallel owners. Shared `db.ts`, session/roles, schema, migrations and supplier/commission writers were inspected but not edited here.
- `AGENTS.md` was read. It requires relevant local Next guides before Next changes; these new pure TypeScript modules do not use Next APIs. No repository `.agents` directory or applicable files in `/workspace/.agents` were found.

## Reproduced foundation findings

| Finding | Exact checkout evidence | Executed evidence | Status |
|---|---|---|---|
| INV-15 | `issuedCostForPatient` in `lib/db.ts` selects all patient movements, filters `out`, and sums them without linked returns or a visit/case selector | Source inspection only; no DB reproduction in this subtask | Existing application fix pending coordinated adapter |
| INV-16 | Existing treatment UI depends on a patient material total rather than these exact allocations | Attachment finding; no browser reproduction in this subtask | Existing UI repair pending owner |
| INV-17 | `calculateProcedureProfitability({ serviceName: 'Synthetic', revenueMinor: 20000 })` returns direct cost zero and tier `excellent` | Foundation characterization test passed before new modules were created | New `summarizeTreatmentResult` reports missing categories; existing profitability/UI remains unchanged |
| INV-18 | Existing `materialCost` returns theoretical cost; `db.ts` caps net earned at zero | Characterization test confirms theoretical cost 1000 and no applied amount; cap inspected at `netEarnedMinor` | New D computation requires actual applied source events; posting integration pending |

The initial focused run contained **2 passing foundation characterizations**, not two resolved application findings. The current run contains **43 passing unit tests**, including those characterizations. This is not 43 end-to-end acceptance scenarios and not completion of all 69 required scenarios.

## Public contracts and arithmetic

`treatment-cost.ts` exports:

- `CostSnapshot`, `TreatmentIssue`, `TreatmentAllocation`, `TreatmentReturn`, `TreatmentScope`, `TreatmentCostSummary`: immutable input contracts identifying the existing movement, usage identity, actual quantity, unit scale, historical valuation source and scope.
- `proportionalCostMinor`: safe-integer atoms and minor money, BigInt intermediate multiplication, half-up rounding only after extending quantity. It preserves the 3/1/8 SAR examples and cheap pieces below one minor unit per piece.
- `summarizeTreatmentCost`: exact patient plus case, visit, or visit/procedure selection; shared visit material stays at visit scope. Linked returns reduce only the identified original allocation. Duplicate usage keys, movement IDs, allocation IDs, excess allocation and excess linked returns fail closed. Known and estimated subtotals reconcile to the once-rounded total. Missing price, missing registration, or unallocated supplied movement produces `totalMinor: null` and explicit reasons/identities. Fully returned usage carries no residual material cost.
- `summarizeTreatmentResult`: explicit materials, laboratory, direct labor and allocated overhead categories. Absent categories are missing. Known zero must be supplied with a source. It labels direct contribution and result after allocated overhead, without a universal profit badge. A repeated cost source across direct/overhead categories is rejected.
- `priceSimulation`: C/(1−m), or C/(1−r−m) only for an explicitly declared net-price commission. It rounds the target price upward to a minor unit, rejects a nonpositive denominator, and returns null margin at zero revenue. It does not update prices or contracts.
- `allocateOverhead`: unique source expenses, declared planned capacity and cost drivers. Direct labor and capital-purchase sources cannot be inserted into the overhead pool. Largest remainders preserve total minor money; idle capacity stays unallocated. Exceeding capacity requires a policy revision.
- `treatmentFinancialSnapshot`: agreement, allocated performed revenue, billed and collected are separate. Performed revenue requires a policy; allocations cannot exceed the agreement. Collections cannot manufacture performed revenue. Projected completion contribution includes remaining expected cost and is null when that estimate is absent.

`custody.ts` exports:

- `previewCustodyTransfer`: source, transit and accepted quantities/values reconcile to the clinic original. Rejected quantity returned to the source is separate. Transfer means zero consumption, payable and cash effect.
- `reconcileCustody`: opening + received − transfers − returns − consumption − approved waste. Duplicate source movements and negative running balances are rejected. Count differences return review requirements, never invented consumption or automatic liability.
- `calculateDeduction`: explicitly identifies collections/commission/agreed-other basis, reuses `FULL_RATE_BP` from existing `materialRate`, and separates theoretical, applicable and unapplied amounts. This is a preview, not proof a deduction was posted.
- `summarizeAppliedDeductions`: D is only actual applied amounts from the existing commission writer minus linked reversals. Reversals cannot exceed the original applied amount. Mixed doctor/period inputs, duplicates and unlinked reversals fail closed.
- `attributableConsumedCost`: A includes only contract-covered, known net consumed costs with explicit agreement version and percentage. Opening or closing custody quantities are not cost lines. Waste needs a separate approved exception; missing/estimated cost or unreconciled inventory keeps total A null. Returns must already be reconciled to the original allocation by the treatment adapter. Shares aggregate before monetary rounding.
- `proposeSettlement`: target = D−A; supplemental amount = target − all previous signed posted adjustments in the same doctor/scope. A positive amount is due to the doctor; a negative amount remains a proposed amount from the doctor. It never creates cash or a wage deduction and never claims finality. Incomplete prerequisites yield `provisional`.
- `convertSettlementMoney`: requires original currency, target currency, rational minor-to-minor rate, dated quote and quote ID. Returned quote and original money are frozen. No current-rate lookup exists. Cross-currency totals without this explicit source conversion are rejected.
- `treatmentCostAfterDoctorRecovery`: materials + gross doctor fee − covered material recovery, equivalent to materials + net fee. It rejects recovery above material or fee in this presentation; any separately approved additional receivable belongs to the existing finance engine.
- `packageEvidenceAction`, `reconcileEmptyPackage`: hazards override an unsafe empty-return configuration. Sharps and contaminated materials require a safe disposal record; no retrieval, return to store or handling of waste is requested. Package and evidence IDs cannot be reused within the supplied history. Empty package evidence changes neither material stock nor patient consumption nor debt. A 120 package with 80 recorded usage produces 40 unexplained, for review only. Remaining usable material needs its own inspected movement.
- `reviewReplenishment`: considers remaining stock, allows early replenishment without a nonexistent empty package, and requires an independent authorized approver and reason for emergency or target exceptions. It is an approval-policy check, not stock posting.

All currency validation reuses `requireCurrency`/`Currency` from `lib/money.ts`. Money and quantity inputs must be safe integers; totals and products use BigInt and reject unsafe output. Quantity atoms must be constructed from the immutable unit conversion snapshot by the source adapter. These APIs do not parse user-entered decimal quantities or choose WAC/FX policy.

## Requirement-to-source/test/evidence ledger

Every unit reference below is in `__tests__/inventory-treatment-custody.test.ts`. A P-number in a test name identifies the requirement's **arithmetic subset**, not that the complete acceptance scenario has run.

| Requirement | Domain source/export | Executed unit evidence | Remaining integration gate |
|---|---|---|---|
| P39 | `proportionalCostMinor` | 3/1/8 SAR, cheap pieces, overflow/invalid atoms | Persisted package versions and actual movement quantities |
| P40 | Transfer is zero consumption; package evidence zero movement | Transfer and empty-package checks only | Kit decomposition and balanced component valuation not implemented here |
| P41 | `summarizeTreatmentCost` | Two cases, exact visit, linked return, wrong/excess/duplicate returns | Existing DB adapter and UI replacement |
| P42 | `summarizeTreatmentCost` | Shared usage key duplicate rejected; over-allocation rejected | Unique PG usage/allocation constraints and transaction locks; visit signer integration |
| P43 | `summarizeTreatmentCost` | Shared visit not repeated per procedure; estimated quantities explicit | Versioned `service_materials` and confirmation UI |
| P44 | Both treatment summaries | Missing price/registration/categories/unallocated material versus known zero | HTTP result and UI labels; existing profitability path still unchanged |
| P45 | `treatmentFinancialSnapshot` | Partial stage revenue, late payment separation, cap and completion estimate | Approved agreement stage adapter; no Ortho files modified |
| P46 | `allocateOverhead`, `summarizeTreatmentResult` | Low utilization, source dedup, salary/capital rejection, exact reconciliation | Expense classification, approved period/capacity policy, source allocations across reports |
| P47 | `priceSimulation` | 180/200=10%; 25% target=240; commission and invalid denominator | Permissioned simulation UI; actual agreement engine for other bases |
| P48 | Cost/FX snapshots | Inputs unchanged; currency mixing rejected; immutable quote | Historical database snapshots; replacement quote version UI |
| P49 | `previewCustodyTransfer` | 100→70+30; partial transfer, transit and value conservation | Location ownership, dispatch/acceptance PG writes |
| P50 | `reconcileCustody` | 30−8−2=20; clinic 92 | Existing movement/return writer |
| P51 | Both custody functions | Difference review, no fabricated consumption; waste reason/approval required | Doctor-to-doctor authorization, stocktake count cutoff and locking |
| P52 | `calculateDeduction` | Collections 10000→1000 versus commission3000→300 | Agreement history snapshot from existing engine |
| P53 | `summarizeAppliedDeductions` | Theoretical1000/applied600/reversal100→D500; reversal bounds | Actual applied deduction events from commission owner |
| P54 | `proposeSettlement` | Positive/negative/zero directions | Authorized posting to existing doctor account |
| P55 | `reconcileCustody`, attributable calculation | Carry-forward consumes nothing | Opening import/period close transaction |
| P56 | `attributableConsumedCost` | Exclusions and waste held without exception | Contract item coverage and exception approval ownership |
| P57 | `proposeSettlement` | Prior 2000 then new target2500→supplement500; duplicate adjustments rejected | Concurrent approvals/idempotency/unique period lock not tested |
| P58 | Scoped settlement inputs | Wrong doctor/period rejected | Late collections, frozen source sets and cross-period consumption uniqueness |
| P59 | `convertSettlementMoney` and money validation | Explicit quote conversion; mixed currencies rejected | Approved valuation policy and displayed original/FX-difference reconciliation |
| P60 | `treatmentCostAfterDoctorRecovery` | 100+300−40=360 | Finance recovery/read-model adapter |
| P61 | Proposals have no side effects | Zero cash/wage deduction assertions | Doctor-only reads, separate review/approve/post permissions and immutable objections: not tested |
| P62 | Cost/count completeness | Unknown costs/count prevent complete proposal | Historical import preview and unknown records |
| P63 | Arithmetic composition test | Transfer→6 consumed→2 unused returned→22 custody; clinic114; cost300; settlement100 | Entire purchase/payment/patient/custody browser and PG E2E has not run |
| P64 | `reconcileEmptyPackage` | Empty receipt has zero material/consumption/debt effect | Persisted closure linked to actor and custody |
| P65 | `reconcileEmptyPackage` | 120−80=40 unexplained | Review/approved cause document |
| P66 | `reconcileEmptyPackage` | Reused package or evidence ID rejected in supplied history | Unique PG indexes and concurrent closure tests |
| P67 | `reviewReplenishment` | Early replenishment uses remaining; emergency self-approval denied | Authenticated capability source, request transitions and actor audit |
| P68 | Safety action and reconciliation | Sharp/contaminated force disposal and reject physical-return evidence | RTL/English UI and print instructions; no browser gate yet |
| P69 | Reconciliation only | No automatic charge to doctor or assistant | Any approved loss decision must be one shared source in existing finance; cross-person duplicate constraint and reversal test pending |

## Integration ownership and required unnumbered schema proposals

The following are requirements for coordination, not applied schema changes or chosen migration numbers:

1. Inventory owner: allocation relations referencing **existing** `inventory_movements`, with immutable lot/location/unit/cost snapshots, unique branch+usage identity, parent/return allocation links, consumed/returned quantity bounds, and transactional audit. Custody locations reuse clinic inventory ownership; transfer source/transit/destination is one transfer document. Never create a second quantity ledger.
2. Treatment owner: versioned `service_materials` templates and allocation relations linking movement allocation to patient, visit, procedure, case and responsible doctor. Cross-doctor shares must sum to 100% or one responsibility owner. Unassigned history remains explicitly unassigned. All supplied records must be branch-authorized and scoped before these read models run.
3. Finance/HR owner: applied-deduction and linked reversal evidence on the existing commission account; agreement version and effective event dates; frozen doctor/period/scope source membership; unique settlement source/idempotency key; signed supplemental posting and immutable reversals through existing finance writers. No salary deduction or cash payment is implicit. Scope IDs must remain stable for late collections so moving a case or changing year cannot re-use already settled material.
4. Shared costs owner: source expense allocations and policy versions proving that a salary or equipment acquisition is not loaded both directly and through overhead. Typed categories here reject an explicit invalid classification; they cannot detect an incorrectly classified database expense without the source adapter.
5. Custody package owner: unique per-package identity and evidence event, safety classification, custodian/lot/period tracking quality, independent reviewer/receiver/approver audit and exception documents. A general product barcode cannot stand in for the unique package ID. Database uniqueness must arbitrate concurrent receipts; this pure function only rejects duplicates in a supplied snapshot.
6. Security/API owner: validate runtime input, enforce patient/procedure/case/branch/doctor relationships and capability limits, redact costs before serialization, freeze source versions and permissions in the posting transaction. `approverAuthorized`, `registrationComplete`, `inventoryReconciled` and `prerequisitesComplete` are trusted server-derived attestations, never accepted from client JSON.

Exact next step: root obtains coordinated ownership/schema reservation, then implements narrow adapters and migration constraints, replaces patient-wide costing in the existing UI, and tests database concurrency and authenticated HTTP before wiring production workflows. Do not treat these pure helpers as authorization checks or durable idempotency.

## Executed verification and unrun gates

Environment: local synthetic-only workspace, Node `v22.23.3`, Vitest `4.1.11`. No production/staging connection or live data was used by this subtask.

- Before implementation: focused Vitest run, 2/2 foundation characterization tests passed at 2026-10-11 23:09 UTC.
- Final current focused run at 2026-10-11 23:16 UTC: **43/43 passed**, 1 file, exit 0. Command: `/workspace/.cloud-tools/node_modules/node/bin/node /workspace/.cloud-tools/node_modules/npm/bin/npm-cli.js test -- __tests__/inventory-treatment-custody.test.ts`.
- Targeted strict TypeScript check: passed, exit 0. Command: `/workspace/.cloud-tools/node_modules/node/bin/node node_modules/typescript/bin/tsc --noEmit --incremental false --target ES2022 --moduleResolution bundler --module ESNext --strict --skipLibCheck --esModuleInterop lib/inventory-domain/treatment-cost.ts lib/inventory-domain/custody.ts __tests__/inventory-treatment-custody.test.ts`.
- Targeted ESLint: passed, exit 0. Command: `/workspace/.cloud-tools/node_modules/node/bin/node node_modules/eslint/bin/eslint.js lib/inventory-domain/treatment-cost.ts lib/inventory-domain/custody.ts __tests__/inventory-treatment-custody.test.ts`.
- Not run by this subtask: full repository unit suite/typecheck/lint, PostgreSQL integration, migrations/restore, HTTP permissions, 390/1280 browser workflows, generated print artifact verification, production build, CI or release gates. They remain root/adapter-owned gates.
- No commit, push, merge, deploy, external message, supplier order, migration, security/CI edit or live-data mutation occurred here.

Verified source postimages at this checkpoint:

| File | SHA-256 |
|---|---|
| `lib/inventory-domain/treatment-cost.ts` | `514b00a20e02c484f9f3877717077bc647a2277954ef6a6b69686b99d6f548aa` |
| `lib/inventory-domain/custody.ts` | `ebb1cc51b043cec7958300af7238bd361dd1eb399105a99754dcf9af3a233dbc` |
| `__tests__/inventory-treatment-custody.test.ts` | `49d4ba71decc1d40522f086fb8a313558c0aa5958376458258084bc279c4d80d` |

The root executor owns Library upload/materialization IDs for this bundle. This document does not claim uploaded deliverables before upload is verified.
