# Actual DEFAULT ID after failed replay — draft synthetic witness

This is a **test-only draft**, not a product fix, release finding or approved
policy. It has not run on PostgreSQL, in HTTP, in a build, or in CI. The
existing sequence regression was observed in synthetic CI on `603b4756`; this
new witness asks whether a real `DEFAULT patients.id` INSERT after an injected
late replay failure falls above an ID allocated concurrently on the same owned
synthetic target. Patient-number text is fixed synthetic data and does not test
the separate patient-number allocator.

Four cases combine a target with no public tables at stagedRestore entry or a
previously migrated target with one synthetic row, and both `is_called` states.
A test-only `installUnregisteredProposals` callback runs after target
migrations and adds a synthetic trigger and high-water before replay. A
separate connection controls the trigger's advisory barrier. The actor runs
`nextval` asynchronously; replay resumes after allocation completes or an
actual sequence-lock wait is observed. After the exact writer-shaped duplicate
fails replay, the witness compares snapshot table rows and migration registry,
source patient fields, stage, both archives and target identity, then issues an
actual INSERT with DEFAULT ID and checks `RETURNING` and the persisted actor
row. A fixed marker and assertion distinguish whether the returned ID exceeds
the reserved floor. No numbers or raw database messages are printed.

The fixture uses only a guarded dedicated CI PostgreSQL 18 service. Global
setup connects to its service database; the fixture connects to its `postgres`
maintenance database, creates unique source and target databases, records intent
and OID/owner/current role, and retains them. It does not drop a database or
delete witness evidence; the backup writer removes its own internal scratch
directory. The CI runner and databases are ephemeral. Any rejection before the
callback/barrier is **NOT_EXERCISED**, never counted as replay or rollback
success; unclassified errors fail with a fixed code. The callback is test-only
and leaves its synthetic trigger as evidence inside its newly owned target.

This draft requires independent security, timing, isolation and test review
before push. It does not prove the ordinary `createPatient` transaction uses
the actor's separate SQL flow, test an HTTP endpoint, cover all sequences or
roles, or justify the nonempty-target concurrency policy. Its completion
deadline and database statement timeout do not bound every Node/cleanup hang.
