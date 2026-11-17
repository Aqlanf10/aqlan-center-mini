# Retained synthetic restore-history selector (WIP)

`vitest.config.restore-history-witness.mts` selects the three HR archive cases
and two inventory restore cases. It intentionally excludes later inventory
reset cases that remove temporary triggers; it does not change the existing
PostgreSQL gate or claim coverage of the excluded cases. A separate workflow
provides the required isolated PostgreSQL 18 service and runs only on its specifically
named review branch, including manual dispatch; another ref fails a separate
branch gate before either job. The guarded global setup checks the
environment before its first connection. This combined candidate has not been
run against PostgreSQL. Its completion gate requires all five named cases to
pass; a failure before the witness step starts produces no report artifact.
An independent job is configured to exercise the raw SQL and nonempty-option
subprocess refusals on Node 22.13.0 without a database; its result is not known
until that job runs.

Only with `SYNTHETIC_RESTORE_HISTORY_WITNESS=1` and the full CI guard do the
two files use retain-only mode. Before CREATE each generated name is recorded
as an intent under a fresh directory in runner temp; after CREATE its OID and
owner are recorded. The fixture closes pools and admin connection on success
or setup failure without dropping newly created databases in this mode, even
if identity recording fails. Test teardown does not remove their directories.
A failed intent write prevents CREATE; if CREATE succeeds but later identity
lookup fails, only the intent may remain. Only a fixed-field sanitized result
report is uploaded; no archive, dump or raw logs are included. Runner teardown
destroys ephemeral CI resources, so this is retention for the runner lifetime,
not a durable backup. The writer's own private backup scratch may be removed by
that writer.

The fixture's ordinary mode and its existing identity-checked cleanup stay in
place for other users and ordinary PostgreSQL CI. In ordinary mode these two
files also retain their existing cleanup; only the separate guarded selector
has the no-delete guarantee. Unit mock tests cover the distinction and setup
failures; they do not demonstrate live PostgreSQL or runner behavior.
