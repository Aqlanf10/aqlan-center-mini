# Multi-Currency Ledger Audit (TD-REG-028 / F-05)

Read-only audit of the derived journal on `main` at **eaaca85** (after PR #120), done before any change.

Rule under test: **ONE CURRENCY UNIT PER ACCOUNTING LINE.** No balance, sum or account may add YER + SAR + USD minors unless it has a currency dimension or a recorded, proven conversion.

## 0. How the ledger works today

- The journal is **derived on read** (`lib/db.ts → journalEntries(from, to)`) from documents, plus `journal_manual(_lines)`.
- `JournalLine = { accountCode, amountMinor, side }`. It has **no currency field**.
- `isBalanced` compares total debits with total credits across the whole entry, regardless of unit.
- `trialBalance` keys balances by `accountCode` only. `incomeStatement` and `balanceSheet` return one scalar per account and one total.
- The code comments state the intent: "the books are all in one currency (YER base)". That intent is **not** what the invoice builder does.

## 1. Journal builders

| # | Builder | Source document | Unit it receives | Unit it books | Accounts hit | Balances per currency? | Base or raw | Mixed-unit risk |
|---|---|---|---|---|---|---|---|---|
| 1 | `invoiceEntry` | `invoices` (currency = `invoices.base_currency`, can be YER/SAR/USD) | `total_minor`, `discount_minor` **in the invoice currency** | **raw invoice-currency minors** | Dr 1201 AR, Dr 4201 discount, Cr 4101 revenue | Only by accident (single-unit entry, but no tag) | **RAW** | **HIGH.** 1,000.00 SAR books as 100000 on AR and revenue, next to YER minors. AR and 4101 become meaningless as soon as one SAR/USD invoice exists. |
| 2 | `paymentEntry` | `payments` | `base_amount_minor` (YER equivalent at the payment's recorded rate) | **YER base** | Dr 1101/1102/1103 (cash) or 1111/1112/1113 (bank) by *payment* currency, Cr 1201 | Unit is YER, but the account is labelled SAR/USD | **BASE** | **HIGH.** A SAR invoice paid in SAR: AR is debited 100000 SAR-minors (invoice) and credited 40,000,000 YER-minors (payment), so AR never reaches 0. The "SAR cash" account 1102 holds YER numbers. |
| 3 | `openingBalanceEntry` | `patient_opening_balances` | `amount_minor` in its currency | YER only; SAR/USD rows are **filtered out** (`o.currency = 'YER'`) | Dr 1201, Cr 3101 | n/a | BASE (YER rows only) | **F-06**: foreign opening receivables are missing from the books entirely, so the ledger AR ≠ the patient ledgers. |
| 4 | `openingPayableEntry` (FIA-1) | `payables` `source_type='opening'` | effective base equivalent (`payableBaseAmountSql`) | **YER base** | Dr 3101, Cr AP (2101 or party code) | Unit is YER | BASE | Medium: a 1,000 SAR legacy debt is booked as its settings-rate YER equivalent, not natively. Correct in value, but it can't reconcile with the per-currency party statement. |
| 5 | `openingAdvanceEntry` (FIA-1) | `party_opening_advances` | `base_amount_minor` | YER base | Dr AP, Cr 3101 | YER | BASE | Same as #4. |
| 6 | `payableEntry` | `payables` `source_type='operational'` | `base_amount_minor` | YER base | Dr expense (category/party code), Cr AP | YER | BASE | Medium: a USD lab bill is booked in YER at the bill's rate, so ledger AP can't be compared with the USD party statement. |
| 7 | `expenseEntry` | `expenses` (vouchers) | `base_amount_minor` | YER base | Dr expense **or** Dr AP (lab/supplier party), Cr 1101/1102/1103 by voucher currency | YER | BASE | Medium: a USD voucher credits "USD cash" 1103 with YER minors. **BUG (F-14):** `if (baseAmountMinor <= 0) return null` drops **void reversal rows** (negative amounts), so **a voided voucher stays in the books** as cash out and an expense or AP debit. |
| 8 | `cashDifferenceEntry` | `cashier_shifts` (closed) | counted − expected **in the drawer currency** | converted to YER at a *computed* rate (`effectiveRate` of that shift's payments, else the **settings rate today**) | Dr/Cr 5961 vs cash[c] | YER | BASE (derived rate) | Medium: a SAR shortage is booked at a rate that is not recorded anywhere, and that rate can change between two reads (settings fallback). |
| 9 | `revaluationEntry` + `postRevaluation` | computed and written as a `journal_manual` entry | difference in YER | YER | Dr/Cr cash[c] vs 5951 | YER | BASE | By design of the base book: it translates foreign cash to today's rate. Once the ledger is native, foreign cash is **already** in its own units, so this adjustment has no meaning (see §4). |
| 10 | Manual journal (`POST /api/accounting` → `createManualEntry`) | user input | `parseAmount(…, CLINIC_BASE_CURRENCY)` (YER) | YER; `journal_manual_lines` has **no currency column** | any postable account | Whole-entry balance only | BASE (implicit) | An accountant can't post a SAR entry. Every historical manual line was entered and validated as YER. |

## 2. Statements and readers

| Reader | What it does | Risk |
|---|---|---|
| `trialBalance(entries)` | Sums debits and credits per `accountCode` across all entries | **Mixed**: raw SAR/USD invoice minors + YER base payments on 1201 and 4101; YER amounts on the SAR/USD cash accounts. |
| `incomeStatement(balances)` | Revenue (4101), discount (4201), expenses and net profit as one scalar each | **Mixed** revenue; the net profit mixes units. |
| `balanceSheet(balances)` | One total for assets, liabilities and equity, plus `differenceMinor` | **Mixed**. It "balances" only because every entry is self-balancing in raw numbers; the totals are not money. |
| `/api/accounting` GET (+ account ledger with running balance) | Trial balance, income statement and balance sheet exactly as above | **Mixed** (F-05). |
| `/api/export?table=journal` | CSV rows: date, source, reference, description, account, debit, credit | **No currency column.** A 100000 on 1201 could be YER, SAR or USD minors. |
| `fxReport` / `postRevaluation` | Reads the base balance of 1102/1103 (+1112/1113) against units held | Relies on the base book; see §4. |
| Executive (`executiveKpis`) | Billing and receivables from canonical per-currency read models (P-01 fix). **Expenses, cash movements and `payableMinor` come from the journal as YER base scalars.** | Expenses: base (and voids not reversed, F-14). Cash: YER amounts shown per drawer. `payableMinor`: a base scalar next to the canonical `payableByCurrency`. |
| Finance summary / reports centre / debts / suppliers / lab / commissions | **Do not read the journal.** They read documents with per-currency grouping (P-01 guard) or recorded base equivalents. | Out of the journal's blast radius; they are the reconciliation target. |
| Patient ledger / party statement | Canonical per-currency buckets (`patientBalancesByCurrency`, `partyBuckets`) | Correct. This is the truth the journal must match. |

## 3. Settlement rules that exist today (the journal must honour them)

- **Patient payment** (`recordPayment`; read side `settlePaymentMinor`):
  - Same currency as its target: the payment settles `amount_minor` of that bucket.
  - Target in YER, paid in SAR/USD: settles `base_amount_minor` YER, the equivalent **recorded at payment time**.
  - Target in SAR/USD, paid in another currency: **refused at creation** (`cross_currency_not_supported`). Such a row found on read fails closed (`FinancialCurrencyIntegrityError`).
  - A refund inherits the target and the rate of its origin.
- **Supplier/lab voucher** (`recordExpenseInTx`; read side `settledOnPayableSql`, `partyBuckets`):
  - Every linked voucher carries a snapshot: `payable_currency`, `payable_exchange_rate`, `payable_settled_minor`.
  - Grouped settlements carry the same data per payable in `expense_payable_allocations` (`paid_minor` in voucher currency, `settled_minor` in payable currency).
  - The unlinked remainder is an advance in the voucher currency.
  - Voids are negative mirror rows, including negative allocations.
- **Opening balances:**
  - Patients: per currency (`patient_opening_balances`).
  - Parties: per currency (`payables` `source_type='opening'` + `payable_adjustments`, `party_opening_advances`).

These rules mean every cross-currency settlement the system can create **already has a recorded amount in both currencies**. The journal can therefore be made native in every currency **without inventing a single rate**.

## 4. FX revaluation today

- `fxReport` compares two things:
  - the units of SAR/USD "held" (payments − vouchers in that currency);
  - the **YER book value** of the SAR/USD cash and bank accounts.
- It posts the difference as a manual YER entry (Dr/Cr cash[c] vs 5951).
- **Which rate:** settings today. **Which date:** `asOf`.
- Its purpose is to keep a base-currency book of foreign cash at today's value (IAS 21 translation).
- In a native ledger that purpose disappears. 1102 holds SAR, and 100 SAR stays 100 SAR whatever the rate does. Foreign-currency value changes belong in a **translation view** (units × a stated rate, informational), not in native books.
- **Historical revaluation entries already posted** are YER-unit manual lines on 1102/1103/5951. They stay exactly as recorded (YER), and remain visible as a YER bucket on those accounts. Nothing is deleted or rewritten.

## 5. Findings

| ID | P | Finding | Evidence |
|---|---|---|---|
| **L-01 (= F-05, TD-REG-028)** | **P1** | Invoice legs are raw invoice-currency minors, payments are YER base. AR, revenue, discount, trial balance, income statement, balance sheet, accounting screen and journal CSV are all wrong once any SAR/USD invoice exists. | `invoiceEntry` vs `paymentEntry`. PG18 repro in `__tests__/postgres/multi-currency-ledger.test.ts` (Scenario 1 on baseline: AR ≠ 60,000 SAR-minors). |
| **L-02 (= F-06)** | P1 | SAR/USD patient opening balances are absent from the journal. | `o.currency = 'YER'` filter. |
| **L-03** | P1 | **Voided vouchers are never reversed in the journal.** The reversal row has a negative amount and `expenseEntry` returns `null` for ≤ 0. The ledger overstates cash out, expenses and AP debits after every void. | `expenseEntry` guard + `voidExpense` negative mirror row. PG18 repro (Scenario 6b). |
| **L-04** | P2 | Journal lines carry no currency, so no export, CSV or account ledger can say which unit a number is in. | `JournalLine` type. |
| **L-05** | P2 | Manual journals can only be entered in YER (`parseAmount(…, base)`), and the table has no currency column. | `app/api/accounting/route.ts`. |
| **L-06** | P2 | The cash-count difference is booked at a derived (not recorded) rate that can change between reads (settings fallback). | `journalEntries` shift loop. |
| **L-07** | P2 | Executive expenses, cash movements and `payableMinor` are YER-base scalars read from the journal. Cash per drawer is shown in YER. | `lib/executive.ts`. |
| **L-08** | P2 | FX revaluation is defined against the base book and becomes meaningless once the book is native. | `fxReport`. |
| **L-09** | P3 | The money aggregation guard does not cover `payables`, `payable_adjustments`, `party_opening_advances`, `expense_payable_allocations` or `journal_manual_lines`, and does not look at journal aggregation in TypeScript. | `lib/money-aggregation-guard.ts`. |

### Baseline reproduction on PostgreSQL 18.6 (main eaaca85)

Setup, then the trial balance was read:
- a SAR invoice of 1,000.00 SAR;
- a SAR payment of 400.00 SAR at rate 140;
- a YER electricity voucher of 5,000, then voided.

| Account | Baseline balance | True value |
|---|---|---|
| 1201 AR | **44,000** (100,000 SAR-minors − 56,000 YER) | 600.00 SAR (60,000 SAR-minors), 0 YER |
| 1102 Cash SAR | **56,000** (YER amount on the SAR drawer) | 400.00 SAR (40,000) |
| 5502 electricity | **5,000** (voided voucher still an expense) | 0 |
| 1101 Cash YER | **−5,000** (void not reversed) | 0 |

All 14 cases of `__tests__/postgres/multi-currency-ledger.test.ts` fail on the baseline.

**Not a finding** (verified): finance summary, reports centre, debts, suppliers, lab reconciliation, commissions, party statements and patient ledgers do not read the journal. They are per-currency (P-01, P0-2, FIA-1) and are used as the **reconciliation target** in the new tests.

## 6. Decision

The FIA-1 proposal (**currency-dimensional ledger**) still fits the current code best:

- Every cross-currency flow the system allows already stores both sides (see §3), so native books need **no** rate at all.
- A base-currency book would need an FX snapshot on every invoice. That can only be added going forward, and historical SAR/USD invoices would then need a guessed rate, which the owner forbade.

The implementation is described in `MULTI_CURRENCY_LEDGER_DESIGN.md`.
