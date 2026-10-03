# Direct expense reversal versus shift close

## Evidence boundary

Source audited at local commit `5e532043a4614deda74725420dececcff22f3885`, tree
`c8a890f13d54c028730431eccd4613acdb48b586`, identical to released main 212
`114ddb677d6e58c18ce8e241f9c44eccdc850189`.

Status: **local implementation with reproduced before/after evidence, not released**.
The only application change is the direct expense-reversal branch's original-shift
lock/recheck. No migration, historical financial source, saved shift snapshot, or
Production data was changed. No financial loss or actual Production incident is
established. The red baseline is tests-only commit
`dc41825a63cde60e17fa0caf6f43d77bdb34c7de` on the audited source.

Final focused run: **four expected regression failures and four passing controls,
all eight cases executed on PostgreSQL 18.4**, 6.11 seconds total / 1.26 seconds in
tests. The unchanged domain runtime returned success for a direct reversal into a
newly closed shift in each currency. Stored expected/count remained 8,000 while
recomputed expected and derived GL cash became 10,000. The reversal-first test also
failed: close computed too early and returned a 2,000 `difference_reason_required`.
Supplier close, supplier history/current-shift, already-closed direct refusal and
duplicate controls passed. These failures are assertion counterexamples, not
connection or setup errors.

Raw final log: workspace `expense-void-close-pg18.V70tQI/postgres.log`. The runner
stopped that owned cluster; `pg_ctl status` confirmed no server running. Data/logs
were retained. This proves a synthetic source/closed-snapshot divergence; it does
not establish an actual Production incident or monetary loss.

The first invocation had exited 137 before tests reported. Its stopped cluster and
logs remain in `expense-void-close-pg18.glbsr2`; it supplies no regression evidence.
The one permitted retry retained identical test semantics, adopted the previously
successful proof's `max_connections=12` / `shared_buffers=16MB`, used workspace
TMPDIR/compile cache, constrained Node heap to 256 MB and explicitly used one Vitest
worker. Focused TypeScript syntax/transpilation, ESLint and shell syntax passed;
no full typecheck/build/browser verification was attempted.

## Highest-confidence bounded source finding

The non-supplier branch of `voidExpense` does not serialize its admission against
closing the original shift:

- `lib/db.ts:11629–11642` reads `s.status` in a join but locks only `e` (`FOR UPDATE OF e`)
- `lib/db.ts:11670–11685` gives supplier/payable reversals a locking current-shift
  lookup, while direct reversals trust the previously read status
- `lib/db.ts:11700–11722` inserts the negative mirror into the original `shift_id`
  without another shift-status check
- `lib/db.ts:8642–8668` separately locks the shift, reads its sources, and freezes
  expected/count/difference before commit

A direct reversal can therefore read the open state, a concurrent close can freeze
and commit its count, and the reversal can then append to that closed shift. Its
foreign key checks the shift's existence, not open status. Even if that FK waits
for close, it does not re-run the domain admission check after the wait.

Existing guards do not close this gap: `lib/db.ts:1918–1969` and migration 0005
protect expense UPDATE/DELETE, `lib/supplier-payment-schema.ts:61–82` protects
settlement UPDATE, and `lib/shift-close-schema.ts:27–37` prevents updating an
already closed shift. None checks shift status on expense INSERT.

The implemented prospective repair locks/rechecks the exact original shift using
`FOR SHARE` in the existing direct-void transaction and preserves `closed_shift`
refusal. The lock is retained through the mirror insert/commit. It does not move a
direct historical reversal into another shift, change supplier semantics, repair
old data, or add a second ledger.

## Fixed-runtime verification

- Same eight-case focused suite: **8/8 passed**, 4.46 seconds, log
  `expense-void-close-pg18.vIv0v1/postgres.log`, SHA-256
  `a4828d38f838982e52d912e9c4ec1a3f738d38f04a1770db9f5f33965bad6fe7`
- Six-file related suite: **129/129 passed**, 21.16 seconds, covering those same
  eight tests plus shift-close, supplier-payable-overpayment, multi-currency-ledger,
  expense-category-history-containment and manual-cash-containment; log
  `expense-void-close-pg18.UEZnd3/postgres.log`, SHA-256
  `d13ab9fe1c1a90118f768efc5e50e9414e3406bab92778a750c2d2813f669ce4`
- Counts overlap and must not be summed. No source assertion, trigger, domain
  function or test outcome was weakened between the red and green focused runs
- Red baseline log SHA-256:
  `cf5be8d2f2fa379c847e83caadbd39f1d1be16e9fda2d9376af34c25d9cc3876`
- Both fixed-runtime clusters were stopped; `pg_ctl status` independently reports
  no server running for all four owned attempts. All synthetic data/logs retained
- Money aggregation guard, focused test syntax/transpilation, test ESLint, Bash
  syntax and diff checks passed. Combined DB/test ESLint initially exceeded the
  explicitly constrained 256 MB Node heap; that aborted invocation is not a pass.
  A sequential DB-only lint with a 512 MB heap then passed with the same eight
  unchanged-source warnings and no errors (`expense-void-close-db-lint.log`)
- Full typecheck, aggregate unit/HTTP suite, exact-head CI, merge and Railway
  verification remain separate release gates. No UI or Production operation ran

## Canonical event trace and preserved controls

### Patient cash receipt and reversal

- Receipt/refund source: `payments`; `recordPayment` delegates to its canonical
  transaction (`lib/db.ts:9256–9266`), locks the open shift (`9575`), and records
  source linkage, native currency, amount, exchange-rate/base snapshots and
  idempotency data (`9734–9752`)
- Refunds require an origin, same currency, inherited target and recorded rate;
  cumulative refunds are bounded under the origin lock (`9534–9561`, `9666–9673`,
  `9714–9726`). Correction remains append-only reversal plus replacement
- Drawer uses cash methods only, adds receipts and subtracts refunds independently
  in YER/SAR/USD (`lib/shift-close.ts:39–65`)
- GL derives the same payments, resolves their settlement target and uses recorded
  settlement quantities (`lib/db.ts:14074–14093`, `14198–14217`);
  `lib/accounting.ts:345–377` sends cash to 1101/1102/1103 and transfers to bank,
  with per-currency clearing when settlement currency differs. Refunds mirror
  both sides rather than deleting the receipt

### Expense and payable payment

- Physical expenditure source: `expenses`; payable payments also retain settlement
  currency/amount/rate snapshots (`lib/db.ts:11435–11464`, `11512–11531`)
- Ordinary expense insertion locks the selected open shift in the same INSERT
  (`11521–11525`), unlike the missing direct-reversal fence
- Drawer subtracts the expense in its own currency, so its negative reversal adds
  back the same native amount (`lib/shift-close.ts:60–64`)
- GL derives the voucher and linked settlement/allocation
  (`lib/db.ts:14105–14125`, `14248–14280`); `expenseEntry` debits AP for supplier/lab
  settlement instead of charging the cost twice and always credits native cash.
  Negative reversals mirror the entry (`lib/accounting.ts:534–587`)
- Supplier reversal already locks the current open shift and mirrors saved
  settlement/allocation quantities (`lib/db.ts:11670–11682`, `11700–11732`), so an
  original closed shift remains unchanged

### Close and report cutoff

- Expected is opening + native cash receipts − native cash refunds − native
  expenses, with transfer money excluded (`lib/shift-close.ts:44–65`)
- Close freezes expected/count/difference under its shift row lock and requires a
  reason for a nonzero difference (`lib/db.ts:8642–8668`)
- Stored expected wins over later recomputation (`lib/db.ts:8514–8522`), and GL
  books only the saved close difference on the clinic calendar close date
  (`14283–14295`; `lib/accounting.ts:597–616`)
- Source journal timestamps are selected by inclusive clinic calendar dates
  (`14069–14148`). Accounting GET reads history from 0001-01-01 through the end date
  once, then distinguishes prior opening, period activity and cumulative closing
  per account/currency (`app/api/accounting/route.ts:43–70`;
  `lib/accounting-reports.ts:36–64`). This preserves PR192, not a claim of immutable
  posting-policy history or a transactionally consistent multi-query snapshot

PR203 manual-cash containment remains intact (`lib/db.ts:14558–14571`). Broader
durable manual movement/opening reconciliation and party/lab posting-history
controls remain separately PARTIAL in the live matrix. They are not required to
repair this specific race, and no old journals or counts should be rewritten.

## Deterministic regression contract

`__tests__/postgres/expense-void-close-race.test.ts` calls actual domain writers.
The only instrumentation is test-only PostgreSQL triggers in a fresh synthetic DB.
Controllers hold named advisory locks; tests observe actual `pg_stat_activity`
lock waits. A polling interval is not a pass condition. Domain promises capture
both resolution and rejection immediately, and barriers are released in finally.

1. Close wins, repeated for YER/SAR/USD: receive 10,000 native minor units, expense
   2,000, then pause actual close after it writes expected/count 8,000 but before
   commit. Start direct void while the old open row remains visible; observe its
   lock wait. Release close. Require exact `closed_shift`, no mirror/no success
   audit, original voucher unchanged, stored and recomputed expected 8,000 and
   source cash 8,000. A pre-fix success with source/recomputed 10,000 but stored 8,000
   is the counterexample, not an accepted result
2. Reversal wins: pause actual direct reversal before INSERT/FK checks after
   admission. Start close with count 10,000. It must wait, then include the committed
   mirror and freeze 10,000 with zero difference. Early difference refusal is a
   regression failure, not a passing concurrency outcome
3. Supplier close wins: the existing supplier fence must wait then return exact
   `no_shift`, leaving voucher/payable settlement unchanged
4. Supplier historical control: reverse an old closed-shift supplier payment into
   the currently open shift, preserving the old snapshot and zeroing settlement
5. Direct historical control: a different open shift must not authorize reversing
   the direct voucher from an already closed shift
6. Duplicate control: force a second direct reversal to wait on the origin; require
   one mirror, one audit, and exact `already_voided` for the second caller

The suite contains eight test cases because the close-wins case is parameterized
across all three currencies. Existing coverage only checks already-closed direct
expense refusal and ordinary expense insertion during close:
`__tests__/postgres/supplier-payable-overpayment.test.ts:359–364` and
`__tests__/postgres/shift-close.test.ts:129–149`.

## Lock order and verification boundaries

The narrow direct-void fence follows the existing void order:
original expense row, then target shift row. Close locks its shift but only reads
expenses, so it does not wait on the original expense row. Do not change the
supplier/lab/party lock order or expand into global locking without separate proof.
PR203 manual fencing deliberately does not row-lock its open-status read; preserve
that protection against table/row-lock inversion.

Standalone runner: `scripts/audits/expense-void-close-proof.sh`. It validates the
original environment before replacing aliases, then validates the generated
canonical test target before connection. It creates a unique workspace-overlay
cluster, binds 127.0.0.1:56647 only, disables Unix sockets, verifies server major,
actual data directory/port/listen settings, and creates only `aqlan_p1_test`.
The default fixture refuses a nonempty schema; the existing explicit
`MANUAL_CASH_CI_DISPOSABLE_FIXTURE=1` contract is reused only for the established
disposable aggregate-CI lifecycle. Standalone runner clears that opt-in.

Use an exclusive local PostgreSQL window for execution. Stop the owned
cluster on exit and retain its evidence; do not delete backups or existing
clusters. A red baseline must be distinguished from setup errors. After any
runtime repair, repeat the exact suite plus relevant supplier, shift-close,
multi-currency, category-history and manual-containment controls, then require
full exact-head CI and normal release verification. Local passing regressions are
not a released financial fix.
