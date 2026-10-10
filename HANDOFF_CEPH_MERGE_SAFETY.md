# Ceph merge and current-authority safety

## Candidate status

Source-only refresh for existing PR #319. This composed candidate has not been
executed, published, merged, or deployed as part of its preparation. It requires
independent review and full CI on its exact published commit before Staging use.
Earlier local results recorded on PR #320 do not establish this candidate's CI
status and are not carried forward as passing evidence.

The source composition preserves:

- PR #319 at `eadd75028cbf35188d972a7521022522538c31d6`.
- Released main at `148fcbeac229cb279848e6ea37049d1599a4fafe`, composed using
  common base `1878cf92ae5ac8ed5596b67a9d0c58f7b67812cd`.
- The actual nine-file PR #320 delta from
  `f7ef7c8b7bd2b21c891aacdcf8bb65881c9609b7` to
  `1503b0d22b2159bb4d504d47d038f7867fb746ac`.

Only `lib/audit.ts`, `lib/db.ts`, and `lib/http-permissions.ts` overlap between
PR #319 and the released-main delta. The older main snapshot on PR #320 is not
used to replace released-main changes. The intended commit retains all three
source heads as parents rather than discarding their history.

## Runtime scope

- Create locks the patient with `FOR KEY SHARE` before inserting a study. This
  follows patient merge/delete ordering and avoids the parent/unique-index cycle.
- Existing-study writers resolve and lock the current patient, validate current
  credentials and `canUploadXrays` with locked access witnesses, lock the study,
  and recheck its patient ID. A preceding patient merge cannot grant the
  source-only doctor permission on the destination patient.
- Calibration, landmark and diagnosis PATCH writers use the same transactional
  authorizer as completion, discard and correction. Existing `ai-analyze` save
  paths pass that authorizer and propagate refusal statuses. A view-only user can
  still request a permitted preview, but cannot persist either suggestion type.
  No AI feature, provider, model, or external-service behavior is added.
- Canonical authorizers carry a pure wall-clock expiry check. Writers recheck
  expiry after child-lock waits and before commit, without acquiring new access
  witnesses after child locks. Expiry after a transactional write rolls it back.
- Create's entire transaction is covered by rollback-on-error before releasing
  its connection, including patient-lock, authorization and pre-insert failures.
  Existing duplicate-study conflict translation remains intact.
- Completed-study immutability, one-open-draft uniqueness, correction lineage,
  measurement stamping and patient scope remain enforced.

## Audit boundary

Correction and case linking insert their audit row in the same transaction as
their clinical change. Create, calibration, landmarks, diagnosis, completion and
discard retain their existing post-COMMIT `recordAudit` behavior. A failure of
those post-COMMIT audit writes does not roll back an already committed clinical
change. The previous broad claim that every Ceph audit was transactional was
incorrect; this refresh does not redesign that audit boundary.

Measurement stamping itself remains transactional with completion. A failure
while stamping rolls back the completion and its measurements.

## Regression acceptance

The regression sources cover current-patient authority after actual merge,
credential and upload-permission changes, reverse serialization, completed-study
guards, throwing-authorizer cleanup and existing route refusal propagation.
Concurrency assertions identify the exact writer backend/query and its
`pg_blocking_pids` edge to the intended blocker, not a database-wide waiter count.
Pending rejections are consumed immediately; parked transactions and writers
are released or drained in `finally` cleanup.

These are test-source changes, not claimed passing results. Run the repository's
full lint, typecheck, unit, PostgreSQL, security-HTTP, schema/ownership/catalog and
build gates on the final candidate. Use isolated test databases, and do not
exercise external AI providers for this regression work.

## Schema and deployment boundaries

PR #319's `0047_ceph_correction_lineage.sql`, migration registry, ownership
guards and generated PostgreSQL catalogs are preserved from the pinned source.
No new migration or manually generated schema catalog is introduced. Migration
0051, HR/discount work and future AI/Dot features are outside this refresh.

Staging already has the 0047 migration and must not be downgraded to a tree that
omits it. Production is untouched by this source preparation. Any later Staging
publication must verify exact-head CI and the retained migration/catalog chain.
