# Consent audit atomicity — independent candidate awaiting dot review

Root cause: `recordPlanConsent` committed consent and tooth-chart changes, then
called `void recordAudit`. That helper uses the pool outside the transaction and
swallows errors. The API could acknowledge success before its audit existed, and
an audit failure could leave committed consent without its evidence.

Changed application path: `lib/db.ts`, only `recordPlanConsent`. The existing
`insertAuditRow(client, ...)` is awaited before COMMIT. Existing rollback handling
now covers audit failures. No audit payload, ownership rule or financial writer
semantics changed. No schema/migration changes.

New test: `__tests__/postgres/plan-consent-audit-atomic.test.ts`.
Evidence/documentation: `docs/review/plan-consent-audit-atomic/`.
The existing ownership snapshot test is unmodified.

## Scope and provenance

Independent branch `fix/plan-consent-audit-atomic`, based on exact #370 candidate
`4b4e12db484833cbedbc39c816b7324fa054eafa`, tree
`85226dfceea4cb9a43ae17cfe1794bd973354258`.
No changes to #373 or other active branches. Parent task owns integration.
A PR against main includes inherited stack changes; the small reviewable repair
is the delta from this explicit base, not that entire comparison.

The parent supplied a CI annotation for run39528688050/job118989278283:
`plan-ownership-audit.test.ts:83`, direct cross-plan rejection, extra `plan.consent`
audit for plan2 by `agreement-admin`. No raw CI log was requested. That annotation
alone does not prove an ownership mutation. Source inspection plus the deterministic
reproduction establishes a deferred prior-consent audit mechanism consistent with
that extra row; it does not claim to reconstruct the exact hosted execution order.

## Deterministic reproduction and results

Synthetic PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2), server_version_num=180006,
Node22.23.3. Fresh container `aqlan-consent-atomic-pg18-synthetic`, ID
`8aed960ab9b50af9a2f74b11776aee8ac8e25100c7fa5cd37bb67e44c277ea53`,
label `aqlan.purpose=consent-atomic-synthetic`, loopback 127.0.0.1:55441.
Admin database `aqlan_p1_test`; isolated test database `aqlan_plan_consent_atomic`.
Before setup, container identity, server version and database inventory were
checked: only the newly created test database existed among aqlan databases.
The repository global setup also enforced its target/PG18 contract.

1. Delay only `currentAuditSource` using an explicit promise barrier. SQL, pool,
   transaction and business functions are real. While audit metadata is held,
   read full table snapshots from an independent connection. No timers, sleeps,
   retries or hidden audit rows. Before the fix, committed consent and planned
   tooth conditions were visible even though the audit could not yet persist.
   After the fix, the complete snapshot stays unchanged until release; successful
   return exposes consent, chart and exactly one audit together. Repeated consent
   is refused without changing the entire snapshot.
2. A test-only PostgreSQL BEFORE INSERT trigger rejects `plan.consent` audit.
   Before the fix the function returned `{ok:true}`. After the fix it rejects and
   the full snapshot (plans, items, tooth conditions, audit, invoices, payments,
   installments, including timestamps) is unchanged. Trigger is removed in cleanup.

`red.log`: 2/2 new tests failed for the above reasons on unmodified base.
`green.log`: 13/13 PG tests passed after the fix (2 new + all11 unchanged
plan-ownership-audit tests). No skips or timeout changes.
`units.log`: 33/33 related plans/audit/audit-source units passed.
Full Node22 TypeScript passed. Scoped ESLint: 0 errors, 8 pre-existing warnings
on unrelated lib/db.ts lines. `git diff --check` passed.

An initial combined run had a harness setup error because SESSION_SECRET was
unset; it was not counted as passing. The final run supplied a process-local
synthetic test secret, without reading/changing credentials or deployed secrets.

## Reproduce on a disposable PG18 instance

Use Node22, installed dependencies, explicit NODE_ENV=test and
DATABASE_ENVIRONMENT=test, a synthetic SESSION_SECRET at least32characters, and
TEST_DATABASE_URL pointing to a fresh local `aqlan_p1_test` database. Verify the
container and database identity before initialization or cleanup, then run:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.config.postgres.mts \
  __tests__/postgres/plan-consent-audit-atomic.test.ts \
  __tests__/postgres/plan-ownership-audit.test.ts
node node_modules/vitest/vitest.mjs run \
  __tests__/plans.test.ts __tests__/audit-source.test.ts __tests__/audit.test.ts
```

Limits: no full suite, HTTP/browser acceptance or production operation was run
for this repair. No cancelled CI is counted as a pass. No migrations, credentials,
CI configuration, assertion weakening, raw denied-log retrieval or deployment.
Keep Draft until independent review and parent integration gates are satisfied.
