# PostgreSQL sequence mechanics witness — test-only WIP

This branch builds on `1ad9e1d433ac14ab90a3767dafe48cdd8e6ac1a6` and tests
PostgreSQL mechanics only. It is not a restore implementation, a policy change,
or a release candidate. The hypothesis that a same-increment `ALTER SEQUENCE`
can make subsequent `setval`/`nextval` effects rollback-safe is not assumed to
be true: the synthetic PostgreSQL CI result must decide it. The committed app
code is unchanged.

The tests verify the baseline that `setval` without an ALTER survives a
rollback; then for both `is_called` values test ALTER plus setval/nextval on
rollback, and ALTER plus low setval followed by restoration on commit. Two
further cases start a `nextval` on a different session while ALTER holds its
transaction, check the relation lock wait, release the transaction, and
validate the value after COMMIT or ROLLBACK. A separate case observes a backend
that acquired sequence cache before a same-increment ALTER and cache change;
it prints only a fixed category and does not require either cache outcome.

The environment guard executes before connecting. Every case creates a new
randomly named database on the dedicated local PostgreSQL 18 CI service,
verifies name/OID/owner/current role, and records its identity in a unique
temporary directory. A statement timeout is configured only on that newly
created database before the test connections. Connections are closed but no
database or evidence file is removed; CI's disposable runner and database
service are ephemeral and this is not an external-retention guarantee. No
patient data, existing database, production service, staging deployment, or
unrelated local database is accessed by the witness.

Even a green result would establish only the tested PostgreSQL 18 behavior,
not a production-safe concurrency fence. Existing backends can hold cached
values and a point-in-time `pg_stat_activity` check does not prevent new
connections. A future implementation must address those limits, privilege
and ownership changes, all sequences touched by triggers/defaults, bounds,
lock ordering, old archive compatibility and error privacy separately.

Local checks are limited to a focused in-memory TypeScript check and ESLint
on the test file, using the current checkout with the base CI guard overlaid;
these are not a full-project typecheck or a PostgreSQL/HTTP result. The test
adds a file to the existing standalone
CI witness configuration without removing or weakening any prior test.
