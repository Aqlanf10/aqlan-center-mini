# Multi-Currency Ledger Design (closes TD-REG-028 / F-05, F-06)

Audit and findings: `MULTI_CURRENCY_LEDGER_AUDIT.md`.

## 1. Rule

**ONE CURRENCY UNIT PER ACCOUNTING LINE.**

- Every journal line carries `currency` (YER, SAR or USD) and `amountMinor` in **that** currency's minor units.
- An entry is balanced **per currency**: for each currency, debits = credits.
- No balance, statement or total adds two currencies together. Any base-currency (YER) equivalent is either absent or explicitly labelled as informational translation at a stated rate. It is never booked.

## 2. Why native books and not a YER base book

- A base book needs an FX snapshot on **every** invoice.
- Historical SAR/USD invoices have none. Converting them means inventing a rate, which the owner forbade.
- Every cross-currency settlement the system can create **already stores both amounts**:
  - patient payment to a YER target: `amount_minor` in the payment currency plus `base_amount_minor` YER at the rate recorded that day;
  - supplier/lab voucher: `payable_settled_minor` / `expense_payable_allocations.settled_minor` in the payable currency, plus the paid amount in the voucher currency.
- So native books need **zero** rates.

## 3. Currency clearing account

- The chart has no clearing/position account. 5951 «فروقات أسعار الصرف» is an expense and cannot carry a per-currency position.
- Added (additive, in the code chart):
  - `19` «حسابات وسيطة» (asset group);
  - `1901` «مقاصة تحويل العملات» (asset).
- A cross-currency settlement books each currency's leg against 1901, so **each currency balances on its own**:

```
Patient pays 400.00 SAR on a 56,000 YER invoice (rate 140 recorded on the receipt):
  SAR: Dr 1102 Cash SAR      40,000   Cr 1901 Clearing [SAR]   40,000
  YER: Dr 1901 Clearing [YER] 56,000  Cr 1201 AR [YER]         56,000

Clinic pays 106,000 YER on a 500.00 USD lab bill (snapshot: settles 200.00 USD):
  YER: Dr 1901 Clearing [YER] 106,000  Cr 1101 Cash YER       106,000
  USD: Dr 2101 AP [USD]        20,000  Cr 1901 Clearing [USD]  20,000
```

- 1901 holds the clinic's **currency conversion position**. Translated at the recorded rates of its own transactions it nets to zero. It is never netted across currencies inside the books.
- **Gain/loss:** none is booked. Both legs come from the same recorded snapshot, so a settlement realises no FX difference inside the books. A current-rate view of 1901 and of foreign cash is available as *informational translation* only (§7).

## 4. Builders (lib/accounting.ts)

| Builder | Lines (each tagged with a currency) |
|---|---|
| `invoiceEntry` | In the invoice currency: Dr 1201 net, Dr 4201 discount, Cr 4101 gross. |
| `paymentEntry` | Payment currency P, amount A; settlement target T with settled S (`settlePaymentMinor`: same currency → A; YER target → `base_amount_minor`; foreign → foreign fails closed). If P = T: Dr cash/bank[P] A, Cr 1201[P] A. Otherwise: Dr cash/bank[P] A, Cr 1901[P] A; Dr 1901[T] S, Cr 1201[T] S. A refund mirrors this (the refund inherits its origin's target and rate). |
| `openingBalanceEntry` | **All currencies**, natively: Dr 1201[c], Cr 3101[c] (closes F-06). |
| `openingPayableEntry` | Party debt, natively: Dr 3101[c], Cr AP[c] at the **effective** amount (original + append-only adjustments). |
| `openingAdvanceEntry` | Dr AP[c], Cr 3101[c]. |
| `payableEntry` | Dr expense[c], Cr AP[c] at `amount_minor` in the payable currency. |
| `expenseEntry` | Voucher currency C, amount A. Cr cash[C] A, then: **direct expense** (no lab/supplier party) → Dr expense[C] A. **Party voucher**: for each settlement piece (the linked payable, or each grouped allocation) with paid P in C and settled S in payable currency PC: if PC = C and S = P → Dr AP[C] P; otherwise Dr 1901[C] P, Cr 1901[PC] S, Dr AP[PC] S. The unallocated remainder U → Dr AP[C] U (advance in the voucher currency, same as the party statement). **Negative amounts (void reversal rows) produce the exact mirror** (fixes L-03). |
| `cashDifferenceEntry` | Natively: counted − expected in the drawer currency, Dr/Cr 5961[c] vs cash[c]. No derived rate (fixes L-06). |
| Manual journal | Each line carries a currency; balanced per currency (see §5). |

Every builder uses **the same settlement quantities the patient ledger and the party statement read** (`settlePaymentMinor`, `settledOnPayableSql`, allocations, `payableAmountSql`). The journal therefore reconciles with them by construction, and the tests prove it.

## 5. Manual journal

- Additive migration `0031_journal_line_currency.sql`: `journal_manual_lines.currency TEXT NOT NULL DEFAULT 'YER' CHECK (currency IN ('YER','SAR','USD'))`.
- **Historical compatibility:**
  - Every existing manual line was entered through `parseAmount(…, CLINIC_BASE_CURRENCY)` into a book whose unit was YER base, and was validated as YER.
  - So `YER` is the **factually correct** unit for every existing row. No rate, no rewrite, no delete.
- **New entries:**
  - Every line must name its currency; it is parsed with that currency's minor units.
  - The entry must balance **per currency**. `Dr 1102 100 SAR / Cr 4101 100 YER` is refused (400, Arabic message).
  - An entry may hold several currencies only if each one balances (for example a manual conversion through 1901).
  - Validation is enforced in `createManualEntry` itself (server side), not only in the route.
  - The audit record stores the per-line currency.

## 6. Statements

- `trialBalance(entries)` returns one row per **(account, currency)**. There is no cross-currency total.
- `incomeStatement(balances, currency)` and `balanceSheet(balances, currency)` are computed per currency. `statementsByCurrency(balances)` returns one pair per currency with activity.
  - Each currency's balance sheet balances on its own (assets = liabilities + equity + period result), because every entry balances per currency.
- The accounting screen shows: account, currency, debit, credit, balance; statements are grouped by currency.
- The account ledger (running balance) is per account **and** currency.
- CSV `table=journal` gains a currency column on every line.
- **No base-equivalent total** is shown for statements. Historical SAR/USD invoices carry no FX snapshot, so a base total would need a guessed rate. **BY CURRENCY ONLY.**

## 7. FX revaluation (redefined, not silently removed)

- The old path posted a YER adjustment on foreign cash (a base-book translation).
- In native books foreign cash **is** its own unit, so there is nothing to revalue inside the books:
  - `POST /api/finance/fx` now refuses with **409** and the Arabic reason «الدفاتر بعملاتها الأصلية — لا يُرحَّل قيد إعادة تقييم».
  - `GET` returns a **translation view**: for each foreign currency, the native cash+bank balance **from the journal**, the settings rate and the date read, and the informational YER equivalent. It is labelled «للعلم — غير مرحَّل».
- **Historical revaluation entries** already posted stay exactly as recorded (YER manual lines on 1102/1103/5951). The translation view lists them so the accountant can see them, and reverse them with an audited manual entry if they choose. Nothing is deleted.

## 8. Executive

- Billing and patient receivables stay on the canonical per-currency models (P-01). No regression.
- Expenses: `expensesByCurrency` from the native income statement of each currency. The YER-base scalar is removed.
- Cash: `cashMovements` per drawer, **native amounts in the drawer's own currency** (1,500.00 SAR shows as 1,500.00 SAR).
- Payables:
  - canonical `payableByCurrency` (party buckets);
  - `payableLedgerByCurrency` from the journal (2101–2105 per currency) as a cross-check that is tested equal;
  - the YER-base `payableMinor` scalar is removed.
- CSV: every money row carries its currency.

## 9. Guard

`lib/money-aggregation-guard.ts` is extended to:

- **SQL:**
  - cover `payables`, `payable_adjustments` (`delta_minor`), `party_opening_advances`, `expense_payable_allocations` (`paid_minor`, `settled_minor`) and `journal_manual_lines`;
  - require `GROUP BY currency`, a single-currency filter or a per-entity key.
- **TypeScript:** a new ledger rule flags any reduction over journal-line/balance amounts (`amountMinor`, `balanceMinor`, `debitMinor`, `creditMinor`) in files that import from `lib/accounting` without a `currency` key in the same expression.
  - `lib/accounting.ts` is exempt, because it is the per-currency reducer itself.

## 10. Out of scope (unchanged, documented)

- **Patient payment in a currency different from a foreign (SAR/USD) invoice or plan is still refused at creation** (TD-05 `cross_currency_not_supported`).
  - Nothing stores a recorded settlement amount in the target currency for such a payment.
  - Enabling it means adding a recorded settlement snapshot to patient payments, as P0-2 did for vouchers. That is a payment-product change, not an accounting one.
  - The journal builder already books it correctly if it ever exists (clearing on a recorded S), and a unit test covers that.
- Purchasing B-1/B-2/B-3, Backup/Restore and TD-08A are not touched.
