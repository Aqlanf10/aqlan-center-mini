# Treatment cost and doctor custody domain contract

## Checkpoint and scope

- Base/HEAD: `148fcbeac229cb279848e6ea37049d1599a4fafe`; active branch `feat/inventory-completion-20261015` (Draft PR #338).
- Authoritative attachment: Library `libfile_05f8e16e32508191aefa2093c44f9a21`, consumer materialization `/workspace/inventory-task/source/scope-read.md`, 499 lines. SHA-256 `ed47678714550343cc489825db47686bbbf36c2446b8344229c8d2a90ac53e81`.
- Pure domain contracts live in `lib/inventory-domain/treatment-cost.ts` and `lib/inventory-domain/custody.ts` (`49` passing unit tests in `__tests__/inventory-treatment-custody.test.ts`), and the transactional store/schema proposal lives in `lib/inventory-domain/custody-store.ts` and `lib/inventory-domain/custody-schema-proposal.ts` (`13` passing PostgreSQL 18.6 integration tests in `__tests__/postgres/inventory-custody-transfer.test.ts`).
- `custody-store.ts` reuses existing `inventory_movements` for clinic consumption (`custody.consume` and `custody.approve_waste` + `approved_waste`) without writing any supplier payable, expense, commission, wage deduction, or cash payment. No migration number is selected or reserved (`29` additive tables across `schema-proposal.ts` and `custody-schema-proposal.ts` remain unnumbered).
- Shared `lib/db.ts`, `lib/session.ts`, `lib/migrations.ts`, `schema/*`, `migrations/*`, and supplier/commission/invoice writers remain untouched.
- `AGENTS.md` was read.

## Reproduced foundation findings

| Finding | Exact checkout evidence | Executed evidence | Status |
|---|---|---|---|
| INV-15 | `issuedCostForPatient` in `lib/db.ts` selects all patient movements, filters `out`, and sums them without linked returns or a visit/case selector | Source inspection only; no shared `lib/db.ts` mutation in this branch | Existing application fix pending coordinated adapter |
| INV-16 | Existing treatment UI depends on a patient material total rather than these exact allocations | Attachment finding; owned `/inventory/custody` verifies patient/visit/case/procedure on custody consumption | Existing clinical UI repair pending owner |
| INV-17 | `calculateProcedureProfitability({ serviceName: 'Synthetic', revenueMinor: 20000 })` returns direct cost zero and tier `excellent` | Foundation characterization test passed before new modules were created | New `summarizeTreatmentResult` reports missing categories; existing profitability/UI remains unchanged |
| INV-18 | Existing `materialCost` returns theoretical cost; `db.ts` caps net earned at zero | Characterization test confirms theoretical cost 1000 and no applied amount; cap inspected at `netEarnedMinor` | New D computation requires actual applied source events; posting integration pending |

The initial focused run contained **2 passing foundation characterizations**, not two resolved application findings. The current focused unit run contains **49 passing unit tests** in `__tests__/inventory-treatment-custody.test.ts` (plus **83 passing unit tests** in `__tests__/inventory-procurement-domain.test.ts` and **30 passing PostgreSQL 18.6 integration tests** across `__tests__/postgres/inventory-procurement-store.test.ts` and `__tests__/postgres/inventory-custody-transfer.test.ts`). Complete integrated acceptance remains **0/69**.

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
- `canonicalSettlementPeriodId`, `proposeSettlement`: normalizes `"YYYY"` and `"YYYY-annual"` to canonical `"YYYY-annual"`; target = D−A; supplemental amount = target − all previous signed posted adjustments in the same doctor/scope. Every `priorAdjustments` entry must have `postingState === "posted"` and a unique non-empty `postedEntryId` (`unposted_settlement_adjustment`, `duplicate_adjustment`). `sourceBacked` defaults to `false` so unbacked worksheets remain `provisional`. It never creates cash or a wage deduction and never claims finality.
- `convertSettlementMoney`: requires original currency, target currency, rational minor-to-minor rate, dated quote and quote ID. Returned quote and original money are frozen. No current-rate lookup exists. Cross-currency totals without this explicit source conversion are rejected.
- `treatmentCostAfterDoctorRecovery`: materials + gross doctor fee − covered material recovery, equivalent to materials + net fee. It rejects recovery above material or fee in this presentation; any separately approved additional receivable belongs to the existing finance engine.
- `classifyDefaultPackageSafety`, `resolvePackageSafetyWithFieldObservation`, `packageEvidenceAction`, `reconcileEmptyPackage`: `classifyDefaultPackageSafety` is a conservative fail-closed baseline heuristic until authoritative item/package safety registration metadata is added to `inventory_items` / `inventory_item_unit_versions` in a future root-coordinated migration; `resolvePackageSafetyWithFieldObservation` can only escalate hazard (never downgrade `sharp` or `contaminated` to `none`, and never override a safe `none` package's registered `policy`). Sharps and contaminated materials require a safe disposal record; no retrieval, return to store or handling of waste is requested. Package and evidence IDs cannot be reused within the supplied history. Empty package evidence changes neither material stock nor patient consumption nor debt.
- `reviewReplenishment`: considers remaining stock, allows early replenishment without a nonexistent empty package, and requires an independent authorized approver and reason for emergency or target exceptions. It is an approval-policy check, not stock posting.

All currency validation reuses `requireCurrency`/`Currency` from `lib/money.ts`. Money and quantity inputs must be safe integers; totals and products use BigInt and reject unsafe output. Quantity atoms must be constructed from the immutable unit conversion snapshot by the source adapter. These APIs do not parse user-entered decimal quantities or choose WAC/FX policy.

## Requirement-to-source/test/evidence ledger

Every unit reference below is in `__tests__/inventory-treatment-custody.test.ts` (`49/49` passing), with PostgreSQL 18.6 persistence verified in `__tests__/postgres/inventory-custody-transfer.test.ts` (`13/13` passing). A P-number in a test name identifies the requirement's **verified subset**, not that the complete integrated acceptance scenario has run (`0/69` integrated acceptance).

| Requirement | Domain source/export | Executed unit / PG18 evidence | Remaining integration gate |
|---|---|---|---|
| P39 | `proportionalCostMinor` | 3/1/8 SAR, cheap pieces, overflow/invalid atoms | Persisted package versions and actual movement valuation adapter |
| P40 | Transfer is zero consumption; package evidence zero movement | Transfer and empty-package checks | Kit decomposition and balanced component valuation not implemented here |
| P41 | `summarizeTreatmentCost`, `recordCustodyUsage` | Two cases, exact visit, linked return, wrong/excess/duplicate returns; PG18 verified `patientId`/`visitId`/`caseId`/`procedureId` & `doctorOwnsPatient` | Shared clinical UI/visit-signer replacement |
| P42 | `summarizeTreatmentCost`, `recordCustodyUsage` | Shared usage key duplicate rejected; PG18 unique `usage_key` + `pg_advisory_xact_lock` | Visit signer integration |
| P43 | `summarizeTreatmentCost` | Shared visit not repeated per procedure; estimated quantities explicit | Versioned `service_materials` and confirmation UI |
| P44 | Both treatment summaries | Missing price/registration/categories/unallocated material versus known zero | Existing profitability path replacement |
| P45 | `treatmentFinancialSnapshot` | Partial stage revenue, late payment separation, cap and completion estimate | Approved agreement stage adapter; no Ortho files modified |
| P46 | `allocateOverhead`, `summarizeTreatmentResult` | Low utilization, source dedup, salary/capital rejection, exact reconciliation | Expense classification, approved period/capacity policy |
| P47 | `priceSimulation` | 180/200=10%; 25% target=240; commission and invalid denominator | Permissioned simulation UI |
| P48 | Cost/FX snapshots | Inputs unchanged; currency mixing rejected; immutable quote | Historical database snapshots; replacement quote version UI |
| P49 | `previewCustodyTransfer`, `dispatchCustodyTransfer`, `acknowledgeCustodyTransfer` | 100→70+30; partial transfer, transit and value conservation on PG18 and HTTP/browser | Coordinated transfer migration |
| P50 | `reconcileCustody`, `recordCustodyUsage` | 30−8−2=20; clinic 92; PG18 `consumed`, `approved_waste`, and `returned_to_store` verified | Shared clinical writer integration |
| P51 | `reconcileCustody`, `recordCustodyStocktake` | Difference review, no fabricated consumption; PG18 `custody.stocktake` holds variance for review | Store-wide stocktake cutoff and variance posting |
| P52 | `calculateDeduction` | Collections 10000→1000 versus commission 3000→300 | Agreement history snapshot from existing engine |
| P53 | `summarizeAppliedDeductions` | Theoretical 1000/applied 600/reversal 100→D 500; reversal bounds | Actual applied deduction events from commission owner |
| P54 | `proposeSettlement`, `proposeAnnualCustodySettlement` | Positive/negative/zero directions; PG18 canonical `periodId` (`2026-annual`) and `provisional` status | Authorized posting to existing doctor account |
| P55 | `reconcileCustody`, `attributableConsumedCost`, `proposeAnnualCustodySettlement` | Carry-forward consumes nothing; closing custody excluded from A | Opening import/period close transaction |
| P56 | `attributableConsumedCost`, `approveCustodyWaste` | Exclusions and waste held without exception; PG18 independent admin `custody_waste_approvals` enforced | Contract item coverage adapter |
| P57 | `proposeSettlement`, `proposeAnnualCustodySettlement` | Prior 2000 then new target 2500→supplement 500; unposted adjustments and missing `postedEntryId` rejected | Coordinated financial settlement posting |
| P58 | Scoped settlement inputs | Wrong doctor/period rejected; canonical `YYYY-annual` normalization and advisory lock | Late collections and frozen cross-period source sets |
| P59 | `convertSettlementMoney` and money validation | Explicit quote conversion; mixed currencies rejected | Approved valuation policy and displayed FX-difference statement |
| P60 | `treatmentCostAfterDoctorRecovery` | 100+300−40=360 | Finance recovery/read-model adapter |
| P61 | `readDoctorCustody`, `objectCustodySettlement` | Zero cash/wage deduction assertions; PG18 doctor-only reads and immutable settlement objections | Separate settlement approval/posting integration |
| P62 | `proposeAnnualCustodySettlement`, `reconcileHistoricalMovements` | Unknown costs/count keep proposal `provisional`; PG18 `legacy.reconcile` quarantines missing-expiry lots and rejects outflow-before-inflow | Opening migration and historical importer |
| P63 | Arithmetic & PG18 custody composition | Transfer→consume→waste→return→stocktake→package closure→settlement proposal verified on PG18 | Full purchase→payment→patient→custody E2E unrun |
| P64 | `reconcileEmptyPackage`, `closeCustodyPackage` | Empty receipt has zero material/consumption/debt effect; PG18 verifies authoritative `packageId` and `evidenceEventId` | Coordinated migration registration |
| P65 | `reconcileEmptyPackage`, `closeCustodyPackage` | 120−80=40 unexplained for review only; multi-tranche quantities persisted in `custody_package_closures` | Persist investigation and independently approved cause |
| P66 | `reconcileEmptyPackage`, `closeCustodyPackage` | Reused package/evidence IDs and already-closed tranches rejected on PG18 with advisory + unique locks | Coordinated migration registration |
| P67 | `reviewReplenishment` | Early replenishment uses remaining; emergency self-approval denied | Authenticated capability source and request transition integration |
| P68 | `classifyDefaultPackageSafety`, `resolvePackageSafetyWithFieldObservation`, `closeCustodyPackage` | Sharp/contaminated force disposal and forbid hazard downgrade (`package_hazard_downgrade_forbidden`) on PG18 | Authoritative item/package safety registration columns |
| P69 | Reconciliation only | No automatic charge to doctor or assistant (`automaticDebtMinor: 0`, `automaticFinancialAdjustmentMinor: 0`) | Shared finance loss-decision adapter |

## Integration ownership and required unnumbered schema proposals

The following remain requirements for root-coordinated integration, with **29 additive tables** proposed across `lib/inventory-domain/schema-proposal.ts` (19) and `lib/inventory-domain/custody-schema-proposal.ts` (10) and no migration number self-assigned:

1. Inventory owner: allocation relations referencing **existing** `inventory_movements`, with immutable lot/location/unit/cost snapshots, unique branch+usage identity, parent/return allocation links, consumed/returned quantity bounds, and transactional audit.
2. Treatment owner: versioned `service_materials` templates and shared visit-signing adapters linking movement allocation to patient, visit, procedure, case and responsible doctor. In `custody-store.ts`, `recordCustodyUsage` already verifies `patients`, `visits` (rejecting unlinked walk-in visits with `visit.patient_id === null`), `treatment_plans`, `planned_visits`, and `doctorOwnsPatient` across all supplied clinical IDs.
3. Finance/HR owner: applied-deduction and linked reversal evidence on the existing commission account; `postedEntryId` linkage when a settlement adjustment is posted to the financial ledger.
4. Shared costs owner: source expense allocations and policy versions proving that a salary or equipment acquisition is not loaded both directly and through overhead.
5. Custody package owner: authoritative item/package hazard and policy columns on `inventory_items` / `inventory_item_unit_versions` so `classifyDefaultPackageSafety` heuristics are replaced by registered master data.
6. Security/API owner: allowlisted `safeInventoryErrorMessage`, `publicInventoryErrorCode`, `sanitizeInventoryAuditDetails`, and structured `correlationId` logging on `/api/inventory/procurement`.

## Executed verification

Environment: Node `v22.23.3`, PostgreSQL `18.6` (isolated synthetic database), Vitest `4.1.11`.
- Focused unit tests (`__tests__/inventory-treatment-custody.test.ts` + `__tests__/inventory-procurement-domain.test.ts`): **132/132 passed** (`49` treatment/custody + `83` procurement).
- PostgreSQL 18.6 integration tests (`__tests__/postgres/inventory-custody-transfer.test.ts` + `__tests__/postgres/inventory-procurement-store.test.ts`): **30/30 passed** (`13` custody + `17` procurement).
- TypeScript `npm run typecheck`: **passed (0 errors)**.
