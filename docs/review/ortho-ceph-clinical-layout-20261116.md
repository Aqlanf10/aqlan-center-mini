# Orthodontic workup navigation and clinical-first cephalometric report

Review-only presentation slice on PR #545, commit 2c47709f854ad3fe9f0372f79eadb5d34fd3b7df. Its parent is PR #541 at 4e88b6a7. No merge, deployment, DB connection, migration, permission change, measurement formula change or clinical-data rewrite.

## Source review and limits

Read the exact workup catalogue and navigation component, diagnostic scroll navigation, relevant PatientOrtho imports and diagnostic/visit rendering, the current ceph print page, tracing helper and relevant presentation tests. This is not a full audit of every orthodontic writer or of the live staging UI. Connected-browser access was unavailable. Do not assume the supplied old reports identify the deployed SHA.

The code has five routine case destinations and a separate seven-group workup map covering thirteen bookmarked destinations. Normal diagnostic navigation scrolls to records, ceph, comparison and assessment; in workup mode it is hidden and the parent selects the relevant section. They are not all necessarily visible simultaneously. Workup's examination group includes records, model measurements and ceph, while the analysis group is the diagnostic summary. Naming, transitions and the actual normal-view content order need further owner-led review; changing text alone is not workflow completion.

PR #538 contains a separate value-first UI effort. It was not merged or copied blindly. Reconcile overlaps before combining either branch. Keep routine adjustment visits directly accessible; do not force an established case through an initial-assessment wizard.

## Implemented

- Compact workup map with one scrollable stage row, only the current group's subordinate destinations, a short contextual heading, and explicit no-save/no-approval semantics. All thirteen destination indexes, callbacks and parent-owned navigation admission stay unchanged. No children or record owners are unmounted by this component.
- Preserve the routine-visit-first case tab order. Use sky-blue selection styling without changing clinical commands.
- Reorganize the actual ceph print route: clinic identity/status, acquisition metadata, saved/draft landmark diagram, full-width grouped measurements, authored diagnosis/notes and signature.
- Keep the existing clinic PrintHeader, PrintFooter, PrintMetadata and PrintTableFrame watermark components. No logo files or global print rules are replaced. New rules are scoped to this report and its named A4 page.
- Move verbose hashes, versions, saved evidence and scientific technical context into an optional audit appendix. Open it before printing to include it. Keep concise status/reference limitations in the clinical report; legacy completion notice remains visible. No source evidence is deleted.
- Index repeated source labels rather than repeating long hashes in clinical rows. Preserve values, units and source labels; unknown groups remain visible; null/nonfinite values stay unavailable; descriptive values cannot become graded by injected references.
- Repeat case/study/status context in table headers. Label the internal patient ID as Patient ID, not a claimed public file number.
- Larger diagram, with externally positioned labels and leader lines. All source coordinates remain verbatim; no inferred anatomy or altered clinical points. Labels are presentation-only.

## Verified locally

127 isolated cases passed, including the previous safety cases, actual page/component logic through an explicit JSX collector, grouped layout, reference availability, label geometry and navigation callbacks. This harness uses TypeScript and a Vitest-registration shim; it is NOT the repository Vitest/esbuild/React/Next runtime. Navigation catalogue data in the offline harness is a documented source-derived stub.

Strict TypeScript passed for the two dependency-free report helper modules. Chromium rendered the actual candidate report/page components with React 16 UMD and explicit synthetic read/header/reference substitutes. The 38-row synthetic example printed as four clinical pages, without overflowing table cells or JavaScript errors. An opened audit appendix was also printed. This is layout evidence, NOT a Next.js/staging/clinical acceptance result; production React is newer and actual branding/global styles must still be checked.

The previous PR545 hosted run 43804002515 failed Unit tests and PostgreSQL integration; Typecheck/Lint passed. Root causes were not established in this slice. Never describe that run or this candidate as green based on isolated tests.

## Required acceptance before any deployment

Run the exact-head repository typecheck/lint/unit/build, targeted report and navigation tests, patient-scope/HTTP tests and persisted synthetic journeys. Confirm unsaved edits, denied access, back/forward links, correction studies and completed snapshots. Check real print branding and watermark, long bilingual names/notes, legacy/invalid records, 390px and desktop navigation, closed/open audit printing and table pagination.

## Remaining work

The full orthodontic information architecture, normal diagnostic-view order, editor density, ceph workspace layout, valid landmark/protocol definitions, ratios, reference interpretation and independent clinical validation are NOT complete. No automatic diagnosis, extraction/expansion recommendation or old template landmark detection is enabled. Do not rewrite historical measurements or clinician text while improving presentation.

All new test data is synthetic. No patient images, real identifiers, commercial program files, proprietary drawing assets, credentials or textbook pages are included.
