# Expense-category posting-history containment: prospective test contract

Date: 2026-10-02. Base commit `5900259` (release-equivalent tree supplied by the coordinator). This is a **tests/runner/documentation-only** handoff. It does not implement a repair, change schema, touch Production, backfill history, or introduce a second ledger. Do not merge the intentionally red tests as a completed fix.

## Outcome and scope

The focused desired-invariant suite exercises real PostgreSQL 18, real domain writers/readers and the real category API; only the authenticated synthetic session and two transaction scheduling seams are mocked. The original audit is in `docs/CASH_GENERAL_LEDGER_LINKAGE_AUDIT.md` at audit commit `f2109e8` (not copied into this branch).

Coverage:

- Closed-shift voucher references by category key **and legacy name**: reject changes to posting policy, expense account and name; reject re-enabling intentionally excluded history.
- Allow normalized no-ops, budget/display/description/activation edits, and genuinely unused configuration.
- Atomic batch and sync behavior. Sync can repair unused configuration and can no-op against referenced configuration; it cannot re-enable excluded historic vouchers or replace their historical account mapping.
- Creation name/name and cross key/name collisions; renaming an unused category onto an existing alias; creation/renaming that captures a historical `expenses.category` string with no current category row. Normalized creation keys are included.
- Deactivate rather than delete categories referenced through either key or name.
- Real PATCH single/batch and POST `sync_accounting`, `ensure_all_linked`, and alias creation must return a conflict (proposed HTTP 409), preserve all category rows and financial history, and avoid a successful settings-change audit on refusal.
- Two real contention cases: first uncommitted voucher versus policy edit, and first uncommitted unmatched voucher versus category creation capturing its alias. Both must wait, then refuse after the voucher commits.

The financial snapshot compares all derived journal entries plus the exact immutable voucher and closed shift. Balance equality alone is insufficient. No test “repairs” historical data after a mutation to conceal the failure.

## Source inventory (base `5900259`)

- `lib/db.ts:10817–10864` — `createExpenseCategory`: normalizes a supplied key, inserts without cross-key/name or historical-raw-alias checks.
- `lib/db.ts:10866–10916` — `updateExpenseCategory`: updates policy, mapping and name directly, without reference protection.
- `lib/db.ts:10918–10937` — `batchUpdateExpenseCategories`: calls independent single updates, so a later refusal would not undo earlier writes.
- `lib/db.ts:10940–10993` — `syncExpenseCategoriesAccountingMapping`: raw updates, including forced auto-posting and standard account remapping, outside a common transaction.
- `lib/db.ts:10995–11015` — `deleteExpenseCategory`: checks only `expenses.category = key`, missing name references.
- `app/api/finance/expense-categories/route.ts:54–145,149–224,226–264` — POST create/sync, PATCH single/batch, DELETE all call the above writers. Existing catch blocks map every domain exception to 500; intentional containment conflicts need explicit safe 409 handling.
- `lib/db.ts:11437–11469` — the first `INSERT INTO expenses` is inside `recordExpenseInTx`, called by `recordExpense` and grouped lab settlement. Its existing lock protects the open shift, not the category namespace.
- `lib/db.ts:11626` — voucher reversal inserts another expense. Any cooperative writer-fence design must include this path too.
- `lib/db.ts:14030–14042,14173–14205` — the derived journal joins current category `key OR name`, applies the live posting flag and live account mapping. A new matching category can remove or duplicate a historic expense entry without touching the voucher.

Additional category setup writers exist in `ensureSchema` at `lib/db.ts:961–964` (null posting flag and two standard account rewrites) and seed insertion around `2276–2300`. These are **not covered by this runtime-API slice**. Repeated bootstrap behavior needs separate verification before claiming category history is protected across process restart. Do not silently broaden this patch into historical migration or schema-owner changes.

## Smallest robust runtime design to review after the current db.ts owner finishes

1. Add one typed, safe domain conflict for historical reinterpretation/collision. Preserve existing signatures where practical; throw this conflict for a blocked edit, reserve `false` for “not found”, and map only the known conflict to 409. Log success only after an actual committed change.
2. Normalize proposed values exactly once (including trimmed name/account and normalized generated/supplied key). Compare effective stored values first. No-op material fields and unrelated metadata must remain allowed even when the category has old references or old ambiguity; do not automatically clean up that ambiguity.
3. In one transaction on one client, serialize category configuration changes and fence prospective expense inserts **before** checking references. All create/update/batch/sync/delete entry paths must share this transaction helper; do not call a public writer that opens a nested independent transaction. Batch validation and writes must roll back together. Sync must calculate all desired changes and apply the same material-change checks, rather than its existing blanket UPDATE.
4. Material changes include name, account and posting policy. For an existing category, a reference is any expense whose raw category equals the current key **or** current name, regardless of date, sign, closed/open state, party association, or whether posting is currently excluded. Do not filter out reversals or intentionally excluded documents.
5. For creation or name changes, reject proposed cross-category alias collisions against both key and name. Separately check whether a new alias would capture an already-recorded unmatched/raw expense string. Checking only references to the edited row misses this case. On update exclude the row itself from collision checks, but do not allow another row's alias. Key is currently immutable through update APIs.
6. Deactivate referenced categories. Before permitting true deletion also consider existing lab/payable category foreign-key references, to avoid unintended `ON DELETE SET NULL` changes. This is a deletion safety check, not permission to alter those documents' accounting.

### Recommended bounded PostgreSQL fence

A low-complexity, conservative option for these rare settings writes is, within the transaction and **before reads or category row writes**:

```sql
LOCK TABLE expenses IN SHARE MODE;
LOCK TABLE expense_categories IN SHARE ROW EXCLUSIVE MODE;
-- fresh READ COMMITTED reference/collision reads, then guarded category writes
```

All category mutation paths must use that same order. No configuration transaction may acquire party/payable/shift locks or rewrite source documents. Keep it short; return DTOs after COMMIT and do not hold locks during audit/network work. Use the application's bounded timeouts, roll back safely on timeout/deadlock, and never report success after failure.

This deliberately global fence trades brief expense-write latency during rare configuration updates for complete coverage of first-insert phantoms and unmatched aliases. Ordinary journal reads remain available. PostgreSQL automatically gives INSERT/UPDATE/DELETE a ROW EXCLUSIVE table lock; SHARE conflicts with that lock. The category table lock serializes all configuration namespace checks, including two concurrently created aliases. Locks last through transaction end. These semantics are documented by [PostgreSQL 18 explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html).

- Writer wins: its expense table lock prevents the settings fence from completing. After writer COMMIT, a fresh reference read sees the new voucher and refuses the edit.
- Settings wins: its expense SHARE lock delays insertion until configuration commits. The new voucher is then first recorded under the new configuration. It is not a historical rewrite.
- Existing-reference `FOR UPDATE` alone cannot lock an empty reference set or a missing alias and fails both supplied race tests.
- A category-row lock alone also fails because current expense inserts do not lock category rows and unmatched aliases have no row.
- Advisory locks are an alternative only if every writer uses the same namespace/protocol. Retrofitting them only to settings is insufficient. Acquiring a new advisory fence inside `recordExpenseInTx` after a grouped caller has already locked a party/lab order risks inverted ordering. If chosen, acquire it at every outer transaction entry, before existing party → payable → shift/source locks, including grouped settlement and reversal. That has a larger implementation surface than the table fence.

This is a reviewed-design candidate, not proof an implementation is safe. The repair must run both race tests plus a configuration-first serialization test and concurrent alias-creation test before merge, and review deletion/FK lock interactions. Keep failed containment atomic; do not automatically retry financial writes.

## Test mechanics and execution

`__tests__/postgres/expense-category-history-containment.test.ts` is a **focused fresh-database proof**. It explicitly refuses a nonempty public schema and never drops or truncates it. The companion runner creates a unique workspace-owned cluster and the canonical `aqlan_p1_test` database, validates the original environment before test stubbing and validates the exact target before connection/runtime import. It stops the cluster in an EXIT trap and retains synthetic evidence even on red tests. It intentionally does not fit an already-populated all-files PostgreSQL run until its test isolation is integrated deliberately with that harness; never remove safety checks just to make CI green.

```sh
NODE_BIN=/path/to/node22 \
PG18_BIN_DIR=/path/to/postgresql18/bin \
bash scripts/audits/expense-category-history-proof.sh
```

The contention scheduler wraps one real acquired client. It executes the original INSERT, then pauses its real transaction before COMMIT. A separate inspector confirms the uncommitted row is invisible and observes a real `pg_blocking_pids` wait edge or early completion. No successful lock assertion depends on elapsed sleep time; the ten-second deadline is only a failure bound. A finally block releases the writer and closes the synthetic shift.

Initial run: PostgreSQL 18.4, Node 22.23.3, 31 tests, **26 failed / 5 passed** on unmodified runtime, 10.01 seconds total. Every failed case is a desired missing guard; positive metadata/no-op/unused controls and key-referenced deactivation passed. The final revision adds the unused/no-op sync control and orphan-creation contention case; see the final run summary below.

Lint for the changed TypeScript and Bash syntax validation passed. TypeScript transpilation/syntax passed; **full typecheck, full suite and build were deliberately not run** under the coordinator's memory/concurrency restriction. Runtime and schema files are untouched.

## Remaining work deliberately outside this slice

Party/laboratory mapping/posting updates (`updateLabAccountingMapping`, batch mapping, `updateLaboratory`), mutable per-document lab/payable accounting updates, startup category rewrites, initial cash/manual physical cash treatment, and immutable future posting snapshots remain separate follow-ups. No claim is made that category containment alone fixes all cash/general-ledger linkage problems. Historic exclusions or manually replaced entries must never be automatically re-enabled or inferred/backfilled.

### Final retained proof, 2026-10-02

Final focused run: **33 tests; 27 failed / 6 passed**, PostgreSQL 18.4, total 7.73 seconds. Both real phantom cases failed because settings committed before the first voucher; the unused/no-op sync control passed. Exit status 1 is the intentional pre-repair result, not a successful release check.

Workspace evidence retained outside the git deliverable:

- `../category-history-before-fix.log` and `../category-history-containment-pg18.fyrkpX/{postgres,server,stop}.log` — initial run
- `../category-history-final-before-fix.log` and `../category-history-containment-pg18.Cfylgm/{postgres,server,stop}.log` — final run
- Both cluster stop logs say `server stopped`; `pg_ctl status` confirms no server running. The synthetic cluster directories were retained, not erased.

## Runtime containment implementation (local follow-through, 2026-10-02)

The runtime repair now shares `withExpenseCategoryConfiguration` across creation,
updates, batch updates, accounting sync and deletion. It uses one acquired client
and one READ COMMITTED transaction, a 10-second local lock timeout, then locks
`expenses` in SHARE mode and `expense_categories` in SHARE ROW EXCLUSIVE mode.
The shared normalized guard rejects used-category name/account/effective-policy
changes, cross-key/name collisions and newly captured historical raw aliases.
False posting flags are not re-enabled; NULL has its existing effective-enabled
meaning. Exact no-ops and unrelated metadata remain supported, including when
old categories already have ambiguous aliases. No old ambiguity is cleaned up.

Batch and sync call a private transaction-local update, so any later conflict
rolls back earlier category writes. They never call public writers or the pool
inside the transaction. Creation and sync assemble their DTOs after COMMIT.
Known historical/collision and lock-timeout conflicts return HTTP 409 through
all mutation handlers; success audits are reached only after the writer commits.
Unexpected errors keep their existing error path and all failures roll back.

### Lock-order and deletion/FK review

- Normal voucher insertion, grouped settlement, reversals and expense updates
  automatically take ROW EXCLUSIVE on `expenses`. SHARE therefore fences even
  an absent first reference. Settings do not take shift, party, payable or lab
  row locks and do not rewrite a source document.
- Concurrent configuration writes serialize on the category table before any
  category/reference read. Reads use a fresh READ COMMITTED statement snapshot
  after a blocking writer commits. A settings-first writer commits configuration
  before a new voucher can be inserted under it.
- Category-table SHARE ROW EXCLUSIVE does **not** block the ROW SHARE and KEY
  SHARE locks used by the lab-order/payable foreign keys. For deletion, the
  category row is additionally selected `FOR UPDATE NOWAIT` before fresh FK
  reference reads. This blocks new FK references between the check and DELETE.
- NOWAIT is intentional: a lab transaction can already hold category KEY SHARE
  and later update `expenses` (for example a source-deletion flow). Waiting for
  that category row while holding the expenses fence would invert those locks.
  Instead, deletion immediately rolls back with a safe 409; after the writer
  commits, retry deactivates the now-referenced category. No automatic financial
  retry is introduced.
- If deletion wins first on an unused category, a concurrent FK insertion waits
  and then gets the normal FK violation after deletion commits. It never commits
  an implicitly cleared category reference. Already referenced categories,
  whether by voucher key/name or either FK, are deactivated rather than deleted.

### Deliberate CI fixture integration

The default suite and standalone proof still refuse a nonempty public schema.
`_expense-category-fixture.ts` revalidates the **original pre-stub environment**
and exact canonical target before any connection or reset. Only an exact
`CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE=1` opt-in invokes the standard PG-suite
`dropPublicSchema` fixture. The CI workflow sets this flag solely on its existing
PostgreSQL integration step against the disposable service database. It is not a
workflow-wide or runtime environment setting. The standalone runner explicitly
unsets an inherited opt-in and keeps its fresh private cluster lifecycle.

The fixture safety unit suite checks empty/default behavior, nonempty refusal,
exact opt-in, original Production/Railway/environment rejection, target and query
override rejection before reset/connection, and the runner's explicit opt-out.
This fixture integration does not permit resetting a real database.

### Added coverage and verification boundary

The original 33 desired cases are retained. Twelve further PostgreSQL cases
cover configuration-first posting, concurrent cross-key/name creation, actual
bounded lock timeout with rollback/409/no success audit, unused deletion, both
committed FK references, both writer-first and deletion-first FK schedules,
preexisting alias ambiguity and legacy NULL effective-posting semantics.
All successful concurrency assertions observe actual `pg_blocking_pids` edges;
no passing lock assertion is based on elapsed sleeping alone.

The first local PostgreSQL 18.4 run passed all **45/45** cases. Focused test and
lint results are recorded in the implementation handoff; full build/typecheck
and remote CI remain separate release gates. The initial red-run findings above
are historical pre-repair evidence, not the current expected outcome.

### Explicitly unchanged startup seam

`ensureSchema` still normalizes NULL flags and rewrites the two legacy account
mappings (`facility_maintenance` 5601→5504; `marketing` 5901→5902), and still seeds
fresh default categories. Runtime containment alone is **not restart-safe
closure** of those bootstrap paths. Removing just those two account remaps may
be a separate small follow-up with a cold-start preservation proof; this patch
does not silently remove migrations, change NULL initialization, or alter fresh
bootstrap defaults. Party/lab mapping writers and historical remediation remain
outside this slice as described above.

Final local fixture verification reran all 45 PostgreSQL cases on a fresh
synthetic schema, then deliberately reran without the CI opt-in: the default
refused the nonempty schema and retained a sentinel plus all 35 vouchers. An
explicit disposable-fixture opt-in then reran **45/45** successfully. Both local
clusters were stopped and retained. Focused fixture/target/accounting/expense
unit suites passed **86/86** in four files. Focused ESLint passed (the eight
preexisting `lib/db.ts` unused-import/function warnings remain); Bash syntax and
`git diff --check` passed. A separate PGlite-backed `transactions.test.ts` worker
exited unexpectedly in two combined attempts; its four cases are **unverified**,
not reported as passing. No full typecheck/build or remote CI was run locally.
