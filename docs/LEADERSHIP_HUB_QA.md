# Leadership hub validation record

Scope: isolated read-only leadership hub on PR #472's exact base commit `b0a0578361a31eb854ed9e64caaa2c5ba41ea080`. No hosted/staging/production verification is implied by local checks.

## Foundation evidence (commit 47181cc8), 2026-10-25 UTC

- Environment: independently copied project dependencies; Node 22.23.3, npm 10.9.9, PostgreSQL 18.6, clinic zone Asia/Aden. `npm run verify:environment` passed. Test commands received only local synthetic database/auth settings.
- Full unit command `npm test`: 11,949 passed; two tests failed because unchanged `verify-ci-orchestrator.test.ts` spawns the tsx CLI, whose Unix IPC listen is denied with EPERM in this workspace. The restriction was not bypassed and those tests were not weakened.
- That full run also had one failed setup in `preflight-artifact.test.ts` and its 11 cases were therefore skipped: the original dependency symlink resolved outside the hermetic project root. After replacing only this checkout's symlink with a local dependency copy, all 11 preflight cases passed. There are no unexplained skipped cases from that run.
- Targeted rerun: `vitest run __tests__/preflight-artifact.test.ts __tests__/leadership-pulse.test.ts __tests__/leadership-read-ui.test.tsx __tests__/leadership-operations-route.test.ts __tests__/lab-backlog-route.test.ts __tests__/journal-review-ui.test.tsx` passed 91/91. Includes source failures, session change, privacy transport, date scope, future-arrival unknown age, midnight Today refresh, explicit day/page retention, timeout, stale-response rejection and no polling.
- PostgreSQL: `vitest run --config vitest.config.postgres.mts __tests__/postgres/leadership-pulse.test.ts` passed 5/5. Includes clinic-midnight boundaries; 321 old overdue tasks beyond a 300-row cap; own versus other private visibility in totals; assignee versus latest actor; null due; terminal exclusions; source-record read purity.
- Scale fixture: 20,000 open tasks and 100,000 events, actual query count **1**, returned enriched rows **10**, elapsed reader time **14 ms**. This is a local synthetic observation, not a Production latency promise.
- Strict scoped UI audit using the existing `docs/leadership-operational-ui-audit.json`: zero findings. This does not certify application-wide accessibility or replace browser verification.
- At the foundation commit, the financial page extraction was compared with the base: only imports/wrapper/header and moving operational/lab content changed. The fresh presentation below subsequently replaces that visual layout, while retaining calculation, endpoint, currency, range and export invariants.

- Final `npm run typecheck` passed after Next generated route types.
- Final `npm run lint` passed with zero errors and 209 warnings in unchanged files. The test scheduler was separated from its pure hook harness rather than disabling hook rules; its final six-test rerun also passed.
- Final `npm run build` passed, including TypeScript, route generation and standalone output (compile 8.4 s; TypeScript 59 s). One earlier unchanged build attempt compiled but its TypeScript worker ended without a diagnostic; direct typecheck and the complete retry passed. No build/typecheck gate was skipped.
- `git diff --check` passed. Production source hashes were rechecked against the reviewed freeze.

Hosted UI acceptance remains pending; build time is not browser first-paint evidence.

## Hosted acceptance required before rollout

`__tests__/security-http/leadership-hub-ui-journey.test.ts` uses an owned synthetic clinic and the real built app. It verifies:

- Populated, empty and failed-source cards at 1440px and 390px, RTL overflow and native keyboard activation.
- Exactly two pulse reads and one lab backlog read on initial overview, with no initial finance, attendance or inventory fetch.
- Role denial, exclusion of another user's private task, real assignee separated from last actor, and original-record destinations.
- Changing the selected day does not filter current laboratory backlog; finance is requested only after opening it.
- Unknown rather than zero for failed sources; any session-denied new reader removes the whole hub subtree.
- No workflow writes and no change to source fixture records.

The explicit `leadership-hub-ui` artifact contains twenty synthetic viewport screenshots: overview metrics, representative day/lab/task records, empty/error states and four freshly designed financial views at both widths, alongside first-contentful-paint, layout-shift, content-ready, API-read timing and scoped 200%-text reflow measurements. It excludes auth state, cookies, logs, broad directories and real clinic records. Overview populated state comes from the owned database; empty/error states and the separately typed financial visual fixture use explicitly synthetic transport responses. The financial visual fixture is not a claim about real clinic balances or end-to-end ledger verification.

The existing operational and lab browser journeys are retained and adjusted only to open the corresponding hub section. Full hosted CI, screenshot review and timing review are still required. Local Chromium restrictions are not bypassed. No browser-performance result or screenshot is claimed before those checks execute successfully.


## Fresh presentation and project-local skill follow-up

The subsequent owner direction requested a coherent fresh interface plus a tailored project skill. `docs/skills/clinic-leadership/SKILL.md` validates with the skill validator and is applied to finance, laboratory and operational presentation. It changes no global assistant settings.

- Source-supported: the financial load callback, range-selection callback and CSV endpoint remain unchanged; the financial aggregation/domain files are not edited. Lab and operational read lifecycles also remain byte-identical to the reviewed foundation.
- Applied presentation: four local financial views avoid duplicate default cards/tables, retain independent currencies, separate current party balance from period-end patient receivables, and do not turn zero-capacity occupancy into a 0% performance claim. Laboratory and operational review use the same card, status, button and spacing family.
- Applied accountability: existing treating-doctor, assigned-staff, latest-actor and unknown-due distinctions are retained with the same exact readers and privacy scope.
- Automated evidence: 83 targeted finance/domain/operational/lab/hook tests pass, including a rerun after the shared financial fixture extraction. Post-edit typecheck and the final production build pass; targeted TypeScript/TSX lint has zero errors and zero warnings. The scoped strict UI audit has zero findings, and the project-local skill validator passes. The earlier PostgreSQL projection source is unchanged, so its five-case and scale-fixture evidence still applies to those readers.
- Still pending: hosted screenshots and manual visual acceptance of every refreshed view, actual first-paint/layout observations, keyboard/narrow layout journey, and full hosted CI. No new browser claim is made from source inspection.

## Viewport evidence correction (local review)

Tall element screenshots were replaced with normal 1440×960 / 390×960 page viewport frames. Native wheel input uses the checked main-content gutter. Before each frame, its representative slice must fit between actual sticky/fixed shell bars and pass nine-point hit checks. Visible controls and financial record cards/facts are checked individually for reachability, without requiring the whole dashboard to fit a screen. No app CSS, DOM scrolling, hidden chrome, or enlarged viewport is used to stage a screenshot. The separate existing 200%-text reflow probe is reset before subsequent captures. All original source/privacy/no-write/first-paint assertions remain. This is a test correction, not proof of a reproduced application defect. Hosted execution and pixel review remain pending.
