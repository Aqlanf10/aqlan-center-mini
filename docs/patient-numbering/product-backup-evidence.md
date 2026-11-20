# Configurable numbering: application backup/restore witness (not activated)

## Original backup gap (before the scoped legacy fix)

Originally tested from the private candidate at `d1d473b9` and captured
at `49892e26`. Separate from native PostgreSQL `pg_dump` and Railway backups.
The following limitations apply to old archives and the unwired prefix
namespace. The scoped legacy P fix is described below.

- `lib/db.ts` enumerates only `information_schema.tables` and columns in
  `public` in `backupSnapshotSqlLines`. The SQL is data-only; the only
  restored sequence positions are synthesized for numeric serial/identity
  `id` columns (not actual last/called state of independent sequences).
- `backupSqlLines` and `lib/fullBackup.ts:fullBackupBlocks` use that same
  snapshot writer. The full archive includes the official SQL, document
  bytes and manifest, but no dedicated numbering namespace and no standalone
  legacy `public.patient_number_seq` snapshot.
- `lib/restore/validate.ts:validateBackupArchive` validates the v1 archive,
  its hashes and listed documents, not completeness of numbering state.
  `lib/restore/staging.ts:stagedRestore` provisions the published migration
  schema, replays the SQL, verifies documents and general migration/critical
  probes, and can mark that restoration ready despite numbering omissions.
- Historical #490, commit `7377434dea25cd52ae2540c7e56ec8363a31a5de`, has an
  actual product backup recovery witness at
  `__tests__/postgres/patient-numbering-restore.test.ts`. Its public
  single-sequence policy/alias design is a useful test reference, not a drop-in
  compatibility proof for this separate, 26-prefix candidate.

## Historical and prefix-namespace witness

`__tests__/postgres/patient-numbering-product-backup.test.ts` uses only newly
created random databases, a random synthetic namespace on local test
PostgreSQL, and an injected reader that refuses any document except the known
synthetic bytes. It does not connect to Railway, read application data or
change production/test application backup behavior.

1. An old-format application SQL and full archive preserve the public
   synthetic patient, invoice and document, but contain neither the prefix
   namespace nor the standalone legacy sequence. The regression fixture
   removes only the new marker to reproduce that historical format. The
   historic archive validates and staged restore returns `ok` and `readyForCutover`,
   with a verified document, despite losing numbering state. The isolated
   numbering admission refuses that target. Specifically, the source legacy
   sequence had issued 900000 to a synthetic public patient that was then
   removed, with only P-00123 left; there is no legacy retired-ID registry in
   this base. Source state is (900000, called): next 900001. Migration-only
   restore starts (1, called). The actual application `ensureSchema` on that
   restored synthetic DB keeps a safe minimum of 7000 relative to surviving
   rows, but not the lost historical watermark: (7000, pending), next 7000.
   This is a local reproduction on the candidate base, not an observation
   about current Railway data or a live restore.
2. A **test-only** builder appends a fixed schema/table allowlist and exact
   sequence values/called flags to the archived SQL; it recomputes manifest
   hashes. No production writer/parser/restore path was modified for the
   prefix extension. The
   official staged restore refuses to apply the augmented archive without
   its dedicated schema; it does not restore documents or mark it ready.
3. In a second fresh target, the same archive round-trips via the unchanged
   product staged restore after **test-only** provisioning of the empty
   numbering namespace. Config, history, receipt, audit, synthetic issuance
   evidence, 26 prefix counters, audit identity sequence, legacy public
   sequence and synthetic document are compared. P retains used 900000,
   and B retains unconsumed 37; first isolated B issuance is `B-00037`.
4. Independent numbering admission also rejects that restored target
   against a newer external fixture checkpoint. Test databases are separate;
   this is not a claim that either runtime enforces cutover fencing.

## Scoped legacy fidelity fix (private source only)

Both official product exports now record the legacy public counter as a
versioned SQL comment, and the full archive's existing hash covers it. The
boundary scanner accepts a unique, canonical bigint plus called flag only
as a standalone comment before the final COMMIT. No new executable archive
statement is needed or admitted by this change. Both official replay paths
verify the existing target sequence shape, owner privilege and fixed schema
and name; they serialize reconciliation with allocation using a no-change
CACHE 1 command after verifying cache 1. Reconciliation only advances the
target using transactional RESTART, consuming exactly one value only for
called state. Unsupported target shapes and malformed input fail closed.

The same PostgreSQL witness verifies used 900000 and pending 900111 through
unmodified official archives, and the real legacy SQL CLI for the used case.
It verifies no rewind, equal pending-to-called advancement, blocking of
another nextval even on no-op reconciliation, rollback to pending after
higher advancement, unsupported cache rejection, and malformed metadata
refusal before any application migration or document write. Old archives
remain compatible and explicitly report `not-recorded`; fresh ones report
`reconciled`. Direct SQL execution doesn't consume comment metadata and isn't
a substitute for the official restore. Neither status proves archive
freshness after cutover, and no live operations were performed.

## Configurable-prefix activation gate (not done)

Do not enable numbering until the governed application migration and the
official backup writer/restore verifier agree on an explicit, least-privileged
namespace and complete snapshot contract. Capture counter state consistently
with allocation (sequence reads are not MVCC); preserve complete history,
audit/receipts and exact called vs pending state. Prove that an older or
incomplete archive cannot resume allocation, even if normal application
restore succeeds. Use trusted lineage/high-water evidence kept outside the
archive and enforce it before enabling issuance/cutover; a hash in the archive
does not provide that evidence. Verify the corresponding restore with
password/owner governance, security and authenticated Staging journeys
separately; none were activated here.

Local verification (validated disposable PostgreSQL 18 address only):

```sh
TEST_DATABASE_URL=postgresql://agent@127.0.0.1:55439/aqlan_p1_test?sslmode=disable \
NUMBERING_PG_BIN=/path/to/postgres18/bin NODE_ENV=test \
npx vitest run --config vitest.config.postgres.mts \
  __tests__/postgres/patient-numbering-product-backup.test.ts \
  __tests__/postgres/patient-numbering-bootstrap.test.ts \
  __tests__/postgres/patient-numbering-adapter.test.ts
```

## Cutover hold after isolated restore (separate private fix)

The 49892e26 historic result originally advertised `readyForCutover:true`
even when legacy P state was missing; that was not safe readiness. The
scoped follow-up retains successful isolated restore (`ok:true` /
`status:"restored"`) but never projects cutover readiness:

- Old archive: `not-recorded` / `numbering-history-not-recorded`.
- Recorded and reconciled: `reconciled` / `numbering-freshness-unverified`.
- Persisted old "ready" or unknown evidence: preserve counts, normalize to
  "restored", suppress the historical true bit, require new independent proof.

Admin POST and GET history, the settings page, direct restore CLI, and
offsite JSON/text preserve the distinction. Malformed or unsupported
sequence marker syntax fails SQL-boundary preflight before resetting the
dedicated admin target. Actual restore guards, companion serial-sequence
handling, and external freshness fencing are otherwise unchanged. The
preflight is not a new archive trust/authentication layer or concurrency
lock on the volume. No backups or environments outside fixtures were touched.
