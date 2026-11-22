# P0 intake-history upload-only boundary — CI witness

Review PR: https://github.com/Aqlanf10/aqlan-center-mini/pull/558

Staging baseline: `b0196b02ded454f7973e8f8cd87cd49b7940f4d3`.

This branch inherits the **same code and synthetic tests** as PR #558. This
documentation-only commit triggers the existing `feat/**` CI push workflow.

Acceptance gates: typecheck, lint, unit/security, dependency audit, build,
PostgreSQL 18 isolated integration, built-app HTTP/browser, print watermark.

P0 security invariant: reception can attach external documents for filing,
but does not receive medical-intake forms by GET and cannot create a structured
clinical intake form by POST. Role denial happens ahead of data access.
Admin and patient-authorized doctor remain able to read and append records.

Negative scope: no real patient photos, identifiers or records; no Railway DB,
production deploy or shared-db migrations; no ceph/ortho #541 integration.

Do not treat green CI on this review branch as a staging deploy or PR merge.
