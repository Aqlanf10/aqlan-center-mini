# Legacy restore target hardening and PG18 acceptance handoff — 2026-10-21

**Immutable code review reference:** [PR #369 commit 7610f3c6ca7063b1319a429f2579e708e0459104](https://github.com/Aqlanf10/aqlan-center-mini/commit/7610f3c6ca7063b1319a429f2579e708e0459104). **Review/merge exclusively by Dot.** PR #368 is evidence/documentation only; both remain Draft until owner review.

## Confirmed defect and narrow fix

- **Confirmed from source and reported independent no-connection reproduction:** Node PostgreSQL URI parser may accept authority `127.0.0.1` while a query parameter `?host=remote.example` or `?database=other` changes effective connection destination. The original PR #369 guard checked URL authority/path but forwarded the **unmodified URI** to `pg.Client`.
- At immutable commit [7610f3c6ca7063b1319a429f2579e708e0459104](https://github.com/Aqlanf10/aqlan-center-mini/commit/7610f3c6ca7063b1319a429f2579e708e0459104), [guard](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/scripts/security/synthetic-restore-target-guard.mjs) delegates to existing [verification-target-policy](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/lib/verification-target-policy.mjs), inspects runtime alias/PG environment options, denies all connection-string query params other than a *single* `sslmode=disable`, rejects encoded database paths/ambiguous hostnames, accepts only literal loopback IPs and dedicated synthetic test DB names, and constructs a sanitized URL.
- [Actual legacy CLI](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/scripts/restore.mjs) validates before `readFileSync(backup)` or `new Client`, then passes `validatedTarget.connectionString`, not original input, to `pg` with `ssl:false`. This prevents arbitrary SSL certificate file options from reaching the client after acceptance.
- Compatibility retained with existing `scripts/verify-backup.mjs` disposable `backup_dst_*` targets **and** random `aqlan_backup_precision_[32 hex]` fixture databases from [restore-multiline-literals.test.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/__tests__/postgres/restore-multiline-literals.test.ts) only in `NODE_ENV=test`.
- **Separate shared-code risk (NOT CLOSED):** [lib/db-target.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/lib/db-target.ts) calls `parseDatabaseHost`, which uses URI authority/path and does not visibly account for override query parameters. The `restore:full` CLI uses that classifier and forwards the target URI into the restore client. Its effective destination guard must be independently reviewed with Dot before changing shared files; PR #369 only hardens `scripts/restore.mjs`. No claim that all restore entry points are fixed.

## Local run evidence and strict limitations

- Runtime available in the isolated agent container: `node v22.16.0`, `pg_config 17.11` client/development metadata **only**. `postgres`, `initdb`, `pg_ctl`, `psql`, Docker and PostgreSQL 18 server binaries are **not present**. Container GitHub access failed with `Could not resolve host`. Installing PG18 is unavailable; no Railway service or production DB was used.
- On 2026-10-21 local Node fixture: `node --test scripts/security/*.test.mjs` gave **32 pass / 0 fail**, including 22 guard cases and 10 script-invocation cases, using a no-network `pg` import hook and a deliberately nonexistent backup file. The local `scripts/restore.mjs` copy matched GitHub blob SHA **`e790ce73cb55e264cda8aa3009d7adedca47af06`** by `git hash-object`. These tests used the earlier local guard before the final shared-policy integration; **not** a successful run of final 7610f3c6ca7063b1319a429f2579e708e0459104 against installed project dependencies. Do not use this number as final-commit acceptance.
- [Committed guard tests](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/scripts/security/synthetic-restore-target-guard.test.mjs), [committed actual-CLI probe](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/scripts/security/legacy-restore-cli.test.mjs), and [no-network preload](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/scripts/security/pg-probe-preload.mjs) are available for independent execution. A rejected URI must exit **2**, not reach missing backup file read (exit 1), and never print `PG_CLIENT_CONSTRUCTOR_CALLED`. The positive control with an allowed synthetic URI must reach the missing-file error, proving ordering.
- **PG18 integration NOT EXECUTED in this environment**. PR #369 adds [real PostgreSQL missing-attachment/partial-restore tests](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/__tests__/postgres/security-restore-negative.test.ts). Existing [restore-drill](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/__tests__/postgres/restore-drill.test.ts) covers invoice lines, SAR payment/refund with exchange rate, FK pairs, inventory WAC, document SHA/bytes, corrupt archives and nonempty targets. [production-backup](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/__tests__/postgres/production-backup.test.ts) covers production writer/PG18 version, expense attachments and realpath checks. [hr-composed-legacy-restore](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/__tests__/postgres/hr-composed-legacy-restore.test.ts) includes truncated archive and late SQL transactional rollback. Tests are not evidence of success until a recorded run proves it.

## Executable tests — dedicated synthetic PG18 environment ONLY

Use a fresh, isolated local or CI runner. `docker-compose.yml` defines `postgres:18-alpine` at loopback port **54329** with disposable database `aqlan_p1_test`. **WARNING:** the existing restore tests deliberately reset the schema of `TEST_DATABASE_URL`, and the fixture creates/drops *its own* randomly named databases. Never point either URL to production, staging, a shared database, a backup archive or a non-dedicated service. Do not run if a pre-existing local DB or service is occupying this test endpoint.

```sh
docker compose up -d pg18  # only on a brand-new, task-owned local sandbox
npm ci
export NODE_ENV=test
export DATABASE_ENVIRONMENT=test
export DATABASE_URL='postgresql://ci:ci@127.0.0.1:54329/postgres?sslmode=disable'
export TEST_DATABASE_URL='postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable'
# A synthetic test-only SESSION_SECRET is required; never reuse a production secret.
node --test scripts/security/synthetic-restore-target-guard.test.mjs scripts/security/legacy-restore-cli.test.mjs
npm run typecheck
npm run test:postgres -- __tests__/postgres/security-restore-negative.test.ts __tests__/postgres/restore-drill.test.ts __tests__/postgres/production-backup.test.ts __tests__/postgres/offsite-backup-drill.test.ts __tests__/postgres/hr-composed-legacy-restore.test.ts __tests__/postgres/restore-multiline-literals.test.ts
```

The existing `vitest.config.postgres.mts` global setup checks PostgreSQL major **18** before executing tests and uses canonical test-target safeguards. These command examples are for a synthetic disposable environment and are **not** authorization to transfer/restore real patient data.

## Outcomes as of audit publication

| Topic | Evidence-backed status |
|---|---|
| Query host/database override gap in original PR #369 | CONFIRMED original static weakness; targeted hardened code committed at 7610f3c6ca7063b1319a429f2579e708e0459104; final commit tests pending |
| Pre-read pre-connect refusal | Local script-copy probe 10 PASS; committed test against exact script available, final branch not independently run post-refactor |
| PG18 actual full backup/restore | **NOT EXECUTED HERE** (server absent). Executable test paths above; CI pending at audit time |
| Missing attachment | Negative integration test prepared, **NOT EXECUTED** |
| Corrupt/truncated/nonempty targets | Existing real PG test cases reviewed, **NOT RE-RUN HERE** |
| Partial filesystem restore | New PG18 test documents destination is disposable after SQL succeeded but document staging failed; **NOT EXECUTED** |
| Production last verified backup time/size/archive checksum | **UNKNOWN**; admin-authenticated history/volume metadata not accessed |
| External/second copy | **NOT PROVEN**; previous audit: configured S3 and encryption variable names absent and Google Drive provider stub. No production archive copied or examined |
| Production changes | **NONE**: no Railway updates/restarts, no production connections, no archive download/deletion/restore; no finance/db/migration/package/CI edits |

**Decision for Dot:** PR #369 remains Draft; require green final-commit Node CLI tests and real PostgreSQL 18 synthetic tests, review the separate shared `lib/db-target.ts` risk, then decide merge. Do not claim any production backup restore proof from these tests.
