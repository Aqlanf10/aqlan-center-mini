# HR integration handoff — PR #308

Status: implementation and validation in progress; **not ready for merge or deployment**. No production or staging migration/data change was performed.

Branch: `feat/hr-staff-tasks-phase1`. Received remote head: `e5c4e4ae748b4ad2e08ee70d5794b71018038f8b` (newer than the prompt's reviewed `895500c9`). Main integrated with ordinary merges; current integrated base: `f1164bbecc0bbf9f4a12855aa54827c3d8b44a60`. Implementation checkpoints: `b92edb39` and merge/pushed `3f0e8fb3a8bb8546c43ba7ab67e2a30c92986206`. The delivery head for this checkpoint is the commit containing this file, obtainable with `git rev-parse HEAD`; validation is ongoing and will be recorded against the final head.

## Migration reservation and external histories

The user relayed dot's approval reserving **0050** for HR integration in PR #308 after open-branch number checks. This approves the number in source only. 0045, 0046, 0048 and 0049 were not rewritten. Current production/staging sources do not contain 0048/0049, but external manual database histories remain unverified; do not infer they were never applied. All corrections are additive in `0050_hr_payroll_integrity.sql`, byte-equal to `HR_PAYROLL_INTEGRITY_SQL`. Do not apply externally or merge this branch.

0050 adds payroll pay-term snapshots/blockers, independent commission payable and component vouchers, immutable request fingerprints and reversal metadata; it also adds raw attendance events and pending/approved/rejected correction decisions. Existing corrections were already applied by old code and retain historical approved status. Schema contracts/disclosure are generated through the official PG18 path, not manually combined fingerprints.

## Proven defects and fixes

- Original merged branch: **27 failed / 3 passed** financial integrity cases (`/tmp/hr-baseline-integrity.log`). Authoritative effective contracts now govern calculations; profile fallback is explicit and only when no governing contract exists. Profile synchronization and addenda preserve historic approved snapshots. Unsupported proration/employment changes or engine policy conflicts block approval rather than invent policy.
- Hybrid cash payments now generate salary and commission vouchers linked to their respective existing payables, using the existing commission/expense engine. Derived balances replace the nonexistent `payables.balance_minor` assertion. Payroll and doctor payout entrypoints share party locks and engine due checks. Outstanding HR claims require the atomic HR settlement path; unlinked direct vouchers cannot leave a parallel outstanding payroll claim. Direct payments before approval force draft revalidation/recalculation.
- UI persists the exact payload and request key across reload, response loss, double click and tabs; server fingerprints, request/row locks and uniqueness reject key reuse with different content. A real COMMIT-success/response-error test verifies lookup of the committed result. Reversals call the existing accounting reversal inside the same audited transaction.
- Old print pages lost two decimal places: **6 failed / 1 passed** against the original pages, **7 passed** after the fix (`/tmp/hr-print-red.log`, `/tmp/hr-print-green.log`), including YER/SAR/USD and every print row.
- Attendance/leave regressions: **5 failed / 1 passed** before repair (`/tmp/hr-workforce-red2.log`): correction requests applied before review, night checkout split onto the next day, checkout-only treated as complete, paid leave approved without owner allocation, and leave overwrote existing attendance. New event log preserves raw punches; independent approval applies actual corrections; clinic-zone night shifts stay on the starting date; missing punches remain incomplete. Paid leave requires an explicit adequate allocation and cannot replace attendance. Leave creation serializes overlapping requests on staff.
- Separate leave privacy regression failed against the real PG database (`/tmp/hr-workforce-privacy-red.log`); session-scoped reads now protect reasons/balances and staff-id tampering. Admin alone allocates balances and decides leave. Corrected panels consume actual shared DTOs and leave codes, and offer approved-leave cancellation.
- New unlinked commission regression failed against the real expense engine (`/tmp/hr-unlinked-commission-red.log`), proving a separate voucher could leave HR payable outstanding; repaired by requiring the HR atomic settlement context.
- Reset classification now includes both new child tables; normal main merges preserved lab accounting changes. Main-file LF normalization removes earlier whole-file CRLF review noise without changing unrelated behavior.

## Validation checkpoints (final reruns pending)

- Frozen `npm ci` succeeded; package lock unchanged.
- PostgreSQL 18.6 isolated local server. Earlier financial scope: **40 / 40** (`/tmp/hr-all-financial-final.log`); latest 37 integrity cases + finance/workforce/schema/reset/backup are running in `/tmp/hr-integration-final.log`.
- Workforce including privacy: **7 / 7** (`/tmp/hr-workforce-final.log`), before latest allocation hardening; final rerun pending.
- Actual HTTP/browser payroll journey: **3 / 3** (`/tmp/hr-http-payroll5.log`), including salary/percentage/hybrid, desktop1280/mobile390, complete print PDF, partial split, reversal, response loss/reload/double click/two tabs and permission checks. Artifacts: `/tmp/hr-evidence/hr-payroll-1280.png`, `hr-payroll-390.png`, `hr-payroll-all-rows.pdf`. Actual existing HR UI journey: **10 / 10** before latest attendance/leave fixes; final built-app rerun pending.
- Backup/restore: **2 / 2** before attendance additions (`/tmp/hr-backup-roundtrip.log`), custom identifiers/relations/sequences, SKIP_SEED and old no-HR backups; final rerun pending.
- Official current schema generation now: **109 tables, 1448 columns, 1461 constraints, 344 indexes, 30 triggers** (`/tmp/hr-schema-generation-final.log`). Independent source verification rerun pending. Earlier verifier reported zero unexpected differences and 16 already-declared convergence findings; no ownership/diagnostic guard was weakened.
- Latest typecheck checkpoint passed (`/tmp/hr-typecheck-final.log`); new settlement-context typecheck and lint running. Raw-body scanner and money guard passed earlier.
- Production build passed at 3f0. Final source rebuild/security/browser suite pending.
- Dependency audit passes using npm11.15 metadata and Node22 `--use-env-proxy` with existing strict scoped advisory verification (`/tmp/hr-audit-proxy.log`): six existing dev findings explicitly scoped by the unchanged guard; production audit zero moderate-or-higher. npm11.21 in this local environment returns empty advisory ranges and is rejected by the guard; no suppression was added. Runtime artifact proof remains required after final build.
- Full local unit run: 8504 passed, 3 timed out tests + one timed out suite. Two affected guards subsequently passed; runtime-tracing/saved-reports still timed out under concurrent work. **CI at 3f0 passed all unit tests, typecheck, lint and money guard**, then failed PG on schema-count/reset defects subsequently corrected. Logs download from the Actions result host was forbidden; job/step statuses are accessible.
- CI 3f0: https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38026854993 and https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38026853229. These are checkpoint runs, not final delivery evidence.

## Remaining work at this checkpoint

Finish targeted integration checks, fresh schema verification, final lint/typecheck/build and runtime dependency proof; run final full unit/PG with the real CI fixture flags, operational verification and complete HTTP/browser suite. Push final commits normally to this same branch and update this file and PR description with exact head/CI links/results. Do not declare ready until final-head CI and actual journeys pass. Dot owns final review, merge and deployment.

All local source changes in this checkpoint are included in its commit; environment tooling/logs/screenshots remain local ignored artifacts. Do not publish protected environment configuration or secrets. This handoff supersedes `HANDOFF_HR_INTEGRITY_WIP.md`.
