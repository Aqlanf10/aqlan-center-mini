# Cephalometry safety admission review

Base: `4f7df3d404da96f6baf6a6de2dd932186c74a715`.
Scope: isolated tests and admission fixes in the existing cephalometry API. No patient records, images, external AI calls, schema changes, or adjustment-session changes.

## Reproduced findings

1. `ai-analyze` required `canViewXrays` but could persist suggested landmarks or diagnosis without `canUploadXrays`. Synthetic route-handler tests reproduced both writes for a read-only principal. The patch gates both persistence options with the write permission, including truthy malformed flags to prevent bypass of the existing save conditions.
2. The PATCH numeric converter coerced null to zero, allowing a missing calibration coordinate to become an invented coordinate. Admission now accepts finite numbers only.
3. PATCH silently discarded invalid landmark members while saving the remaining batch. Admission now rejects malformed, unknown, duplicated or nonnumeric landmark entries before writing any part, including a calibration supplied in the same payload. Diagnosis shape is validated before writes too.

The new tests failed on the unmodified base (four assertions), then passed after the patch. Tests call the real route handlers with mocked persistence and permissions: this proves routing and admission logic, not deployed HTTP or database integration.

## Positive evidence and limits

Existing geometry/core and legacy-characterization suites pass alongside page-access and scoping tests. External diagnosis dispatch remains disabled when the clinical-external settings lookup fails. All fixtures are synthetic; no image is included. The test suite imports the real geometry and inference functions, but mocks AI transport and all persistence.

Completed-study immutability is retained by existing database domain checks; the patch does not change them or recalculate saved measurements. Their concurrent PostgreSQL behavior was not executed in this review.

The PATCH handler still performs separate transactions for calibration, landmarks and diagnosis. Prevalidation prevents malformed payloads from causing partial writes, but **database failure or concurrent completion between these operations is not made atomic by this patch**. This needs a dedicated transaction-domain revision with real PostgreSQL concurrency tests before a claim of full atomicity.

No application build, hosted CI, real PostgreSQL, image-storage authorization journey, or browser journey was run for this slice. No live-environment exploit or patient exposure was tested. Scientific/clinical validation remains outside this API fix; all independent-core measurements remain research-only.

## Final local verification

- Five focused files: 124/124 passed on Node 24.22.1 (repository requests Node 22; hosted validation still required).
- ESLint for the three changed TypeScript files: passed.
- Full TypeScript check with 4 GB heap and incremental output disabled: passed.
- `git diff --check`: passed.
- Branch `test/ceph-safety-20261117` does not match repository push workflow branch filters. This alone does not prove third-party deployment configuration; no push is implied by this report.
