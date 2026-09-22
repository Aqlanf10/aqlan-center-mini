# Schema Ownership Characterization (TD-01A preparation)

**Status:** preparation evidence only. This document does not start or close TD-01A, TD-01B, or TD-08A.

- `TD08A_COMPLETE=NO`
- `TD01A_COMPLETE=NO`
- `PRODUCTION_WRITES_ALLOWED=NO`

## Purpose

The repository currently has two schema owners: the immutable numbered migration chain (`0001`–`0011`) and runtime `ensureSchema()` in `lib/db.ts`. The CI gate builds each path independently on disposable loopback PostgreSQL 18 databases and compares their catalogs in both directions. It does not connect to staging or Production and does not adopt an existing database.

## Safety boundary

The harness reads only `TEST_DATABASE_URL`, requires database `aqlan_p1_test` on a loopback host, rejects production classifications and all repository-known Railway runtime markers, and verifies PostgreSQL major 18 before any `CREATE DATABASE`. Generated names must begin with `aqlan_schema_ownership_` and are validated before creation, runtime initialization, and deletion.

The CLI accepts no arguments or exactly `--output <path>`. Runtime initialization is not exposed through an arbitrary URL: callers must supply the validated environment-derived target and a validated generated name, and the function repeats both checks immediately before `ensureSchema()`.

Cleanup always attempts both generated-database drops and maintenance-connection closure. Any cleanup error fails with `SCHEMA_OWNERSHIP_CLEANUP_FAILED`; when an operation also failed, the aggregate retains the primary error.

Artifacts contain schema metadata, migration fingerprints, classifications, and boolean/symbolic synthetic-fixture results. Connection data, environment dumps, SQL migration contents, role identities, and patient/business row values are forbidden.

## Catalog and comparison

The detailed SELECT-only projection extends `lib/schema-manifest.ts` without changing baseline-manifest v1. It captures and compares:

- database owner, public-schema owner, and explicit schema ACL, with arbitrary roles canonicalized;
- table persistence, relkind, partition identity/key/parent, RLS state, owner, and ACL;
- column rendered and base/domain types, modifiers, precision, nullability, defaults, identity/generation, and collation;
- complete constraints including referenced FK schema, actions, inheritance, validation, and deferrability;
- indexes, predicates, opclasses/collations, uniqueness, validity, readiness, and liveness;
- application triggers including enabled state, definition, and function identity;
- internal triggers in a separate section, with generated FK trigger names canonicalized because constraints carry the authoritative semantics;
- non-extension-owned public functions;
- sequence definition, ACL, dependency type, owned-by link, and column-default link;
- extension name/version/schema and extension-owned membership as separately compared provenance;
- `schema_migrations` separately from application-schema equality.

Mutable sequence `last_value` and `is_called` values are reported separately and never used as schema identity.

## Difference policy

`compareDetailedSchemaCatalogs()` reports raw catalog divergence without exceptions. A separate classifier checks it against [the committed PG18 open-findings manifest](../schema/schema-ownership-open-findings.pg18.json). `OPEN_CONVERGENCE_FINDING` means an owner-reviewed unresolved difference whose complete left (numbered migrations) and right (`ensureSchema`) catalog values match exact SHA-256 fingerprints. `UNEXPECTED_DIFFERENCE` means a new, removed, or changed difference. A disappeared finding requires review rather than silently becoming success.

The current manifest contains exactly 16 findings: 12 appointment column ordinals and four function definitions. The financial delete guard differs in wording **and** indentation. It has no phrase exception and is one of the four open function findings. `KNOWN_DIFFERENCE=0`, `APPLICATION_SCHEMA_EQUAL=NO`, and, when all 16 fingerprints match, `CHARACTERIZATION_OK=YES`. Characterization success proves only that the reviewed unresolved state was reproduced; it does not claim schema equivalence or authorize adoption.

Run `npm run schema:ownership:manifest` to generate a candidate in the system temporary directory. The command cannot overwrite the committed manifest. Review the raw drift and candidate, obtain approval, then replace the committed manifest in an explicit reviewed commit. CI never updates it automatically. Later convergence work must remove resolved findings from the manifest deliberately, one reviewed subset at a time.

## Provenance and populated evidence

Every numbered SQL file is fingerprinted as loaded by the migration runner: SHA-256 over exact UTF-8 bytes, plus version, name, filename, and byte length. Fresh registry rows must match and must not be adopted. `sourceCommitSha` means the checked-out PR head supplied by CI, or local `git rev-parse HEAD`; it is not GitHub's synthetic merge SHA.

The same isolated run records synthetic populated-state evidence. Migration 0004 material-rate backfill and migration 0010 preference conversion are `PROVEN_BEHAVIOR`; all four business-number sequences lag imported prefixed identifiers and synchronize after runtime initialization (`PROVEN_BEHAVIOR`); and two service-specific open waiting rows reproduce the obsolete runtime unique-index cold-start ordering (`PROVEN_HAZARD`). Synthetic values are not emitted.

This evidence does not prove general adoption or recovery. Reciprocal/cyclic FK restore behavior, effective restore-target identity, and any Production preflight/adoption remain outside this command.

An artifact is not authorization for staging adoption, Production migration, `ensureSchema()` retirement, or restore/cutover. The exact Production archive Restore Drill remains deferred by the owner; TD-08A and the dependent adoption chain remain incomplete.
