# Leadership completion review

Base: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f`, verified against fetched `origin/main` before branching. Local branch: `feat/leadership-source-completion`.

The initial environment was older (`2667b71f`); no feature changes were made there. The work is limited to the leadership surface, dedicated read projections, documentation and their verification. The clinic shell, IBM Plex Arabic, RTL, financial engines, permission policy, visit/lab workflows and schema remain outside the change.

## What existed and what changed

| Owner question | Existing behavior | Completion |
| --- | --- | --- |
| What needs attention today? | Four visit/lab cards, separate day/lab/task readers | Individual scope on cards, separate appointment/no-show/cancelled strip, current source state and appropriate original-record action |
| What does a card open? | Review day and lab filter were lost | Selected day carries into reviews; received and overdue lab cards open the corresponding filter |
| What treatment remains? | No all-active-plan overview | Exact all-date active plans and pending item counts, distinct patients, 10-row stable pages; active plans with no pending item remain explicit |
| How are doctors performing? | No leadership view | Lazy existing provider report: visits, appointments, valid chair duration, production and attributed collection; no live presence, payroll, commissions or invented utilization |
| What is scheduled or stopped? | Existing reporting sources available elsewhere | Lazy unscheduled-treatment subset and plans-started-in-period views; source limitations and dates are visible |
| Who owns the follow-up? | Assignee/event actor separated, but own-private tasks were summarized | Shared tasks only in rows/counts; every private task stays in HR. Lab linked-task summaries are withheld because their source does not label privacy per row |
| Can the financial figures be trusted after changing period/user? | Unvalidated cast, no timeout/abort, no shared 401/403 handling | Strict matching-period/native-currency decoder, abort/timeout, synchronous stale-value clearing, range validation, source receipt time, global hub refusal handling, exact-source CSV details |
| Can it be read on a phone? | Scoped card layout with teal emphasis | Existing clinic navy/orange, wrapping tracks, native controls, distinct evidence strips, source-specific progressive detail |

The all-current care projection is read-only. It counts `planned`/`in_progress` items in active plans, excluding completed/cancelled items and stopped/completed plans. It does not infer session count, overdue treatment, a staff assignee or patient debt. The separate unscheduled report is narrower: any booked appointment today or later excludes the patient, even if for other work.

## Verification and evidence

All fixtures are synthetic. Test execution uses the isolated local PostgreSQL 18.6 service, Node 22.23.3/npm 11.21.0 and the preinstalled Chromium 151 through Playwright. No deployed clinic database or external patient media was used.

- Environment contract: passed.
- Focused unit/SSR/routes: 141 tests passed across 13 files, including currency/date failures, invalid range, timeout, stale reply, current versus superseded permission denial, shared-only privacy, plan counts and canonical links.
- PostgreSQL pulse/operations: 26 tests passed. A 20,000-task / 100,000-event fixture returns 10 rows in one SELECT (36ms measured locally).
- PostgreSQL care: 3 tests passed. A 20,000-plan / 100,000-item fixture returns 10 rows in one SELECT (129ms measured locally). Covers exact pagination beyond 300, booked patients retained in all-current care, terminal-state exclusion and unchanged source records.
- Full lint: passed with 0 errors and 209 existing repository warnings. Scoped changed-file lint passed with 0 errors/warnings before the final test-timeout/documentation edits.
- Production build including TypeScript: passed. The existing dynamic filesystem tracing warning in `lib/migration-files.ts` remains.
- Actual Chromium browser journeys: 9 tests passed across 3 files. Coverage includes 1440px/390px, 200% font size, keyboard targets, slow independent sources, source failures, permission refusal, account replacement, private-task exclusion, deferred sources and selected day/filter retention. The initial loading assertion allows the existing 20-second reader timeout plus rendering time.
- Earlier browser failures were resolved: overlapping CSV link target, outdated conflict-message assertion, duplicate route-announcer selector and an initial cold-read assertion timeout. No failures remain in the final focused run.
- The full repository test suite, cross-browser/screen-reader checks and remote CI were not run; no broader readiness claim is made.

Actual browser evidence lives in `/tmp/leadership-hub-evidence`. The populated desktop/mobile, care mobile/200% and finance desktop screenshots were visually inspected. The final populated journey recorded ready times of 1077ms (1440px) and 769ms (390px), three initial requests and no horizontal overflow at 390px/200%. These are local synthetic measurements, not production promises. Only explicit synthetic screenshot filenames are allowlisted in the existing CI upload step. No cookies, storage state, HAR, database dumps or broad directories are added to publication. Additional operational/lab journeys retain their existing synthetic artifact locations.

## Remaining boundaries and coordination

1. The shared lab-backlog DTO can contain the signed-in owner's private linked tasks without a privacy marker. The hub therefore shows none of those linked-task titles/assignees/counts. Changing that server contract belongs with the concurrent lab/permissions work. Shared task accountability remains available from the dedicated shared-only source.
2. The legacy financial endpoint authorizes before its read, but lacks a post-read principal recheck and explicit private/no-store response header. This is a concrete coordination item for the finance/permissions owners; this branch does not alter their central route or calculation engine. The leadership client now clears values on scope/principal change and 401/403 and does not cache financial reads.
3. Optional existing report readers return full results. They remain user-opened only, without polling or per-doctor fan-out; the new current-care source has exact bounded pagination. There is no invented current workforce denominator, doctor presence, accepted follow-up SLA, or causal blame for lab delay.
4. Financial presets use the application's current clinic fallback calendar (Asia/Aden). Supporting a runtime clinic timezone override for the standalone privileged-doctor financial surface needs timezone metadata from its existing server contract; receipt times are explicitly UTC.
5. This work provides no financial writes, outbound messages, migrations, AI/Dot features, merge or deployment.

Publication is paused by the parent task's later instruction pending explicit permission for the public repository. No branch push or PR creation was attempted. Remote CI cannot run for this local head before publication. At the parent's subsequent usage-budget instruction, active development stops after local commits and a private recovery package; further implementation and verification require a resumed task.
