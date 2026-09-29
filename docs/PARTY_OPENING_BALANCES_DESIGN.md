# Party Opening Balances — ديون المعامل والموردين السابقة لبدء النظام (FIA-1)

## The problem (verified on `main` @ 34fde0a)

- Patients already had a proper opening-balance mechanism: `patient_opening_balances`, per currency, journaled Dr AR / Cr 3101.
- Parties (labs, suppliers) had **none**. The only way to record "we owed Lab A 350,000 before go-live" was a normal `payables` row.
- The journal books every `payables` row as `payableEntry`: **Dr expense / Cr AP**. So an old debt would have landed in the *current* period's lab or material expenses, and the current income statement would have been wrong.
- Workarounds such as a fake expense, a fake purchase or a fake lab order would each have distorted a report: expenses, inventory, lab board or commissions.

## Options considered

| | Option A — separate `party_opening_balances` table | **Option B — `payables` with an explicit, unambiguous marker** (chosen) |
|---|---|---|
| Settlement (voucher, snapshot, over-payment guard, reversal, grouped settlement) | Would need a **second** settlement engine, or a link table plus special cases in `recordExpense`. That duplicates the financial engine, which the brief forbids. | Reused **as is**: a voucher pays an opening payable exactly like any payable (`payable_id`, per-currency snapshot, `exceeds_payable`, `voidExpense`). |
| Party statement, suppliers report, aging, party balance guard | Every reader would need to union a second source. | Already reads `payables`, so each reader needs only the marker. |
| Risk of being treated as a current expense | None | Removed where it matters: the journal skips `source_type = 'opening'` in `payableEntry` and books it Dr 3101 / Cr AP. No purchase or expense report reads `payables` (verified: only the journal, the suppliers report, statements, balances and exports do). |

**Decision: Option B.** The liability has one source of truth (`payables`) and one settlement engine. `source_type` is a constrained column, so an opening row cannot be confused with an operational one.

## Schema — migration `0030_party_opening_balances.sql` (additive only)

- `payables.source_type TEXT NOT NULL DEFAULT 'operational'`, `CHECK (source_type IN ('operational','opening'))`.
- `payables.as_of_date DATE`, `payables.reference TEXT`, `payables.opening_reason TEXT`.
- `CHECK`: an opening row has `as_of_date` and `opening_reason`, no `lab_order_id`, and `amount_minor > 0`.
- **`payable_adjustments`** (append-only; DB trigger blocks `UPDATE`/`DELETE`): `payable_id`, signed `delta_minor ≠ 0`, `reason` of at least 3 characters, `created_by`, `created_at`.
  - Effective amount = `amount_minor + Σ delta`.
  - The original value always stays visible.
- **`party_opening_advances`**: "we prepaid the supplier before go-live".
  - It is a **positive** amount with its own meaning. It is not a negative payable.
  - Columns: `currency`, `amount_minor`, `exchange_rate`, `base_amount_minor`, `as_of_date`, `reference`, `note`, `reason`.
  - It is voided (`voided_at`, `voided_by`, `void_reason`), never deleted. A trigger blocks `DELETE` and any change except the one-time void.
- **Trigger `payables_opening_guard`**: an opening payable cannot be deleted, and its money fields (party, amount, currency, rate, base, as-of date, reason) cannot be updated. Operational payables are untouched by the guard (lab flows keep working).
- Factory reset (`RESET_WIPE_TABLES`) wipes the two new tables together with `payables`. It uses `TRUNCATE`, which does not fire row triggers.

## Accounting semantics

| Event | Journal (derived) | Current-period P&L |
|---|---|---|
| Opening payable 350,000 YER as of 2026-08-31 | Dr 3101 Opening equity / Cr AP (party's payable account, default 2101), dated `as_of_date` | **no change** |
| Correction to 330,000 | The opening entry is re-derived at the corrected value (at the original rate) | no change |
| Payment 100,000 YER (voucher linked to the opening payable) | Dr AP / Cr Cash (existing `expenseEntry`, `settlesPayable`) | **no change** |
| Opening advance 200 SAR | Dr AP (debit balance = advance) / Cr 3101 | no change |

In the daily/monthly finance summary, vouchers that settle an opening payable are reported as **`openingSettlements`**. They are included in net cash but **excluded from `expenses`**.

## Multi-currency

- Each opening row keeps its own currency (YER / SAR / USD). Lab A with 100,000 YER + 500 SAR shows two buckets, never "100,500".
- A cross-currency payment uses the existing snapshot model:
  - The voucher keeps its payment currency and amount.
  - It also stores `payable_currency`, `payable_settled_minor` and `payable_exchange_rate`.
  - The remaining amount is computed in the liability currency.
- The base equivalent (for the base-currency derived ledger) uses the configured rate at entry time. This is stored as `exchange_rate` and `base_amount_minor` on the row, the same practice as every other payable.

## Permissions and audit

- Create, correct and void are **admin only**, with a mandatory reason.
- Reading is open to users who can see financial reports.
- Audit rows are written **inside the same transaction**: `party_opening.create`, `party_opening.adjust` (from → to, settled, reason), `party_advance.create`, `party_advance.void`. All are in `SENSITIVE_ACTIONS`.
- Duplicate protection: the same party + currency + amount + as-of date + reference is refused (409) under a row lock on the party.
- A correction cannot go below what has already been paid ("money that left is not erased by a correction").

## UI

`/finance/opening` has two tabs: «أرصدة المرضى السابقة» (unchanged) and «ديون المعامل والموردين السابقة».
- **Entry form:**
  - Kind: "دَينٌ علينا" or "رصيدٌ مقدَّم لنا".
  - Party, amount, currency, as-of date, optional due date, reference (old statement or invoice number), note, reason.
- **Per-currency totals:** remaining, owed, settled and advance.
- **Per-row display:**
  - «رصيد افتتاحي حتى …».
  - «الاستحقاق: غير معروف» when no due date is given. The system never invents a due date.
  - Correction history showing «أُدخل أولًا …» and each signed correction with reason, actor and date.
- **Party page:** an opening payable carries a «رصيد افتتاحي» badge and is paid with the normal «سداد» button. The printed statement shows the opening part and the advance per currency.

## Multiple legacy invoices vs one balance

- The minimum is supported: one balance per party per currency as of a date.
- Where old invoices are known, the owner can enter several opening rows, each with its own reference, due date and note. They remain opening liabilities, never operational invoices.

## Import (deferred — documented plan)

- A CSV/Excel import of party opening balances is **not built in this PR**.
- The plan:
  - Reuse the patient-import preview pattern (`/api/patients/import`).
  - Columns: Party Name, Kind, Currency, Opening Balance, As Of Date, Reference, Note.
  - Match existing parties by exact name and kind.
  - An unknown party is flagged; it is never auto-created.
  - Re-import is caught by the same duplicate key.
  - One transaction for the whole batch, and an after-import report.
- Reason for deferring: party counts in the clinic are small (tens), and the manual form covers them safely.

## Tests

- **Unit:** `__tests__/party-opening-schema.test.ts` checks that migration 0030 is byte-equal to `PARTY_OPENING_SQL`, that the migration is additive only, and that factory reset wipes the new tables.
- **PostgreSQL 18:** `__tests__/postgres/party-opening-balances.test.ts` — **Scenario C** (see `docs/FINANCIAL_INTEGRATION_AUDIT.md`).
