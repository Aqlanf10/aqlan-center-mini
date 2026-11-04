# Appointments with the approved prescription candidate

This is an isolated local integration candidate, not a deployment or a shared
branch merge. The prior appointments evidence under `../appointments-completion`
describes its own source branch; its hosted CI result does not certify this tree.

## Reviewed inputs and boundaries

- Rx base: draft [#523](https://github.com/Aqlanf10/aqlan-center-mini/pull/523),
  `b804d515ca454c15507af94429d31546893f94fc`, stacked on #520
  `7baeff369f775dbe6999f4e80734369097bb6006`.
- Appointments: draft [#522](https://github.com/Aqlanf10/aqlan-center-mini/pull/522),
  `f90069176bb428ed3369ece3aa0bb90c8a1df7c0`, including #514 and #515.
- Common ancestor: `1b5f3c61df702be1d5283d295a3e1b420196c94b`.
- Local branch: `feat/appointments-rx-approved-integration-20261103`.
- The bounded appointments net patch contains six reviewed commits and 115
  paths. Its overlap with the Rx delta is 28 paths. The composed source retains
  both sets of migration validation, reset protection and patient-history guards.
- All 13 paths changed by #523 relative to #520 remain byte-identical to the
  approved Rx candidate. Existing migration files from both inputs remain
  byte-identical. Radiology 0094 and unrelated WORK/Opus branches are excluded.

The final metadata recheck found Stage deployment
`ea6d99f0-08df-4b0c-ac4f-0e36a9d8c750` at `b804d515` SUCCESS (initially BUILDING),
and the previous `7baeff36` deployment REMOVED. The remote Rx and appointments
heads remain the pinned inputs above; `main` remains `6a6bdc0c`. No Git branch
named `Staging` was returned; Stage is the deployment environment, currently
tracking the Rx candidate. This metadata inspection did not read live patients,
validate the deployed application, or establish real doctor-roster readiness.

## Integration changes

The clinical categories, staff confirmation, actor-bound booking recovery,
patient filters and authoritative doctor-duty checks from the appointments
branch now coexist with prescription issuance receipts and approved printing.
Unknown doctor/staff mapping is explicitly described as preventing confirmation
until the mapping and duty schedule are reviewed. No internal HR identities are
exposed by the warning, and a manual override cannot bypass this admission rule.

Native PostgreSQL 18 regenerated the current schema and disclosure artifacts from
the combined source: 72 numbered migrations, 136 tables including the registry,
1,727 columns, 2,008 constraints, 425 indexes and 107 triggers. Contract drift
verification passed. Ownership characterization found zero unexpected differences
and retained 16 previously disclosed convergence findings (12 columns and four
function definitions); it does
not claim full equality between runtime and numbered-migration catalogs.

The new native test starts with populated Rx 0093 history, applies 0095/0096,
then verifies official SQL and archive restore with all three immutable receipt
families. The new browser journey books and arrives a synthetic patient, creates
the linked visit, saves/replays a prescription, opens the authorized saved print,
and schedules follow-up while checking patient/doctor/visit ownership.

## Validation and remaining gates

Final local test results and synthetic browser evidence are recorded in
`validation.md` after execution. Every test database is newly created on local
PostgreSQL 18; no production or Stage database migration was performed.

Hosted CI at the final integration commit, actual supported-browser print
acceptance, and a coordinated Stage doctor/staff/duty review remain release
gates. Real roster correctness cannot be inferred from synthetic fixtures.
The initial preparation was local only. The owner's subsequent continuation on
2026-11-04 authorizes publishing this isolated branch as a draft review and
running GitHub CI. It does not authorize merging, changing another branch, or
deploying to Stage/Production. The current CI result belongs to the exact PR head
and must be checked there; earlier local evidence is not a hosted-CI claim.

The retained single local lab-PDF failure is diagnosed in `print-diagnosis.md`;
the approved Rx files and the strict PDF oracle are unchanged.
`roster-radiology-audit.md` records the fresh 62-case compatibility check and
the separate radiology boundary. Immediately before publication, read-only
Railway configuration showed Stage bound to the Rx branch at `b804d515` and
Production bound to `main` at `6a6bdc0c`, with no staged configuration changes.
Neither service follows this isolated review branch.
