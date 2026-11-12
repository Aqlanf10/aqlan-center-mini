# Interim Claude continuation checkpoint — 2026-11-09

## Ownership and exact source

- Reference: draft PR #506 (`feat/work-recovery-followup-20261027`) at `8586f991d95b6456e2b58574a33add3418b93702` on inspection, not an assumption that it never moves.
- Independent continuation branch: `feat/claude-interim-plan-item-scope-20261109`. No commit on Claude's source branch, Dot's branch, `main`, or any deployment branch.
- Existing `main` moved to `c6c886121bcc50aa548f64b0b0fbd7b5beb1f324`; this continuation does not silently merge or replay that source.
- Scope here is a single reproduced, reviewable security defect from Dot's PR #506 comment of 2026-11-05: item-ID financial lineage was queried before constraining it to the authorized plan.

## Implemented

1. `lib/db.ts`: `removePlanItemOn` now constrains the financial-lineage check by **both** `itemId` and `planId` after the plan/patient authorization lock. Keeps the existing financial-lineage policy and transaction/atomic audit path intact.
2. `__tests__/postgres/plan-items-canonical.test.ts`: a new synthetic-data integration regression compares out-of-plan billed and unbilled item IDs with a nonexistent ID. It also checks that an in-scope financially linked item remains protected, an ordinary in-scope item remains removable, a foreign plan is denied, and missing capability is denied. Test invoices are `SYN-PI-SCOPE-*`, without receipts, live accounts or external providers.
3. No migration, configuration, access grant, service URL, workflow, deployment or patient asset changed.

## Evidence and test status

- Source-verified SQL binding: `WHERE i.id = $1 AND i.plan_id = $2`, args `[itemId, planId]`.
- Initial reference head `8586f991` previously had a successful GitHub Actions CI run: https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/42407639303 . This **does not** validate the new commits.
- Exact new test-head CI: https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/42527247387 . **FAILED BEFORE TEST EXECUTION**: quality, PostgreSQL and print jobs reported failure within seconds, with zero job steps and unavailable job-log blob; built-app HTTP/browser was skipped. Earlier push and branch-creation runs exhibited the same startup failure. Cause not proven. Do not attribute the failure to the code or call it a passing build.
- No real PostgreSQL, TypeScript/full lint, build, HTTP, browser or Playwright execution was possible in the current isolated local environment. No local Git checkout or node_modules; direct GitHub connector operations only. The source structure was checked against the remote head.
- Tests must be rerun on a clean ephemeral PostgreSQL instance, with full required gates and an independent review before any acceptance. Do not weaken any CI threshold.
- No untracked local files exist in this connector-only workflow. Only the two intended source/test paths and this documentation file were submitted. Both modified paths are program source or synthetic tests; no patient files, image identifiers, account records or secrets intentionally included. Do not interpret this as an audit of all pre-existing repository history.

## Non-overlap and integration hold

- Dot owns orthodonics/cephalometry, including separate draft PR #530 (review/ortho-ceph-current-source-20261107). Her PR modifies `lib/db.ts` and `.github/workflows/ci.yml`. This continuation touches **only** `lib/db.ts` of those paths; coordinate a bounded hunk review before carrying the fix into Dot's integration. Do not overwrite or import Dot's branch.
- Separate known ceph-complete contract difference: canonical `expectedVersion` versus Dot's `expectedSnapshot` + `expectedSources`. It is held for owner-mediated coordination; not fixed here.
- Prescription candidates (#519, #520, #523) and appointment candidate (#522) are independent and not replayed. Existing lab canonical slices 66–71 and finance/plan slices through 94e need exact-head tests and source reconciliation.
- No new PR: cannot yet certify that opening one will not initiate a preview connected to real data. No merge, staging, production, Railway or live DB access.

## Next bounded work

- Diagnose GitHub Actions jobs failing before any steps; restore a legitimate clean CI runner without changing security policy.
- Run the new PostgreSQL test with PostgreSQL 18 (expect a baseline failure without the fix), plus neighboring plan/finance permission and HTTP-security suites, typecheck, lint, unit, print, production build and relevant browser tests.
- Review exact-head PR #506 and present main/Dot/Rx/appointments branches for source conflicts, especially the `lib/db.ts` hunks, before cross-branch integration.
- Resume independent lab, finance, appointments, permission and governance defects once actionable tests and owners are established; clinical release gates and owner sign-off stay separate.
