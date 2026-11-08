# Orthodontic and cephalometric current-source review

## Source and scope

Comparison base: `c6c886121bcc50aa548f64b0b0fbd7b5beb1f324`.
Current source: `dfe580564a760d8ba5e33787559635daa74f48db`. Includes output-directory creation for synthetic PPTX verification, its focused regression test, and explicit synthetic labels in the orthodontic baseline database fixture.

This review contains current application changes, tests and synthetic fixtures, database migrations and schema contracts, dependency/configuration changes, and current verification tooling. Coverage includes orthodontic case and visit lifecycle, cephalometric measurement and tracing, clinical record ownership and concurrency, saved study capture/export, facial and panoramic records, space analysis, follow-up and retention workflows. It preserves existing main assets, vendor integrity inputs, test inputs, CI gates, and the migration and settings documentation needed for accurate current-source review.

This is a current-source deliverable. It does not include historical execution evidence or import the historical evidence branch ancestry.

## Current validation status

Comparison verified all 4,299 included source paths against the source blob IDs and file modes, with all 3,617 base paths preserved. The new review summary is additional to those source paths. The delta has 829 changed paths: 828 exact current-source files and this summary. Current CI, tests, schema and tooling remain unchanged from the stated source.

Under supported Node 22.23.3, 615 tests passed across 16 focused files, with zero skips. These cover documentation drift, schema baseline and ownership, environment contracts, vendor packaging and provenance, synthetic PPTX generation, orthodontic creation/read admission, client safety and legacy identity. The generator regression verifies a missing output directory and safe repeated generation; its test timeout is 60 seconds, with a 30-second bound for each subprocess invocation.

Derived-tree PostgreSQL validation remains pending: the fresh local PostgreSQL 18.6 startup attempt failed to create its Unix-domain socket, before tests ran. No database-test pass is claimed for this derived candidate.

Full unit tests, full lint/typecheck, dependency audit, build/preflight, PostgreSQL integration, HTTP-security, browser/print checks, hosted CI and Staging verification remain unverified for this candidate. Staging database isolation and backup readiness remain release blockers until verified. No production verification or release is asserted. These limitations do not change any existing required gate.

## Historical evidence explicitly omitted

The following six historical validators and their archive inputs, manifests and receipts are not included and cannot be independently verified from this package:

1. `docs/ortho/evidence/followup-attendance-truth-20261105/verify-evidence.py`
2. `docs/ortho/evidence/retention-followup-truth-20261105/verify-evidence.py`
3. `docs/verification/evidence/ceph-calibration-mode-20261105/verify-evidence.py`
4. `docs/verification/evidence/ceph-comparison-chronology-20261105/verify-raw-logs.py`
5. `docs/verification/evidence/ceph-comparison-norms-20261105/verify-evidence.py`
6. `docs/verification/evidence/ceph-tracer-references-20261105/verify-evidence.py`

The omitted material also includes historical raw/compressed logs, visual outputs, generated reports, duplicate source previews, historical hash manifests and narrative archives. Their original hashes and claims remain unchanged in the original private archive. No historical PASS is implied by omission. Current tests establish current behavior only.

The generated synthetic presentation example is omitted; the generator creates its output directory instead. No existing main file is removed, and no current gate or test exclusion is relaxed.
