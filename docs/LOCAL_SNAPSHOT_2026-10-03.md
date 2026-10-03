# Local patient-workspace snapshot — 2026-10-03

This branch preserves the selected project source, regression tests, schema assets, and implementation contracts assembled on base `00762afab733217a84fa016d025b329adb9b551c`. It is a backup/review snapshot, not a release or a completion claim for the patient module.

## Scope

The assembled work includes patient workspace/navigation, plan and clinical-record boundaries, periodontal persistence, patient/lab reads and financial projection, consent/document context, structured visit records, and endodontic dossier printing. Existing canonical authorization and financial owners remain in place. No AI/Dot feature is included in this work.

## Validation and limitations

The assembled local checkpoint recorded 7,014 passing unit tests and 1,326 passing PostgreSQL tests, with five PostgreSQL skips explicitly retained. The production build completed (`SOReHIYBmtpwyTi9LxW1N`), and all 37 selected built-HTTP test cases passed against that frozen build. These are local checkpoint results, not remote exact-commit CI or a blanket browser/print acceptance claim. A source snapshot does not replace independent review, the remaining patient-module work, or exact proposed-release validation. Historical notes and test counts are scoped to their corresponding source checkpoints and must not be added as distinct coverage or treated as release approval.

The snapshot branch name does not match the repository's push-CI branch filters. There is deliberately no pull request or merge as part of this upload. Required CI and release gates must run on the exact proposed release commit before any future merge.

Two subsequent isolated and independently reviewed UI containments are included as separate commits: laboratory batch-payment proposal removal (231 tests, types and lint) and contextual quick-lab creation retirement (415 tests, types and lint). Each was validated against the assembled baseline separately. The combined latest tree has not yet repeated the broad build/HTTP/CI gates. Existing linked lab API/provider and financial-overview gaps remain; these UI containments do not certify backend remediation.

## Publication boundary

This upload does not change `main`, execute a production deployment, run migrations against Production, delete patient data, change credentials, or remove backups. A read-only Railway configuration check at 2026-10-03 21:20 UTC confirmed that the Production service tracks `main`, so this differently named snapshot branch does not update that service.

## Exclusions

Credentials and environment files, dependencies, generated builds/caches, audit/runtime evidence, screenshots/PDFs, database files and backups, real patient data, and local recovery/coordinator packets are excluded. Only project deliverables are preserved.

## Earlier open work

At upload preparation, PR [#209](https://github.com/Aqlanf10/aqlan-center-mini/pull/209) (`fix/patient-focused-shell`, head `c4e7030`) and PR [#213](https://github.com/Aqlanf10/aqlan-center-mini/pull/213) (`release/patient-dossier-main212`, head `80f554f`) remain open drafts. Their relevant work has been reconstructed/integrated into the assembled sources, with subsequent corrections. This is not a claim of byte-identical UI preservation or a claim that those draft heads validate this newer snapshot. Existing branches and PRs are not overwritten or closed. The separate backup PR [#47](https://github.com/Aqlanf10/aqlan-center-mini/pull/47) remains deferred and is not part of this integration.
