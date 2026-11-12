# WORK / main reconciliation intake — 2026-11-01

This is the historical read-only intake, not acceptance of the later merge. At intake, published WORK was `e718e9f7fcc8eead9301ad4e8d7f6b7e3776791a`; fetched main was `6a6bdc0cc705874fd4ff6d0f0ddc3fdcd314e9e6`; their common ancestor was `82ff44f165a6f7a199c330ca0aee41bbb2110368`. Current resolution and verification are tracked in the [integration report](work-main-integration-20261101.md).

`git merge-tree --write-tree --name-only` reported **35 content-conflicting files**. It wrote only comparison objects, with no checkout, index, branch, commit, push or deployment change. The generated tree is `a8f223508ff2886cd85c5f3beb046693d6e2e464` and contains conflict markers; it is not executable acceptance evidence.

## Conflicting paths

- `__tests__/lab-accounting-fx-snapshot.test.ts`
- `__tests__/lab-accounting-monetary-intent-route.test.ts`
- `__tests__/migrations.test.ts`
- `__tests__/patient-appointment-history-schema.test.ts`
- `__tests__/periodontal-candidate-chain.test.ts`
- `__tests__/periodontal-schema.test.ts`
- `__tests__/postgres/_periodontal-fixture.ts`
- `__tests__/postgres/debt-installments-storage.test.ts`
- `__tests__/postgres/hr-composed-backup.test.ts`
- `__tests__/postgres/hr-runtime-registration.test.ts`
- `__tests__/postgres/legacy-doctor-fk-compatibility.test.ts`
- `__tests__/postgres/patient-appointment-history-index.test.ts`
- `__tests__/postgres/periodontal-restore.test.ts`
- `__tests__/postgres/schema-ownership.test.ts`
- `__tests__/schema-preflight-cli.test.ts`
- `__tests__/security-http/hr-temporal-history-ui.test.ts`
- `app/api/lab/[id]/route.ts`
- `app/layout.tsx`
- `app/login/page.tsx`
- `app/print/lab/[id]/page.tsx`
- `app/settings/page.tsx`
- `components/LabDentalChart.tsx`
- `components/PatientLabOrders.tsx`
- `components/inventory/DoctorCustody.tsx`
- `components/inventory/ProcurementAdministration.tsx`
- `components/inventory/ProcurementOperations.tsx`
- `docs/DATABASE_MIGRATIONS.md`
- `lib/audit.ts`
- `lib/db.ts`
- `lib/fullBackup.ts`
- `lib/restore/staging.ts`
- `lib/settings-definitions.ts`
- `schema/current-schema-contract.pg18.json`
- `schema/preflight-disclosure.pg18.json`
- `scripts/verify-schema-ownership.ts`

## What is incoming and what must remain

Main contains already-reviewed laboratory dispatch/shade and installment-reminder work, login photograph and print identity, clinic-day financial display and HR leave/attendance fixes. The incoming migration files are existing `0087_agreement_reminder_metadata.sql` and `0089_lab_shade_specification.sql`, not newly allocated WORK migrations. Main currently has no0090–0093 files. Existing WORK-only migration/proposal files must not be deleted merely because they are absent from main; pending M4 registration must not be silently activated by a merge.

The critical conflicts are database helpers, audit, full backup/restore staging, schema contracts and ownership verification. UI conflicts also need WORK-specific tooling compatibility, canonical/legacy separation and active clinical/financial workflows preserved. Choosing one side wholesale is not a resolution.

## Conservative sequence authorized by the latest parent instruction

1. Finish exact-head CI41265345671 for e718; keep local slice37 separable with its own evidence.
2. Resolve a normal history-preserving main merge on an isolated local candidate, preserving WORK history and all independently accepted changes. Do not merge WORK into main, deploy, rebase or force-push. Do not import separate Rx branches.
3. Resolve each conflict by behavior: preserve canonical scope/snapshot/command protections and include the specific reviewed main improvements. Existing immutable migration bytes stay exact. Any new migration or unresolved business-policy decision is held separately.
4. Reconcile schema/backup ownership and fixture requirements using isolated PostgreSQL. Re-run source guards without lowering limits; source witnesses remain tied to their own revisions rather than silently rehashed.
5. Run local focused regressions for every conflict group, full unit/type/lint/build/runtime/audit checks, PostgreSQL schema/restore/financial/canonical journeys and built browser workflows. Keep the final merged head reviewable, then normal-push only after fresh remote comparison and run full exact-head CI.

At this intake checkpoint no source conflict had been resolved and no integrated build existed. The subsequent integration report records the actual behavior resolutions and evidence; deletion of conflict markers alone is not acceptance.
