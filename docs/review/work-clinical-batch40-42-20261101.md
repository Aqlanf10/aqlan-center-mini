# Clinical graph batch 40–42 — local acceptance and publication handoff

Product source: `fff3e57efe9a6371c37757e73be039c2d89f52ea`. Separable commits: slice 40 `15bacdb7a0b4de242b928545b72eb480b0212c39`, slice 41 `b21b151c504128f853f58059ddd3cf689e7f125b`, slice 42 `fff3e57efe9a6371c37757e73be039c2d89f52ea`. Destination remains WORK, Draft [506](https://github.com/Aqlanf10/aqlan-center-mini/pull/506). No release or canonical activation.

The connected batch provides the scoped clinical case/problem/plan graph, case-link and priority edits, and dependency add/remove. Independent grants, current patient scope, same-patient references, financial attribution guards, graph cycle rules, atomic audit and uncertain-response recovery are detailed in the individual [40](work-patient-cases-slice40-20261101.md), [41](work-plan-case-slice41-20261101.md) and [42](work-plan-dependency-slice42-20261101.md) acceptance matrices. The client never automatically replays these commands. No durable request receipt is claimed.

## Final local gates

| Gate | Actual result |
|---|---|
| Full units | 14,329 / 14,329 in 850 files |
| Full PostgreSQL 18.6 | 5,045 / 5,045 in 393 files; zero skipped |
| Focused PostgreSQL batch | 107 / 107 in five files |
| Built HTTP/Chromium | 37 / 37 in three files |
| Focused unit and map guards | 56 / 56 in five files |
| Typecheck / production build / preflight | Passed; build `eVAs967ymX9nktdV8mD9y` |
| Full lint | Zero errors; 345 existing warnings |
| Environment / money / raw-body guards | Passed |
| Runtime braces | 9,956 shipped/provenance files, 372 traces |
| Runtime lint-tooling | 741 traces, 86 manifests; only available maps, no opaque-code absence claim |

The same package/lock and reviewed tooling from the main integration remain unchanged. Exact-head hosted CI must still run its own audit, full HTTP/browser, schema/operational and synthetic print gates; earlier CI is not relabeled as this batch's result. Runtime proof JSON is archived losslessly as gzip and hash-bound in the manifest.

## Failures and isolation record

The first full unit attempt passed 14,323 and failed six: five lacked the synthetic SESSION_SECRET in the local command, and one existing development-runtime tracing test exceeded its time limit. The missing-secret error was independently reproduced and corrected only in the invocation; the unchanged tracing group passed 5/5. The final full suite passed all 14,329 without code/threshold changes.

The first full PG attempt was deliberately interrupted (exit 130) after a next-slice legacy fixture touched the same synthetic public schema. It is not a passing run. Continuation work moved to a separate PostgreSQL 18.6 server on localhost:55438, and this complete clean rerun used 55437 with the two existing disposable-fixture flags. These servers contain synthetic data only. No live cleanup or schema bypass occurred.

## Earlier integration acceptance and remaining blockers

Both workflows for published `8e12f959` passed all five jobs: [PR 41276866882](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/41276866882) and [push 41276862847](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/41276862847). The parent independently accepted the bounded finance conflict, immutable migration union, reschedule race witness, backup/restore and settings boundaries. That is not independent acceptance of all 35 conflict files. No unresolved Git conflict remains. The attached review ledger preserves the unconfirmed login/layout, lab UI/print, inventory UI, schema/test and other shared-file sections; passing CI does not replace that source review.

Local actual WORK Docker build remains denied at Alpine v3.24 APKINDEX CONNECT HTTP403 before TLS. No mirror, retry, security change or alternate transport was used. A proposed WORK-only isolated CI image build exists outside the repository; HANDOFF §1.5 requires coordination before enabling a new CI workflow. PR 501 image evidence is not WORK image evidence. Schema convergence still has 16 open findings; M4 is not complete. No migrations allocated; 0090–0093 remain reserved for coordinated Rx work.

This delivery advances the source map to 63 canonical-done / 281 existing ordinary methods, with inventory NOT_READY. These are conversion states, not a system completion percentage. Slice 43 is independently prepared in a later local commit and is not covered by this full-suite result. Publication, new exact-head CI and independent review are the next gates; no whole-plan completion or same-day promise is made.
