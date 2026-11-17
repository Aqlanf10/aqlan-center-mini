# Synthetic sequence rollback and concurrency witness — WIP

**WIP:** The corrected witness and its timeout handling require independent
review before any push. No PostgreSQL run is claimed.

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
empty sources and targets before test data are inserted. The backup writer
removes its own internal temporary working directory, distinct from the
retained witness archive, stage and database evidence. No clinical data or
external database is used. CI's runner and databases are ephemeral and no
long-term retention outside it is claimed.

Four independent scenarios cover successful and deliberately late-failing
legacy replay to an explicitly permitted nonempty target, with the existing
serial and patient-number sequences set above all imported IDs and `is_called`
both false and true. The failure uses a writer-shaped duplicate key after the
writer's sequence statements, while requiring the particular synthetic
constraint failure and comparing all target table contents by digest. After
failure the test requires exact sequence state, including `is_called`, in this
isolated target. After success it requires no regression, and reports any
changed state with a fixed diagnostic; it does not decide whether gaps are
acceptable. The patient-number sequence is checked separately. Successful
replay also compares the restored patient fields with the synthetic source.
A separate case tests the existing `allowNonEmptyTarget=false` rejection. If
the override cases are refused early, their checks report that the intended
successful replay or late rollback was **not exercised**, rather than count
the refusal as a successful replay or a demonstrated rollback.

The fifth scenario adds a synthetic advisory-lock barrier through a trigger
on a uniquely owned target and advances the ID sequence on another connection
while replay waits. Success must preserve and restore relevant patient rows;
the existing, exact nonempty-target rejection is allowed only after checking
that the rows, stage and sequence state remain safe. A rejection before the
barrier is reported separately and does not claim that concurrency ran. Any
other error is unclassified and fails the witness with a fixed message. If the
barrier is reached, the next-candidate floor must remain above the concurrent
allocation. The allocator runs asynchronously; the barrier is released after
allocation completes or a sequence-lock wait is observed, so a transactional
fix may block the allocator without deadlocking the witness. A fixed completion
deadline bounds the paired promise wait, and a statement timeout is set only on
the owned disposable target; neither guarantees a bound on every Node or cleanup
hang. This is a safety witness, not a policy that concurrent replay must
succeed. Neither this test nor a `GREATEST` expression
alone proves correctness under all races,
sequence caches, unusual increment settings, or backend failures.

Canonical-source restores already require a fresh target and are not the
subject of this witness. It does not prove safe behavior for unowned targets,
does not exercise the HTTP endpoint, and must never run against an existing
database. A sampled target connection verifies ownership, required privileges
and READ COMMITTED; it does not inspect the replay connection's isolation
directly. The disposable CI role may be a superuser. The late-failure test on
this base recognizes `patients_pkey` in an error; integration with the separate
privacy branch must preserve constraint provenance without exposing raw
database messages. Its existing target-refusal classifier recognizes only the
current exact error, and must be updated explicitly if a reviewed future policy
introduces a new stable reason. A future implementation must preserve old archive compatibility,
avoid leaking SQL/data, address the lock and failure-atomicity contract, and
be reviewed with synthetic PostgreSQL cases before any use. PostgreSQL's
`ALTER SEQUENCE ... RESTART` is transactional unlike `setval`, but choosing it
requires resolving locking, `is_called`, increment, and crash behavior:
https://www.postgresql.org/docs/current/sql-altersequence.html

Local verification: TypeScript transpilation, a focused in-memory compiler
check and ESLint's in-memory lintText passed, as did 15 pure synthetic refusal
classifier checks. The compiler uses the current checkout plus the base guard
overlaid in memory and is not a full-project typecheck. No PostgreSQL, HTTP, Next build,
CI, or product code ran or changed. This branch intentionally retains the old
tests and adds coverage without relaxing any guard.
