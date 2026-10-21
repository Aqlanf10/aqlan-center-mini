# Supplier/lab financial report parity: bounded read repair

## Scope and evidence

Reconciles U14 (native supplier/lab vouchers/statements), U21 (complete, truthful reports/export/PDF) and M05 (financial integrity) from the 2026-10-20 requirements reconciliation. PR365 statement-native parity is already closed for its documented scope and is not reimplemented here. This is a read-only report repair, not approval of every financial journey.

The reviewed starting tree is `7fc0f79947ba46d0f3bd79c0f2c512e9eb531f9b`.

`lib/reports.ts: suppliersReport` independently used original `payables.amount_minor` and raw `expenses.payable_settled_minor`. `lib/db.ts: PAYABLE_SELECT` instead uses effective principal (append-only `payable_adjustments`) and the existing historical null-snapshot settlement fallback. Consequently a corrected opening balance or a historical settled payable could have different outstanding amounts in its statement and supplier report.

Baseline executable witness: `__tests__/suppliers-report-parity.test.ts`, first 10 cases: 7 fail, 3 recorded-snapshot cutoff controls pass. Example: native principal 10,000 corrected by -2,000 still reported 10,000; historical same-currency settlement 3,000 reported zero. Cross-currency historical fallback is equally omitted. Fixtures are synthetic, not observations of real patient/supplier records.

## Repair

- Reuse `payableAmountSql` and `payableSettledTotalSql` from the report.
- Optional bound-parameter clinic-date cutoff applies independently to correction, direct expense and batch allocation timestamps. Without the optional cutoff the helpers produce their original live-reader SQL.
- Preserve recorded settlement snapshots and the pre-existing historical fallback verbatim. Do not invent an FX rate, use today's rate, modify a receipt or merge currencies.
- Preserve existing report scope: payables created by the cutoff and still outstanding, not a net party balance. Explain explicitly that unallocated payments/opening advances are not subtracted.
- No migration, financial write, Production access, or UI redesign. Shared code overlap is only the two canonical SQL helpers and their small cutoff type/helper; report overlap is the import and supplier function.

## Remaining requirement gaps (not completion claims)

1. Supplier/lab payment and reversal acceptance: `__tests__/postgres/supplier-payable-overpayment.test.ts` already contains exact remaining/overpay, YER→USD, SAR→USD, frozen FX snapshot, concurrency, quote drift, reversal and batch cases. Existence is not a fresh pass. Rerun its real PostgreSQL suite on the composed release and reconcile source/payable/statement/report; do not redo PR365.
2. Reporting cutoff policy remains bounded to recorded event time here. Opening `as_of_date` versus entry time is not redesigned. A backdated opening entered after cutoff is still outside this report. A complete accounting-effective-date historical report needs an explicit contract, not an incidental query change.
3. Current party print reads `partyStatement` (live totals) and has no historical cutoff input. Do not claim it matches an arbitrary past-date supplier report. Render long multi-page YER/SAR/USD statements/vouchers and verify PDF text, native amounts, reversals, allocation details and every page; JSX presence alone is insufficient. No browser/PDF witness was executed in this slice.
4. Monthly report currently labels `invoice native base-currency revenue - expenses.base_amount_minor` as accrual net. `loadContext` loads expenses by payment created_at and does not load incurred unpaid payables. That is a hybrid metric, not demonstrated complete accrual profit. Next finite tranche: create one unpaid payable + later partial payment fixture and prove monthly labels/arithmetic; first clarify presentation without inventing expense recognition policy.
5. Aging reports bucket each patient's full outstanding native-currency balance by their oldest uncovered debt, as the current subtitle/notes state. This is not invoice-level due-date aging. Acceptance must test the stated method, date boundaries and export; not assume conventional invoice aging from the title.
6. U21 remains open for per-report filter semantics, native KPI-to-detail reconciliation, source completeness/caps, CSV/export and multi-page PDF parity. This supplier read patch does not close all financial reports.

## Validation limits

- Focused local regression: 73/73 across supplier parity, statement totals/UI and report/statement arithmetic.
- New supplier parity regression on PostgreSQL 18.6: 13/13, session UTC and clinic Asia/Aden. This proves future correction, direct reversal and allocation reversal exclusions at clinic midnight, native-currency handling and legacy fallback without receipt rewriting.
- Existing `__tests__/postgres/supplier-payable-overpayment.test.ts`: 29/29 on the same owned disposable PostgreSQL 18.6 cluster, including cross-currency snapshot, overpay, concurrent settlement, reversal and batch-allocation guards. Cluster stopped after the runs.
- PGlite alone does not prove timezone handling; the PostgreSQL run above is the boundary witness.
- Changed-file lint: zero errors, nine existing unused-variable warnings in db/reports. No full compiler, full suite, browser/PDF or Production verification is claimed by this slice.
