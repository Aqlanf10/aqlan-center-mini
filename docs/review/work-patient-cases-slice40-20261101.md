# Slice 40 — bounded clinical cases and plan dependency read

Base: `8e12f9591ebd0aafc578587b4d6c3e5e657eee6f`, same WORK branch. Implemented and verified locally; publication, final batch CI and independent review remain separate. This is the read prerequisite of a case-link/dependency batch, not completion of the case or plan modules.

## Contract and acceptance matrix

| Requirement | Implementation | Evidence |
|---|---|---|
| A valid canonical clinical reader must reach the route | Canonical envelope selected once, no legacy fallback; existing `read:patients.clinical` care group and patient scope | Built baseline returned 401 instead of 200; final real HTTP returns 200 |
| Separate clinical, plan and ortho authority | Cases/problems use the existing care group; items/edges need `clinical.plans.view`; native/bridged ortho needs `clinical.ortho.view` independently | PG own/all/none, unlinked, care-only, finance/appointment-only and ortho-only cases; HTTP/browser boundaries |
| One coherent, bounded read | Owning fenced RR READ ONLY snapshot; 1000 cases, 1000 problems, 2000 items, 4000 edges, 2 MiB; excess refuses instead of truncating a graph | Native PG limits, concurrent commit, no initialization/pool escape/financial reads, intermediate error |
| No foreign clinical reference | Same-patient case, bridge, native plan, problem and both dependency endpoints; unknown stored states/cycles reject | Native PG corrupted synthetic associations, exact projection validation |
| Clinical graph remains truthful | Explicit cancelled-plan endpoints; recorded status and existing `isDependencyMet`, no invented progress, no finance-derived flags | Native PG cancelled plan and clearance; pure negative graph tests |
| Revocation and stale presentation | Fresh server proof; waiting-session expiry, revoked grant/scope/credentials; UI clears on refresh failure, closes or rejects delayed/invalid payload | PG and real HTTP/Chromium journeys, synthetic 390px screenshot |
| Preserve existing workflows | Legacy GET tail and POST byte-identical; database/writer engines and old case workspace untouched | 13 source preservation witnesses and existing specialty/clinical-plan PG regressions |

The central care group remains `clinical.plans.view`, `clinical.visits.document`, or `clinical.xrays.view`. An ortho-only grant keeps its separately admitted ortho entrance; it does not manufacture access to the general care record. Hidden ortho case links are omitted from general item/problem projections. No prices, billing flags, invoice/agreement metadata, photos, or medical assessment payload enter this reader, including for the owner. This clinical screen does not attest financial coverage or commissions.

The existing legacy case writer, plan-item case writer and dependency writers are **not** activated by this slice. No migration, permission document, production setting or historical clinical value changes. The next bounded contracts are case linking/priority and dependency add/remove, retaining the historical billed-source guard and an explicit ambiguous-response recovery workflow.

## Actual local validation

- Native PostgreSQL 18.6: **70/70**, three files; **35** new reader cases plus existing specialty-case and clinical-plan regressions.
- Built HTTP/Chromium: **11/11**, one file. Build `M4w9eIjy-wThb6RFv7ToG`, Chromium 151, synthetic data only.
- Unit: **22/22**, two files; typecheck, focused ESLint and production build passed. Route-map/readiness guard results are archived separately.
- **13** preservation checks and **436** historical source hashes verified against their own pinned revisions. The preceding CI-test evidence is now pinned to `8e12f959`; old evidence was not rehashed against new source.
- Screenshot `evidence/work-patient-cases-20261101/patient-cases-390.png` was visually inspected: readable RTL layout and dependency labels without horizontal overflow or financial values.

Failures retained: the initial HTTP command used a nonexistent config and ran no tests; the corrected baseline test failed 401→200 as intended. First PG attempt had 27 passes/one witness failure because clearing only the primary doctor correctly retained access through case/item responsibility. The witness now clears both primary-doctor and case-responsibility scope witnesses in the concurrent transaction, together with the associated item doctor (the latter is not itself a scope witness). The second PG attempt had 69 passes/one fixture failure: the native case-status CHECK correctly rejected an impossible synthetic state. The final test proves that rejection and unchanged record instead of weakening the constraint. No failed attempt is labelled a pass.

Full-unit/complete-PG/full-HTTP CI for this new slice has not yet run; focused success is not release acceptance. The published base `8e12f959` is independently under CI runs 41276862847 / 41276866882. Old `93b54b12` CI ended with PostgreSQL failure, HTTP cancellation and failed aggregate; its HTTP was never marked passed. Docker/Alpine's enforced HTTP403 and actual clinic speech-device validation remain separate existing blockers/limits. No deployment or live activation.
