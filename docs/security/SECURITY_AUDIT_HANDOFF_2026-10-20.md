# Security audit handoff — 2026-10-20 (READ-ONLY)

> **Updated 2026-10-21:** For each backup finding's source, UTC event/inspection time, limits, what failed and what remains untested, refer to [BACKUP_RESTORE_EVIDENCE_2026-10-21.md](./BACKUP_RESTORE_EVIDENCE_2026-10-21.md). This later evidence matrix is authoritative for the backup/restore portion. Synthetic SQLite smoke PASS is **not** a PostgreSQL 18 or production archive restore proof. Separate hardening proposal: [Draft PR #369](https://github.com/Aqlanf10/aqlan-center-mini/pull/369). Dot retains sole review/merge decision. No production modifications or data transfers.


**Owner for review and merge:** Dot. **Do not auto-merge or deploy.**

## Verified production facts

- Railway project `aqlan-center-mini`, environment `production`: web and PostgreSQL healthy during inspection; no recent failed deployments in the queried 8-hour window.
- PostgreSQL has **no public service domain and no public TCP proxy** in the inspected environment; private network endpoint configured. This is *not* a penetration test of the application.
- Production web is sourced from `main`; Railway service config reports `checkSuites: false`. **Verify** deploy gating against GitHub checks and branch protection before changing it.
- GitHub repo visibility is **public**. Treat code and commit history as public when reviewing tracked secret exposures; do not commit actual secret values in audit evidence.
- CI workflow includes typecheck, lint, unit tests, PostgreSQL integration, journeys, dependency audit, parser scan, build and backup preflight. Presence does not prove latest run passed; verify latest check conclusions.
- `lib/auth.ts` uses scrypt password hashes and HMAC-signed session tokens and refuses absent/short `SESSION_SECRET` (32 chars). `proxy.ts` includes request origin checks, CSP, and route allowlists. These positive findings **do not** prove route-level RBAC correctness.
- Production web contains a **temporary admin reset credential configuration name**; verify no runtime dependency remains, then securely remove/rotate with documented rollback. Do not paste its value anywhere.
- Daily `backup-cron-runner` invokes an internal authenticated endpoint over the public app URL; Railway logs inspected show daily container starts, **not proof of completed backups**. Verify destination, retention, failure alerts, offsite copy, and actual restore in an isolated environment. Do not trigger a production backup/restore as part of review without approval.

## Next security work packages — separate PRs reviewed by Dot

1. **P0 Backup evidence:** establish last successful backup metadata and isolated restore proof; alert on missed/failed runs; avoid sensitive log output.
2. **P0 Secret hygiene:** audit committed git history and environment variable inventory for legacy credentials; rotate only with a verified zero-downtime procedure.
3. **P0 Authorization:** test cross-patient IDs, staff vs doctor vs cashier vs admin privileges, horizontal object access in attachments, patient portal, reports, invoices, payments and case records. Tests must be non-destructive and use synthetic patients only.
4. **P1 API security:** exercise unauthenticated routes, origin/CSRF restrictions, upload limits, webhook signature checks, throttling and browser security headers; capture exact test evidence.
5. **P1 Delivery gating:** validate branch rules, mandatory checks on main and deployment policies; avoid direct production deploy without green gates.

## Acceptance requirements

- No production database mutations, no changed environment vars, no redeploy from this audit PR.
- Each confirmed defect must have reproduction with synthetic data, severity, affected file/route, regression test and a minimal fix in its own PR.
- Dot independently reviews CI, logs, backup proof, and code diff, then authorizes any merge/deploy.
- Public PR comments must not include patient information, live tokens, credentials, connection strings or exploit payloads.

## Scope limitation

This is an evidence-based **initial configuration/source review**, not a full repository scan or penetration test. Runtime values were redacted by the Railway connector. A healthy application is not evidence of protection against compromise.
