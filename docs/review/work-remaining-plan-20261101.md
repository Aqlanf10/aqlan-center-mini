# Remaining WORK plan — measured checkpoint, 2026-11-01

This is an **initial execution grouping**, not an approved final number of slices or a release forecast. The governing plan remains [HANDOFF §2, §5 and §7](../security/staff-cutover/HANDOFF.md) and [CONTRACT's bounded execution order](../security/staff-cutover/CONTRACT.md). Dependencies and discovered failures can split or combine contracts. A route/method is not a slice, and a source-map status is not acceptance.

## Verified checkpoint

- Claude handoff `1ccb30c2`: 41 `canonical-done`, 303 `existing` in the map; the recorded sequence reached slice25, with preparatory shift readers already present. The earlier numbered table has gaps, so “25” is not asserted to be the count of completed independent deliverables.
- Published `a7af0bde`: 53 `canonical-done`, 291 `existing`; all four jobs of [CI 41258775996](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/41258775996) succeeded.
- Published `e718e9f7`: 55 `canonical-done`, 289 `existing`; [CI 41265345671](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/41265345671) is in progress at this checkpoint. Slice35 and slice36 each passed their documented local gates. Their CI is not the older a7 run.
- Astra continuation implemented eleven numbered slices, 26–36, now all published. Five, 26–30, have recorded independent technical acceptance. Source review of 32–34 was conditional on final CI and did not cover the broad tooling transfer. Later acceptance remains separate. Slice37 is additional local work, not part of e718.
- `344 = canonical-done + existing`: the ordinary route/method conversion subset. The full map has 383 entries including 20 owner-only, 4 entry, 3 self and 12 excluded entries. The wider inventory has 416 explicit HTTP methods and 97 pages. These are different inventories, not interchangeable completion denominators.

## Proposed execution groups within M2

| Order | Coherent group | What closes the group |
|---|---|---|
| 1 | Remaining ortho / ceph / treatment plans | Scoped reads followed by bounded writers; immutable historical-source rules, independent care/image/finance authority, actual booking lineage, signed-visit rules and retry recovery. Slice37 is the follow-up read; it does not finish the group. |
| 2 | Laboratory work and laboratory directory | Authorized order lifecycle and delayed-work workflows, independent price/financial visibility, provider/patient scope, atomic audit and concurrency. |
| 3 | Remaining clinical and patient workflows | Patient/document/visit/case/referral/family workflows, real owner/doctor/reception paths, privacy projections, signed-state boundaries and existing data compatibility. Prescription work requires coordination with the separately owned Rx branch. |
| 4 | Financial workflows | Invoices, collections/refunds, expenses/payables, reconciliations and reports; unchanged currencies/balances, treasury and open-shift rules, atomic effects/audit, replay with fresh authority and proven ambiguous-outcome recovery. This is not estimated using read-only slice speed. |
| 5 | HR, accounts and centralized settings | Independently scoped staff/payroll/settings operations; permission and account changes revoke the correct sessions, protect owner identity, and never manufacture mappings or grants. Existing accepted account work must not be repeated. |
| 6 | Remaining operational routes and full workflow closure | Tasks, messages, inventory/service setup, audit and residual journeys. Outbound effects need a separate durable-effect contract before dispatch; no future AI/Dot scope. Cross-cutting D1 initialization fencing and login/session-security work are reconciled with the existing designs. |

Each group is split into reviewable contracts, with separate commits, before/after reproduction where applicable, actual PostgreSQL and built HTTP/browser evidence, failure/revocation/concurrency cases, legacy witnesses, map/inventory hashes, exact-head CI and independent review. No fixed slice total exists yet. These groups are not a promise to migrate one route at a time or to treat a multi-action route as complete from one passing branch.

## After M2 and external dependencies

HANDOFF §5.4 contains five headings. Its account-write implementation is already recorded under §5.5; the four deferred headings are coordinated main integration, M3b's 69 inventory/procurement acceptance scenarios, M4 schema registration and synthetic upgrade/restore/rollback rehearsal, and M5 cutover/rollback/maintenance planning. B2, R5, D1 and session-security dependencies overlap these stages and cannot honestly be summed as independent completed/remaining checkboxes.

The latest parent instruction authorizes conservative main reconciliation on WORK after the current exact-head CI, without merging WORK into main or deploying. New migrations and live changes remain outside this read batch. Migration numbers 0090–0093 remain reserved for the coordinated Rx path; this continuation allocated none. See the separate reconciliation intake for the 35 concrete conflicts. The clinic maintenance date and actual owner workflow acceptance remain operational decisions.

## Time estimate and blockers

At the e718 publication checkpoint, the current 35–36 delivery was estimated at **2–4 hours to complete exact-head CI**, conditional on no new failure; independent review scheduling is separate. Recent bounded read contracts took roughly 15–65 minutes of implementation/local verification in the commit record, but this excludes review, dependency repair and complete CI. The a7 run itself took substantially longer than a focused local suite. That rate must not be extrapolated to financial writers, concurrency protocols or full deployment readiness.

There is no defensible whole-plan finish date yet and no evidence for a same-day completion promise. The smallest estimable stage is the current published batch's CI and review, while independent local contracts continue.

- Actual WORK Docker proof is blocked: `apk add --no-cache su-exec` received HTTP403 for both Alpine v3.24 main/community `APKINDEX.tar.gz`; build exited 1 with no final image. A single diagnostic HEAD after the parent's new verification instruction returned curl56: CONNECT tunnel failed, HTTP403, server envoy. This establishes a proxy tunnel refusal before reaching the repository; it does not establish that su-exec is absent. No apk/build retry, alternate mirror or destination bypass was attempted. PR 501's image evidence is not WORK image evidence.
- Draft publication is **resolved**: [PR 506](https://github.com/Aqlanf10/aqlan-center-mini/pull/506) was created through the same connector after new direct user authorization. It remains draft and has no formal approval or merge authorization.
- Full a7 HTTP logs could not be downloaded: the GitHub connector failed, then the ordinary read-only `gh` log download returned Forbidden from the Actions results receiver. No further log route was attempted. Terminal job metadata confirms HTTP success; no unverified CI HTTP test count is invented.
- Actual Arabic speech quality on the clinic display device remains unverified. Synthetic browser voice-management tests do not establish acoustic quality.
