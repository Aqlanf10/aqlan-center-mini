# Backup and isolated restore audit — 2026-10-21 (evidence, NOT production-restore proof)

**Reviewer / merger: Dot only.** This report contains no credentials, patient data, production archive copies, runtime changes or secrets. Reference audit PR #368 and proposed Draft hardening PR #369.

## Scope, timing, and evidence conventions

- Railway read-only environment `production`, project `aqlan-center-mini`; sampled **2026-10-20 UTC**. All times below are UTC unless explicitly stated; clinic Asia/Aden is UTC+03:00. Railway service/variable inventories and sampled deploy logs are point-in-time or limited windows and cannot certify all historical operations.
- Source review uses GitHub `Aqlanf10/aqlan-center-mini` default branch around 2026-10-20/21; the exact fetched files should be compared by Dot to final merge head. Source code proves an implemented *path*, not a successful production run.
- Railway environment/variable read access was **redacted to names**; the task did not inspect values, application database tables, volume files, backup history JSON, authenticated administrator API responses or patient records.
- Locally tested only an isolated **SQLite surrogate** to exercise independent archive/relational/attachment evidence. This is **not** PostgreSQL or the actual AQLAN backup/restore implementation and must **never** be called production restore proof.

## Evidence matrix — source, time and limitation for each claim

| Claim | Result | Primary evidence / timestamp | Limit |
|---|---|---|---|
| Scheduler defined | VERIFIED CONFIG | Railway production `backup-cron-runner` service config, `cronSchedule = 0 0 * * *`, inspected 2026-10-20 UTC; command invokes `POST /api/internal/backup/run` via web with dedicated Bearer | A schedule is not evidence that backup ran |
| Container invocation | VERIFIED STARTS ONLY | Railway deploy log stream for cron service has `Starting Container` at 2026-10-14 00:00:02Z, 15 00:02:56Z, 16 00:01:25Z, 17 00:04:55Z, 18 00:02:35Z, 19 00:04:24Z, **20 00:03:40Z** | Sampled log window contains no completion/archive metadata; no inference of success/failure from start |
| Web service, database, storage | VERIFIED CONFIG | Railway production environment description on 2026-10-20 UTC: web and Postgres services live with volume mounts; `web-volume` -> `/data`, `postgres-volume` -> `/var/lib/postgresql/data`. Postgres no public TCP proxy, uses private endpoint; PG container image `postgres-ssl:18` | Does not prove file exists, valid DB dump, storage backups or PostgreSQL restore |
| Scheduled endpoint | VERIFIED CODE | [app/api/internal/backup/run/route.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/app/api/internal/backup/run/route.ts), reviewed 2026-10-20 UTC. Returns `ran:false` for disabled/not-due; requires token, production guard, documents storage and settings; only claims schedule day after verified result | Cron HTTP success or process start may mean no archive produced |
| Backup archive completion criteria | VERIFIED CODE | [lib/backupEngine.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/backupEngine.ts) and [lib/backupVolume.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/backupVolume.ts): tmp archive + fsync, validation, SHA-256 and atomic publication, history `verified`, replication tracked independently | Runtime history record and archive integrity have not been read |
| Last successful production archive (time, bytes, checksum, ID) | **UNKNOWN** | [app/api/settings/backup/route.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/app/api/settings/backup/route.ts) offers admin-only `status.lastSuccess` from local history; no authorized read response available to this audit | **Do not supply or infer** last-success date, size, archive ID or existence |
| Storage location | CODE-DERIVED ONLY | [lib/backupVolume.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/backupVolume.ts): backups underneath Railway mount directory, thus nominal `/data/backups` for inspected web-volume `/data` | No filesystem enumeration; existence, free space, durable snapshot and backup copies NOT confirmed |
| Retention | IMPLEMENTED; EFFECTIVE POLICY UNKNOWN | [lib/backupRetention.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/backupRetention.ts); [lib/backupConfig.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/backupConfig.ts) defaults daily=1, weekly=1; DB settings and on-volume override can change them | Actual configured retention, oldest existing archive and successful deletion history not read |
| Coverage | IMPLEMENTED, NOT VERIFIED WITH REAL ARCHIVE | [lib/fullBackup.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/fullBackup.ts) SQL dump plus `patient_documents` and, if table exists, `expense_attachments`; each referenced physical file is SHA/size checked; [lib/productionBackup.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/productionBackup.ts) uses same full archive with PostgreSQL source client | Unreferenced documents or files stored outside these tables/volume, external media, additional file stores NOT proven covered. Legacy `scripts/backup.mjs` uses pg_dump only and does not include documents |
| Offsite copies | **NOT PROVEN / DEFAULT ROUTES NOT AVAILABLE** | On 2026-10-20 Railway production web variable-name list did NOT contain `BACKUP_S3_*` or `BACKUP_ENCRYPTION_KEY`. [lib/s3-client.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/s3-client.ts) requires those names; [lib/backupDestinations.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/backupDestinations.ts) Google Drive provider is unconnected stub | Evidence excludes other independent/manual offsite backup workflows not discoverable here; does not prove absolute nonexistence |
| Failure monitoring | GAP / NOT VERIFIED | Railway project `list_webhooks` returned **0 project webhooks** on 2026-10-20 UTC; status API reports failures and cron status. Code stores history failures and partial replication | No proof of configured alert delivery, monitoring outside Railway or successful restore-drill alerting |
| Restore guard / archive integrity | VERIFIED CODE ONLY | [scripts/restore-full.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/scripts/restore-full.ts) rejects production/unknown-remote via [lib/db-target.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/db-target.ts); [lib/restore/validate.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/restore/validate.ts) verifies SQL/doc SHA, document size and path containment before writing | Actual isolated PostgreSQL restore and schema/financial correctness not executed |
| Legacy restore safety | CONFIRMED STATIC RISK; FIX PENDING TEST | [scripts/restore.mjs](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/scripts/restore.mjs) lacks `classifyDbTarget` and can connect to supplied DATABASE_URL. [Draft PR #369](https://github.com/Aqlanf10/aqlan-center-mini/pull/369) adds a pre-connect synthetic-local-only guard. Local **7/7 guard unit tests PASS**; PostgreSQL integration not run | No production restore attempted. Dot must check compatibility before merge |
| Partial restore | VERIFIED BEHAVIOR BY CODE INSPECTION | [lib/restore/staging.ts](https://github.com/Aqlanf10/aqlan-center-mini/blob/main/lib/restore/staging.ts) applies schema/SQL transaction, then writes documents and verifies post-write SHA. Failure later leaves an incomplete **isolated** target while returning `ok:false` | No cross-resource atomicity; target must be disposable, never used for cutover after error |
| PostgreSQL version compatibility | **NOT TESTED** | Writer saves `pgVersion` in manifest if available; validator checks archive format/version and checksums; no evidence of a major-version compatibility gate in reviewed validator; production image indicates PG18 | Verify actual `server_version`, restore server major, extensions, collations and migration compatibility on isolated PG18 before asserting support |

### Observability caveat

Cron `wget` sends a POST to the web service and outputs HTTP response; the endpoint can return HTTP 200 `ran:false`, so successful command exit is not sufficient. Sampled web service deploy logs (234 entries in the queried window) did not yield recognized `backup-engine` completion lines; this absence does **not** prove no backup exists. There is no read-only Railway connector filesystem listing. Safe way to obtain actual last success is the **administrator-authenticated** `GET /api/settings/backup` with access already authorized; extract only metadata (`lastSuccess.createdAt`, `archiveBytes`, `documentCount`, replication flags, retention setting), then independently confirm on-disk checksum/manifest through a reviewed metadata-only procedure. Do not post raw HTTP response or tokens to a public PR.

## Isolated synthetic local experiment — PASS, narrower than requested

At **2026-10-20 21:12:08 UTC**, a Python 3 standard-library test executed in an automatically removed OS temporary directory. Only synthetic SQLite rows were used; no Railway services, network or PostgreSQL databases contacted. Created 5 synthetic relational tables: patients, invoices, invoice_lines, receipts, attachments. Populated 1 patient, 1 invoice for 150000 YER minor units, 1 receipt for 50000 YER minor units and 2 binary sample attachments. Created a gzip tar archive containing a SQLite snapshot, documents and SHA-256 manifest, restored it into a *new* temporary database and verified: integrity_check=ok, foreign_key_check empty, invoice/line/receipt amounts and joins exactly match, both stored file sizes/checksums match. Corrupted one attachment in a second copy: checksum gate rejected it. **PASS (local surrogate only)**. Evidence script SHA-256: `3d69a146879f2da2e236777b8710a1e3bc495cc43af662f3c0ba7696b4706ec4`; `archive_bytes=1135`; `snapshot_bytes=28672`. The stand-alone script and JSON result are delivered as conversation artifacts, not stored in this public repository.

**Do not count** this experiment as a PostgreSQL 18 app-engine backup/restore, financial integration, migration, or production archive proof. This execution environment has no `postgres`/`initdb`/`pg_dump`/`pg_restore` and package downloads failed due network DNS. A dedicated PostgreSQL 18 runner with synthetic-only database is needed to satisfy the requested actual application restore test. No CI or financial files altered.

Run commands (redacted/synthetic, no production credentials):
```sh
python3 synthetic_local_restore_smoke.py
sha256sum synthetic_local_restore_smoke.py
node --test scripts/security/synthetic-restore-target-guard.test.mjs  # Draft PR #369; 7/7 PASS locally
```

## Dedicated PostgreSQL 18 synthetic acceptance drill — **NOT EXECUTED**

1. Dot provisions/approves a dedicated **non-production and non-shared** PostgreSQL 18 test instance, private-only endpoint, dedicated ephemeral database and isolated document directory. No production secrets, datasets, variables or endpoints. Do not reuse staging/finance databases.
2. Use only new synthetic patients, invoices, line items, multi-currency amounts, receipt/payment records, patient document and expense attachment bytes. Use the full-archive writer code (not legacy pg_dump-only script).
3. Before restore: record source table/row counts, declared and applied migrations, FK inventory, invoice-line totals by currency, receipts and allocations, and source document sizes/SHA values without identifiers in public logs.
4. Verify archive manifest and checksum, restore into a second empty synthetic PG18 database and separate empty directory via `restore:full` with `DATABASE_ENVIRONMENT=test` and explicit synthetic-only target. Verify zero FK violations; per-table counts; invoice totals, receipts, allocations and accounting currencies; patient/invoice references; physical attachments hash/size and two-way storage-key join; sequence next IDs; round-trip schema compatibility.
5. Negative checks: invalid SHA, truncated archive, missing document, nonempty target, production-declared target, unknown-remote target, and failure midway through document writes. These must fail closed; discard unsuccessful destination. Capture non-sensitive test artifacts.
6. Only then ask Dot to review tests, compare against current finance branch, and classify the remaining gaps. No CI, financial, migration, db.ts, dependency or infrastructure mutation in this PR.

## Production-archive restore proof — PROPOSAL ONLY, REQUIRES PRIOR APPROVAL

**STOP BEFORE ALL DATA TRANSFER.** Dot and clinic owner must approve a written change plan specifying:

- **Source**: actual latest verified production archive ID, creation timestamp, size, hash, document count, manifest PostgreSQL version, external-copy status, storage medium and encryption status; validate via admin metadata/independent checksum before selection. None of these runtime fields has yet been verified.
- **Destination**: a newly provisioned physically/logically isolated recovery project, private PostgreSQL 18 database and separate encrypted attachment store, not current staging or production; no public TCP proxy, no outbound integrations, no patient notifications, no routine users. Verify free space, storage lifetime and isolation.
- **Access/privacy**: explicit named operator/witness, least-privilege read-only production archive access, tightly scoped credentials in secret manager (never PR/chat/logs), encrypted transport and at-rest encryption, audited access, restricted retention and verified cleanup.
- **Execution**: archive copy/download only AFTER approval; validate SHA/manifest before target access; restore into empty dedicated recovery instance; no production URL accepted by recovery executor.
- **Validation**: compare aggregate schema/table counts, FK consistency, representative financial invariants by currency (no patient names or account amounts in public report), file counts/hash/size, application smoke with integrations disabled, rollback/RTO/RPO and disposal proof. A failed check means no cutover and the isolated target is quarantined/discarded under approved protocol.
- **Decision gate**: Dot signs off separate approval and execution window; this PR does NOT authorize it.

## Defect / gap queue (no claim of closure)

| Priority | ID | Finding | Action / owner |
|---|---|---|---|
| P0 | BAK-01 | Last verified production archive date, size, SHA, on-disk integrity and last drill unknown | Read-only metadata evidence; Dot/authorized operator |
| P0 | BAK-02 | No verified offsite copy; S3 secret variable names absent, Drive provider stub | Design external encrypted/offsite storage and independent restore proof, Dot review |
| P0 | BAK-03 | Legacy `restore.mjs` lacks explicit production-target guard | [Draft PR #369](https://github.com/Aqlanf10/aqlan-center-mini/pull/369); 7/7 guard unit tests passed; PostgreSQL end-to-end pending |
| P1 | BAK-04 | Production actual retention and failed-run alert delivery not proven; Railway webhooks=0 | Verify effective settings and alert channel, then isolated failure drills |
| P1 | BAK-05 | Full backup registered-file scope vs unregistered radiographs/attachments unverified | Read-only storage inventory and metadata-key comparison approved by Dot |
| P1 | BAK-06 | Version compatibility, FK/finance round trip and post-partial-failure cleanup untested on real PG18 | Dedicated synthetic PostgreSQL 18 full-path drill |
| P1 | BAK-07 | Staged restore can leave partially populated disposable target after downstream document failure | Test failure handling/quarantine; don't cut over failed target |

No files of finance, `lib/db.ts`, migrations, package manifests or CI were edited. No Railway settings, secrets, permissions, services or production data were modified.
