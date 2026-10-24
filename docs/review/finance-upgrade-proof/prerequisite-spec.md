# Catalog-only prerequisite specification: f2b5eef9 → c998b435

**Status:** specification only, validated on local synthetic databases. Running it on Production is a separate operation that needs its own authorization. Nothing here authorizes that.

The deployed runtime is f2b5eef97047994438729fe8a2da72e214cdf881. The candidate is c998b435306f8295a217e49f20080293c479c359. During lazy schema initialisation the candidate applies four new extension files, in this order: **0066, 0068, 0069, then 0067**. Each file runs in its own transaction under the migration advisory lock and commits on its own (`applyRuntimeMigrationFiles`, `lib/migrations.ts`). A precondition that fails part-way therefore leaves the earlier files committed (see `evidence/partial-failure.json`). Every precondition is a property of the catalog, so it is checked before the first file runs.

## How to check

`prerequisites.sql` is a single read-only query:

- It runs as `BEGIN TRANSACTION READ ONLY`, with `statement_timeout 10s` and `lock_timeout 2s`, and ends in `ROLLBACK`.
- It returns `(check_id, ok, detail)` rows. A rollout may start only if **every `ok` is true**.
- It reads only:
  - the system catalogs;
  - the 8-row migration registry `schema_migrations` (version, name, checksum, adopted);
  - planner metadata (`pg_class.reltuples`, relation sizes).
- No patient, clinical or financial row is read. The only lock on an application table is ACCESS SHARE on `schema_migrations`.
- `detail` holds only object names, definitions, counts and estimates.

## Checks

| Group | check_id | Requirement | Why |
|---|---|---|---|
| Server | `server.version` | `server_version_num >= 110000` | `EXECUTE FUNCTION` and `hashtextextended` |
| | `server.not_in_recovery` | connected to the primary | DDL on a standby fails |
| Registry | `registry.exactly_eight` | exactly the eight versions 0051, 0052, 0056, 0057, 0058, 0063, 0064, 0065 | the deployed starting point that was proven |
| | `registry.names_and_checksums_match_published` | each row's name and checksum equal the published file | the runtime refuses a mismatch (`RUNTIME_MIGRATION_REGISTRY_MISMATCH`) |
| | `registry.none_adopted` | no row has `adopted = true` | the runtime refuses adopted rows; no baseline adoption |
| | `registry.candidate_versions_absent` | none of 0066, 0067, 0068, 0069 registered | this is a pre-upgrade gate, not a re-run check |
| New-object conflicts | `conflict.relation_names` | none of the 16 relation names exist (4 tables, 1 sequence, 11 indexes, explicit and implicit) | `CREATE TABLE` / `CREATE INDEX` have no `IF NOT EXISTS`; PostgreSQL would silently rename an implicit index, giving a schema other than the one proven |
| | `conflict.type_names` | no composite or array type with a new table's name | `CREATE TABLE` creates both types |
| | `conflict.functions` | none of the 4 functions exist under any signature | 0066 uses plain `CREATE FUNCTION`, which fails; 0068 and 0069 use `CREATE OR REPLACE`, which would silently replace an unrelated function |
| | `conflict.triggers_on_existing_tables` | none of the 5 triggers on `invoice_items`, `invoices`, `payments` and the two reclassification tables exist | `CREATE TRIGGER` has no `IF NOT EXISTS` |
| | `conflict.direction_check_name` | `invoice_settlement_reclassifications_direction_check` not used in the schema | 0069 adds it by name |
| Referenced keys | `keys.<table>.id` × 8 | `patients`, `treatment_plans`, `plan_items`, `clinical_cases`, `invoices`, `services`, `parties`, `users`: integer `id` with a single-column PRIMARY KEY or UNIQUE constraint | required by the new `REFERENCES` clauses |
| Columns read later | `columns.<table>.<column>` × 26 | each column exists, with the expected type category (number, text, date/time, integer array) | PL/pgSQL bodies are not validated at `CREATE` time, so a missing column would surface as a failed ordinary invoice, payment or reclassification write after the upgrade, not as a failed file |
| `appointments_patient_history_idx` | `appointments.index_name_absent` | the name is free | 0067 uses plain `CREATE INDEX` |
| | `appointments.no_equivalent_index` | no other index on `(patient_id, scheduled_date, scheduled_time, id)` without a predicate | not a correctness failure, but 0067 would build a redundant index while holding the write-blocking lock; the release owner decides |
| | `appointments.no_invalid_index` | no invalid index on `appointments` | a leftover invalid build is a sign of an interrupted operation |
| Old currency CHECKs | `currency.invoice_settlement_reclassifications_source_currency_check` | present, validated, definition exactly `CHECK ((source_currency = 'YER'::text))` | 0069 drops it **by name** with no `IF EXISTS` |
| | `currency.invoice_settlement_reclassifications_target_currency_check` | present, validated, definition exactly `CHECK ((target_currency = 'SAR'::text))` | as above. If it is missing, 0069 fails **after** 0066 and 0068 committed (proven) |
| | `currency.no_other_checks_on_currency_columns` | the only other CHECK is `…_source_invoice_ids_check` | an unknown extra CHECK makes the outcome unproven |
| Lock planning | `estimate.<table>` × 13 | informational (always `ok`) | `reltuples` and total size for the tables the four files lock |

**Why the new CHECK cannot fail on existing rows.** Each row of `invoice_settlement_reclassifications` satisfies `source_currency = 'YER' AND target_currency = 'SAR'`, because both old CHECKs are validated. Each such row also satisfies the new `direction_check`: YER and SAR are both in the allowed set, and they differ. So the validation scan that 0069 runs, under ACCESS EXCLUSIVE, cannot reject an existing row. Its *duration* still grows with the table's size, which is why the estimate is reported.

## Validation (synthetic only)

`proof/validate-prerequisites.mjs` builds the database with the deployed runtime and its own fixtures (`aqlan_prereq_base`). Each scenario then runs on a separate template copy and must fail **exactly** the listed checks. Result: `evidence/prerequisites-validation.json` is **PASS**.

| Scenario | Failing checks (must match exactly) |
|---|---|
| deployed schema with fixtures | none (all 64 rows ok) |
| target CHECK missing | `currency.…target_currency_check` |
| source CHECK re-added `NOT VALID` | `currency.…source_currency_check` |
| unknown extra CHECK | `currency.no_other_checks_on_currency_columns` |
| conflicting table, functions (plain and OR REPLACE), trigger, and constraint name | `conflict.relation_names`, `conflict.type_names`, `conflict.functions`, `conflict.triggers_on_existing_tables`, `conflict.direction_check_name` |
| index name taken, plus an equivalent index | `appointments.index_name_absent`, `appointments.no_equivalent_index`, `conflict.relation_names` |
| `payments.idempotency_key` renamed | `columns.payments.idempotency_key` |
| `parties` primary key dropped | `keys.parties.id` |
| registry row adopted, plus a checksum changed | `registry.none_adopted`, `registry.names_and_checksums_match_published` |

In addition, two states are reported rather than asserted:

- **Partially applied** (0066 and 0068 committed, 0069 failed), from `partial-failure.json` → `prerequisitesAfterFailure`. The check refuses this state: registry, conflict and target-CHECK checks fail. A partially applied database is handled by the roll-forward procedure in `rollout-plan.md`, not by re-running this gate.
- **Fully upgraded**: the check refuses it as expected.

## Limits

- Validated on PostgreSQL 18.6 with synthetic data. The production server version is unknown here and is reported by `server.version`.
- Lock *modes* are exact (see `evidence/lock-inventory.json`). No duration in this directory is a Production estimate.
- The check describes the catalog at the moment it runs. It must be repeated in the same window as the rollout, after writes stop.
