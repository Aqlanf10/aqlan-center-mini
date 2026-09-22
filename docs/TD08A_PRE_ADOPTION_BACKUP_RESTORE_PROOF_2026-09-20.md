# TD-08A — Pre-Adoption Backup / Restore Proof

**Date:** 2026-09-20  
**Branch:** `td/08a-pre-adoption-backup-proof`  
**Starting main:** `5f6c0678dee6a27c1841e311adf54f050a983956` (PR #46 merge)  
**Owner authorization:** explicit approval to start TD-08A in chat before this audit.

## Purpose

Create a real, verified rollback point before TD-01A/TD-01B:

1. verified full production backup,
2. restore of that exact archive into an isolated PostgreSQL 18 target,
3. post-restore operational proof,
4. dated RPO/RTO observations,
5. no production migration/adoption work in TD-08A.

## Safety boundary

This phase does **not** authorize:

- migration/adoption on production,
- `schema_migrations` writes,
- `ensureSchema` retirement,
- restore into production,
- Google Drive replication,
- modification of patient/financial production data.

The backup code path is expected to remain read-only against the production database. Durable writes for backup state/archive belong only on the Railway Volume.

## Verified Railway state — 2026-09-20

Project: `aqlan-center-mini`.

Production services observed:

- `web`
- `Postgres`
- `backup-cron-runner`

### Web service

- source: `Aqlanf10/aqlan-center-mini`, branch `main`
- current production deployment after PR #46: SUCCESS
- healthcheck: `/api/health`
- persistent volume mounted at `/data`
- runtime variables include the expected backup-related names:
  - `DATABASE_ENVIRONMENT`
  - `DATABASE_URL`
  - `DOCUMENTS_DIR`
  - `INTERNAL_BACKUP_RUN_TOKEN`
  - `PRODUCTION_BACKUP_ONCE_TOKEN`
  - Railway volume/platform variables

Variable values were not read or copied into this report.

### Cron service

`backup-cron-runner` exists and is active:

- image: `alpine:3.22`
- schedule: `0 0 * * *`
- restart policy: NEVER
- calls `POST /api/internal/backup/run`
- uses `INTERNAL_BACKUP_RUN_TOKEN` without exposing it

Container starts were observed daily through 2026-09-20.

**Important:** a successful cron container run is not treated as a verified backup.

## Verified volume state

Read-only inspection of the production `web` volume showed:

- `/data` mounted and accessible
- `/data/backups` exists
- `/data/backups/.backup-state` exists
- `.backup-state` is empty
- `backup-config.json` absent
- no backup archive present in `/data/backups`
- no `history.json`
- no latest verified backup metadata

A prior 2026-09-11 cron invocation is documented as returning:

```json
{"ok":true,"ran":false,"reason":"backup-disabled"}
```

This paragraph records the **initial 2026-09-20 audit only**. A verified archive
was created later that day; see the dated evidence below. It is no longer the
current blocker.

## Initial blocker (resolved for archive creation)

The application design intentionally requires backup runtime activation to be written through:

`POST /api/settings/backup/config`

with an authenticated admin session. That endpoint validates a strict whitelist and writes only:

`/data/backups/.backup-state/backup-config.json`

It does not require a production database write.

The available Railway remote tooling for this audit could inspect the production volume but could not write files or execute arbitrary commands inside the container. Railway Agent confirmed that its available container-file tools are inspection-only.

A local Railway CLI fallback was also attempted in the agent runtime, but the CLI is not installed and that runtime has no external DNS access to install it. No unsafe workaround was used.

## Approved activation profile

When the authenticated application path is available, TD-08A uses this conservative profile:

```json
{
  "backupEnabled": true,
  "scheduleEnabled": true,
  "scheduleTime": "03:00",
  "scheduleTimeZone": "Asia/Aden",
  "retentionDailyCount": 30,
  "retentionWeeklyCount": 12,
  "destinations": {
    "railwayVolume": true,
    "googleDrive": false
  }
}
```

Rationale:

- Railway Volume only for the first rollback proof.
- No external replication before separate encryption/OAuth review.
- daily schedule aligned with the existing cron firing at 00:00 UTC = 03:00 Asia/Aden.
- conservative 30 daily + 12 weekly retention.


## Verified production backup evidence — 2026-09-20

The owner triggered the newly deployed **«نسخ الآن إلى القرص الدائم»** control from the production admin UI.

Observed production evidence:

- HTTP invocation: `POST /api/settings/backup/run` → **200**
- Invocation time: `2026-09-20T02:02:59.329712427Z`
- Trigger type: `manual`
- Backup status: **verified**
- Replication status: **complete**
- Railway Volume destination: **success**
- Google Drive: skipped (disabled)
- Local agent: skipped (disabled)

Verified archive:

- filename: `production-backup-20260920-020258-893-97562bd7de64-c2281700.tar.gz`
- createdAt: `2026-09-20T02:02:58.893Z`
- filesystem mtime: `2026-09-20T02:02:59Z`
- archive bytes: `1,498,080`
- document count: `5`
- archive SHA-256: `e271486eabf8e0d74635a687fe932b73d14949099d2eaca846d522dd4e2579a7`

Backup state now contains `history.json` and records this archive as verified. No production migration or schema adoption was executed.

## Isolated restore drill — 2026-09-22

The exact archive above was downloaded from the production Railway Volume by a
read-only file operation. Independent local validation matched its 1,498,080-byte
size, archive SHA-256, database SQL SHA-256
`61bd61e64fcf751b393e5ef927e73a6fca0190f6c8f7d991704f0c1322d9a85a`,
and five document objects. Archive entries were regular files with no unsafe
paths, symlinks, duplicates, or truncation. No archive content, patient data, or
credentials are included in this report.

The target was a new, separate Railway project `aqlan-td08a-restore-drill`
(`0c7828c0-2269-4d79-9a37-7b976bbfa16f`), staging environment
`73081862-0cb8-4b58-b711-ab148e78485f`, PostgreSQL service
`1bbb0ad3-d8d0-43ad-9b2c-445dd75fc104`. PostgreSQL reported version
18.6; the target had zero tables before restoration. Its credentials, volume,
service, project and database identity were separate from production. There was
no production restore target or production cutover. The eleven numbered
migrations were applied to this **empty isolated target** as required by the
current `stagedRestore` implementation; this is not TD-01A baseline adoption.

The first attempt with the supported `stagedRestore` path **failed** after
23.455 seconds (22:15:37.804–22:16:01.259 UTC). It applied migrations but
could not replay data: SQLSTATE `23503`, constraint
`lab_orders_payable_id_fkey`. `lab_orders` and `payables` reference one another
with non-deferrable foreign keys, while the backup exports their strongly
connected group in alphabetical table order. The target was disposable; this
failed attempt restored no documents. A diagnostic SQL replay within a rolled
back transaction confirmed that deferring these two constraints resolves the
ordering dependency. The archive was not modified.

An operator then performed a **manual, cycle-safe restore** on that isolated
target. Inside one transaction, the two cyclic foreign keys were temporarily
made deferrable, all constraints were deferred, the exact archive SQL was
replayed without changing its data statements, `SET CONSTRAINTS ALL IMMEDIATE`
forced validation, and both keys were returned to `NOT DEFERRABLE` before
commit. This completed at 22:23:13.550 UTC after starting at
22:23:08.819 UTC: **4.734 seconds** for the successful manual database and
document procedure. The five documents were written to an isolated staging
directory, read back, and their hashes matched. The production archive remains
untouched.

Read-only verification on the restored target found 62 tables, 895 restored
rows matching the archive across 61 data tables, 105 foreign keys with zero
orphaned references, 185 indexes with zero invalid indexes, 645 constraints
with zero unvalidated constraints, zero disabled triggers, and 51 sequence
checks with zero failures. Eight uncalled sequences belonged to empty tables.
Both cyclic foreign keys remained non-deferrable after commit. Application
read queries against the restored clinical and finance tables succeeded.

### Candidate supported-path repair — PR #55, 2026-09-22

The restore defect was fixed in the **separate draft code PR #55** (not part of
this documentation PR). Its focused PostgreSQL 18 regression drill created a
reciprocally linked lab order and payable, then passed all 9 tests; typecheck
and lint also passed locally. Using that candidate code, `stagedRestore`
successfully restored the **same exact production archive** into a newly
created database inside the isolated Railway project. It applied the numbered
migrations, replayed 895 archive `INSERT` statements, restored and verified
5/5 documents, found 62 tables, and reported a consistent migration status
and successful critical probe. Both cyclic foreign-key definitions were
non-deferrable after the restore. The candidate supported-path procedure ran
from `2026-09-22T22:51:48.213Z` to `22:52:24.973Z`: **36.758 seconds**,
excluding database provisioning and any cutover. That temporary database
was dropped after verification. This is candidate-branch evidence; production
and `main` do not yet contain the fix.

`npm run db:status` passed against the restored target. `npm run verify:backup`
passed on the isolated PostgreSQL 18 server using synthetic databases; it does
not validate the restored production-shaped data. All seven phase-1
`verify:ci` operational journeys passed when invoked individually; they use
PGlite and therefore do not themselves exercise the restored clone. The full
`verify:ci` launcher failed on the Windows drill host: all 20 child journeys
reported failure from `spawn("npx")` being unavailable as a native executable
there. It is **not** recorded as a full-suite pass against this clone. Main CI
had passed separately before the drill.

**RTO/RPO evidence:** 36.758 seconds is the candidate `stagedRestore` run on
the exact archive after the isolated database was provisioned; it excludes
provisioning and any cutover. The 4.734-second measurement is the successful
**manual database/document procedure** on an already migrated target; it
excludes target provisioning, diagnosis, extended verification and cutover.
The failed original supported-path attempt took 23.455 seconds and has no
successful RTO. The backup history records creation
at `2026-09-20T02:02:58.893Z`; the SQL header was written at
`2026-09-20T02:02:58.928Z`, after snapshot acquisition. The exact snapshot
cutoff was not persisted, and there was no production outage/cutover event.
Consequently **observed RPO is not measurable** from the available evidence;
archive age at drill time is not RPO.

Railway metadata checked after the drill showed the production PostgreSQL,
web, and backup-cron services at SUCCESS. The production PostgreSQL service
and its deployment ID were unchanged from the pre-drill baseline. All database
replay, DDL, document writes and synthetic test databases were confined to
the separate drill project. No production database connection, production
migration, production restore, or production Railway change was made by this
drill. Metadata cannot independently prove every production row or schema
object remained identical; that would require a separate read-only production
preflight, which TD-08A did not perform.

The restored target and its separate Railway volume remain available for
review; they contain copied production data and must be removed through the
normal Railway owner-controlled workflow after evidence is accepted. The
downloaded local archive and staged document copies also remain pending safe
cleanup. A credential for an earlier **empty** temporary target appeared in
local tooling output; that service was deleted before this restore, and the
successful target uses a different credential. No credential is recorded here.

**Decision:** TD-08A remains **OPEN**. The verified rollback archive is real,
and its data can be recovered on an isolated target. Candidate PR #55 repaired
and reran the supported path successfully, but that code has not passed its
required CI/review and is not on `main`. Full operational verification against
the restored clone is incomplete, the exact snapshot cutoff is unavailable,
and the rollback point has not been formally accepted for TD-01A. Reassess
TD-08A after PR #55 is reviewed and the proof is accepted. None of this
authorizes TD-01A/TD-01B, production adoption,
`ensureSchema` retirement, or production cutover. The 16 independent schema
convergence findings remain open.

## Restore drill contract

After the first verified production archive exists, restore must occur only into an isolated PG18 target.

Existing repository components to reuse:

- `scripts/restore-full.ts`
- `lib/restore/staging`
- `__tests__/postgres/restore-drill.test.ts`
- `npm run verify:backup`
- `npm run db:status`
- operational `verify:ci` journeys as applicable

The restore target must classify as staging/local-safe; production and unknown remote targets are fail-closed by `restore:full`.

## Acceptance checklist

- [ ] backup runtime activation written through the intended authenticated path
- [x] first production archive created
- [x] archive status = verified
- [x] archive SHA-256 recorded (metadata only)
- [x] archive byte size recorded
- [x] document object count recorded
- [x] Railway Volume replication status recorded
- [x] exact archive restored into isolated PostgreSQL 18 by manual cycle-safe procedure (supported path still fails)
- [x] restored documents verified (5/5)
- [x] `db:status` green on restored target
- [x] required phase-1 PGlite operational journeys green (7/7; they do not query the restored target)
- [x] RPO observability limit recorded; no numeric observed RPO claimed
- [x] manual and candidate supported-path restore durations recorded; no cutover RTO claimed
- [ ] rollback point formally accepted for TD-01A
- [x] no production DB writes/migrations occurred during TD-08A

## Phase status

**BACKUP PROOF COMPLETE / MANUAL RESTORE PROVEN / SUPPORTED RESTORE PATH
FAILED / TD-08A OPEN.**

TD-01A must not start until the checklist above is complete and this report is updated with the actual archive/restore evidence.
