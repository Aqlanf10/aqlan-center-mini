# Restore registry compatibility: multiline and columnless inputs — WIP

Reviewed head: `1d793d823fcd4ffbe11f9befa5055bdcc9a636b2`.
CI [44093782060](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/44093782060)
reported two PostgreSQL failures in `restore-multiline-literals.test.ts`.
The tests are retained unchanged; this note does not settle the compatibility policy.

The multiline registry test migrates a **synthetic** source and explicitly changes
migration `0058`'s stored `name` to a multiline, SQL-like string. The actual
application backup writer then exports the altered database row. The source
schema can therefore hold and the writer can export such a name, but this test
is not evidence that an actual historical installation contained one. The
candidate provenance guard rejects that name as mismatched metadata before
replay. Whether any historical mismatched names must be restored is unresolved;
no historical archive or patient data was inspected.

The columnless test directly writes a synthetic `INSERT INTO schema_migrations`
with version `9999` and an all-zero checksum; it labels this input as outside
the current writer's output. The predecessor filtered the statement, while the
candidate rejects the unknown version. The test is not evidence that a prior
writer actually emitted version `9999`, nor evidence that unknown historical
schemas can safely be ignored. Keep the old compatibility assertion visible
until the contract is decided.

A supplementary synthetic test can use a real matching migration version,
name, checksum, timestamp and adoption state in a columnless record, verifying
that the target registry stays unchanged. Separate negative tests can confirm
that unknown versions and name mismatches are refused before connection or
administrative target reset and that the archive and existing target remain
unchanged. Continue testing multiline application bytes and SQL-looking text
through both restore paths, as well as scanner boundaries in isolation. These
additional checks do not replace or silently invert the original assertions.

This is an investigation note only. It authorizes no production access,
deletion, deployment or merge, and it makes no release-readiness claim.
