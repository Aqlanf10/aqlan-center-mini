# Synthetic upgrade proof: deployed f2b5eef9 → completed-work candidate c998b435

This is release verification only. The candidate under review is **#451 at c998b435306f8295a217e49f20080293c479c359**, and it stays frozen: this branch adds only this directory on top of it. The deployed runtime is **f2b5eef97047994438729fe8a2da72e214cdf881**.

There was no Production connection, Production SQL, backup operation, merge or deployment. No bulk `migrate` and no baseline adoption were run. Every database used here is a disposable local PostgreSQL 18.6 database: each script drops and recreates its own database on every run, and refuses a non-local host. All data is synthetic, and no Production schema dump or data appears here.

## Contents

| Path | What it is |
|---|---|
| `proof/run-proof.mjs` | The upgrade proof (21 assertions). Database `aqlan_upgrade_proof` |
| `proof/lock-inventory.mjs` | Exact locks per new file, blocked reader and writer proof, rollback and a clean rerun (5 assertions). Database `aqlan_upgrade_locks` |
| `proof/partial-failure.mjs` | A deliberately violated 0069 precondition: what persists, the fail-closed retry state, the deployed-runtime fallback and forward repair (9 assertions). Database `aqlan_upgrade_partial` |
| `proof/validate-prerequisites.mjs` | Validates `prerequisites.sql`: the clean deployed schema passes, and 8 injected violations each fail exactly their checks |
| `proof/static-checks.sh`, `static-checks.eslint.config.mjs` | Syntax and static checks for every harness file, with the repository's pinned tooling |
| `proof/init.mjs`, `fixtures.mjs`, `balances.mjs`, `checksums.mjs`, `prereq.mjs` | Helpers: one runtime's `ensureSchema()` in its own process; synthetic fixtures written by the **deployed** runtime's own writers; per-patient balances computed by one runtime's own readers; published checksums; a `prerequisites.sql` runner |
| `prerequisites.sql`, `prerequisite-spec.md` | Catalog-only, read-only prerequisite check and its specification |
| `rollout-plan.md` | Bounded rollout plan. It separates application rollback, forward repair and a last-resort restore |
| `evidence/*.json`, `evidence/static-checks.log` | Output of the scripts |

## Upgrade proof: `evidence/upgrade-proof.json` = PASS (21/21)

**The starting point is never normalised.**
- The schema is exactly what the deployed runtime creates. The original validated `CHECK (source_currency = 'YER')` and `CHECK (target_currency = 'SAR')` stay in place while the legacy fixtures are written.
- The harness itself runs no DDL on this database.
- 0069's constraint change happens only inside the candidate's own initialisation.
- Assertions 3–6 and 11 prove these preconditions explicitly.

**Method:**

1. The deployed runtime initialises an empty database.
2. The deployed runtime's own writers create the fixtures:
   - invoices in YER, SAR and USD, with receipts and a reversal;
   - a consented plan, with a plan payment;
   - an opening balance, with an opening collection;
   - 6 appointments;
   - a legacy 0063 YER→SAR reclassification document, with its event.

   Result: 4 patients, 5 invoices, 9 payments, 28 non-empty tables.
3. Per-patient balances are read with the deployed reader. Every pre-existing table is digested on its pre-upgrade columns, and the catalog is snapshotted.
4. The candidate initialises **twice**, each run in a fresh process.

**Assertions:**

1. The deployed runtime registers exactly 0051, 0052, 0056, 0057, 0058, 0063, 0064 and 0065.
2. Those rows are applied, never adopted.
3. The unmodified deployed schema keeps its original validated YER/SAR CHECKs, with exact definitions, and has no direction CHECK.
4. `prerequisites.sql` passes on the deployed schema (64/64) before the fixtures exist.
5. The fixtures write data only: the catalog is identical before and after them.
6. The legacy YER→SAR reclassification fixtures exist under the original CHECKs, and the prerequisites still pass.
7. After the candidate there are exactly 12 registrations.
8. The eight deployed rows are byte-identical (name, checksum, adopted, `applied_at`).
9. The four new rows are applied, never adopted.
10. The new rows were applied in the order 0066, 0068, 0069, 0067.
11. All four, including 0069's constraint change, were applied after the candidate started, by its own initialisation.
12. The second candidate initialisation is a no-op.
13. The new rows carry the published checksums:

    | Migration | Checksum |
    |---|---|
    | 0066 | 28bd13b5ca9f34d9a9010aade759d91fb398b47f30a78433e5e663ce90464dac |
    | 0067 | 4717e0a68ee8ba9aee745000c8561d4b9d6481f48f41c094518fac76c1bdacc6 |
    | 0068 | 07864df6fb6fb98742fd35efebcd2f33f23a1b26c90fb7df16f54605cf62aa42 |
    | 0069 | c11d02aecc5d8644dbec1edea664ecb5ba63f3c21a53c77f06c5bb4007fbc714 |

14. The 51 other historical versions stay unregistered (no retroactive registration and no baseline adoption).
15. Every pre-existing row is unchanged.
16. The only removals are 0069's two currency CHECKs.
17. No pre-existing definition changed.
18. 0067's index and 0069's validated direction CHECK exist.
19. Per-patient balances are identical: the deployed reader before the upgrade, the candidate reader after it.
20. The deployed runtime re-initialises on the upgraded schema without registering, replaying or refusing anything.
21. The deployed runtime's writers all still succeed on the upgraded schema.

**Catalog difference:** added 4 tables, 4 functions, 11 indexes and 14 triggers. Removed only the two old CHECKs. Changed: none.

**Synthetic time** (not a Production claim): deployed initialisation about 0.5 s; candidate about 0.13–0.16 s per run.

## Locks: `evidence/lock-inventory.json` = PASS (5/5)

**Method:**
- Each file runs alone in a transaction, as the runtime runs it.
- While that transaction is open, an ordinary reader and an ordinary writer are run, from separate sessions, against every pre-existing table the file locks, each with a bounded `lock_timeout` of 200 ms. Writers are no-op `UPDATE`s where the table has a harmless column; otherwise the `ROW EXCLUSIVE` request that every write takes first.
- A blocked probe is proven by the server itself: `pg_locks` shows its request ungranted, and `pg_blocking_pids()` names the migration backend.
- Then `ROLLBACK`: the catalog must be unchanged, and every probe must now proceed.
- The whole inventory runs twice, on freshly recreated databases, and both passes must match.

**Results:**

| File | Locks held on pre-existing tables | Readers | Writers |
|---|---|---|---|
| 0066 | SHARE ROW EXCLUSIVE on `clinical_cases`, `invoice_items`, `invoices`, `parties`, `patients`, `plan_items`, `services`, `treatment_plans`, `users` | proceed | **blocked** (ungranted ROW EXCLUSIVE, blocked by the migration) |
| 0068 | SHARE ROW EXCLUSIVE on `patients`, `payments`, `agreement_delta_collection_receipts` | proceed | **blocked** |
| 0069 | ACCESS EXCLUSIVE + SHARE ROW EXCLUSIVE on `invoice_settlement_reclassifications`; SHARE ROW EXCLUSIVE on `…_events` | **blocked** on the reclassification table (ungranted ACCESS SHARE); proceed on events | **blocked** |
| 0067 | SHARE on `appointments` | proceed | **blocked** |

## Partial failure: `evidence/partial-failure.json` = PASS (9/9)

The violation is injected deliberately and only here: `…_target_currency_check` is dropped before the candidate starts.

| Stage | Observed |
|---|---|
| Candidate, first start | fails in 0069 |
| Committed and registered afterwards | 0066 and 0068 (10 registrations). Their objects exist; 0069's and 0067's do not |
| `prerequisites.sql` on that state | refuses it, naming the missing CHECK |
| Candidate, retry | fails the same way (fail closed). Registry and catalog are **byte-identical** to before the retry, and no lock is left held |
| Deployed runtime | re-initialises, and its writers succeed; registrations stay at 10 |
| Forward repair | re-adding the exact validated CHECK, then starting the candidate again, gives exactly 12 registrations with 0069 and 0067 applied |

## Static checks: `evidence/static-checks.log` = PASS

`proof/static-checks.sh` runs with the repository's pinned tooling: Node 22 (`.nvmrc` and engines), and ESLint 9.39.5, @eslint/js 9.39.5 and TypeScript 5.9.3 (package-lock). It checks every harness file:

- **Syntax:** `node --check`.
- **ESLint:** a dedicated config, `static-checks.eslint.config.mjs`. The repository config ignores every `*.mjs`, so it cannot check these files. The config uses `recommended`, `no-undef`, `no-unused-vars`, `eqeqeq` and `prefer-const`, and a negative control proves that it rejects a bad file.
- **TypeScript:** `tsc --checkJs` against the pg and node declarations, with `--noUnusedLocals`, `--noUnusedParameters` and `--noImplicitReturns`.

`prerequisites.sql` is checked by executing it in every validation scenario.

## Reproduce (local disposable cluster only)

```sh
export OLD_ROOT=<checkout of f2b5eef9 with npm ci>
export NEW_ROOT=<checkout of this branch with npm ci>
export ADMIN_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:<port>/postgres
D=docs/review/finance-upgrade-proof
sh $D/proof/static-checks.sh
EVIDENCE=$D/evidence/upgrade-proof.json node $D/proof/run-proof.mjs
EVIDENCE=$D/evidence/lock-inventory.json node $D/proof/lock-inventory.mjs
EVIDENCE=$D/evidence/partial-failure.json node $D/proof/partial-failure.mjs
EVIDENCE=$D/evidence/prerequisites-validation.json node $D/proof/validate-prerequisites.mjs
```

## What remains open

The proof does not close any release gate:

- Production schema compatibility (`prerequisites.sql` has not been run on Production);
- recovery readiness, which deferring the backup feature does not waive;
- the migration-locking decision;
- the open decision in `rollout-plan.md` on how initialisation is triggered deliberately.

No restore is approved.
