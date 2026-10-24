# Ortho legacy-object login blocker: reproduction, diagnostics and explicit 0051 reconciliation

**Scope:** a repair review branch from the frozen candidate `c998b435`, per #451 comments 6377946506, 6377980588 and 6378081251. There was no Staging or Production connection, merge or deployment. Every test uses local, disposable, synthetic PostgreSQL 18.6 databases.

**Labelling:** the reproduction is synthetic. It does **not** prove the full shape of the live table. Dot's read-only catalog comparison (owner-approved summary, 6378081251) reports that the existing unregistered Staging 0051 schema matches the pinned contract structurally. **That is not an authorization to repair.** The live data invariants and a separately approved run are still required.

**Unchanged:**
- the normal startup guard (`guardOrthoRevisionMigration`), which stays fail-closed;
- the migration files and generated contracts;
- the registry semantics.

**Never done:** DROP or reset, blind registry insertion, `adopted = true`, automatic adoption at startup.

## 1. Reproduction: `__tests__/postgres/ortho-legacy-object-login.test.ts` (5/5)

**Predecessor:** the candidate schema minus the 0051 and 0052 objects and registry rows, plus a synthetic staff user.

| Scenario (not registered) | Login | `ensureSchema()` | Registry and catalog |
|---|---|---|---|
| control (no legacy objects) | 200; password verified | registers 0051 and 0052 (not adopted) | — |
| exact 0051 objects | **500**, unchanged generic Arabic message; **password never verified**; one sanitised log line | `ORTHO_UNREGISTERED_OBJECT_COLLISION: 0051: …` | unchanged |
| partial (0051 table only) | 500, as above | same | unchanged |
| conflicting table with data | 500, as above | same | unchanged; row preserved |
| exact 0052 alone | 500, as above | `…: 0052: …` | unchanged; 0051 not applied (the pair is guarded before any DDL) |

With the guard's `throw` disabled, the 4 legacy-object cases fail.

## 2. Sanitised login diagnostics: `lib/login-failure-diagnostics.ts`

The route's outer catch now logs exactly one line:

```json
{"event":"staff_login_failed","stage":"rate_limit","category":"ORTHO_UNREGISTERED_OBJECT_COLLISION","version":"0051"}
```

- **`stage`** is one of: `rate_limit`, `user_lookup`, `password_verify`, `session_issue`.
- **`category`** is one of:
  - the five migration guard codes;
  - `session_secret_missing`;
  - `database_connection`, `database_resources`, `query_canceled` or `schema_object_missing`, derived from the SQLSTATE or errno code;
  - otherwise `unclassified`.
- **`version`** appears only for the migration guard categories, and only as 4 digits.
- **Never logged:** the exception message, detail, hint, stack, cause, username, password, headers, SQL, URLs or patient data.
- **Responses are unchanged:** 500 generic, and 503 for a missing `SESSION_SECRET`.

**Tests:** `__tests__/login-failure-diagnostics.test.ts` (22/22) covers:
- a classifier table;
- hostile and non-Error throws;
- each route stage with secret-bearing injected errors, asserting the exact single line and that no secret appears in any log argument.

The 4 route tests were **red before the route change** and are green after.

## 3. Explicit 0051 reconciliation: `lib/ortho-legacy-reconciliation.ts`, `npm run db:ortho-reconcile`

**Operator-only.** It is never called from `ensureSchema()` or at startup.

```text
npm run db:ortho-reconcile -- --database <name>                      # report only, always ROLLBACK
npm run db:ortho-reconcile -- --database <name> --apply \
  --expect-fingerprint <sha256 from the report> --actor <name> --reason <text>
```

**Sequence:** session `pg_advisory_lock(MIGRATION_ADVISORY_LOCK_KEY)` (the same lock the migrator and runtime use), then one transaction with `lock_timeout 5s` and `statement_timeout 120s`:

1. **Target and registry:**
   - `current_database()` must equal `--database`;
   - `0051` must not already be registered;
   - the contract source is checked against the generated, pinned contract.
2. **Reference:** the exact published 0051 SQL runs in a throwaway schema inside a savepoint that is always rolled back, so its objects and locks vanish with it.
3. **Freeze writes:** `LOCK TABLE ortho_strategy_revisions IN SHARE ROW EXCLUSIVE MODE`. Writes stop; reads continue.
4. **Classify by catalog equivalence**, not by name. The comparison covers:
   - relations: kind, persistence and options;
   - columns: type, nullability, default, identity and generated status;
   - constraints: definition, deferrability, validation and whether they are local;
   - indexes: definition, valid, ready and live;
   - triggers: definition and enabled state;
   - functions: signature, return type, language, volatility, security, body hash and config;
   - the sequence: parameters and owning column;
   - row and array types.

   Result: `absent`, `exact`, `partial` or `conflicting`. Owners and ACLs are not compared.
5. **Existing-data invariants**, run read-only and reported as counts only, re-evaluating the contract's rules on every row rather than trusting the installed triggers:
   - column CHECK rules, `first_revision` and `not_self`;
   - references exist;
   - **owner bridge** (the ortho case and the clinical case both belong to the revision's patient);
   - **exact predecessor** (same case and clinical case, version − 1);
   - no duplicate version, successor or command.

   The sequence must not be behind `max(id)`.
6. **Apply, only if** the classification is `exact`, every invariant is 0, the sequence is ok, and the fingerprint matches `--expect-fingerprint`. In the same transaction it then:
   - writes an append-only `audit_log` row (`schema.migration_reconciled`) holding the fingerprints, the evidence SHA-256, the row count and the reason;
   - writes `schema_migrations('0051', <contract name>, <contract checksum>, adopted = FALSE)`;
   - **recomputes the catalog fingerprint**, and aborts if it changed;
   - commits.

   Any failure rolls back both writes.

**History and sequence are preserved.** No row or object is changed. `0052` is out of scope: there is no evidence about it, so it stays blocked by the guard if any of its objects exist unregistered, and is applied normally by startup if none do.

**Tests:** `__tests__/postgres/ortho-legacy-reconciliation.test.ts` (21/21):

| Case | Result |
|---|---|
| dry run, exact, 3 synthetic revisions | eligible; invariants 0; nothing written; startup still refuses |
| apply with the confirmed fingerprint | 0051 registered (not adopted) plus one audit row; history and sequence identical; startup then applies only `0052`; a repeat is refused (`already_registered`) |
| no, stale or wrong fingerprint; missing actor; short reason; wrong database | refused; nothing written |
| absent, partial table, conflicting table, extra column, disabled trigger, changed function body, changed deferrability, missing index | refused as `absent`, `partial` or `conflicting`, with differences listed; nothing written |
| a row that breaks the owner bridge (inserted with triggers bypassed) | refused `row_invariants_violated` (`owner_bridge: 1`); nothing written |
| sequence behind the rows | refused `sequence_behind_rows` |
| failure injected just before commit | both writes rolled back; no advisory lock left |
| advisory lock held by another session | waits until it is released |
| two concurrent applies | exactly one `applied`, the other `already_registered`; one registry row, one audit row |
| apply racing normal startup | serialised; startup never adopts; consistent end state |

**Mutation checks:**

| Mutation | Tests that catch it |
|---|---|
| ignoring the invariants | owner-bridge test |
| ignoring the sequence check | sequence test |
| dropping the advisory lock | lock-wait and concurrent-apply tests |
| treating `partial` as `exact` | partial and missing-index tests |

Argument parsing is covered by `__tests__/ortho-reconcile-args.test.ts` (6/6).

## Unresolved conditions before any live use

1. **Existing-data invariants on Staging must be run and reviewed.** Report-only mode does this read-only, and its report contains only counts and catalog identifiers. Running it against Staging is Dot's call and needs owner authorization. It was not done from this branch.
2. **Apply needs separate explicit approval.** That covers the reviewed fingerprint, the actor and the reason. Any `partial` or `conflicting` result, or any invariant violation, stops for review. It never leads to deletion, reassignment or guessing.
3. **The decision to record a registry row** (`adopted = false`) **plus an audit row** is recommended here and needs Dot's and the owner's acceptance.
4. **0052 status on Staging is unknown.** If its objects exist unregistered, startup stays blocked by design.
5. **Staging acceptance by Dot and the owner** is required before any Production deployment. No merge or deployment from this branch.
