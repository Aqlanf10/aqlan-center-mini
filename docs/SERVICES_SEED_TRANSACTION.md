# Default billing-services seed transaction repair

## Scope

The runtime billing-services seed remains in `ensureSchema()`. Its
`SKIP_SEED` gate, fail-soft error log, advisory-lock key `7461`,
`services.seeded` marker, default catalog and prices are unchanged.
This change neither retires runtime bootstrap nor changes migration ownership.
No existing service, patient, financial history, credential or backup is repaired
or deleted by this change.

## Proven failure

The previous block used a separate `getPool().query()` for `BEGIN`, the lock,
reads, writes, `COMMIT` and `ROLLBACK`. A `pg.Pool` checks out and releases a
connection for each such statement. Under a concurrent borrower, later statements
can execute outside the transaction opened by `BEGIN`.

On disposable PostgreSQL 18.4, deterministic borrowers reproduced:

- A transaction advisory lock that was already released before the catalog read
- Committed catalog rows despite failure to write the marker
- A committed marker with zero visible catalog rows when another request borrowed
  the transaction connection after its catalog insert
- Independent seeders that did not serialize before the empty-catalog decision

These are synthetic local reproductions, not evidence of existing Production
corruption or duplicates. A marker alone must not be used to infer or repair a
live catalog without separate authorized investigation.

## Repair

`lib/services-seed.ts` uses the existing `withTransaction` helper and its one
checked-out client for every seed statement. The helper commits or rolls back
on that client and releases it. `lib/db.ts` retains the seed failure handler.
The new helper imports database types only and never calls `ensureSchema`, so
it does not re-enter initialization.

The original decisions are retained:

- No marker and empty catalog: insert the unchanged defaults, then the marker
- No marker and existing catalog: preserve every row and add only the marker
- Existing marker: preserve the catalog, including a deliberately empty catalog
- Marker failure: roll back all newly inserted defaults and allow a later startup
  to retry; do not fail the whole application startup

## Regression evidence

`__tests__/postgres/services-seed.test.ts` exercises actual PostgreSQL with
independent connections, including unrelated borrowers, lock-wait observation,
rollback/retry, marker/catalog atomicity, exact defaults, repeat initialization,
owner edits, owner-created and emptied catalogs, and the real runtime caller's
`SKIP_SEED` and fail-soft behavior.

Before the fix, substituting the original pool-query seed statements into the
same helper boundary fails four of the eight tests: lock ownership, marker/catalog
atomicity, rollback, and concurrent serialization. With the pinned-client helper,
all eight tests pass on PostgreSQL 18.4. Existing catalog and transaction unit
coverage also passes (12 tests).

CI runs these regressions through the existing mandatory `test:postgres` job.
Production release verification remains a separate post-merge check.
