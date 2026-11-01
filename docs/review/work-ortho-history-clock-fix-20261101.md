# Orthodontic saved-history dates — clinic-zone follow-up

The assessment history dropdown and strategy history/selected revision still truncated stored UTC instants after the parent coverage fix. Two actual-render witnesses failed on base `c65faea5`: `2026-10-31T22:30:00.000Z` appeared as October 31 instead of November 1 in Asia/Aden. The correction passes the already validated server clinic zone from the canonical case detail through its wrappers to the existing shared widgets and existing `formatClinicDate` formatter. The selected strategy retains the exact original `datetime` value.

No server reader, authority rule, writer, SQL, persisted result, formula, immutable history, migration or calendar-date field changes. Shared legacy callers that do not yet provide a server clinic zone retain their prior label behavior; this is not a claim that all legacy/application date labels are corrected. The original full assessment ISO timestamp remains an explicit instant.

| Gate | Actual evidence |
|---|---|
| Causal render witness | Original two failed; expanded six pass for Aden, New York and legacy callers without a zone. |
| Focused unit and source guards | 47 passed in five files, including existing shared UI admission and strategy tests plus map/inventory guards. |
| PostgreSQL regression | 80 passed in three files: canonical assessment, canonical strategy and legacy assessment/strategy union. No skipped cases. |
| Built HTTP and Chromium | 21 passed in three files on build `Chpd2GcxS6DtKukI0zRmm`: both canonical readers plus the existing legacy editor journeys at 390px/1280px, saves/reopens and lost-response recovery. Added tests use an America/Los_Angeles device and verify the clinic date after refresh and older-revision selection. |
| Type/build/lint | Passed. Targeted lint has zero errors and one unchanged shared-widget effect warning. |
| Remaining gates | Final-build runtime provenance, final full unit, combined full PG, exact-head CI and independent review are tracked separately. No unrun gate is a pass. |

Synthetic fixtures insert their explicit timestamps at creation; no immutable stored revision is updated to obtain the witness. Evidence and SHA256s are in `evidence/work-ortho-history-clock-20261101/manifest.json`. The separate coverage fix `0937e9aa` remains in the preserved history. No main merge, deployment or live change. This follow-up does not count another converted route.
