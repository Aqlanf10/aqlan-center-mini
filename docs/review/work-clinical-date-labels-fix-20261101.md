# Canonical clinical date labels — extension of the proven midnight defect

Base combined local source `f7ef90b7`, including slices 53–55 and the separate coverage fix `0937e9aa`. This correction is not a new route-conversion slice.

The coverage review prompted a bounded source audit of canonical patient components. Seven actual component witnesses failed: at 2026-10-31T22:30:00Z they showed 31 October instead of 1 November in Asia/Aden. The exact seven witnesses passed after the correction, then expanded to fourteen cases covering an alternate configured clinic zone. The original witness source and failed log are retained.

The existing clinic formatter now renders orthodontic closure, specialty completion, problem registration, plan creation/consent/item completion, cephalometric registration/approval/diagnosis, discard confirmation and comparison fallback labels. Four canonical read families carry the server-resolved clinic zone; validators reject missing or invalid zones. The comparison uses the zone of its current server-projected parent list. Calendar business dates (xray, treatment start, retainer delivery and adjustment day) remain literal. No stored instant, source ordering, historical clinical value, query, authority check, command, financial rule or migration changed; eighteen source checks establish those boundaries.

| Acceptance | Observed result |
|---|---|
| Original component witnesses | 7 failed before; the exact 7 passed after. |
| Expanded unit, projections and map/inventory guards | 120 tests passed in seven files, including fourteen component cases and sixteen invalid-zone refusals. |
| PostgreSQL read/scope/source/lifecycle regressions | 226 tests passed in eight files. Existing exact field allowlists retain every restriction and add only clinicTimeZone. |
| Built HTTP / Chromium | First run: 95 passed and 3 failed in 98 tests across nine files. Two failures were old exact root-key expectations; one synthetic fixture violated the existing clinical case status/timestamp constraint. Corrected only those expectations and the fixture's legitimate completed state, retaining the constraint. The affected two files then passed all 21 tests. Together the runs cover all 98 distinct cases; this is not a claim that the initial 98-test run passed. |
| Device clock and refresh | Stored midnight instants display the clinic day on a browser in America/Los_Angeles; refresh remains correct. An invalid ortho detail zone clears the old display. All existing permission, revocation, delayed response, clinical editor, discard and coverage browser journeys remain covered. |
| Build and quality | Build z9dm33uOCMXzi0KHgP5Ay, typecheck, lint with 0 errors / 345 existing warnings, body/environment/money/preflight passed. The first typecheck caught four old typed fixture envelopes missing the new zone; the corrected typecheck passed. Final build typechecks the expanded tests. |

The build product source stayed unchanged during the HTTP fixture corrections; before/after source hashes are recorded. Full combined suites, runtime provenance, exact-head CI and independent review remain separate gates. Inventory was regenerated and remains NOT_READY; no conversion count changes. No main merge, deployment or live mutation.

Integration update: the final combined source and separately pinned full-suite/runtime gates are recorded in [batch 53–55 evidence](work-clinical-batch53-55-20261101.md). This preserves the original per-slice chronology above; final-head CI and independent review remain separate.
