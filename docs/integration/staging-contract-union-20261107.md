# Contract integration scope

This source checkpoint extends public base `0af83b43d1cf6e6306302b760184d1c8fb473d05`. It is not a release approval.

## Contract and regression inventory

1. Preserve migration 0090–0093 identities and runtime/schema validators alongside newer ortho migrations. Retain historical booking lineage without enabling booking or AI features. Validate fresh bootstrap, registered/unregistered drift rejection, and checksum agreement.
2. Combine issued-prescription history protections with ortho guards for visit reassignment, visit deletion, source-patient merge, and clinic reset. Validate both kinds of protected history, empty history, locking, and rollback.
3. Restore durable prescription issuance/recovery, transactional authority, prescriber snapshots and locked safety acknowledgement. Validate command replay/conflict/concurrency, stale sessions, patient access and safety changes.
4. Restore medication catalogue/settings and saved-history API/UI while preserving ortho surfaces. Validate saved-history access, medication selection and clinic settings.
5. Restore saved-only prescription printing, reception reprints, saved prescriber, clinic-zone dates and pagination. Validate malicious URL inputs, print access and layout.
6. Restore ortho plan-link command compare-and-swap/recovery while retaining authority and ownership checks. Validate stale versions, concurrent requests, revoked access, and cross-patient plans.
7. Validate backup-restore migration provenance using synthetic data. This source checkpoint does not verify a live backup or authorize a restore operation.

## Release gates

Use synthetic data for validation. Preserve security and existing ortho/ceph coverage; do not weaken checks, add broad skips, or repin exception hashes merely to make gates pass. Completion of individual sections does not establish full compatibility.

The initial comparison identified 113 modified runtime files requiring review. Review of large shared engines and surfaces remains incomplete. Before release, complete remaining contract reviews, exact-head aggregate type/lint/regression/build/CI checks, browser/PDF acceptance, and deployment-target isolation checks. Record blocked, resource-killed and unrun checks explicitly. See the companion validation report for bounded results and known limitations.
