# Bounded rollout and roll-forward plan: f2b5eef9 → c998b435

**Status:** a plan for review. It authorizes no Production command, backup operation, merge or deployment. Every step marked **[authorized operator]** needs its own explicit approval at the time.

## Gates that must already be closed

None of these is closed by this document.

1. **Recovery proof:** a verified backup of the target database, restored and checked somewhere other than Production, plus a measured restore time.
2. **Production schema compatibility:** `prerequisites.sql` returns every `ok = true` on the target, run by an authorized operator in the rollout window after writes stop (`prerequisite-spec.md`).
3. **Migration-locking decision:** the release owner accepts the lock and duration profile below, or rejects it.

## What startup does, and the lock each file holds

The schema initialises **lazily**. `/api/health` runs `SELECT 1` and deliberately does not call `ensureSchema()`. The first request that does call it applies, in its own transaction and under `MIGRATION_ADVISORY_LOCK_KEY`:

| Order | File | Locks on tables that already exist (exact, `evidence/lock-inventory.json`) | Ordinary traffic during the file | Work that grows with data |
|---|---|---|---|---|
| 1 | 0066 | SHARE ROW EXCLUSIVE on `patients`, `treatment_plans`, `plan_items`, `clinical_cases`, `invoices`, `invoice_items`, `services`, `parties`, `users` | reads proceed; **writes block** | none (foreign keys from new, empty tables; trigger creation) |
| 2 | 0068 | SHARE ROW EXCLUSIVE on `patients`, `payments` (and the 0066 table) | reads proceed; **writes block** | none |
| 3 | 0069 | **ACCESS EXCLUSIVE** + SHARE ROW EXCLUSIVE on `invoice_settlement_reclassifications`; SHARE ROW EXCLUSIVE on `…_events` | **reads and writes block** on the reclassification table | the new CHECK's validation scan of `invoice_settlement_reclassifications` |
| 4 | 0067 | SHARE on `appointments` (plain `CREATE INDEX`, inside the file's transaction) | reads proceed; **appointment writes block** | the index build over all of `appointments` |

Synthetic durations were 18 ms, 3 ms, 1 ms and 1 ms. These are **not** Production estimates. The two data-dependent steps are 0069's scan, which is small for a table holding only currency-correction documents, and 0067's build. Both are sized from `estimate.*` in the prerequisite output.

`CREATE INDEX CONCURRENTLY` is not available. It cannot run inside a transaction, and published migration files are not changed.

**The lock queue is the real risk, more than lock duration.** None of these statements uses a `lock_timeout`. If any session holds a conflicting lock (for example an open transaction on `invoices`), the file waits. While it waits, every new conflicting request queues behind it. This includes ordinary reads of `invoice_settlement_reclassifications` behind 0069's ACCESS EXCLUSIVE request. Hence the window below: no competing traffic, and no other sessions.

## Window procedure

1. **Announce a write-free window.** Reception, cashier and doctors stop entering data. The deployed service is scaled to **zero** instances, so nothing competes for locks.
2. **[authorized operator] Take the backup** that the recovery gate requires, at this point. Restoring it loses only what happens after this moment, which in a write-free window should be nothing.
3. **[authorized operator] Check for other sessions** with a count-only query that returns no query text. Example: `SELECT state, count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() GROUP BY 1`. Proceed only with **0** other active or idle-in-transaction sessions.
4. **[authorized operator] Run `prerequisites.sql`.** Proceed only if every row is `ok = true`. A false row stops the rollout before any change, and the deployed version is started again.
5. **Start exactly one candidate instance.** Use a single replica. The advisory lock would serialize a second one, but that instance would sit waiting inside a request. Do not open public traffic yet.
6. **Trigger initialisation deliberately**, while traffic is still held: one authenticated staff request to a route that calls `ensureSchema()`.
   - Open decision: the image has no dedicated "initialise and exit" command, so this request is the trigger.
   - Adding such a command would be a code change. It is outside this release.
7. **[authorized operator] Verify the registry** read-only: `SELECT version, name, checksum, adopted FROM schema_migrations ORDER BY version`. Expect exactly **12** rows, all `adopted = false`, with the four new checksums equal to the published files (in `README.md`).
8. **Smoke-test with synthetic or dedicated test records only**, then open traffic.

## If initialisation fails part-way

**Per-file commits persist.** A failure in file *n* rolls back only file *n*. Files 1 to *n−1* stay committed and registered.

The candidate then **fails closed per request**, but it does not fail at startup:

- the process stays up;
- `/api/health` still returns 200;
- every request that calls `ensureSchema()` re-attempts the failing file. Each attempt briefly takes that file's locks, then errors.

So a partial failure must be detected at step 7. The process must not be left serving.

| Failing file | Committed afterwards | Deployed runtime against that state |
|---|---|---|
| 0066 | nothing new (registry 8) | the original state |
| 0068 | 0066 | inferred from the proven 0066+0068 case below (0066 alone adds no trigger the proven state lacks) |
| 0069 | 0066, 0068 | **proven**: re-initialises and writes succeed with registry 10 (`partial-failure.json`) |
| 0067 | 0066, 0068, 0069 | **proven** as a superset: the deployed runtime re-initialises and writes succeed after all 12 (`upgrade-proof.json`). 0067 is only an index |

**Response:**

1. Scale the candidate to zero.
2. Start the deployed version again (one instance). It ignores the extra registrations, as proven.
3. Keep the window write-free until a decision is made.
4. Choose:
   - **Roll forward** when the failure names a catalog precondition (one of the `prerequisite-spec.md` check IDs), and the committed files are in the proven-compatible table above.
     - Fix that one precondition with a separately reviewed and authorized catalog statement.
     - Then repeat steps 5 to 7.
     - Proven synthetically for the missing target CHECK: re-adding it, then starting the candidate again, reached exactly 12 registrations with 0069 and 0067 applied (`partial-failure.json` → `registeredAfterRollForward`, `objectsAfterRollForward`).
     - Re-adding a validated CHECK scans its table under ACCESS EXCLUSIVE, so it belongs in the same window.
   - **Restore the step 2 backup** when any of these holds:
     - the failure is not a named precondition;
     - data integrity is in doubt;
     - the committed state is outside the proven table.
5. **Never:**
   - drop the committed 0066 or 0068 objects by hand;
   - delete or edit `schema_migrations` rows;
   - mark anything adopted;
   - run the CLI migrator (`npm run db:migrate`) or any baseline adoption.

   Each of these changes registered fingerprints or replays history, outside what has been proven.

## Explicitly out of scope

- No bulk migration and no baseline adoption. The other 51 historical versions stay unregistered, which is proven by the upgrade proof.
- No Production command, backup operation, merge or deployment is authorized by this document or by the proof that comes with it.
- No Production performance claim. All timings are synthetic.
