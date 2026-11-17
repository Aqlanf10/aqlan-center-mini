# Target migrations before replay — synthetic witness WIP

This is an independent, read-only source finding and an unrun synthetic CI
witness for `603b4756584e7570dfacd0f62e76699ccd3702c1`. It is not a product
fix, an approved restore policy, or evidence about a real patient's database.

`stagedRestore` validates the archive, then invokes `migrate(...apply:true)`
before it issues the `BEGIN` around `prepared.dataSql`. The migrator applies
pending migrations in individual transactions and commits their SQL and
registry entries. Thus a later replay rollback does not itself undo earlier
committed migrations. This is a source-level conclusion; this new witness has
not yet run on PostgreSQL and cannot establish that a particular real target
changed. The target's original rows and previous registry entries must not be
assumed lost or preserved solely from the ordering.

The direct opt-in path can be invoked by `restore-full` with
`--allow-non-empty-target` for an eligible legacy, noncanonical source. It
differs from the admin drill: that path verifies the source and then resets its
designated dedicated target before calling staged restore with the nonempty
override disabled. No conclusion about keeping the admin drill's pre-reset
target is made here. Canonical source restores require an empty target and are
not this scenario. The raw SQL `scripts/restore.mjs` has its own replay path;
an eventual fix must review and test it separately rather than assume staged
restore covers it.

The added witness builds separate, randomly named PostgreSQL databases on the
guarded CI-only service; it verifies OID, owner and current role, migrates both
empty databases to 0043, and only then adds synthetic rows. It creates a real
archive from the source and a separate archive with a writer-shaped late
duplicate, each retained with its hash. The target retains a stage marker and
an existing patient row. After invoking staged restore with nonempty explicitly
allowed, the test requires the exact synthetic late primary-key error; it then
checks that old registry fields and the existing row survived and observes the
0080 registry row and table. It never drops a database or removes the retained
witness files. The backup writer removes its own private temporary working
directory; the runner and its isolated DBs are ephemeral after CI completes.

The assertion about `0080` documents current ordering if the witness reaches
it. It is **not** an endorsement that migration-before-failure is acceptable.
If a future reviewed design provides whole-operation atomicity or refuses a
nonempty target before migrating, this investigation witness must be rewritten
with that explicit contract rather than used to force the old behavior.
The test checks a named table and selected data; it does not inspect every
catalog object, all sequences, replication-session settings, or every failure.
The strict constraint-message match is specific to this base; integration
with privacy diagnostics must use trusted bounded codes without leaking raw
database messages.

The companion high-water witness covers different sequence risks and remains
independent. Candidate remedies for migration/replay atomicity must preserve
historical 0079 contracts and backups, address pending/unknown migrations and
callbacks, explicitly handle privileges and concurrency, and avoid irreversible
changes before an informed target-safety decision. No production policy or
implementation change is proposed here.

Local status: a focused in-memory TypeScript check and ESLint lintText passed;
the check uses the current checkout with the base witness guard overlaid and is
not a full-project typecheck. No PostgreSQL, HTTP, build, or CI ran on this test.
