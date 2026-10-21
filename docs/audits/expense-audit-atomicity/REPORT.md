# Cash / receipts / commission lane: bounded acceptance, 2026-10-20

Base source tree: `7fc0f79947ba46d0f3bd79c0f2c512e9eb531f9b`.
No published branch, Production access, historical-data mutation, migration, credential change, or AI work.

## Concrete defect and repair

Original `recordExpense` committed its cash voucher before reading the result; expense POST subsequently called best-effort `recordAudit` for creation, FX override, and prepayment. `recordAudit` swallows errors. On a fresh disposable PostgreSQL 18.6 database, a synthetic trigger rejecting `expense.create` produced HTTP 201, a persisted voucher and YER drawer 10000 → 9900 without creation evidence. A deliberate retry then produced two vouchers. This is synthetic reproduction, not a claim about live historical records. Baseline desired-invariant test FAILED as intended (see `baseline.log`).

Repair: standalone `recordExpense` reads/maps the voucher and writes its required audit events using the same transaction before COMMIT. Failed rollback destroys the connection while preserving the original write error. The route passes the authenticated role and no longer writes the three post-commit events. Direct/internal standalone calls also receive creation evidence; caller-owned `recordExpenseInTx` flows remain unchanged and retain their existing purpose-specific audits. No change to amounts, exchange-rate snapshots, journal policy, or commission engine.

Tests: 157/157 pure checks passed across 17 commission, expense, payroll and shift calculation files. 25/25 PostgreSQL checks passed: twelve new expense checks and thirteen existing payment audit/replay checks. New coverage includes three mandatory audit failure points, receipt read failure, all native currency drawers, no audit for quote/refusal, audit actor/role and rate/prepayment metadata, failed rollback discard, and settings-rate audit parity for YER, missing foreign rate and an explicit override. Expense/journal/drawer snapshots stay unchanged on rejected required audit. This repair does NOT add expense idempotency or solve unknown COMMIT acknowledgements.

## Requirement inventory (not whole-finance completion)

- Payment/refund idempotency and audit atomicity: existing implementation and existing 13-test regression rerun pass in this tranche. Covers canonical replay, receipt/refund audit rejection, concurrent exact requests and unknown COMMIT acknowledgement receipt recovery. No assertion of every payment adapter or all UI interruption journeys.
- Standalone expense audit atomicity: newly reproduced and repaired here. Expense idempotency/uncertain COMMIT retry remains a separate open acceptance gap, not closed by rollback tests.
- Native cash currencies: newly verified YER/SAR/USD expense bucket isolation. Existing `p01-final-cash-ownership.test.ts` covers foreign receipt ownership and commission settlement, but was not rerun in this tranche. Full cash-page/feed/print agreement remains open.
- Performing-doctor attribution: commission aggregation consumes `invoice_items.doctor_id` (`lib/db.ts` commissionReport); case/plan attribution freeze and detailed report suites already exist. No change or fresh full clinical-to-commission proof here. Finite acceptance still needed with coordinator A, performer B, signed invoice, correction/refund and statement totals.
- Commission statements: `app/print/commission-statement/[id]/page.tsx` explicitly consumes `commissionDetailReport` and `commissionReport`, rather than a second calculation engine. Reconciliation U25 records PR288 as shipped within its bounded print scope. Full browser/print pagination and detail-total parity across three currencies, historical rates/material deductions and performer attribution remain unverified in this tranche.
- Payroll financial posting/commission settlement: existing `payroll-journal-settlement.test.ts` covers one accrual, partial/final settlement, reversal/replay, salary+commission separation, native currencies, historical FX and payable account allocation. `hr-payroll-integrity.test.ts` covers contract snapshots and commission-policy conflicts. Implementation exists; these PostgreSQL payroll journeys were not rerun here. Full report/party statement/doctor commission agreement at each partial payment and reversal remains a finite acceptance task, not an HR rebuild.
- Shift close/Z-report: shared `lib/shift-close.ts` separates native cash, cash refunds, expenses and noncash. Existing `shift-close.test.ts` covers expected/count/difference and historic snapshots. Pure tests are separate from actual UI/Z-report acceptance; no fresh complete closing journey in this tranche. The previously denied period-close race operation is explicitly restricted and excluded, not retried or rephrased.

## Next finite financial tranche

1. Synthetic receipt retry matrix: lost response for standalone expense, explicit request identity and mismatch behavior; do not promise duplicate protection until a dedicated idempotency design/test exists.
2. One three-currency clinical/commission acceptance fixture (assigned separately by root, not duplicated in this lane) with distinct coordinator and performer; compare detailed engine, period balance, payment/refund allocation and printed input aggregates.
3. Existing payroll settlement + integrity regression tranche (assigned separately by root, not duplicated in this lane); verify salary versus commission cash, outstanding payables and journal totals after partial/full payment and reversal.
4. Ordinary non-racing shift/Z-report acceptance fixture comparing native drawer figures, noncash exclusion and saved count/difference with reports. No denied period-close race operation.

Each tranche requires its own review and evidence. Local tests are not CI/merge/Railway Production verification.
