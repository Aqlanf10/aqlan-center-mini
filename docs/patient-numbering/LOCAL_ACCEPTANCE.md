# Local acceptance and release boundary

This task is local-only on top of sequential batch commit
`18a09ab2c352bf47d9f0bcf804a8b50983f29eaf`. The original proposal is retained at
`saved/patient-numbering-7000-10dcd19f`. No publication, deployment, live database
readiness check, real patient edit, credential change or backup deletion occurred.

## Contracts

- Migration0080 SHA256: `b2bee7694f0781775bbddeea3715cb16ab701f4ee3fd748785ef1016c0f2e10a`.
- Exact runtime bytes; reserved0079 unchanged; migration-after0081/82 covered.
- Fresh schema:139 tables,1740 columns,2050 constraints,429 indexes,116 triggers.
- Ownership characterization retains exactly16 reviewed pre-existing findings,
  no unexpected differences. This is not a claim of complete schema convergence.
- Artifact projection fingerprints only the exact reviewed patient guard DTO
  `be3650ee86318a8431b9449fd05637d930549649b38cec38695c6a9c65bff5cd`;
  changed definitions remain subject to the strict sensitive-text scanner.
- Disclosure candidate generated solely from fresh numbered/runtime source schemas:
  seven column identities and thirteen constraint identities added; none removed.

## Reproducible validation

Use Node22, existing verified dependencies, the shared heavy-test lock and marked
synthetic PostgreSQL18 cluster. No dependency installation/full build is required.
The preflight artifact dependency boundary requires a real local node_modules
path; an existing dependency tree may be hard-linked locally without installation.
Never broaden the reviewed-module allowlist to accommodate symlink resolution.
Run TypeScript, focused/full units, changed-file lint, fresh schema contract drift,
ownership characterization and all PostgreSQL files. PostgreSQL aggregation must
set both `CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE=1` and
`MANUAL_CASH_CI_DISPOSABLE_FIXTURE=1`, matching existing CI guarded fixture policy.
On constrained disks run deterministic bounded file chunks on the same frozen
commit, recreating only the verified owned `aqlan_p1_test` database between chunks.
Never disable triggers or relax checksums to make fixtures pass.

External evidence directory: `patient-numbering-evidence/`. A diagnostic full-suite
attempt was interrupted for disk headroom and is NOT a full passing result.
The final handoff must state the exact tested head/tree and each terminal test
result, including any failure, interruption or not-run gate; this document alone
is not an assertion that the final full suite passed.

## Required release work

Root review; browser journeys; later canonical permission adapter; combined-task
publication/CI/Staging; authorized count-only live alias readiness before deployment;
then approved promotion and Production verification. `ready:false` (CLI exit2)
is a hard release blocker, never authorization to autocorrect or delete records.
