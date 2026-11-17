# Reserved synthetic ID across restore — investigative witness

This is a **test-only WIP** on `603b4756584e7570dfacd0f62e76699ccd3702c1`;
it is not a product fix, readiness finding, or policy decision. The baseline
restore path describes its target as isolated. The experiment intentionally
uses a second connection to demonstrate what an unverified isolation promise
would fail to protect. A collision in this synthetic experiment would not by
itself prove that a correctly isolated target violates its existing contract.

Each of two cases (`is_called=false` and `is_called=true`) creates a unique
source and target database on the guarded CI PostgreSQL 18 service. Guards run
before this witness's first connection. The standalone global setup separately
connects to the dedicated CI service, and the fixture's maintenance connection
uses its `postgres` database to create new names. Each generated database's
intent, OID and owner are retained and checked against `current_user` before
test data or a sequence value are changed. A statement timeout is set only on
the unique synthetic target. It is not a product database policy.

The legacy, noncanonical source archive has a synthetic patient ID that the
target allocator returns in an earlier autocommit query; the allocator then
attempts its separate later INSERT after replay. This models a previously
issued ID outside a live transaction, not all possible application flows. If
replay reports success, the test verifies the restored patient fields and
classifies the later INSERT as either the exact synthetic primary-key collision
or success; unexpected errors fail with a fixed message. If replay rejects,
only the existing exact nonempty-target refusal is recognized: it must first
preserve target table data, sequence state, archive and stage marker, after
which the reserved INSERT must succeed. Unrecognized failures remain red and
are never reported as safe rejection. All emitted labels are fixed; IDs and
database messages are not printed.

The test retains its synthetic databases, archive, intent/identity files and
stage for the life of the CI runner; it does not drop a database or remove
those files. The backup writer removes its own private temporary working
directory, and CI's disposable service and files do not survive the runner.
It checks all public target table rows before a refused replay by digest, but
does not prove preservation of every catalog item, privilege, source table,
cache state, or external system. It checks the originally owned database and
selected source/target patient fields; not all possible concurrent actors.
The direct `stagedRestore` function is tested, not an HTTP endpoint.

The experiment does not assert that all sequences are safe under concurrent
restore, infer an exclusivity policy, or solve migration commits that precede
replay. A future safe implementation must define an authorized isolation/fence
contract, consider already-issued values, exact `is_called`, source/target
catalogs, migration atomicity, privileges and old archives. Source-code and
standalone PostgreSQL mechanics are evidence for further testing, not a
blanket safety proof. See the [companion investigation](https://github.com/Aqlanf10/aqlan-center-mini/blob/codex-sequence-fence-evidence-wip-20261117/docs/review/restore-sequence-fence-plan-wip-20261117.md).

An in-memory focused TypeScript check and ESLint lintText passed locally; the
compiler uses the current checkout plus the base guard and classifier overlaid
and is not a full-project typecheck. This witness has not been run on
PostgreSQL, through HTTP, in a build, or in CI.
