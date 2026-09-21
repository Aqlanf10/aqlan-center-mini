# Schema Ownership Characterization (TD-01A preparation)

**Status:** preparation evidence only. This document does not start or close TD-01A, TD-01B, or TD-08A.

- \`TD08A_COMPLETE=NO\`
- \`TD01A_COMPLETE=NO\`
- \`PRODUCTION_WRITES_ALLOWED=NO\`

## Purpose

The repository currently has two schema owners during the transition:

1. the immutable numbered migration chain (\`migrations/0001\` through \`0011\`), and
2. runtime \`ensureSchema()\` in \`lib/db.ts\`.

The CI gate \`npm run schema:ownership:verify\` builds both paths independently on two disposable PostgreSQL 18 databases on a loopback server and compares the resulting catalogs in both directions. It does **not** connect to staging or Production and it does not adopt any existing database.

## Safety boundary

The harness:

- reads only \`TEST_DATABASE_URL\`;
- requires the documented local test database \`aqlan_p1_test\`;
- allows only \`localhost\`, \`127.0.0.1\`, or \`::1\`;
- rejects Railway runtime markers and production classifications;
- verifies PostgreSQL major 18 before creating anything;
- creates only generated names beginning with \`aqlan_schema_ownership_\`;
- validates every generated name before \`CREATE DATABASE\` or \`DROP DATABASE\`;
- accepts no remote override and no backup/archive input;
- drops generated databases in \`finally\`.

The artifact contains schema metadata, migration fingerprints and classification only. Connection strings, passwords, environment dumps, SQL file contents, and application row data are forbidden.

## What is compared

The detailed SELECT-only projection extends \`lib/schema-manifest.ts\` while preserving baseline-manifest v1 behavior. It records:

- tables, persistence, partition/RLS state, owner token and explicit ACL;
- columns including PostgreSQL-rendered type, type modifier, precision/scale, nullability, defaults, identity/generated state and collation;
- constraints including full \`pg_get_constraintdef\`, FK actions and validation/deferrability state;
- indexes including complete definition, predicate, opclasses/collations, uniqueness and validity/readiness/liveness;
- triggers including \`pg_get_triggerdef\`, enabled/internal state and function identity;
- non-extension-owned public functions including body and \`pg_get_functiondef\`;
- sequences including definition and ownership linkage;
- installed extensions as environment provenance;
- \`schema_migrations\` separately from application-schema equality.

The comparison is bidirectional. Registry objects are not mislabeled as application drift.

## Known difference policy

The current \`aqlan_financial_delete_guard()\` message differs between migration 0005 and runtime DDL (\`GDPR\` wording). The raw definitions remain visible. Only that exact current difference may be classified as \`KNOWN_DIFFERENCE\`; any additional difference fails the gate.

## Migration provenance

Every numbered SQL file is fingerprinted exactly as loaded by the migration runner: SHA-256 over the unmodified UTF-8 content. The characterization report includes version, name, filename, checksum and byte length, and verifies fresh registry rows against those fingerprints. \`applied_at\` is intentionally excluded from deterministic comparison.

## Evidence limits

Fresh-schema equality does not prove populated-database adoption or recovery behavior. In particular, the following remain separate characterization/engineering obligations:

- the historical waiting-list uniqueness ordering;
- migration 0004 material-rate repair/backfill;
- migration 0010 \`preferred_period\` → \`preferred_shift\` conversion;
- business-document sequence mutable state;
- reciprocal/cyclic foreign-key restore behavior;
- effective restore-target identity;
- production migration preflight and adoption.

A green artifact is **not** authorization for staging adoption, Production migration, \`ensureSchema()\` retirement, or restore/cutover.

## Relationship to TD-08A

A verified Production backup exists, but the exact archive Restore Drill on isolated PostgreSQL 18 remains deferred by the owner. Therefore TD-08A remains incomplete and the adoption chain remains blocked.
