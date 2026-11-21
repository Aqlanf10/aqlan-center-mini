# Offline application archive numbering round-trip

Review-only: no archive endpoint, scheduled backup, manifest version, restore CLI, schema migration, or live clinic backup is changed. This adapter is intentionally unmounted. It exercises only private synthetic fixtures using the existing `fullBackupBlocks` writer and `stagedRestore` application reader.

## Why the detached witness exists

The existing archive replays public patient rows byte-for-byte in the application SQL format, including their existing file numbers. Its sequence resets only cover serial IDs attached to rows. The independent `patient_number_seq` is not part of that contract; neither is the private review policy. A data restore that passes as an old application archive cannot be interpreted as approval to start managed numbering or infer a safe next file number. PostgreSQL sequence reads also do not participate in the application's normal row MVCC snapshot.

The adapter seals a small detached witness only after matching captures from the **held** original source before and after the existing archive writer. The attachment binds the exact compressed archive SHA-256 **and** validated database.sql SHA-256 to the original database identity, held policy revision/prefix, exact decimal sequence `last_value`, boolean `is_called`, and digest of the existing synthetic ID→file number map. It does not contain patient names, copies of IDs, credentials, or approval. Checksums are integrity, not authority: verification requires the expected attachment digest from independent trusted fixture control. Never accept a hash supplied by an otherwise untrusted incoming archive as an approval. Other independent checks to establish backup provenance are unchanged.

An old archive with no attachment still validates as legacy data, and the management decision is held. A supplied but invalid, swapped, unapproved, malformed, or oversized attachment is rejected, not downgraded silently. Even a verified pair is only a held recovery candidate. A local bounded fixture parser does not imply safe memory use for arbitrary large clinic archives.

## Isolated round-trip (not a production procedure)

The existing app reader migrates a fresh target DB and replays its ordinary archive. The tests confirm it keeps the historic patient map but starts the standalone counter at the migration-only tuple `1/true`, not the source's exact state. No application process or grants are attached to this target while setting up the optional review guard.

A separate fixture SQL function (not a migration) verifies that the explicitly named different target is pristine, its runtime cannot bypass the fence, and its actual restored map matches the approved source. It reconstructs the exact pending or consumed sequence transactionally with `ALTER SEQUENCE … RESTART` and a burn only when the archived flag is true; no nontransactional `setval`, old row renumbering, or reset from existing max. The fixture remains held even after successful preparation and requires a separate explicit target-bound resume via the already-tested recovery protocol. Wrong target, ordinary operator and mismatched map are denied; rollback restores the exact pre-prepare tuple and policy.

The tests use actual application backup/restore code on synthetic PostgreSQL 18.6 and cover both pending and consumed values (including aborted issuance). Actual application archive endpoints, a trusted product operator/recovery approval workflow, and any installation or activation remain out of scope.
