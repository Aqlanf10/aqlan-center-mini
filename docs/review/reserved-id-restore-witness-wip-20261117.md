# Reserved synthetic ID across restore — investigative witness

This is a **test-only WIP** on `603b4756584e7570dfacd0f62e76699ccd3702c1`;
it is not a product fix, readiness finding, or policy decision. The baseline
restore path describes its target as isolated. The experiment intentionally
uses a second connection to demonstrate what an unverified isolation promise
would fail to protect. A collision in this synthetic experiment would not by
itself prove that a correctly isolated target violates its existing contract.
The actor's separate SQL requests are intentionally non-cooperating; this test
does not establish that normal `createPatient` separates allocation from INSERT.

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
classifies the exact synthetic primary-key collision. Unexpected success or
any other error is unclassified and fails with a fixed message. If replay rejects,
only the existing exact nonempty-target refusal is recognized: it must first
preserve target table data, sequence state, archive and stage marker, after
which the reserved INSERT must succeed with `RETURNING` and a matching persisted
actor row. Unrecognized failures remain red and are never reported as safe
rejection. All emitted labels are fixed; IDs and
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
and is not a full-project typecheck. No PostgreSQL or build ran locally.

## Synthetic CI observation

On exact revision `df3531956cc93ce7b0735d18f08f29e93702dc47`,
[CI 44113745713](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/44113745713)
ran this witness on its disposable PostgreSQL 18 service. Both cases passed as
observational classifications and emitted
`SYNTHETIC_RESERVED_ID_COLLISION_AFTER_ACCEPTED_REPLAY`: after the actor's
separate, non-cooperating ID allocation, staged replay reported success, and
the actor's later INSERT encountered the synthetic `patients_pkey` collision.
This occurred for initial called and uncalled states. The restored patient
fields were compared before that INSERT attempt; afterward the witness compared
the original target patient fields, source patient fields, archive, stage and
target identity. It did not recompare the restored patient row after the actor
attempt or compare all target tables on accepted replay. It does not test the
normal `createPatient` path, any HTTP endpoint, or a properly isolated target.

The standalone CI job as a whole failed: the inherited
`sequence-atomicity.witness.ts` had five failing cases, while this witness
had 2/2. Other CI jobs were still running at observation time. This result is
evidence of the specified synthetic behavior, not an approved concurrency
policy, product fix, proof of production behavior, or full-CI success.
