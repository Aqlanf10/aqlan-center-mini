# Read-only purchase receipt readiness diagnostic

Use the existing validated packaged preflight runner with the single explicit option
`--purchase-receipts-readiness`. Connection classification, effective MINI database
routing, TLS policy, PostgreSQL 18 requirement, repeatable-read read-only snapshot,
timeouts, artifact verification, and redacted failure handling are unchanged.
No normal startup, health route, application initialization, migration execution,
registry adoption, historical registration, or receipt/business-row access occurs.
The default report is unchanged. This option cannot be combined with arbitrary
selectors or fingerprint bucket flags.

The versioned subreport lists only source-known identities and ABSENT/MATCH/CONFLICT
statuses for the receipt relation, columns, constraints, indexes, immutable function,
user triggers, FK internal triggers, and migration 0065 registration. Definitions,
unknown identities, live field values, and live definition hashes are not emitted.
Unexpected related objects contribute only a count. A same-name view or other
non-table relation is a conflict, not absence. The source fixture and module are
included in the artifact source inventory and the optional provenance report.

COMPATIBLE means the scoped catalog properties match an isolated PostgreSQL 18
projection of exact checksum-pinned migration 0065. Table owner/ACL and role
privileges are explicitly outside this assessment. Operational availability remains
NOT_VERIFIED even when registrationAndShapeMatch is true. The existing global
schemaEquivalence, adoptionAssessment, and registry.matchesFiles meanings are not
changed. Historical registry gaps do not justify replaying migrations.

## Reproducing the expected fixture

`scripts/generate-purchase-readiness.ts` is a synthetic-test-only generator guarded
by the existing PostgreSQL ownership test-target policy. It requires an empty,
owned PostgreSQL 18 test database. It creates minimal users/inventory_movements
prerequisites and exact migration 0065 inside a transaction, projects the catalog,
writes the source fixture, and rolls back all synthetic database changes. It is not
packaged as a Production command. Do not aim it at an application database.

## Remaining operational gate

A deployed, provenance-verified read-only diagnostic can establish current object
and registry state. It cannot prove that a real keyed purchase is available, that
runtime initialization has happened, or that privileges permit the complete flow.
Missing objects, partial shape, conflicting definitions, or registration mismatch
require separate review. Never request an ordinary authenticated API call merely
to trigger broad ensureSchema DDL/seeds. A narrow exact-0065 migration remedy, if
needed after prerequisites are verified, must be separately reviewed; this change
contains no such action and authorizes no Production migration or data writes.
