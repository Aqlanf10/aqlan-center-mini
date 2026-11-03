# Independent appointments review — 2026-11-03

Scope: successor to immutable PR515 b785d75f320a8c8e948f244cccd05998b611a350 in isolated feat/appointments-completion-astra-20261103. No merge, deployment, real patient access or messaging.

Review corrections requested and implemented during this session:
- Bind pending booking requests to the actual authenticated account ID and username; do not regenerate request identity after an unknown response. Storage failure/malformed recovery must fail closed.
- Keep clinical category separate from appointment purpose and treatment status. Preserve existing 0095 command hashes and provenance semantics.
- Enforce existing explicit HR mapping, roster and approved leave through the shared booking transaction; table locks prevent phantom schedule/leave/block insertion. Check suggested alternative times against the same frozen roster.
- Reject center-hours violations, including duration and buffers, independently from capacity overrides and whether a doctor is selected.
- Revalidate clinical-link authority in the same transaction and explicitly exclude roles without clinical access. Only same-patient reciprocal stored links are displayed.
- Preserve category when replacing a planned appointment and reset staff confirmation on a real time/date move.
- Respect explicitly empty second center shifts and initialize HR presets from current loaded settings.
- Patient category filtering uses parameterized EXISTS before pagination and composes with doctor scope. Multiple appointments do not duplicate patients. Explicit history is disclosed as history, never inferred from notes/service names or asserted as current treatment status. Finance and assistant roles cannot use category membership filtering.

Independent validation already completed:
- Original PR515 migration fixture repairs: 33 unit tests and 50 native PG tests across eight files (three affected files rerun after fixture corrections); broader final validation supersedes these where available.
- Existing quick appointment follow-up and patient search harnesses: 28 + 16 passed after supplying authenticated actor and explicit category.
- Plan visibility:48 passed, including assistant denial and denied purpose authority.
- Admission-isolated booking intent/capacity suggestions:36 passed after prepared-admission mock change; native admission tests are separate, not mocked.
- Exact package-lock dependency installation under Node22.23.3; no package/lock/guard relaxation.
- Native regression of planned rebooking/referral consistency/manual cash/category history/payment shift:5 files,193 passed with explicit synthetic roster and CI disposable-fixture flags.
- Patient-category route81 passed, including8 new access/validation/scope cases. Native category2 passed using32 synthetic patients, historical duplicate appointments, cross-doctor isolation, search composition and pagination.

Interim full-suite runs while the source was changing are not exact-final-head evidence. Final unit/PostgreSQL/type/lint/browser/CI results must be recorded against the final frozen head.

External candidate: Library libfile_e22c6d7f4b84819188139c2fa534d459 v2 was resolved, but the supported materialization helper could not download through a proxy403. No bytes were obtained or incorporated and the earlier claimed67 tests were not reproduced. No verified Gemini-specific patch was identified.
