# Bounded rollout and roll-forward plan: f2b5eef9 → c998b435

**Status:** a plan for review. It authorizes no Production command, backup or restore operation, merge or deployment. Every step marked **[authorized operator]** needs its own explicit approval at the time.

## Gates that must already be closed

None of these is closed by this document.

1. **Recovery readiness:**
   - the existing backup arrangement is verified, and a restore has been rehearsed somewhere other than Production, with a measured restore time;
   - the owner deferred development of a backup *feature*. That does not disable existing backups, and it does not waive this gate.
2. **Production schema compatibility:** `prerequisites.sql` returns every `ok = true` on the target, run by an authorized operator in the rollout window after writes stop (`prerequisite-spec.md`).
3. **Migration-locking decision:** the release owner accepts the lock profile and the deadline below, or rejects them.
4. **Size inputs:** the `estimate.*` rows from that prerequisite run.
   - They are planner estimates, not measurements.
   - Nothing in this directory says how large any Production table is or how long any step takes there.
   - The synthetic timings are not a size estimate, a duration estimate or an outage guarantee.

## What startup does, and the lock each file holds

The schema initialises **lazily**. `/api/health` runs `SELECT 1` and deliberately does not call `ensureSchema()`. The first request that does call it applies, in its own transaction and under `MIGRATION_ADVISORY_LOCK_KEY`:

| Order | File | Locks on tables that already exist (exact, asserted in `evidence/lock-inventory.json`) | Blocked while the file runs | Work that grows with data |
|---|---|---|---|---|
| 1 | 0066 | SHARE ROW EXCLUSIVE on `patients`, `treatment_plans`, `plan_items`, `clinical_cases`, `invoices`, `invoice_items`, `services`, `parties`, `users` | **writes** on those tables | foreign keys from new, empty tables; no scan of existing rows is expected |
| 2 | 0068 | SHARE ROW EXCLUSIVE on `patients`, `payments` (and the 0066 table) | **writes** | as above |
| 3 | 0069 | **ACCESS EXCLUSIVE** + SHARE ROW EXCLUSIVE on `invoice_settlement_reclassifications`; SHARE ROW EXCLUSIVE on `…_events` | **reads and writes** on the reclassification table; writes on events | the new CHECK's validation scans every row of `invoice_settlement_reclassifications` |
| 4 | 0067 | SHARE on `appointments` (plain `CREATE INDEX`, inside the file's transaction) | **appointment writes** | the index build reads all of `appointments` |

Every "blocked" entry was asserted: the probe fails with SQLSTATE 55P03 within a bounded 200 ms `lock_timeout`, and `pg_locks` / `pg_blocking_pids()` show it waiting on the migration backend. Everything else was asserted to proceed. `ROLLBACK` was asserted to leave the catalog unchanged, and a clean rerun was asserted to match.

`CREATE INDEX CONCURRENTLY` is not available. It cannot run inside a transaction, and published migration files are not changed.

**The lock queue is the main risk.** None of these statements sets a `lock_timeout`. If any session holds a conflicting lock (for example an open transaction on `invoices`), the file waits. While it waits, every new conflicting request queues behind it. This includes ordinary reads of `invoice_settlement_reclassifications` queued behind 0069's ACCESS EXCLUSIVE request. Hence the window below: no competing traffic, and no other sessions.

## Window procedure

1. **Announce a write-free window.** Reception, cashier and doctors stop entering data. The deployed service is scaled to **zero** instances, so nothing competes for locks.
2. **[authorized operator] Record the recovery point** for this moment from the verified backup arrangement (gate 1). This plan performs and authorizes no backup operation. The recovery point only bounds the data-loss window of path C below.
3. **[authorized operator] Check for other sessions** with a count-only query that returns no query text. Example: `SELECT state, count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() GROUP BY 1`. Proceed only with **0** other active or idle-in-transaction sessions.
4. **[authorized operator] Run `prerequisites.sql`.** Proceed only if every row is `ok = true`. A false row stops the rollout before any change, and the deployed version is started again.
5. **Fix the deadline before starting.**
   - Set **D_init**: the maximum time initialisation may run. The release owner chooses it from the size inputs (gate 4) and states it in minutes.
   - Set **D_window**: the maximum total outage, covering D_init, verification and any response below.
   - Neither value comes from the synthetic timings.
6. **Start exactly one candidate instance.** Use a single replica: the advisory lock would serialize a second one, but that instance would sit waiting inside a request. Do not open public traffic.
7. **Trigger initialisation deliberately**, still with traffic held: one authenticated staff request to a route that calls `ensureSchema()`. Record the start time.
   - Open decision: the image has no dedicated "initialise and exit" command, so this request is the trigger.
   - Adding such a command would be a code change. It is outside this release.
8. **[authorized operator] Verify the registry** read-only: `SELECT version, name, checksum, adopted FROM schema_migrations ORDER BY version`. Expect exactly **12** rows, all `adopted = false`, with the four new checksums equal to the published files (in `README.md`).
9. **Smoke test, if any, with dedicated test records only.** Record them: every smoke-test write is a post-recovery-point write (see path C). Then open traffic.

## Deadline, stop and cancel

- **If D_init passes before step 8 succeeds,** stop initialisation. Do not wait it out.
  - Scale the candidate instance to zero. When its connection ends, PostgreSQL aborts the open transaction, so **only the file that was running rolls back**. Earlier files stay committed.
  - If the backend survives the instance stopping, an **[authorized operator]** cancels it: `pg_cancel_backend`, then `pg_terminate_backend` if necessary, on the migration backend only, identified by a count- and pid-only query.
- **Then verify the registry read-only.** It will hold 8, 9 or 10, or 11 if it stopped in 0067.
- **Handle the result as a partial commit, below.**
- Never leave a candidate instance serving after a stop.

## Partial commit

**Per-file commits persist.** A failure or cancellation in file *n* rolls back only file *n*. Files 1 to *n−1* stay committed and registered.

The candidate **fails closed per request**, but it does not fail at startup:

- the process stays up;
- `/api/health` still returns 200;
- every request that calls `ensureSchema()` re-attempts the failing file. Each attempt takes that file's locks, then errors.

So a partial state must be detected at step 8. Proven synthetically for a 0069 failure (`partial-failure.json`, 11/11):

- the registry goes 8 → 10, and a retry leaves it at 10;
- the retry leaves the registry and catalog byte-identical, and holds no lock afterwards.

| Stopped in | Committed afterwards | Deployed runtime against that state |
|---|---|---|
| 0066 | nothing new (registry 8) | the original state |
| 0068 | 0066 | inferred from the proven 0066+0068 case (0066 alone adds no trigger the proven state lacks) |
| 0069 | 0066, 0068 | **proven**: re-initialises and writes succeed with registry 10 |
| 0067 | 0066, 0068, 0069 | **proven** as a superset: the deployed runtime re-initialises and writes succeed after all 12 (`upgrade-proof.json`). 0067 is only an index |

**Boundary of the deployed-runtime evidence.**

The fallback was tested **only before any candidate-only feature record exists**: no rows in the `agreement_delta_*` tables or `collection_attempt_retirements`, and no reclassification in a direction other than YER→SAR. It does **not** show that the old runtime correctly handles data the candidate's new features create. The fallback stays inside the tested boundary only if traffic has not reopened on the candidate, or if it has been verified, read-only and count-only, that no such records exist.

## Three distinct responses, in this order

They are not interchangeable. A database restore is not the default rollback, and an unknown error is not by itself a reason to restore.

**A. Application rollback** applies within the boundary above. The database is untouched and nothing is lost.
1. Scale the candidate to zero.
2. Start the deployed version again, as one instance. It ignores the extra registrations, as proven.
3. Keep the window write-free until the next decision.

**B. Forward repair of the partially committed DDL** applies when the failure names a catalog precondition (one of the `prerequisite-spec.md` check IDs) and the committed files are in the proven table above.
- Fix that one precondition with a separately reviewed and authorized catalog statement.
- Then repeat steps 6 to 8 within D_window.
- Proven synthetically for the missing target CHECK: re-adding it, then starting the candidate again, reached exactly 12 registrations.
- Re-adding a validated CHECK scans its table under ACCESS EXCLUSIVE, so it belongs in the same window.
- A cancellation for timeout is not a failed precondition. It needs a new D_init decision before any retry.
- If B is not possible, the system stays on A.

**C. Database restore: last resort, separately authorized. No restore is approved.**
- It is considered only if A cannot run safely on the committed state, or if data integrity is in doubt, and only after a specific diagnosis.
- **Preserve the current state first:** an authorized, separately approved capture of the database as it is now, so that nothing is lost irrecoverably and the failure can be analysed.
- **Disclose the data-loss window before authorization:** restoring the step 2 recovery point discards **every transaction committed after it**. These include:
  - the smoke-test records from step 9;
  - anything written by the candidate's initialisation;
  - every clinic transaction (payments, invoices, appointments, clinical records) entered if traffic reopened before the problem was found.

  Each must be accounted for and, if it matters, re-entered after the restore.
- In a strictly write-free window, the set of lost clinic transactions should be empty. That must be verified, not assumed.

## Never

- drop the committed 0066 or 0068 objects by hand;
- delete or edit `schema_migrations` rows;
- mark anything adopted;
- run the CLI migrator (`npm run db:migrate`) or any baseline adoption.

Each of these changes registered fingerprints or replays history, outside what has been proven.

## Explicitly out of scope

- No bulk migration and no baseline adoption. The other 51 historical versions stay unregistered, which is proven by the upgrade proof.
- No Production command, backup or restore operation, merge or deployment is authorized by this document or by the proof that comes with it.
- No Production size, duration or performance claim.
