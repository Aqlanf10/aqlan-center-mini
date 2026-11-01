# PR480 reconciled installment reminder repair

Base: `82ff44f165a6f7a199c330ca0aee41bbb2110368` (#480).
Implementation checkpoint: `c8463a1caa30c523852b9b0dbef23b7562f91880`.

## Scope
- Additive migration 0087 permits only `last_reminder_at` updates on reconciled installments. Whole-row JSON equality, excluding that single column, preserves every existing and future term. Insert/delete restrictions and invoice item immutability remain.
- Published migration 0078 and its runtime SQL remain byte-identical.
- The endpoint records plan timestamps, targeted due installments, and mandatory audit together in one transaction. A bulk request is atomic, deduplicated and locks plans in sorted order. A missing individual installment makes no changes. Invalid/int32-overflow targets and batches larger than 500 are refused.
- No UI, role expansion, financial terms, invoices, payments, identity rollout or inventory feature changes.

## Verification
- Before registering the additive fix: 4 failing / 2 passing new PostgreSQL assertions at 65cdd411. The old guard rejected reminder updates.
- Exact candidate: 16 focused unit assertions passed (migration suite, unchanged0078 pin and0087 exact-file parity).
- Exact candidate: 29 PostgreSQL assertions passed (8 reminder/upgrade/immutability assertions plus21 existing reconciliation assertions), on a newly owned isolated PostgreSQL18 cluster, stopped cleanly.
- PostgreSQL tests include individual/bulk success, due-only filtering, no missing-installment timestamp, late-batch audit-fault rollback, installment-fault rollback, future-column protection and repeated runtime upgrade with original0078 registry preserved.
- Independent source review found no blocking issue in this bounded delta.
- Exact candidate: Next.js production build and its TypeScript check passed (Node22,4GiB). Standalone initial typecheck with default heap failed from OOM and is not counted; the explicit4GiB check and final build typecheck passed.
- All eight changed TypeScript files passed scoped ESLint with0errors and8existing unrelated warnings in `lib/db.ts`.
- Exact candidate:8 real built-app HTTP assertions passed (4 new reminder tests and4 existing audit-coverage tests). The isolated application server and newly owned PostgreSQL18 cluster shut down cleanly. No browser sandbox workaround was used.
- A separate fresh synthetic PostgreSQL18 rehearsal executed exact original480 startup and reconciliation. The old updater reproduced both the rejection and partial plan timestamp. Candidate startup then applied0087, preserved0078 registry and financial rows, and successfully recorded reminder plus audit. Restarting the exact old480 app did not overwrite the corrected guard or rows; its old preflight correctly reported0087 as unknown. This proves narrow application-startup compatibility, not schema rollback or live environment acceptance.
- Full hosted CI and Staging acceptance are still required. Focused checks do not imply full-suite success.

## Deployment and rollback constraints
Migration0087 is additive and must be applied through the existing verified migration/runtime path. Do not rewrite0078 or silently adopt an unverified baseline. Do not delete real data.
Application rollback does not roll back the schema:0087 remains installed. An old480 preflight manifest may report0087 as an unknown applied migration. Do not remove that record or claim schema rollback merely because the old app can start. Production and Staging activation require their own reviewed acceptance and release decision.
