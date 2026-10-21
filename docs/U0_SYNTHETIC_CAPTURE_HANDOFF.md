# U0 synthetic backup capture handoff

## Status and exact provenance

This Draft handoff preserves pending recovery compatibility work for the next implementer. It is not an activated backup/restore feature and must not be merged as operational recovery support.

- Base: PR392 head `f2c9c98c2ac8c7a6f3fd3fdf89bc8c7afcc37dc1`, tree `28198d6e6c253492374759d50d49a0f5cdacf057`.
- Reviewed source composition before this document: tree `1c7d6780a9f647e82ac18f0f6b917c7bc8fb2b47`; source patch SHA256 `beb8b72669e5ec16b505614b781a26d02cf89bdca720fec503ea22e7a032adac`; 14 files, 1296 additions/20 deletions.
- The existing PR392 typed-event foundation/type fix, two fixture repairs and Vitest4.1.12 security update are retained unchanged. In particular: `__tests__/debt-read-snapshot-local.test.ts`, `__tests__/postgres/_currency-read-temp-schema.ts`, `package.json`, `package-lock.json`.
- Canonical index collector correction is also independently available as Draft [PR395](https://github.com/Aqlanf10/aqlan-center-mini/pull/395), head `414501aad810679efef0b844340db5d2b85faf3e`, based on main `2667b71f815ee14781cdac6b37ebad3b4f8e246d`. It is included here for coherent testing, not a second implementation. Its separate old-base dependency update remains an integration gate.
- No migration registration, real data, credentials, Production change, restore replay or target trigger operation is included.

## What is connected

`prepareSyntheticCapture` returns an opaque in-process capability only for a controlled disposable fixture. Existing `fullBackupBlocks` consumes canonical typed events, renders the unchanged legacy SQL, captures exact byte spans for the three deferred link forms, and emits a selected synthetic v2/profile envelope. The completed actual TAR writer issues an out-of-band receipt. `validateBackupArchive` verifies that receipt against exact captured TAR bytes, reparses those verified bytes, checks the profile/entry inventory and validates the representation. No normal route, CLI flag or default path creates fixture authority. Ordinary v1 remains the default.

The shared SQL scanner is mechanically exposed without changing its prior grammar or `prepareBackupSql` behavior. UTF16 scanner boundaries map to exact UTF8 byte offsets; malformed bytes, split surrogates and invalid boundaries reject. Each declared link must match a whole original top-level SQL statement and one fixed canonical renderer, not an UPDATE-looking substring inside a literal or comment. Original BEGIN/COMMIT framing and insert -> link -> reset order are checked before removing declared spans. The unchanged strict INSERT decoder then rejects undeclared SQL.

Only plan-item/visit, patient/photo-document and family/guarantor links are supported. Unique identity, expected NULL, target existence, patient/document and plan/visit relationships are checked. Representation validation alone is not provenance authentication. The result always has `readyForCutover:false`.

## Schema and sequence evidence

The synthetic manifest reuses `projectDetailedSchemaReadOnly`, explicitly with `includeMutableSequenceState:false`. It captures existing detailed defaults, columns, indexes, RLS flags, sequence ownership/default links, constraints, triggers/functions, extensions and registry evidence. Complete actual sequence definitions and lastValue/isCalled are captured separately, including standalone sequences; never inferred from MAX(id).

Supplemental rows capture exact schema/table owner and ACL, column ACL, qualified column collation and policy command/permissiveness/roles/USING/WITH CHECK. Existing raw function owner/ACL evidence remains separate from normalized comparison owner tokens. Names and deterministic ordering are used rather than source OID-only relationships. Source identity/OID/owner, expected schema digests, complete sequence inventory and before/after observations are bound to the fixture receipt.

The supported fixture profile rejects unmodeled views/materialized views/foreign tables, partitioning/inheritance, rewrite rules, custom public types/collations, non-public application schemas, nonstandard extensions, global/public default privileges and non-function public routines. Built-in/default collations and standard plpgsql remain accepted. This is a bounded support contract, not a general PostgreSQL equivalence claim.

The canonical collector's former index join included foreign keys referencing a PK/unique index and emitted duplicate index identities. Its one-line correction additionally requires the owning relation and p/u/x constraint kinds. Standalone indexes remain included and the separate FK constraint catalog remains unchanged. Do not silently refresh downstream baseline/fingerprint expectations containing the old duplicates.

## Verified acceptance

On the exact source composition with Vitest4.1.12 and an owned loopback PG18.6 fixture:

- 6/6 PostgreSQL tests passed across `u0-schema-capture.test.ts` and `schema-index-ownership.test.ts`.
- All 59 canonical migrations through0065 were loaded, followed by explicit synthetic-only U0 proposal SQL. No runtime registration was added.
- Actual populated patient/photo and family/guarantor cycles, plan/visit link, physical synthetic document and Arabic/emoji multiline UPDATE-looking literal pass actual fullBackup -> TAR parser -> selected validator. Exact three link identities and unchanged source rows before/after are asserted. Default validation refuses the synthetic profile.
- Advancing a sequence after schema attestation leaves the schema digest unchanged, while the actual captured archive contains its exact advanced state. Procedure rejection and policy/collation supplements are tested on real PostgreSQL.
- Owning PK/unique/exclusion index associations appear once and both referencing FKs remain present.
- 156 focused unit tests across five files passed, including frozen v1 exporter/scanner parity and adversarial identity, ordering, framing, Unicode boundary, provenance and archive tampering checks.
- Scoped ESLint and diff checks passed. Earlier bounded semantic TypeScript checks used real declarations, including the canonical collector and independent index test.

No full local semantic check of the final db/fullBackup/test graph or full final CI success is claimed. Hosted whole-project Typecheck/build and all other CI gates remain required. All local disposable PostgreSQL instances were stopped after testing.

## Reproduction

Use the repository's Node22 and PostgreSQL18 contracts and install the exact lockfile with `npm ci`. Never point these tests at an application or Production database. The PostgreSQL tests require the canonical guarded `TEST_DATABASE_URL` naming `aqlan_p1_test` on a local disposable instance; they create randomized databases and verify saved OID/owner before cleanup. They do not fall back to a Production URL.

Focused units:

```sh
npx vitest run --maxWorkers=1 --no-file-parallelism \
  __tests__/u0-connected-capture.test.ts \
  __tests__/restore-sql-scanner.test.mjs \
  __tests__/backup-events.test.ts \
  __tests__/backup-validate.test.ts \
  __tests__/restore-sql-boundaries.test.ts
```

With an already provisioned disposable PG18.6 instance and the repository's documented synthetic test environment:

```sh
npx vitest run --config vitest.config.postgres.mts \
  --maxWorkers=1 --no-file-parallelism \
  __tests__/postgres/u0-schema-capture.test.ts \
  __tests__/postgres/schema-index-ownership.test.ts
```

`NODE_ENV=test` and `DATABASE_ENVIRONMENT=test` are mandatory for the synthetic capability; Railway runtime markers refuse it. Use only a synthetic session secret if the test harness requires one. Do not configure real credentials to run this handoff.

## Remaining boundaries

- Hard fixture limits: SQL1MiB, TAR8MiB, schema/ownership evidence4MiB, 10000 events/statements/links, 1024 sequences. Ordinary migrated fixture evidence measured 3,274,878 bytes before excluding mutable state. This does not support real patient archives.
- In-process controller receipt is not an external signature, authenticated production provenance, source authority or operational quiescence protocol. Catalog observations detect drift; owning fixture code controls writer lifecycle.
- Target encoding/locale/collation provider/version, roles/membership/grants, runtime/search-path assumptions and exact supported-schema comparison remain separate target acceptance gates.
- No staging/replay integration, generic UPDATE parser, trigger bypass, MAX-derived sequence reconstruction, operational activation or readiness flag is present. `readyForCutover:false` must stay false.
- Before any further publication or activation, reverify current refs, preserve fixture/security changes, complete coherent source review and whole-project CI. Any operational restore design requires its own security/integrity review. This Draft only hands off source capture/validation work.

## Recovered strict decoder packaging

The strict decoder/types/sequence/schema primitives are included at `lib/restore/u0-offline-primitives.ts`; no import relies on a local unpublished replay helper. They were mechanically extracted from the previously sealed synthetic proposal whose original source SHA256 is `befbf2eb7874b11fb3f3f46d60ccaf493d3095309f20e15d90d48785f900366a`, verified against sealed patch SHA256 `d51e6bd92f261110c4e31032ad40acd9b161ca9b801d4b48dc02d7bf9934a37e`. No replay or trigger-operation code was extracted. Historical proposal commit ancestry was not independently reestablished; the byte-verified source and included primitives are the packaging evidence.
