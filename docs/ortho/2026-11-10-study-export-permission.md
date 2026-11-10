# Independent saved-study export permission — 2026-11-10

Base: `74421ee07a621c00874ca4823ec7623f56afeba5`, branch `feat/ortho-reconcile-20261109`. This is a bounded permission and verification slice, not full orthodontic acceptance.

## Existing behavior and change

Saved case studies, source snapshots, image previews and four text/illustrated PPTX/print outputs already existed. Output authorization reused source/patient access without an independent export grant. Two real built-server regression cases confirmed that doctor and reception users could obtain text PPTX without that additional grant before this change.

The new `canExportOrthoStudies` permission defaults to false for doctor and reception and true for the administrator. The server derives it from the current database user under the existing journey authorization lock; request bodies, stale cookies and client UI state do not grant export authority. Ordinary saved-study reading and image review retain their existing access rules. Export permission never substitutes for patient, case, image or source access.

All four output paths check the current grant. Illustrated output rechecks each selected image and checks again after rendering; text PPTX checks again after rendering/audit. Revocation before the final check withholds output. The existing preparation audit is not proof of delivery to a browser. No claim is made that a permission can retract bytes already delivered.

Settings provide an explicit checkbox for doctor/reception. Changing a user's role clears this grant in the editor so that an administrator's implied permission cannot silently carry into a restricted role. Keeping the same role preserves an explicit grant. The UI hides export links without the grant, while the server remains authoritative. Saved revision content and the financial ledger are not rewritten. No migration is required because permissions use the existing normalized JSON representation.

## Verification record

All fixtures are synthetic and PostgreSQL is isolated. Local results below distinguish source tests from a generated-build discovery failure. Hosted CI on the eventual final head remains required.

- PostgreSQL18.6: 32/32 passed in two files (18 new grant tests plus14 image-store tests). Coverage includes fresh database authority, exact boolean grants, image/source/case/patient restrictions, revocation during rendering and between images, expiry, ordinary review access, and unchanged database/private bytes. The initial run failed at a test-fixture INSERT constraint; its log was retained and the fixture corrected before the successful run.
- Built HTTP API: five grant/settings/patient-isolation cases passed after the change. The same-cookie revocation checks and real PPTX ZIP-content assertions use the production build. Text and illustrated print deliberately have different existing denial responses (404 versus a200 error-only page); tests check no clinical output, images or print action on the latter.
- Initial new browser cases used an unsupported `pillar=presentation` URL and timed out before the workspace mounted. The corrected test uses the valid case URL and clicks the real saved-study tab after each reload. No permission assertion was removed. The corrected final run passed11/11 in three files, including the existing workup and prescription flows. Export-control screenshots at390px and1280px were visually inspected; no horizontal overflow was observed in that control region.
- The full Next production build including TypeScript passed (`lP-EAIbDv51loCd2yT6DQ`). The full latest-file TypeScript check passed. The full unit run passed17,930 source tests in1009 files but failed2 duplicate tests discovered inside `.next/standalone`; those generated copies lack their relative source fixtures/workflow. Vitest now excludes only generated `.next` trees. The original two diagnostic tests were rerun and passed2/2, and explicit collection of the generated path returns an empty list. The full suite was not repeated after this discovery-only correction. Changed-file ESLint finished with0errors and6existing warnings. Targeted permission and existing settings tests passed; the role-transition review added five real page-handler cases.

## Separate hosted print investigation

Run42732086815 on the base SHA failed in the synthetic `missing-logo` screenshot before PDF generation: `Page.captureScreenshot: Unable to capture screenshot`. Preceding geometry assertions passed; that case's later PDF assertions were not reached. The prior run passed with identical committed print inputs and the same bundled Chromium153 revision, which does not establish the underlying cause.

The print test now records bounded synthetic numeric/state diagnostics on capture failure and rethrows the original error. Screenshot/PDF assertions, full-page coverage and CI gates remain intact; no retry, delay, skip or success fallback was added. Local Chromium151 passed all three target cases but is not the hosted153 browser. Downloading the exact browser is blocked by the environment's explicit restriction on `cdn.playwright.dev`; a configuration request is pending. The attempted hosted rerun was rejected because its workflow was still running and did not execute. Root cause remains unproven.

## Preserved and outstanding work

The other-cloud `b2d1d771049b716f2e2e1858b15fac4ad541140c` repository and patch paths remain absent here. Expected patch SHA256: `84e987f0b9fd62e0bc582edbdeb333deba0026c705692b11a922505635587abe`. An exact-title Library search also found no matching patch (only unrelated fuzzy candidates). It has not been read, validated or applied; a supported transfer is still required. Its reported953 tests are not results for this branch. Original uncommitted phase21 work remains preserved separately and was not overwritten.

This grant does not complete durable export archives, the final illustrated template, case closure/reopening, unsupported clinical analysis methods, all52 acceptance scenarios or staging readiness. No main merge, PR creation or deployment is part of this slice. The existing CI concurrency policy cancels a running branch build on a new push, so the next push is held while the previous PostgreSQL/HTTP gates finish; this avoids discarding their remaining evidence.
