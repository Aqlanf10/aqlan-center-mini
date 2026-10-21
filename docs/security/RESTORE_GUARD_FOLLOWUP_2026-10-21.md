# 2026-10-21: PR #369 target-override follow-up (Dot handoff)

**Exact reviewed code commit:** [7610f3c6ca7063b1319a429f2579e708e0459104](https://github.com/Aqlanf10/aqlan-center-mini/commit/7610f3c6ca7063b1319a429f2579e708e0459104) (PR #369), with an evidence/runbook commit [e65827d36352b84ae39b8e145753f35d05056d45](https://github.com/Aqlanf10/aqlan-center-mini/commit/e65827d36352b84ae39b8e145753f35d05056d45). **Neither PR merged; no production operations.**

## Finding

Original PR #369 checked `new URL(DATABASE_URL).hostname` but passed the **original URL** to `pg.Client`. PostgreSQL URI query parameters including `host`, `database`, and TLS file parameters may change effective client behavior. This was independently identified/reported without making a connection. Security impact: attempted restoring to a different database or reading SSL credential files after accepting a false localhost declaration.

The proposed Draft fix now uses the repository's existing [canonical verification-target-policy](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/lib/verification-target-policy.mjs) and explicit PG environment/alias checks; it rejects all URI options except a single `sslmode=disable`, permits only literal loopback IP, and returns a canonical URI. [`scripts/restore.mjs`](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/scripts/restore.mjs) checks **before reading the backup file**, and opens a `pg.Client` only with the sanitized URI and `ssl:false`. This intentionally differs from broader `lib/db-target.ts` acceptance for staging/remote targets.

**Residual high-priority item (not fixed, needs Dot coordination):** [`lib/db-target.ts`](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/lib/db-target.ts) parses authority/path without the same verification of override query keys. Its use in `restore:full` deserves a separate, reviewed hardening plan rather than an uncoordinated edit to shared code.

## Tests and limitations

- **Locally executed:** 22 guard tests + 10 script-invocation tests passed, using an inert `pg` import-hook and nonexistent backup archive. The local copy of the **actual `scripts/restore.mjs`** matched GitHub blob `e790ce73cb55e264cda8aa3009d7adedca47af06` byte-for-byte. These local runs preceded final canonical shared-policy integration and **must not be reported as final-commit acceptance**.
- **Committed executable tests:** [guard assertions](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/scripts/security/synthetic-restore-target-guard.test.mjs), [actual CLI pre-read/pre-connection assertions](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/scripts/security/legacy-restore-cli.test.mjs), [isolated PG18 missing-document/partial-failure tests](https://github.com/Aqlanf10/aqlan-center-mini/blob/7610f3c6ca7063b1319a429f2579e708e0459104/__tests__/postgres/security-restore-negative.test.ts).
- **Not executed here:** actual PostgreSQL 18 integration, owing to missing `postgres`, `initdb`, `pg_ctl`, `psql`, and Docker, with no network DNS resolution available to install the server. Local `pg_config` reports libpq development metadata 17.11, **not a PG server**.
- **Runnable command and source-backed coverage:** [exact runbook](https://github.com/Aqlanf10/aqlan-center-mini/blob/e65827d36352b84ae39b8e145753f35d05056d45/docs/security/RESTORE_GUARD_PG18_EVIDENCE_2026-10-21.md), which selects production archive writer/restore tests for integrity, finances by currency, FK, attachments, truncated/corrupt archives, nonempty destinations and partial failures. The repo PostgreSQL test globalSetup requires server **18**.
- **Actual production last-success/archive bytes/checksum:** UNKNOWN; admin-only history or Railway volume contents not read. **External copy:** NOT PROVEN; no offsite object evidence obtained. Cron startup cannot establish archive completion.

## Next decision

PR #369 stays Draft. Dot to run committed final-commit guard/CLI tests and PG18 in a **new dedicated synthetic-only database**, inspect green CI, and resolve the shared target classifier risk before merging. Production-archive restore requires independent explicit approval and is not part of this PR. No changes made to finance, migrations, `lib/db.ts`, package manifests, shared CI, Railway, secrets or production data.

## Final addendum: required CI coverage and latest proposed head

The [PR #369 head ba6e338017fcdbe4ad4f432cfcde887f84ce477e](https://github.com/Aqlanf10/aqlan-center-mini/commit/ba6e338017fcdbe4ad4f432cfcde887f84ce477e) adds an isolated [Vitest wrapper](https://github.com/Aqlanf10/aqlan-center-mini/blob/ba6e338017fcdbe4ad4f432cfcde887f84ce477e/__tests__/legacy-restore-cli-preflight.test.ts) which invokes the committed real-script `node --test` guard and CLI checks through the existing mandatory `npm test` flow **without changing CI configuration**. The companion real PG18 negative suite remains in the same Draft branch. At the last observation the new head CI run was PENDING; **no PASS can be reported for the final head until its result is retrieved**.

**Reviewer/merger:** the requesting owner retains the final decision (or delegates it explicitly). This audit performed no merge or deployment. The old notes assigning Dot do not override the owner's latest instruction.
