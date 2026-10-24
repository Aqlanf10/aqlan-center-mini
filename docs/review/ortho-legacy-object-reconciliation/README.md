# Ortho legacy-object login blocker: reproduction, regressions and reconciliation proposal

**Scope:** a repair review branch from the frozen candidate `c998b435`. No Staging or Production connection, no merge, no deployment. Everything here uses local synthetic PostgreSQL 18.6 databases.

This branch adds:
- **one regression test**;
- **this document.**

It does not change product code. The fail-closed guard, the migration files and the migration registry are unchanged.

## Reproduction: `__tests__/postgres/ortho-legacy-object-login.test.ts`

**Predecessor database:**
1. The candidate runtime initialises a fresh database, and a synthetic staff user is created.
2. The 0051 and 0052 objects and their `schema_migrations` rows are then removed.

The result is the candidate schema minus the two ortho extensions. Each scenario runs on its own template copy.

| Scenario | Legacy state, not registered | Login | `ensureSchema()` | Registry and objects |
|---|---|---|---|---|
| control | none | **200**; password verified once; 0051/0052 registered, not adopted | succeeds | 0051 and 0052 added |
| exact | the byte-identical 0051 contract SQL executed directly | **500** `{"message":"تعذّر تسجيل الدخول. أعد المحاولة."}`; password **never verified**; nothing logged | rejects `ORTHO_UNREGISTERED_OBJECT_COLLISION: 0051: …` | unchanged (registry rows and catalog fingerprint) |
| partial | only the 0051 `CREATE TABLE` (no index, routines or triggers) | 500, as above | rejects `…: 0051: …` | unchanged |
| conflicting | a different `ortho_strategy_revisions` table holding a synthetic row | 500, as above | rejects `…: 0051: …` | unchanged; the row is preserved |
| pair preflight | exact 0052 objects with 0051 absent | 500, as above | rejects `…: 0052: …` | unchanged; **0051 is not applied either**: the pair is guarded before any DDL |

**Sensitivity:** with the guard's `throw` disabled, the 4 legacy-object cases fail and only the control passes.

**Failure path:**
1. `POST /api/auth/login` calls `consumeStaffLoginAttempt()`, which calls `ensureSchema()`.
2. That calls `applyOrthoAssessmentRuntime()`, then `guardOrthoRevisionMigration()`, which throws.
3. The route's outer `catch` maps every error that is not about `SESSION_SECRET` to a generic 500 and logs nothing.

`/api/health` does not call `ensureSchema()`, so the service reports ready while every route that initialises the schema fails. This matches the Staging symptom: health returned 200 `ready:true`, but login fails.

## What stays forbidden

Each of these would either destroy evidence or claim a provenance that has not been proven:

- dropping or resetting the legacy objects;
- inserting registry rows blindly;
- setting `adopted = true`;
- adopting automatically at startup;
- weakening or disabling the guard;
- editing the published migration files.

## Proposed explicit reconciliation (design only; not implemented)

Implementation waits for Dot's catalog metadata from Staging and a review of this design. The shape below must not be guessed from the symptom.

1. **Operator-only tool, read-only by default.** For example, a `db:ortho-reconcile` script. It never runs from `ensureSchema()` and never runs at startup. Its default mode only reports.
2. **Classification by catalog equivalence, not by name.**
   - The tool computes a normalised catalog fingerprint of every object the guard inspects:
     - relation kind and columns (name, type, nullability, default);
     - constraints, via `pg_get_constraintdef`, including deferrability;
     - index definitions;
     - trigger definitions and enabled state;
     - function bodies (hashed);
     - sequence ownership;
     - composite and array types.
   - It compares that with the fingerprint produced by executing the **exact published contract SQL** in a throwaway schema or scratch database on the same PostgreSQL major version.
   - Result: `absent`, `exact`, `partial` or `conflicting`.
3. **Provenance and data invariants (read-only)** are checked for `exact` only:
   - every existing row satisfies the contract's CHECKs and the final-state rules that the trigger functions enforce (case ownership, version lineage, predecessor on the same case);
   - sequences are not behind `max(id)`;
   - no object outside the contract depends on these objects.

   The report contains only counts and pass/fail results, never row content.
4. **Eligibility:** only `exact` with every invariant passing is eligible. `partial` and `conflicting` are never reconciled by the tool. They need a separately reviewed, data-preserving migration plan and an owner decision.
5. **Recording, under a separate explicit approval flag, in one transaction under the migration advisory lock:**
   - write a reconciliation record: version, checksum, catalog fingerprint, SHA-256 of the evidence, operator, reason, time;
   - write the registry row with the published name and checksum, and `adopted = false`;
   - re-check the fingerprint inside the same transaction before committing.

   **Open decision for Dot and the owner:**
   - **Option (a), recommended:** registry row plus reconciliation record. This keeps the CLI migrator, the runtime and the release prerequisite (exactly eight registrations) consistent.
   - **Option (b):** no registry row; the guard accepts a matching reconciliation record and re-verifies the fingerprint on each start. This changes the guard, and it leaves the registry permanently short.
6. **Tests to add when implementing:** exact passes only with all invariants; each kind of drift (a column, a constraint, deferrability, a trigger, a function body, sequence ownership) is refused; partial and conflicting are refused; dry-run writes nothing; a concurrent runtime start is serialised by the advisory lock; the existing guard cases stay green.

## Proposed sanitised login error logging (not implemented)

**Goal:** an operator can see why login returned 500 without the log carrying credentials, request content or patient data.

```ts
// app/api/auth/login/route.ts, inside the outer catch (sketch)
const LOGIN_FAILURE_CODES = [
  "ORTHO_UNREGISTERED_OBJECT_COLLISION", "ORTHO_MIGRATION_REGISTRY_MISMATCH", "ORTHO_MIGRATION_SOURCE_MISMATCH",
  "RUNTIME_MIGRATION_REGISTRY_MISMATCH", "RUNTIME_MIGRATION_SOURCE_MISMATCH", "SESSION_SECRET",
] as const;
function loginFailureCode(error: unknown): { code: string; version?: string } {
  const message = error instanceof Error ? error.message : "";
  const code = LOGIN_FAILURE_CODES.find(candidate => message.startsWith(candidate) || (candidate === "SESSION_SECRET" && message.includes(candidate)));
  if (code) return { code, version: /^[A-Z_]+: (\d{4})\b/.exec(message)?.[1] };
  const sqlstate = (error as { code?: unknown } | null)?.code;
  return { code: typeof sqlstate === "string" && /^[0-9A-Z]{5}$/.test(sqlstate) ? `sqlstate:${sqlstate}` : "unclassified" };
}
console.error(JSON.stringify({ event: "staff_login_failed", ...loginFailureCode(error) }));
```

**Rules:**
- Log only an allowlisted code, an optional 4-digit migration version, or a 5-character SQLSTATE.
- Never log: the username, password, request body or headers, the exception message, the stack, or any object or row data.
- The HTTP response stays the generic Arabic message.

**Tests to add when implementing:**
- the exact log line for each allowlisted code;
- `unclassified` for an arbitrary error whose message contains a synthetic secret, with that value absent from every log argument;
- the response body unchanged.

## Status

- **Frozen candidate:** `c998b435` is unchanged.
- **Production:** no deployment. Staging acceptance by Dot and the owner is still required.
