# 0124 compatibility with the unregistered legacy lineage column

The 0124 migration file is immutable. Its SHA-256 remains
`0d1d94a2003db6599dee120be75c3ff092ad4a19f4e1c911cbde1aa9fc845355`.
The shared CLI/runtime migrator now has an explicit alternate execution path
in `lib/ceph-lineage-migration-compat.ts`; it does not rewrite migration files,
adopt an already installed 0124, or change any existing registry row.

On a fresh schema the original SQL executes unchanged. On the narrowly verified
legacy schema, the original `ADD COLUMN ... REFERENCES` clause becomes an
`ADD CONSTRAINT ... FOREIGN KEY` clause with identical reference, delete action,
and deferrability. Every other byte of the original SQL is executed unchanged.
The registry checksum identifies the original reviewed migration contract,
not the alternate SQL string. This distinction is intentional and must remain
visible in review and deployment records.

The existing column must be nullable bigint without a default, identity,
generated expression or array dimensions. It must have exactly the validated, enforced,
nondeferrable `ceph_analyses_corrects_older_chk` and
`ceph_analyses_corrects_same_patient_fk` constraints with the known definitions.
All three `correction_source*` columns must be absent, and no existing row may
have a non-null `corrects_analysis_id`. Existing legacy correction links require
separate review; this code never invents completion evidence for them.

Validation and application run in the same transaction with an ACCESS EXCLUSIVE
table lock, under the migrator's existing shared advisory lock. Unknown shape,
object collisions and subsequent SQL errors roll back both DDL and registry
insertion. Fresh and upgraded schemas receive identical 0124 constraints,
functions and triggers. The legacy older-ID and same-patient constraints remain
in place, so the upgraded schema intentionally retains those additional checks.
No table, column, constraint, existing row or backup is deleted.

Restore continues validating archived 0124 provenance against the original
checksum. Restoring registry snapshots does not overwrite destination migration
provenance. Compatibility upgrades must go through the application CLI/runtime
migrator, not direct execution of the immutable SQL file on a legacy schema.

Coverage: isolated PostgreSQL 18 fixtures exercise fresh and legacy upgrades,
row preservation, CLI/runtime replay and concurrency, incompatible shape,
existing non-null links, partial-object collisions, transaction rollback,
source pinning, and restore provenance filtering. No live database is modified
by these tests.
