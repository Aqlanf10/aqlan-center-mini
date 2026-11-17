# Synthetic sequence rollback and concurrency witness — WIP

This test-only branch starts at `1ad9e1d433ac14ab90a3767dafe48cdd8e6ac1a6`.
It is an investigative witness, not a product fix or a release candidate. The
current source appears to lower an existing serial high-water using `setval`
to `MAX(id)`; PostgreSQL does not roll `setval` back. The four high-water
assertions are therefore expected to fail on the base if replay reaches them,
but this has **not** been established by running PostgreSQL for this branch.

The test adds a synthetic-only witness to the existing standalone CI job. Its
global environment guard runs before connection; each case creates new local
databases, verifies their names, OID and owner, and retains their data, archive,
identity file, and stage for the lifetime of the disposable CI runner. It never
drops a database or removes evidence. Migration setup runs on freshly created
empty sources and targets before test data are inserted. No clinical data or
external database is used. CI's runner and databases are ephemeral and no
long-term retention outside it is claimed.

Four independent scenarios cover successful and deliberately late-failing
legacy replay to an explicitly permitted nonempty target, with the existing
serial and patient-number sequences set above all imported IDs and `is_called`
both false and true. The failure uses a writer-shaped duplicate key after the
writer's sequence statements, while requiring the particular synthetic
constraint failure and comparing all target table contents by digest. The test
compares the exact sequence state; it does not decide whether future policies
should tolerate gaps. The patient-number sequence is checked separately.

The fifth scenario adds a synthetic advisory-lock barrier through a trigger
on a uniquely owned target and advances the ID sequence on another connection
while replay waits. Its current expectation that replay succeeds preserves
the existing `allowNonEmptyTarget` path; an explicitly reviewed fail-closed
exclusivity policy could require a different acceptance contract. Neither this
test nor a `GREATEST` expression alone proves correctness under all races,
sequence caches, unusual increment settings, or backend failures.

Canonical-source restores already require a fresh target and are not the
subject of this witness. It does not prove safe behavior for unowned targets,
does not exercise the HTTP endpoint, and must never run against an existing
database. A future implementation must preserve old archive compatibility,
avoid leaking SQL/data, address the lock and failure-atomicity contract, and
be reviewed with synthetic PostgreSQL cases before any use. PostgreSQL's
`ALTER SEQUENCE ... RESTART` is transactional unlike `setval`, but choosing it
requires resolving locking, `is_called`, increment, and crash behavior:
https://www.postgresql.org/docs/current/sql-altersequence.html

Local verification: TypeScript transpilation and a focused in-memory compiler
check passed; the latter uses the current checkout plus the base guard overlaid
in memory and is not a full-project typecheck. No PostgreSQL, HTTP, Next build,
CI, or product code ran or changed. This branch intentionally retains the old
tests and adds coverage without relaxing any guard.
