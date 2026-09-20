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

Therefore, as of this audit, **there is no proven production backup archive**.

## Current blocker

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
- [ ] first production archive created
- [ ] archive status = verified
- [ ] archive SHA-256 recorded (metadata only)
- [ ] archive byte size recorded
- [ ] document object count recorded
- [ ] Railway Volume replication status recorded
- [ ] exact archive restored into isolated PostgreSQL 18
- [ ] restored documents verified
- [ ] `db:status` green on restored target
- [ ] required operational journeys green on restored target
- [ ] RPO observation recorded
- [ ] RTO observation recorded
- [ ] rollback point formally accepted for TD-01A
- [ ] no production DB writes/migrations occurred during TD-08A

## Phase status

**STARTED / BLOCKED ON FIRST AUTHENTICATED BACKUP ACTIVATION.**

TD-01A must not start until the checklist above is complete and this report is updated with the actual archive/restore evidence.
