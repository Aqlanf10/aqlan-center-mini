# Restore security follow-up — 2026-10-21 (revised tests and distinct CLI hardening)

**Reviewer decides merge; both PRs remain Draft.** This file records *commit references* and the distinction between committed tests and observed CI outcomes; the heads may move as CI feedback is addressed.

## PR #369 — real partial-write negative test

- Commit [0829f95d5fb1e6d2394ddf1ce728263f308f25a9](https://github.com/Aqlanf10/aqlan-center-mini/commit/0829f95d5fb1e6d2394ddf1ce728263f308f25a9).
- [security-restore-negative.test.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/0829f95d5fb1e6d2394ddf1ce728263f308f25a9/__tests__/postgres/security-restore-negative.test.ts): empty for-await body replaced by explicit emitted-byte accumulator; lint untouched.
- Synthetic PostgreSQL 18 fixture now contains **two** registered physical documents in backup; archive order must equal `documentEntryName(firstKey), documentEntryName(secondKey)`.
- Second restore destination file path is deliberately precreated as a directory. The first physical document is written and checked byte-for-byte and via SHA-256 before the second `writeFile` fails. Test verifies resulting DB rows and second-path obstruction; target remains **disposable, never cut over**. This is an expected negative failure, not a production restore.
- The test is part of the existing `test:postgres` gate and requires the PostgreSQL 18 service. Source review only until CI reaches the PostgreSQL step.

## PR #375 — separate restore:full effective target correction

- Commit [5ae5dc6d75aad62665bdfbe1acd47b19e11ffdc1](https://github.com/Aqlanf10/aqlan-center-mini/commit/5ae5dc6d75aad62665bdfbe1acd47b19e11ffdc1).
- [scripts/restore-full.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/5ae5dc6d75aad62665bdfbe1acd47b19e11ffdc1/scripts/restore-full.ts) validates and reconstructs the target URI **before** staging restore, rather than forwarding unchecked URL query params to `pg.Client` or TLS selection.
- [Effective-target guard](https://github.com/Aqlanf10/aqlan-center-mini/blob/5ae5dc6d75aad62665bdfbe1acd47b19e11ffdc1/scripts/security/restore-full-target-guard.mjs) reuses `validateVerificationQueryParameters` for local test URIs; forbids `host`, `database`, SSL file paths, duplicate/encoded query overrides. Remote restore is limited to explicitly declared `staging` with exactly `sslmode=verify-full` and a PEM root CA configuration; no Railway runtime.
- [Actual CLI pre-read tests](https://github.com/Aqlanf10/aqlan-center-mini/blob/5ae5dc6d75aad62665bdfbe1acd47b19e11ffdc1/scripts/security/restore-full-cli.test.mjs) and [shared CI mandatory unit wrapper](https://github.com/Aqlanf10/aqlan-center-mini/blob/5ae5dc6d75aad62665bdfbe1acd47b19e11ffdc1/__tests__/restore-full-target-preflight.test.ts) check rejection before reading the archive.
- [Actual PostgreSQL 18 CLI integration test](https://github.com/Aqlanf10/aqlan-center-mini/blob/5ae5dc6d75aad62665bdfbe1acd47b19e11ffdc1/__tests__/postgres/security-restore-full-cli.test.ts) creates *synthetic-only* YER and SAR invoices and attached image bytes; invokes `scripts/restore-full.ts` in a child process against the fixture-owned disposable target, and compares currency-specific totals, FK linkage, restored attachment bytes/SHA.
- No shared `lib/db-target.ts` edit. Reviewer should confirm policy compatibility, restore scope and TLS requirements.

## CI and provenance

- Latest inspected GitHub Actions runs were still **running or pending**; no claim of PASS until job conclusions prove it. Earlier local smoke tests cannot be attributed to the new heads.
- In this model runtime there is no PostgreSQL 18 server or Docker. The real PG18 tests are runnable in the existing GitHub PostgreSQL service container; they have **not been independently executed locally**. The scripts in the PRs specify their expected assertions.
- Live production latest backup and independent offsite archive remain **UNVERIFIED**. No authenticated backup-history contents or Railway volume files were accessed. No secrets or patient data are included here.
- No changes to finance, migrations, `lib/db.ts`, `package.json`, lockfile, CI config, Railway, production services or credentials.
