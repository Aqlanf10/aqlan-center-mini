# D1: legacy initialization writes under the lifecycle fence (design for review)

Status: **design for review** (review 6507696166 item 1). Nothing here changes legacy startup
until it is reviewed. The implementation and its PostgreSQL proof follow this design on the
WORK branch, isolated and unactivated. No real `CONNECT` grant, role or database is used
(option (b) of the restore protocol is not taken).

## 1. The gap

`CANONICAL-RESTORE-PROTOCOL-20261028.md` §5.2 D1:

1. `ensureSchema` reads the authority footprint over the pool, with no lock.
2. It then runs its bootstrap DDL, runtime migrations and seeds on whatever pool connections it gets.
3. An instance pointed at an empty restore target can pass step 1 before the restore hold commits, and write in step 2 after the hold has committed.

That is a time-of-check to time-of-use gap. The operational precondition (no application instance is configured for a restore target) is the only protection today.

## 2. Inventory: every legacy initialization writer

| # | Writer | Connection and transactions today | Lock today |
|---|---|---|---|
| W1 | `ensureSchema` footprint check (`readStaffEntryMode(getPool())`) | pool, autocommit | none |
| W2 | `ensureSchema` bootstrap DDL: one large multi-statement query (one implicit transaction), then about 40 module DDL statements (`DOCTOR_COMMISSION_HISTORY_SQL` … `LEGACY_TREATMENT_DOCUMENT_SQL`, `HR_*`) | `getPool().query`, each on any pool connection, each its own implicit transaction | none |
| W3 | Runtime migrations: `applyRuntimeMigrationFiles` (0064–0069, 0074, 0078–0082, 0067, HR temporal), `ensureInvoiceCurrencySchema`, `applyOrthoAssessmentRuntime` | `pool.connect()` (its own connection), one transaction per file with COMMIT | `MIGRATION_ADVISORY_LOCK_KEY`, session level |
| W4 | Seeds and data repairs: HR leave types and settings, AI settings and providers, the cephalometric reference set, local demo users and inventory (`allowLocalDemoData()` only), role relabel `receptionist→reception`, `seedDefaultServices`, identity and price-gate repair markers, lab services, expense categories, `seedAppointmentServicesOnPool` | mostly `getPool().query` (separate statements, separate connections); `seedDefaultServices` is one transaction with marker | `pg_advisory_xact_lock(7461)` in the services seed only |
| W5 | CLI migrator `migrate()` (`scripts/db-migrate.ts`, preflight disclosure, schema ownership verification) | one dedicated connection, one transaction per file | `MIGRATION_ADVISORY_LOCK_KEY`, session level |
| W6 | The restore's own migration step (`lib/restore/staging.ts`, after the hold commit, on the restore's client) | the restore client | `MIGRATION_ADVISORY_LOCK_KEY` |

Not legacy initialization:
- The canonical runtime installers (reviewed installers, never run from a request).
- The restore hold and replay transactions, which already take the fence EXCLUSIVE first.

## 3. Invariants (from the review)

- I1. Every legacy initialization write (W2–W5) happens while its owning connection holds the
  lifecycle fence. The footprint is rechecked on that connection after the fence is taken.
  No pool write happens outside that protection.
- I2. No nested COMMIT releases the fence.
- I3. No shared→exclusive upgrade.
- I4. If the hold wins the race, initialization writes nothing. If initialization wins, the
  hold waits for it to finish and then refuses the non-empty target (`restore_target_not_empty`).
- I5. Two processes starting together, failure and retry: never a partial seed. Legacy startup on a
  legacy database is otherwise unchanged: same statements, same order, same outcome.

## 4. Design

### 4.1 One owning connection, session-level shared fence

`ensureSchema` (when the lock-free precheck says `legacy`) checks out **one** dedicated client
`C` and runs everything on it, in this order:

1. `SET lock_timeout = '30s'` on `C` (session).
2. **Lifecycle fence, SHARED, session level:** `pg_advisory_lock_shared(hashtextextended(staffLifecycleLockKey('public'),0))`.
   - It is session level because W3 commits once per migration file. A transaction-level fence
     would be released by the first COMMIT, which I2 forbids.
   - PostgreSQL makes session-level and transaction-level advisory locks on the same key conflict
     in the expected way, so this shared session lock and the hold's exclusive transaction lock
     exclude each other.
3. **Recheck** `readStaffEntryMode(C)`. If it reports `canonical` (any footprint, including the hold relation): no write; unlock and return without DDL, which is the existing canonical early return.
4. **Migration lock, session level:** `pg_advisory_lock(MIGRATION_ADVISORY_LOCK_KEY)` on `C`.
   - This serializes two starting processes completely; today they ran concurrently and relied on `IF NOT EXISTS`.
   - It is reentrant on the same session, so W3's own `pg_advisory_lock` on `C` stacks, and its unlock pops one level.
5. W2, W3 and W4 run on `C` only:
   - `getPool().query(...)` becomes `C.query(...)`.
   - W3 and the services seed receive a pool view over `C`: the `clientAsPool` shape, where `release` is a no-op.
6. Each W4 seed that is more than one statement runs in one explicit transaction on `C` (`BEGIN … COMMIT`): its decision and marker rows with its data. A failure rolls back that seed whole, which gives I5 "no partial seeds". Committing is safe because the fence is session level (I2).
7. `finally`, in reverse order:
   - `pg_advisory_unlock(MIGRATION_ADVISORY_LOCK_KEY)`;
   - `pg_advisory_unlock_shared(fence)`;
   - release `C`.
   - If the client is uncertain (an error outside a known transaction state, or a failed unlock), destroy it (`release(true)`). Session locks die with the backend, so a crash never leaves a held fence.
8. On error, `schemaReady = null` (existing behaviour), and the next request retries from step 1.

**Lock order** (global, every path):

> lifecycle fence → migration lock → service seed lock 7461 → row locks.

- Initialization: fence S → M → (7461) → rows.
- Restore:
  - the hold transaction takes fence X and COMMITs;
  - the restore migration (W6, §4.3) takes fence S, then M;
  - the replay takes fence X, then rows.
- Canonical issuer and operations: fence S → rows.
- Authority writers: fence X → rows.

No path takes M (or 7461) and then the fence, so there is no lock-order cycle.

**No upgrade (I3):** initialization only ever asks for the shared fence. Nothing it does needs exclusive.

### 4.2 Lock-free precheck stays a fast path only

The existing `readStaffEntryMode(getPool()) === "canonical"` early return stays. A positive answer is
safe without a lock because the authority footprint is monotonic:
- control, identity and the hold relation are protected against removal;
- the hold is released only by the target's own seal, which leaves the identity footprint behind.

The negative answer is never trusted: step 3 rechecks it under the fence.

### 4.3 The CLI migrator (W5) and the restore's own migration (W6)

`migrate()` follows the same pattern:
1. Lock-free footprint precheck.
   - **Ready canonical database, no hold:** proceed as today, with no fence. The M4 upgrade path is unchanged: a hold cannot be installed on a target with an identity footprint (`restore_target_has_identity`).
   - **Otherwise:** take fence S at session level on its dedicated client, then recheck.
2. Hold present:
   - refuse with `MIGRATION_TARGET_HELD`, unless the caller presents that hold's `hold_id`;
   - the restore staging passes its own `hold_id`, which it created in the same run on the same client.
3. Then take M as today.

The CLI never learns a hold id, so an operator running `npm run migrate` against a target that is being restored is refused instead of racing the replay.

### 4.4 Race outcomes

| Order | Outcome |
|---|---|
| Hold first | Initialization's `pg_advisory_lock_shared` waits for the hold transaction (observed with `pg_blocking_pids`). After the hold commits, the recheck sees the hold relation: `canonical`, no write. The login on that instance answers 503 maintenance. |
| Initialization first | The hold's `pg_advisory_xact_lock` waits for initialization's session lock, until step 7. It then refuses: `restore_target_not_empty`. No hold row and no write by the hold. |
| Two processes start | Both take fence S; M serializes them. The second finds every migration applied and every seed marker present, so its writes are no-ops. |
| Failure in the middle | The failing seed's transaction rolls back whole. Earlier seeds and DDL are committed and idempotent. Locks are released (or the client is destroyed). The next request retries and completes. |
| Hold queued behind a running initialization, then a new process starts | The new process's shared request queues behind the waiting exclusive (PostgreSQL grants advisory locks in queue order). It runs after the hold commits, rechecks, sees the hold, and writes nothing. |

### 4.5 Cost

- One connection per process for the duration of `ensureSchema`, once per process lifetime. This replaces the many short pool checkouts.
- On a legacy database, an authority writer's exclusive request waits for a running initialization (with its 5 s `lock_timeout`). There are no canonical writers on a legacy database, so this is only theoretical there.
- On a canonical database, initialization never runs (early return).

## 5. PostgreSQL proof plan (synthetic schema/database, real server)

| # | Scenario | Evidence |
|---|---|---|
| P1 | Hold first: an open hold transaction holds fence X; start initialization | The initializer's backend is blocked by the hold's pid (`pg_blocking_pids`). After COMMIT: zero base tables besides the hold; no seed; the initializer reports canonical. |
| P2 | Initialization first: pause initialization inside step 5 (a test barrier on M held by the test); start the hold | The hold's backend is blocked by the initializer's pid. After initialization completes, the hold refuses `restore_target_not_empty`, and no `staff_restore_hold` relation exists. |
| P3 | Two processes (two pools) start together | The second's backend is blocked on M by the first. Final state equals one run: migration rows once, each seed marker once, row counts equal. |
| P4 | Failure and retry: a fault trigger fails one seed's INSERT on the first run | That seed has no rows and no marker. Earlier seeds are present. Locks are free (`pg_locks`). The second run (after the trigger is dropped) completes, and its state equals a clean run. |
| P5 | Client death in the middle (`pg_terminate_backend` on the initializer) | Fence and M are free immediately; the retry completes. |
| P6 | CLI migrator against a held target | `MIGRATION_TARGET_HELD`; the restore's own run with its `hold_id` succeeds (the existing restore round trip and H2–H4 journeys stay green). |
| P7 | Legacy startup intact | The existing `ensureSchema` suites (fresh, rerun over data, SKIP_SEED restore, schema-ownership verification) are unchanged and green. The statement order is unchanged. |

## 6. Questions for the reviewer

1. Is `lock_timeout = '30s'` for initialization acceptable? On timeout, `ensureSchema` rejects, the request answers 503 in Arabic, and the next request retries.
2. Should W4's demo-only seeds (`allowLocalDemoData()`) stay inside the fence or be dropped from runtime? This design keeps them inside, unchanged.
