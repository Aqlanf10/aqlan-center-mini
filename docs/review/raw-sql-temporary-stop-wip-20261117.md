# Temporary raw SQL restore stop — WIP

The legacy `scripts/restore.mjs` entry point now rejects every invocation with a
fixed message and exit code 2 before loading the environment, reading a backup,
constructing a PostgreSQL client, or connecting to a target. No command-line
option or environment variable enables it. This also disables restoring to a
new, empty database. The reason is that this importer cannot establish that an
initialized target is empty before connecting. This is a temporary policy, not
a claim that raw restore is otherwise safe.

The legacy implementation remains in the file for later review; existing
historical tests and fixtures, including byte preservation and escaping tests,
have not been removed. Tests expecting this entry point to perform a restore or
produce a later refusal conflict with this temporary policy and will fail until
their contracts are reviewed. No claim is made that the full suite is green.

This raw SQL guard is independent of staged full-archive restore and does not
itself protect admin reset or other database access paths. On the combined review
branch those paths have separate temporary guards, with their own documented
limits; none establishes complete target isolation.

The focused subprocess tests use synthetic arguments and targets and a preload
that checks the specific synchronous file methods used by the old importer and
its environment loader, selected asynchronous file methods, socket connection,
ordinary DNS methods, and construction of the `pg` client. Positive controls
exercise the probe. These observations and source ordering support the narrow
claim above; the preload is not a universal I/O monitor. No PostgreSQL instance,
real data, deployment, or build is used by these tests.
