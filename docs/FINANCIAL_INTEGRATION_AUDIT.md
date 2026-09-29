# Financial Integration Audit — AQLAN CENTER MINI

Audited on the current `main` (34fde0a, 2026-09-29). Earlier audit reports were **not** trusted: every finding below was re-checked in code and, where marked, reproduced on PostgreSQL 18.

Rule under test: **ONE EVENT → ONE FINANCIAL TRUTH.**

## 1. Source of truth map

Paths are UI → API → server function → DB table → audit → downstream (reports/accounting).

| Number | Source of truth | Path | Downstream |
|---|---|---|---|
| **Patient invoice** | `invoices` + `invoice_items`. Currency is `invoices.base_currency`; there is **no** exchange-rate snapshot. | Clinical visit «مراجعة وإنهاء» → `POST /api/visits/:id/clinical {action:"sign"}` → `signClinicalVisit` (row lock `FOR UPDATE … signed_at IS NULL`). Manual invoice: `POST /api/invoices` → `createInvoice` (FIN-4 authority). Correction: `correctInvoice` (FIN-2, cancel + reissue). Installment: `recordPlanInstallment`. | Patient ledger (`ledgerBalancesByCurrency`), debts report, commissions (`commissionReport`, per currency), Executive `billingByCurrency`, journal `invoiceEntry` |
| **Payment / receipt / refund** | `payments` (append-only triggers 0005). Stores `amount_minor`+`currency`, `exchange_rate`, `base_amount_minor` (YER), idempotency key + hash, `reversal_of_id`, and a settlement target (invoice / plan / opening currency). | `POST /api/payments` → `recordPayment` (shift lock, target resolution, partial refunds ≤ original) | Patient ledger, shift expected (cash only), finance summary, journal `paymentEntry` (base), commissions (collected basis) |
| **Cashier shift** | `cashier_shifts` (expected and difference stored at close, 0014) | `/api/shifts` → `openShift`, `closeShift` (blind count; a difference needs a reason) | Journal `cashDifferenceEntry` (converted to base at the shift's own rate), Z report |
| **Expense / voucher** | `expenses` (append-only; void = negative reversal row). Settlement snapshot columns (0013). | `POST /api/expenses` → `recordExpense`/`recordExpenseInTx` (over-payment guard, party balance guard, admin-only prepayment with reason, stale-quote guard) | Party statement, payables remaining, shift expected, finance summary, journal `expenseEntry` |
| **Supplier / lab payable** | `payables`. Settled total = snapshots + `expense_payable_allocations`. | Lab order cost → `createLabOrder`/`updateLabOrderAccounting`. Manual bill: `POST /api/payables` → `createPayable`. Stock purchase: `createInventoryMovement` (0017). **Opening: `/api/party-openings` → `createPartyOpeningPayable` (new, 0030).** | Party statement (`partyStatementTotals`, per currency), suppliers report, Executive, journal `payableEntry` / **`openingPayableEntry`** |
| **Lab orders** | `lab_orders` + `lab_order_tracking` | `/api/lab`, `/api/lab/:id` (status, remake, delete) | Payable, lab board, case profitability, commissions (lab deduction) |
| **Inventory** | `inventory_movements` (append-only). Weighted-average cost (`lib/inventoryCost.ts`), derived. | `/api/inventory/*` → `createInventoryMovement` | Valuation report, service material cost, case profitability |
| **Treatment plans** | `treatment_plans`, `plan_items`, `plan_installments`, `treatment_sessions` | `/api/plans` (v2 / template / legacy) → `createPlanV2`; items → `addPlanItem`; consent; installments | Visit billing (plan price per billing rule), patient ledger (plan currency target), commissions |
| **Doctor commissions** | Derived (`lib/commission.ts`) from invoices, payments, lab costs and rates history (0012) | `/api/finance/commissions` → `commissionReport` | Payout vouchers (`expenses`, party kind `doctor`) |
| **Patient opening balances** | `patient_opening_balances` (+history), per currency | `/api/opening-balances` | Ledger, debts report; journal (**YER only** — see F-06) |
| **Party opening balances (NEW)** | `payables` with `source_type='opening'`, plus `payable_adjustments` and `party_opening_advances` | `/api/party-openings` | Party statement, suppliers report, Executive `payableByCurrency`, journal Dr 3101 / Cr AP |
| **Accounting journal / trial balance** | **Derived** from documents on read (`journalEntries`) plus `journal_manual` | `/api/accounting`, `/api/export?kind=journal` | Trial balance, income statement, balance sheet, Executive expenses and cash, FX revaluation |
| **Reports Center / Executive** | Reads canonical per-currency models (`executiveFinancialReadModels`) plus the ledger for expenses and cash | `/api/finance/report`, `/api/executive` | UI, CSV, PDF |

## 2. Findings

Status legend: **FIXED** in this PR, **FIXED (other PR)**, **OPEN** (documented, with the reason it was not done here).

| ID | P | Finding | Root cause | Status |
|---|---|---|---|---|
| **F-01** | **P0** | Legacy lab/supplier debts from before go-live could not be recorded without distorting the books: a `payables` row is booked Dr expense / Cr AP, so an old debt became a current-period expense. | Parties had no opening-balance model. | **FIXED** — 0030 plus opening payables (`source_type='opening'`), journal Dr 3101 / Cr AP, append-only corrections, opening advances, `/finance/opening` tab. Scenario C test. |
| **F-02** | **P1** | Executive "ما علينا" read only account **2101**. Lab payables mapped to 2102–2105 (lab accounting V2) were **missing** from liabilities. | `balanceOf(…, AP_ACCOUNT)` | **FIXED** — sums 2101–2105. |
| **F-03** | **P1** | Executive liabilities were a single base-equivalent number that mixed currencies. | No per-currency payables read model. | **FIXED** — `payableByCurrency` from `partyBuckets` (the same numbers as the party statements), shown per currency and in the CSV. |
| **F-04** | **P1** | A voucher paying an old debt would have appeared as an «مصروف» in the daily/monthly finance summary. | `financeSummary` grouped every voucher as an expense. | **FIXED** — `openingSettlements` is separated: included in net cash, excluded from expenses. |
| **F-05** | **P1** | **TD-REG-028**: the derived journal books invoice legs **raw in the invoice currency** (SAR/USD minors) and payments in YER base. AR and Revenue mix units for foreign-currency invoices, so the accounting screen, trial balance and income statement are wrong **whenever SAR/USD invoices exist**. | Invoices carry no exchange-rate snapshot; `invoiceEntry` has no currency dimension. | **FIXED by FIA-2.** The ledger is currency-dimensional: every line carries its currency, entries balance per currency, cross-currency settlements go through clearing account 1901 using recorded amounts, and statements are per currency. See `MULTI_CURRENCY_LEDGER_AUDIT.md` and `MULTI_CURRENCY_LEDGER_DESIGN.md`. |
| **F-06** | P2 | Patient opening balances in SAR/USD are not journaled (YER only). | Owner decision: no conversion at a guessed rate; same root as F-05. | **FIXED by FIA-2** — journaled natively in their own currency (Dr 1201[c] / Cr 3101[c]). |
| **F-07** | P2 | Permanent deletion of a lab order accepted **no reason** on the server; the UI prompt said «اختياري». | Optional parameter. | **FIXED** — mandatory (≥ 3 characters) in the route **and** in `deleteLabOrder`; UI prompt required; `verify-deletions` journey. |
| **F-08** | P2 | `partyBalances()` (parties list, lab list) nets **base equivalents** at different days' rates. A SAR bill paid in SAR can show a small FX residue. The per-currency statement is correct. | Legacy summary before P0-2. | **Partly FIXED by FIA-2**: Executive's party breakdown now reads per (party, currency) through `partyDueByCurrency`. The parties list and lab list screens still show the legacy summary: OPEN, display only. |
| **F-09** | P2 | A stock purchase from a supplier always creates a **YER** payable; there is no currency choice. | `createInventoryMovement` hard-codes the base currency. | OPEN — see `PURCHASING_GAP_ASSESSMENT.md` (B-2). |
| **F-10** | P2 | A **cash** stock purchase (no supplier) has no linked cash voucher. Inventory rises, but the cash effect depends on the user recording a separate voucher. | Stock purchase flow has no payment option. | OPEN — PURCHASING B-1. |
| **F-11** | P2 | A **purchase return to supplier** has no supplier credit. The "out" movement reduces stock, but the supplier's payable stays whole. | No return flow. | OPEN — PURCHASING B-3. |
| **F-12** | P2 | Inventory purchases are **expensed at purchase** (Dr supplier expense). The chart of accounts has no inventory asset, so consumption is not journaled. The valuation report is derived separately (WAC), so the balance sheet and valuation differ by design. | Simplified periodic expensing. | OPEN — documented design limitation (PURCHASING D-1). |
| F-13 | P3 | `/api/export?kind=payables` exports the original amount, not the corrected amount. | — | OPEN (minor) |
| **F-14 (L-03)** | **P1** | **Voided vouchers were never reversed in the journal.** The negative reversal row was dropped (`baseAmountMinor <= 0 → null`), so cash, expense and AP stayed as if the voucher stood. | Builder guard. | **FIXED by FIA-2** — a reversal row is the exact mirror of the original (PG18 Scenario 6 and the Scenario 5 void). |

**Verified OK** (tested on PostgreSQL 18 in this PR or earlier):
- **Visit sign idempotency:** a concurrent double sign produces one invoice (Scenario A).
- **Payment idempotency and partial refunds** (P1-1 / P1-FIX-5).
- **Shift expected** = opening + cash receipts − refunds − cash vouchers, per currency (P1-3, Scenario A).
- **Supplier over-payment guard and reversal** (P0-2, Scenario B).
- **Cross-currency supplier payment snapshot** (Scenario C).
- **Commission per currency and lab deduction** (P0-1, TD-REG-029).
- **Plan settlement targets:** foreign → foreign payments fail closed (`settlePaymentMinor`).

## 3. Reconciliation scenarios (PostgreSQL 18)

| Scenario | Test | Proves |
|---|---|---|
| **A** Clinical visit → invoice → collection → shift → accounting → reports | `__tests__/postgres/financial-reconciliation-scenarios.test.ts` | Double click gives 1 invoice. 30,000 is the same in the ledger, journal (4101 / 1201 = 0 / 1101), finance summary and shift expected (difference 0). |
| **B** Stock purchase → inventory → payable → payment | same file | 100 × 2,500 gives stock +100 and payable 250,000. Payments of 100,000 then 150,000 leave remaining 0; over-payment is refused; stock is untouched; AP ends at 0. |
| **C** (mandatory) Legacy lab/supplier debt → opening liability → statement → partial payment → remaining → accounting → reports | `__tests__/postgres/party-opening-balances.test.ts` | Entering 300,000 YER / 1,000 SAR / 500 USD gives the same numbers per currency in statements and Executive, and **the current-period income statement is unchanged**. Paying 100,000 leaves settled 100,000, remaining 200,000, cash −100,000, and **period expense 0**. Corrections are append-only and cannot go below what was paid. The DB refuses silent edits and deletes. Advances are handled separately. |

## 4. Multi-currency ledger design (for F-05) — implemented by FIA-2

**Chosen: currency-dimensional books.**
- Every journal line carries its `currency`, and each entry balances **per currency**.
- A payment that crosses currencies (for example a USD payment settling a YER target, or a YER voucher settling a USD payable) is split through a **currency-exchange clearing account** (for example 1901), so each currency's books balance on their own.
- The trial balance, income statement and balance sheet are presented per currency.
- This matches the owner's rule that YER / SAR / USD stay separate, and needs **no guessed historical rates**. Historical SAR/USD invoices have no rate snapshot, so a base-currency journal cannot book them without inventing one.

**Rejected: base-currency journal with a rate snapshot.**
- It requires a snapshot on every invoice. That can only be added going forward.
- Historical foreign documents would either be excluded (AR goes negative when their payments are included) or converted at a guessed rate, which the owner forbade.

**Scope of the redesign:**
- `lib/accounting.ts` builders and statements.
- `journalEntries`.
- `journal_manual_lines.currency` (additive column, default YER).
- FX revaluation (becomes a translation view; native foreign cash needs no revaluation).
- Executive cash movements.
- Accounting screen and CSV.

## 5. Tests run for this PR

See the PR description for exact commands, counts and the `verify:full` result.
