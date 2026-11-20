# Private configurable-numbering recovery sidecar

This is an unwired code/test checkpoint. There is no archive mounting, storage
migration, restore writer, trusted lineage service, API, push or deployment.

## Choice

Use a strictly typed, data-only JSON sidecar, with one fixed manifest entry
(`numbering-recovery-v1.json`), an explicit version, exact UTF-8 byte count, and
SHA-256. Keep it distinct from the standard `database.sql` export. The product
SQL writer enumerates public tables and reconstructs row identity sequences;
allowlisting a private schema there would expand executable replay without
adding complete sequence semantics, expected lineage, or freshness. Do not
accept executable SQL, archive-supplied relation names, paths, or fallback mode
in the configurable numbering restore protocol.

The canonical format includes exactly A–Z state in a deterministic order,
pending/called flags, prefix history high water and proof of reconciliation,
active prefix and monotonic config revision, original retired-alias spelling and
stable owner ID, complete policy audit, durable idempotency receipts, and the
audit sequence high water. V1 reflects the private adapter contract: initial
P/revision 1; every subsequent revision has a complete paired audit and receipt.
Malformed or missing data, unknown schema shape, duplicate or divergent normalized
ownership, noncanonical bytes, extra fields, mismatched manifest, and overflow
are refused. The codec refuses rather than exporting a partial payload if
16 MiB or row bounds are exceeded. Its reviewed adapter export reads these
fixed projections under the existing config/allocator lock; arbitrary relations
and archive input never participate.

## Mandatory independent proof

A valid SHA-256 in the archive only establishes byte integrity. Admission
requires a server-configured expected lineage, and the exact authoritative
current sidecar digest from an independent witness resolver for that lineage.
Absent, stale, apparently higher but different data, and cross-lineage
payloads are all held. Never put the witness resolver behind user-supplied
archive data or generate its proof from the same restore bundle. The test
resolver is an explicit synthetic fixture, not evidence of deployed authority.
Admission verifies only against the witness at that instant. Real runtime
must fence the writers and compare again at activation/cutover.

## Still required

- Approve governed, stable schema and migrated lineage; ship a complete
  retired-alias registry, not a guessed empty set. Reconcile live patient
  identities and historical alternate spellings; bind retirement, allocation,
  configuration and reset/import writers to the same reviewed lock order.
- Add explicit product full-backup manifest integration and version gates;
  do not call unknown entries present in today's generic archive a valid
  numbering restore. Use sensitive backup storage/transport controls for
  aliases, audit, IDs and reasons.
- Build a governed parameterized restore writer, independently durable
  anti-rollback witness and activation fence. Verify public relational
  identities and exact restored state before allowing issuance. Do not make
  dump import an alternate activation path. Current cutover hold is unchanged.
- Existing owner authority/session/credential governance remains a separate
  unresolved prerequisite. No changes in Staging or Production.

## Local verification

`npx vitest run __tests__/patient-numbering-recovery.test.ts`

Against a validated disposable PG18 target only:
`npx vitest run --config vitest.config.postgres.mts __tests__/postgres/patient-numbering-recovery-projection.test.ts __tests__/postgres/patient-numbering-adapter.test.ts`

The PG fixture uses the actual locked adapter and owner-command service with
synthetic authority, covers prior issuance invalidating stale evidence, a
consumed but rolled-back allocation, called versus pending, exact alias IDs
above JS safe integer, and refusal of missing alias/history/receipt evidence.

Verified locally: 22 codec/transport tests, 17 PostgreSQL 18.6 projection/adapter
tests, targeted ESLint and strict source type-check. The TAR transport fixture
contains only the fixed JSON sidecar and its descriptor, never executable SQL.
