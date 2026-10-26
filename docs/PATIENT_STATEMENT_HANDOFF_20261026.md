# Patient statement checkpoint — local, not release-ready

Base: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f` (`origin/main` verified by fetch).
Branch: `feat/patient-statements-20261026`.
Workspace: `/workspace/patient-statements`.

Work was paused at the owner's usage-limit instruction. GitHub push, Draft PR and public publication are explicitly suspended pending publication authorization. No push, PR, merge, Railway deployment, migration or real patient-data operation was performed.

## Implemented locally

- Shared patient-facing projection for print and portal, using structured correction/audit relationships and verified currency allocation evidence. Real cash refunds remain visible; internal correction pairs are compressed without notes parsing. Canonical writers and money calculations are unchanged.
- Historical cutoff reconstruction, opening/closing period balances, exact partial reversal residues, repeated corrections, currency reclassification and stored opening-history reconstruction. Undated cancelled imports fail closed for historical copies.
- One isolated PatientLedger entry; summary, detailed, ongoing, period and selected-treatment preview; current clinical work separated from completed debt and unknown balances.
- Treatment figures/receipts use verified whole-source or explicit plan assignments. Patient-wide unallocated cash is never apportioned. Missing due-date/source coverage is shown as unavailable, never zero or all immediately due.
- Local Arabic/logo PDF (rasterized pages inside valid PDF) and PNG generation, file preview, recipient/content review, device file-share support and download/manual WhatsApp fallback. No public file links or provider.
- API and print authority, no-store responses, stale filter/request/session clearing and explicit revalidation around export.

## Verification evidence before pause

- Node22 environment contract and money-aggregation guard passed.
- Production build and its TypeScript stage passed BEFORE final font-loading fix, captured-day threading and post-response session check. Final source was NOT rebuilt.
- Full ESLint completed: zero errors, 209 existing warnings; subsequent changed files had focused clean lint.
- Targeted print unit:30/30; API/portal/http-permission group:43/43; projection/evidence/due-now group:28/28 at its earlier state; final due-now group:6/6; document assembly:4/4; final isolated export group:5/5.
- Targeted PostgreSQL statements:32 unique cases across five files passed after harness environment and old opening-note assertion corrections. The batching case was rerun:2/2; patientFacing adds exactly three queries at both one and40 plans.
- Built-app Chromium HTTP/UI first run:6/11 passed. Current print2/2; cutoff1/2; new workflow3/7. Tested server is local with disposable PostgreSQL18.6 and system Chromium151.
- Three HTTP export cases failed on loading the complete Next font stack (missing optional local Arial fallback). Code now loads only the bundled application face; isolated regression passes. Browser verification of that fix is NOT performed; no new workflow PDF/PNG was successfully produced.
- Other two HTTP failures were test fixture phone-login number length and old period movement wording; fixtures/expectations corrected, NOT rerun.
- Broad unit suite was interrupted at the owner's instruction; it is NOT a passing gate. Observed failures: development-runtime-tracing timeout (>5s), clinic-zone single-source rule (projection contains literal Asia/Aden), export font test failing within broad run despite isolated5/5. Investigate the latter's suite interaction. Do not weaken these gates.

## Remaining work

1. Resolve the clinic-zone constant violation and investigate broad-suite export regression/trace timeout under normal load.
2. Rebuild final source and rerun targeted HTTP workflow/current/cutoff suites to verify actual downloadable PDF/PNG, RTL readability, mobile/desktop and unsupported share flow. Review rendered exported images, not just signatures.
3. Final typecheck/lint and interrupted unit gate; CI for the exact final head after authorized push/PR.
4. Existing canonical plan readers still perform per-approved-plan/per-owned-invoice work. Added evidence queries are bounded, but this patch does NOT establish absence of inherited N+1. Do not expand financial readers silently while other branches are active.
5. Classic installment selected-treatment copies retain explicit receipt assignments but omit invoice lists when whole-invoice ownership is unavailable in this snapshot. Unknown patient-wide due dates remain unavailable unless verified nonoverlapping sources fully cover the balance. Imported internal corrections without structured lineage cannot be inferred from note text.

## Local evidence / resume

Logs remain under `/tmp/aqlan-statement-*.log`; these contain synthetic test details and are intentionally excluded from the transfer package. Existing print PDF: `.settings-ui-artifacts/patient-statement-current/statement-a4.pdf`. New workflow preview screenshots: `.settings-ui-artifacts/patient-statement-workflow/preview-{390,1280}.png`; first-run full-page screenshots include the synthetic staff ledger background, so they are not patient handouts. No screenshots, operational test DB, logs, .env, dependencies, backups or patient files are packaged.

Node runtime: `/tmp/aqlan-node22/node-v22.23.4-linux-x64/bin`; Chromium: `/usr/bin/chromium`. Disposable PostgreSQL container: `aqlan-statement-test-pg`, localhost55432; harness database is removed after HTTP run. Only task source changes are in the commit/patch; resume on the exact base with `git am task.patch`. Package MANIFEST.json supplies final head/tree and complete file list.

## Local sequential-batch continuation — 2026-10-26

The saved patch was restored on its exact base and its tree verified as
`9302566db4ae4faa64c9b527981e55d98ab74505`. The repaired source is preserved on
`local/patient-statements-completion` at `60666eab43a30fbaf152426420e76bb04830252b`
(tree `f3d7c417ee57235db5842bc4aa804d11f06e11e8`). It was composed without conflicts
onto the sequential batch base `c9313ba7349a9e2615ba47b33483d5a92db33a92` in the
same separate worktree; the master batch was not modified by this task.

Additional repairs and regression evidence:

- Use the configured clinic timezone, preserve stored date-only opening dates,
  and include an opening history's original `beforeAsOfDate` in period movements.
- Verify legacy `invoice.correct` structured audit relationships alongside the
  modern correction table. Do not infer corrections from notes. Same-currency
  replacements retain their printed document date but become effective only on
  their recorded correction date; conflicting lineage fails closed.
- Purge treatment labels/selections and recipient information after authority
  failures, including non-JSON 401/403 statement responses. Hide cached treatment
  choices during authority refresh. Close populated print windows on invalidation,
  filter change or unmount, and revalidate after print resources load.
- Reject period requests carrying a treatment selection rather than silently
  widening their scope.
- Real synthetic PostgreSQL writer regression checks corrected receipts/invoices,
  retained real refunds, internal audit retention, canonical currency totals, and
  before/after-correction historical periods.

Native sharing is a device file-share chooser, not a guaranteed WhatsApp attachment
or recipient selection. The fallback downloads files and opens the reviewed
WhatsApp conversation for manual attachment; it does not send a message or upload
patient data. No message was sent during this task.

Release gates remain explicit: no final build was attempted (limited disk and the
local task's no-build instruction), and no matching built app was available for
browser verification. Actual rendered PDF/PNG readability, RTL/mobile layout and
native-device share acceptance therefore remain **pending**, not passed. CI,
publication, PR, deployment and production verification were not performed; the
owner requested all local tasks be completed before a single batch upload.

A reconciled multi-source agreement may expose canonical progress without a
source schedule list. In that case this patient copy conservatively reports
`غير متاح` for due-now rather than inventing a date or a zero; totals remain
canonical. Unstructured historical corrections cannot be guessed, and malformed
historical facts remain fail-closed. No canonical money writer was modified.

Integrated-source validation (code head `b0fcc5ab`, before this documentation-only
addition): **145/145 focused unit tests in 16 files**, **30/30 synthetic PostgreSQL
tests in 5 files**, and **TypeScript --noEmit --incremental false passed**. This
includes the previously failing timezone/tracing/font groups. The initial new
real-writer regression correctly failed on missing legacy correction evidence;
its final repaired rerun passed. No final gate failures remain among these checks.
The full repository-wide unit/PG suites were not run.
Changed-source ESLint also passed with zero errors and nine existing warnings in
`PatientLedger.tsx` / `lib/db.ts`; no lint rule was weakened. `git diff --check`
passed. Local logs are under `acceptance/statements-integrated-*.log` in the task
workspace and contain synthetic validation only.

Batch-feature composition was additionally exercised through the registered
runtime and current writers: **5/5 PostgreSQL cases passed** (35 unique focused PG
cases overall). A paid invoice is archived using the supported paid-only policy;
a subsequent real refund leaves the archived invoice and its new debt in the
patient statement. A dated service supplement adds only 2,000 to the original
10,000, while the earlier period still contains only the original. Reconciled
agreements in YER/SAR/USD retain 180,000 principal, 12,000 paid and 168,000 remaining
once, preserve completed-treatment debt, and display unavailable due-now when
verified source schedules are absent. These additions are tests only; no archive,
supplement, reconciliation or financial writer was changed.
Final TypeScript and focused lint were rerun after both new composition test files
and passed (exit 0); no new source changes followed those checks.
