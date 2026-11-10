# Archive restore and session-wait review — 2026-11-10

These two independent review questions became reproducible defects and are fixed in the integration branch through `8f32884c`. They do not establish whole-unit or deployment acceptance. All executions below used synthetic fixtures, Node22 and local PostgreSQL18.6; no production data or existing backup was changed.

## Incomplete restore could incorrectly become ready

A backup could omit a saved PPTX and its manifest entry while retaining the artifact row in SQL. Tar/manifest validation correctly described the remaining entries, but lacked the relational check against restored SQL. The negative test reached `readyForCutover=true` before the fix.

The restore transaction now compares every replayed study artifact's storage key, SHA-256 and byte size with independently verified archive bytes. This happens before SQL commit, staging file writes or cutover readiness. Missing files and coordinated replacement of both bytes and manifest are refused. Legacy backups with no artifact rows remain supported; shared content-addressed files may satisfy multiple matching rows.

Evidence: two unit negatives failed before;7/7 scoped units passed after. The actual PostgreSQL omission negative reproduced incorrect readiness before the fix. The final three-case PostgreSQL suite passed omission refusal, coordinated replacement refusal and the existing successful backup/restore/reclaim journey. Failed replay leaves no restored artifact/job rows or staged files. Scoped lint had zero errors and two existing warnings.

Source commit: `58e96386513a48af99578d16f57b40e77daa88e1`; integrated as `7f9fd1df`. Evidence directory: `/workspace/ortho-resume-evidence/archive-restore-review/`.

## Signed session could expire during a database wait

Canonical authorization preceded job-row and audit locks. A signed session could expire while waiting, yet the operation could still return success. Seven actual PostgreSQL lock-wait negatives reproduced this for claim/publication/download/list and later reservation/claim/publication audit waits. Tests deliberately supplied a longer input expiry than the signed cookie to prevent trusting caller metadata.

All seven archive store entry points now recheck the canonical signed session after their final receipt/audit work and before transaction completion. Job paths also recheck immediately after acquiring the job lock. Existing user/source locks and order are preserved; this does not add a separate permission engine. Expired operations roll back reservations, leases, publication and audit rows.

Evidence:7/7 negatives failed before;36/36 tests across expiry, archive and export-permission PostgreSQL suites passed after. The final strengthened expiry suite passed7/7. Scoped lint and independent read-only security review found no additional issue in this change.

Source commit: `e2d799b48f3495ef6d59a7eb4df84050ef9f562d`; integrated as `8f32884c`. Logs: `/workspace/ortho-resume-evidence/archive-expiry-*.log`.

## Combined evidence and remaining gate

The frozen earlier `6f2b303b` full local unit run passed18,055 tests and failed one explicit runtime-migration expectation ending at0122. Adding reviewed0123 to that expectation retained the exact before/after ledger equality, baseline mismatch refusal and absence of baseline adoption. The reviewed checksum manifest had already been corrected separately. The integrated five-file regression then passed65/65, including both migration checks, source-preview/archive UI and restore-unit coverage.

Hosted `3849a27a` is an earlier checkpoint: print passed; unit gate reported18,047 passes and two0123 expectation failures; HTTP was skipped. Later integrated-head build/browser/PostgreSQL and hosted CI remain separate required evidence. No result here authorizes main merge, staging/production deployment or retrying denied PR creation.
