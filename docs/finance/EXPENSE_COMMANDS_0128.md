# Expense commands (migration 0128)

Status: specification written before tests and code (2026-11-14); updated with the implementation
decisions in section 7.
Sources: owner decision on #483, comment 6831365228, items 2 and 3. Allocation and test requirements:
6833690789. Finance queue rows F1-2 and F2-4 in `docs/review/work-finance-continuation-plan-20261110.md`.
Migration allocation: `docs/review/integration-finance-ortho-merge-20261112.md` section 8.

This specification covers only migration 0128. Shift opening reviews (0129), lab payable waivers (0130)
and invoice doctor corrections (0131) have their own specifications.

## 1. Problems today

| Row | Problem | Where |
|---|---|---|
| F2-4 | No idempotency key on expense create. A double click, a retry or a lost response writes a second voucher, a second cash movement and a second audit row. | `app/api/expenses/route.ts`, `recordExpense` in `lib/db.ts` |
| F1-2 | A voucher can exceed the cash in the drawer. The close then books the gap as a cash surplus. Expenses record no payment source. | `recordExpenseInTx`, `lib/shift-close.ts`, `effectiveExpectedSql` |

## 2. Approved rules

### 2.1 Duplicate protection (owner item 3)

- Every expense create carries an `Idempotency-Key` header with the existing pattern
  `^[A-Za-z0-9._:-]{8,128}$` (`lib/idempotency-key.ts`). A create without a key is refused with 400 and
  writes nothing. The expense screen mints one key per intended voucher and reuses it for every retry
  of that voucher.
- The server stores the key and a fingerprint of the full request on the voucher (`expenses.idempotency_key`,
  `expenses.idempotency_request_hash`), the same model as payments (migration 0003). The key is unique
  across all vouchers.
- The same key with the same request returns the original voucher with status 200 and `replayed: true`.
  It writes no second voucher, cash movement, journal source or audit row.
- The same key with a different request is refused with 409 `expense_request_conflict` and writes nothing.
- Two concurrent sends of one key produce one voucher. The loser waits on the unique index, then
  takes the replay or conflict path.
- The fingerprint covers what the voucher means: actor, category, party, payee, amount, currency,
  payment rate, payable, payable rate, note, override and prepayment reasons, and the payment split
  (2.2). It does not cover the preview's `expected` values: a retry after a rate change is still
  the same request. A replay is checked before the stale-preview check and before the drawer check,
  so a lost response is never refused as stale or as exceeding the drawer.
- Reversal vouchers made by a void keep a NULL key.

### 2.2 Drawer limit and the owner's private source (owner item 2)

Every voucher records its real payment source:

| Source | `drawer_amount_minor` | `owner_private_amount_minor` |
|---|---|---|
| `drawer` | the whole amount | 0 |
| `owner_private` | 0 | the whole amount |
| `drawer_and_owner_private` | part, above 0 | the rest, above 0 |

Both parts are in the voucher currency and add up to `amount_minor`. A reversal voucher mirrors the
parts with negative signs.

- **Drawer limit (everyone).** The drawer part of a new voucher may not exceed the cash expected in
  the open shift's drawer in that currency at the moment of the write. Expected cash uses the existing
  rule (opening, plus cash in, minus cash refunds, minus the drawer parts of vouchers). A voucher over
  the limit is refused with 409 `exceeds_drawer_cash`, with the expected amount, and writes nothing.
  The check runs under one drawer-outflow lock, so two vouchers cannot both pass against the same cash.
  It applies in the shared writer, so payroll payouts and lab batch settlements obey it too.
- **Owner exception.** Only the protected owner may record a private part (`owner_private` or
  `drawer_and_owner_private`). The server proves the owner through the canonical staff runtime
  (`staff_authority_control.owner_user_id`, the proof used by `staffOperationIsProtectedOwner`). A
  manager, an accountant, a cashier or a holder of `finance.expenses.create` is not the owner. A
  legacy session cannot prove the owner, so a private part from a legacy session is refused with 403
  `owner_private_requires_owner`. A private part needs a written reason (3–300 characters); a missing
  reason, a missing or negative part, or parts that do not add up are refused with 400 and write nothing.
- **What the drawer sees.** Only the drawer part leaves the drawer. Shift expected cash, the drawer
  breakdown, the close and the cash-difference journal entry use the drawer part. A private part never
  enters drawer cash, so the close never shows it as a surplus or a shortage.
- **What the voucher still is.** The voucher's expense amount, category totals, budgets, party
  balances and payable settlement use the full amount. Example (6833690789): a payable of 1000 settled
  by 300 from the private source leaves 700 owed and the drawer unchanged. A mixed payment of 300
  (100 from a drawer holding 150, 200 private) leaves the drawer at 50 and the payable at 700.
  Nothing else is waived and the original payable expense is not counted again.
- **Audit.** The `expense.create` audit row is written in the same transaction as the voucher and
  records the amount, currency, source, both parts, the actor, the owner proof and the reason.
- **Not a transfer.** Recording a private part does not move money from any owner account. It records
  that the owner paid. It does not create a loan, capital, a second expense or an account number.
- **Revocation.** The owner proof is read inside the write transaction. If ownership changes before
  the commit, the write is refused and nothing is written.

### 2.3 Journal: the open accounting question

The derived journal today credits the cash account for the whole voucher. With the split, the drawer
part credits cash. The private part needs a credit account, and the owner said not to assume one
("إذا احتاج التنفيذ تصنيفًا محاسبيًا إضافيًا غير محسوم، اعرض السؤال المحدد قبل اختياره").

The question is posted on #483 (6878857625). Until it is answered:
- The credit account for private parts is read from a new setting, `finance.owner_private_funding_account`,
  which has no default and is owner-only to change (settings class `authority`). Only an existing postable
  equity or liability account is accepted; cash, bank, receivable, revenue and expense accounts are refused.
- The account in force is captured on the voucher (`owner_private_account_code`), so a later change of the
  setting never rewrites an earlier derived journal entry.
- While the setting is empty, a private part is refused with 409 `owner_private_account_unset` and writes
  nothing. Drawer-only vouchers are unaffected.
- Tests set the setting to a synthetic value only to exercise the path. That choice is not the owner's
  decision.

## 3. Storage (0128)

`migrations/0128_expense_commands.sql`, byte-identical to `lib/expense-commands-schema.ts`, registered
after 0132's predecessor 0126 in `ensureSchema`:

- `expenses.idempotency_key TEXT`, `expenses.idempotency_request_hash TEXT`; a unique partial index
  on the key; a CHECK that the two are both present or both absent.
- `expenses.payment_source TEXT`, `expenses.drawer_amount_minor BIGINT`,
  `expenses.owner_private_amount_minor BIGINT`, `expenses.owner_private_reason TEXT`,
  `expenses.owner_private_user_id INTEGER REFERENCES users(id)`, `expenses.owner_private_account_code TEXT`.
- CHECK `expenses_payment_source_valid`:
  - all five are NULL (a voucher written before 0128: the whole amount came from the drawer, which
    was the only source), or
  - the source is one of the three values, the parts have the sign of `amount_minor`, add up to it,
    and match the source; a private part needs a reason and the owner's user id, and a drawer-only
    voucher has neither.
- Nullable, no default, no backfill. Readers use `COALESCE(drawer_amount_minor, amount_minor)`.

## 4. Readers changed

| Reader | Change |
|---|---|
| `effectiveExpectedSql`, `shiftDrawerBreakdown`, `drawerBreakdown` | Drawer part, not the full amount |
| Shift close and its cash-difference entry | Through the breakdown above |
| Derived journal expense entry | Drawer part credits cash; private part credits the configured account |
| Expense list and receipt | Show source and parts |
| Void | Reversal mirrors the parts; the drawer part returns to today's open drawer; the private part returns to no drawer |

Party balances, payable settlement, the daily expense report, budgets and `financeSummary` keep the
full amount.

## 5. Tests (failure first)

PostgreSQL, real route, synthetic data:
1. Replay: lost response, double submit, second identical send → one voucher, one audit row, 200
   `replayed`.
2. Conflict: same key, changed amount, note or split → 409, nothing written.
3. Race: two concurrent sends of one key → one voucher; two concurrent different vouchers against
   one drawer → one accepted, one `exceeds_drawer_cash`.
4. Missing or malformed key → 400, nothing written.
5. Drawer limit for a manager and a cashier, in each currency.
6. Owner: drawer only, private only, mixed. Non-owner with `finance.expenses.create` (canonical and
   legacy) → 403 with nothing written. Missing reason, parts that do not add up, negative parts → 400.
7. Owner revoked between admission and commit → refused, nothing written.
8. Balances: expected cash, close difference zero, payable 1000 → 700 with a private 300, mixed 300 with
   drawer 150 → drawer 50, payable 700.
9. Journal: balanced entry, drawer part on cash, private part on the configured account; unset
   setting → 409 for a private part, drawer-only unaffected.
10. Void of a mixed voucher → mirrored parts, drawer back by the drawer part only.
11. Storage: CHECK refuses each invalid shape; legacy rows (all NULL) read as drawer.
12. Upgrade, re-initialisation and a fresh database; the migration file equals the runtime constant.

## 6. Limitations stated up front

- The owner exception works only for sessions on the canonical staff runtime, because only that runtime
  proves the owner. Until the clinic moves to it, no one, the owner included, can record a private part:
  on legacy sessions the drawer limit applies to everyone.
- Cash refunds are not capped by drawer cash. That is a separate rule, not part of this decision.
- Payment sources other than the drawer and the owner's private source (bank, transfer) are not added.

## 7. Implementation decisions (2026-11-14)

| Topic | Decision |
|---|---|
| Owner proof | Only the canonical staff runtime proves the protected owner. `POST /api/expenses` gains a canonical branch (`lib/canonical-expense-create.ts`, the first route of M2 slice 97) with the runtime action `finance.expenses.create`. A legacy session that sends a private part is refused with 403 `owner_private_requires_owner`. |
| Rate override and prepayment on the canonical branch | The legacy route gave both to the admin label. The canonical branch takes each from its own grant: `finance.fx.manage` for a rate different from the settings, `finance.payables.record` for a prepayment above a supplier's balance, or the protected owner. Neither is granted automatically. |
| Lock order | The request-key lock comes first. The drawer-outflow lock comes after the party and payable row locks, so the lab batch and payroll writers keep the lock order their concurrency tests pin. A private-only voucher takes no drawer lock. |
| Writer | `recordExpenseOn(client, …)` runs the whole create (replay, voucher, receipt read, audit rows) on a caller-owned transaction. `recordExpense` wraps it in its own transaction; the canonical command runs it inside the admitted operation. |
| Journal | The drawer part credits the cash account of the voucher currency; the private part credits the captured account. A void mirrors both. |
| Screen | The expense form shows the private-source fields only to the protected owner on a canonical session. The finance page reads remain on the legacy runtime until the rest of slice 97. |
| Test fixtures | Fixtures that paid out of an empty drawer now open a funded drawer; assertions that pinned an overdrawn drawer use the float. No assertion was removed. |
