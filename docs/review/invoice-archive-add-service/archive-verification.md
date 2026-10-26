# Archive implementation evidence

The archive-specific source is implemented locally. No push, pull request, deployment, real-record access or message was performed by this worker. The parent owns final composition and any later publication decision.

## Before implementation

`archive-design.md` and the intended unit/PostgreSQL tests preceded application code. `archive-unit-red.log` and `archive-postgres-red-behavior.log` show the new archive modules were absent on the unchanged baseline. These are missing-interface failures (no assertions executed), not claims that the previous cancellation writer was an archive implementation. `archive-postgres-red.log` separately records a temporary dependency-installation setup failure (`vitest` unavailable); it is not behavioral evidence.

## Local verification

- Node 22 from `/tmp/invoice-node22/node_modules/.bin`, installed locked dependencies.
- `npm test -- __tests__/invoice-archive.test.ts`: **17/17 passed**.
- `SESSION_SECRET=synthetic-invoice-archive-secret-0123456789 TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55440/aqlan_p1_test npm run test:postgres -- __tests__/postgres/invoice-archive.test.ts`: **25/25 passed** on PostgreSQL 18.6, synthetic disposable local database only.
- Focused ESLint for both archive libraries, both archive routes, their tests, and the touched audit/HTTP/role catalogs: exit 0, no diagnostics.
- `git diff --check`: clean.
- An intermediate whole-worktree typecheck failed in the concurrently unfinished add-service and maintenance-view files, with no archive-file diagnostics. This is not claimed as a passed final typecheck; the parent owns the final combined check.

The PostgreSQL tests include actual handler requests (request session extraction substituted only; transaction credential/role/permission validation remains real), archived/read/restore transitions, immutable lost-response replay and changed-key refusal, two kinds of real multi-connection races, command-bound monotonic stale refusal after a lost no-op response, actual receipt settlement rather than manual paid status, zero/cancelled documents, partial/unpaid/ambiguous-policy refusal, restore after refund creates debt, closed-period and revoked/read-permission refusal, and atomic rollback if audit insertion fails.

A nonempty synthetic completed-treatment fixture contains plan/case/session/procedure rows, a signed linked visit, a lab cost, historical doctor commission policy, a positive commission calculation, payroll commission evidence and an original print record. Hashes, actual commission report, visit walkout and rendered original invoice remain equal across archive and restore. The ordinary current statement continues to include a current archived invoice; full ledger balances remain equal. The separate archive list does not replace any financial reader.

Proposal checks prove no automatic schema installation, insert/update/delete/truncate protection, ownership/version guards, duplicate-key uniqueness, essential column types and restrictive ownership foreign keys. Removed uniqueness, changed column type, removed foreign key, disabled row trigger and disabled truncate trigger all produce `migration_pending`. Rerunning the proposal preserves event history.

The existing commission reader emits a pg client concurrent-query deprecation warning during its preserved report check; the test passes without suppressing that warning.

## Remaining boundaries

- `migrations/proposals/invoice-archive.sql` remains unnumbered and unregistered. Runtime is deliberately `migration_pending` until migration conflict/adoption review. No 0073–0080 assignment was made. Full migration/backup/reset integration must accompany later adoption; restrictive ownership foreign keys intentionally prevent silently deleting archived evidence.
- Unpaid or ambiguous invoice archive authorization remains a real policy decision. The implementation refuses it without accounting mutations. Later debt on an already archived invoice remains in the account and statement, and restoring it remains available subject to authority and period checks.
- Same-state no-op produces no new event/audit. If its response is lost and state later changes, `version_advanced` proof binds the old command and permits recovery to terminate safely; it never rearchives a restored document.
- Browser UI and whole-task validation are owned by the parent/UI worker and are not counted in this archive-only report.
