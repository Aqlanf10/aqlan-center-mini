# Synthetic upgrade proof: deployed f2b5eef9 → completed-work candidate c998b435

This is release verification only. The candidate under review is **#451 at c998b435306f8295a217e49f20080293c479c359**, and it stays frozen: this branch adds only this directory on top of it. The deployed runtime is **f2b5eef97047994438729fe8a2da72e214cdf881**.

There was no Production connection, Production SQL, backup operation, merge or deployment. No bulk `migrate` and no baseline adoption were run. Every database used here is a disposable local PostgreSQL 18.6 database, and each script refuses a non-local host. All data is synthetic, and no Production schema dump or data appears here.

## Contents

| Path | What it is |
|---|---|
| `proof/run-proof.mjs` | The upgrade proof (16 assertions, below). Database `aqlan_upgrade_proof` |
| `proof/lock-inventory.mjs` | The exact locks each new file holds, and whether ordinary reads and writes would block. Database `aqlan_upgrade_locks` |
| `proof/partial-failure.mjs` | A violated 0069 precondition. Records what persists, the fail-closed behaviour, the deployed-runtime fallback and a roll-forward. Database `aqlan_upgrade_partial` |
| `proof/validate-prerequisites.mjs` | Validates `prerequisites.sql`: the clean deployed schema passes, and 8 injected violations each fail exactly their checks |
| `proof/init.mjs`, `fixtures.mjs`, `balances.mjs`, `checksums.mjs` | Helpers: one runtime's `ensureSchema()` in its own process; synthetic fixtures written by the **deployed** runtime's own writers; per-patient balances computed by one runtime's own readers; published checksums |
| `prerequisites.sql`, `prerequisite-spec.md` | Catalog-only, read-only prerequisite check and its specification |
| `rollout-plan.md` | Bounded rollout and roll-forward plan |
| `evidence/*.json` | Output of the four scripts |

## Upgrade proof: `evidence/upgrade-proof.json` = PASS (16/16)

**Method:**

1. Initialise an empty database with the deployed runtime.
2. Write synthetic fixtures with the deployed runtime's own writers:
   - invoices in YER, SAR and USD, with receipts and a reversal;
   - a consented plan, with a plan payment;
   - an opening balance, with an opening collection;
   - 6 appointments;
   - an existing 0063 YER→SAR reclassification document, with its event.

   Result: 4 patients, 5 invoices, 9 payments, 28 non-empty tables.
3. Read every patient's per-currency balances with the deployed reader. Digest every pre-existing table on its pre-upgrade columns. Snapshot the catalog.
4. Initialise the candidate **twice**, each run in a fresh process.

**Assertions:**

1. The deployed runtime registers exactly 0051, 0052, 0056, 0057, 0058, 0063, 0064 and 0065.
2. Those rows are applied, never adopted.
3. After the candidate there are exactly 12 registrations.
4. The eight deployed rows are byte-identical (name, checksum, adopted, `applied_at`).
5. 0066, 0067, 0068 and 0069 are applied, never adopted.
6. They are applied in the order 0066, 0068, 0069, 0067.
7. The second candidate initialisation registers and re-applies nothing.
8. The added rows carry the published checksums:

   | Migration | Checksum |
   |---|---|
   | 0066 | 28bd13b5ca9f34d9a9010aade759d91fb398b47f30a78433e5e663ce90464dac |
   | 0067 | 4717e0a68ee8ba9aee745000c8561d4b9d6481f48f41c094518fac76c1bdacc6 |
   | 0068 | 07864df6fb6fb98742fd35efebcd2f33f23a1b26c90fb7df16f54605cf62aa42 |
   | 0069 | c11d02aecc5d8644dbec1edea664ecb5ba63f3c21a53c77f06c5bb4007fbc714 |

9. The 51 other historical versions stay unregistered (no retroactive registration and no baseline adoption).
10. Every pre-existing row is unchanged on its pre-upgrade columns.
11. The only removals are 0069's two currency CHECKs.
12. No definition of a pre-existing table, column, constraint, index or trigger changed.
13. 0067's index and 0069's validated direction CHECK exist.
14. Every patient's per-currency balances are identical: the deployed reader before the upgrade, the candidate reader after it.
15. The deployed runtime re-initialises on the upgraded schema without registering, replaying or refusing anything.
16. The deployed runtime's writers all still succeed on the upgraded schema.

**Catalog difference:** added 4 tables, 4 functions, 11 indexes and 14 triggers. Removed only `…_source_currency_check` and `…_target_currency_check`. Changed: none.

**Time and locks are recorded separately, and none of it is a Production performance claim:**

- Synthetic time: deployed initialisation about 0.5 s; candidate initialisation about 0.10–0.15 s per run.
- Locks: exact modes per file are in `evidence/lock-inventory.json`, summarized in `rollout-plan.md`.
  - 0066 and 0068 block writes on the core financial and clinical tables.
  - 0069 blocks reads on `invoice_settlement_reclassifications` (ACCESS EXCLUSIVE).
  - 0067 blocks appointment writes during a plain `CREATE INDEX`.

## Partial failure: `evidence/partial-failure.json`

The scenario drops `invoice_settlement_reclassifications_target_currency_check` before the candidate starts.

| Stage | Observed |
|---|---|
| Candidate, first start | fails with `constraint … does not exist` in 0069 |
| Committed and registered after the failure | the 8 deployed rows plus 0066 and 0068. Their objects exist; 0069's and 0067's do not |
| `prerequisites.sql` on that state | refuses it |
| Candidate, second start | fails the same way; nothing changes |
| Deployed runtime | re-initialises, and its writers succeed; registrations stay at 10 |
| Roll-forward | re-adding the exact validated CHECK, then starting the candidate again, gives exactly 12 registrations with 0069 and 0067 applied |

## Reproduce (local disposable cluster only)

```sh
export OLD_ROOT=<checkout of f2b5eef9 with npm ci>
export NEW_ROOT=<checkout of this branch with npm ci>
export ADMIN_DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:<port>/postgres
D=docs/review/finance-upgrade-proof
EVIDENCE=$D/evidence/upgrade-proof.json node $D/proof/run-proof.mjs
EVIDENCE=$D/evidence/lock-inventory.json node $D/proof/lock-inventory.mjs
EVIDENCE=$D/evidence/partial-failure.json node $D/proof/partial-failure.mjs
EVIDENCE=$D/evidence/prerequisites-validation.json node $D/proof/validate-prerequisites.mjs
```

## What remains open

The proof does not close any release gate:

- Production schema compatibility (`prerequisites.sql` has not been run on Production);
- recovery proof;
- the migration-locking decision;
- the open decision in `rollout-plan.md` on how initialisation is triggered deliberately, since there is no dedicated "initialise and exit" command.
