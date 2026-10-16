# Invoice / historical entry — INCOMPLETE WIP handoff

Stopped on the owner's credit-preservation instruction on 2026-10-12. This is source preservation for root review/completion, **not ready to merge**. No Production/Staging database access, deployment, merge, CI edit, or force-push was performed.

## Exact lineage and inventory

- Repository: `Aqlanf10/aqlan-center-mini`.
- Handoff branch: `handoff/invoice-historical-wip-20261012`.
- Worktree: `/workspace/compat-invoice-03d325a8`.
- Base: `03d325a8b6511098237458c38444620db59709e7`; tree `481e465b82e44205a6f94bcfa10a1df6c2788a18`.
- Preserved implementation head: `32578163a79ca0e66f74f1f7d9fcfefd2fd91eb0`; tree `8c5227da8b1e4655b9ab62ba2f29f6b075a104a8`.
- This document is a separate documentation-only child commit. Resolve its enclosing handoff head/tree with `git rev-parse HEAD HEAD^{tree}`; the final handoff message records the verified remote head. Application source is exactly the implementation commit above.
- All 64 prior dirty/untracked source files were committed: 28 modified, 36 new. `git diff --name-status 03d325a8 32578163` is the exhaustive inventory. This document is the only additional file. No source was omitted.
- Generated `.next`, `node_modules`, local reports, screenshots, archives and raw logs are excluded from Git. No environment files, credentials or real patient data were added. The schema contract is required source, not a database dump.
- Draft PR #326 remains on `feat/invoice-entry-main` at the old base `03d325a8` (verified before push). Its earlier green CI does **not** cover this WIP. This separate handoff branch does not update that PR.

## Implemented locally

- Owner-approved invoice workspace layout, native-currency catalogue prices, server-side price authority, discount permission/reason checks and exact proportional allocation.
- 0059 debt installment schema/writers/API/editor: dated terms over real invoice/opening debt; collection is capped by source balance and canonical same-currency account due; revise remaining/cancel dates without cancelling debt. Old/new opening schedules are mutually exclusive.
- Ordinary invoice save includes terms atomically and retains actor/patient-specific command and idempotency key across uncertain replies. Strict acknowledgements govern completion.
- 0060 historical document schema/writers/API: heterogeneous tooth and grouped-orthodontic lines, immutable clinical coverage, aggregate agreement/paid/remaining once, atomic opening and schedule, exact replay, append-only financial correction and audit. For 300000 agreed / 120000 historically paid, only 180000 opening principal is created; no fake invoice, receipt or cash collection. Line paid/remaining fields are NULL, avoiding invented allocation.
- Whole patient/opening-currency schedule scope covers multiple historical documents. Writers refuse mismatched manual opening ownership and unallocated old receipts. Corrections preserve original clinical lineage and receipts and reject below settled amounts.
- Historical multi-line create UI is now wired through preview/save, retained command and full receipt validation. Saved-document read view shows current version, lines, history and current account due. These are no longer preview-only, but historical browser acceptance is incomplete.
- Permissions: front desk create/preview, admin correction; doctor read access uses patient/payment visibility checks. Server sessions and authority are revalidated by transactional writers.

## Unfinished / known review points

1. Historical correction **editor UI is absent**. Backend correction exists; saved view is read-only. Do not present the workflow as complete.
2. Historical desktop/mobile save, lost/malformed acknowledgement and HTTP permission journeys exist in `historical-document-workspace-ui.test.ts` but have no completed result. The first run was interrupted at the owner's stop instruction; investigate any stall/failure when root resumes.
3. A zero-remaining historical document added to an already-owned opening can unnecessarily move its historical date. Preserve the prior opening date when the added remaining amount is zero; add a focused regression.
4. `listHistoricalDocuments` currently uses strict opening ownership evidence. Later manual opening drift can make the entire read fail; root should decide how to display review-required state while keeping writers strict.
5. Existing overlapping unbilled items are refused (`open_item_exists`), not adopted. Unrelated existing master plans can be reused. Add explicit preservation checks for pre-existing plan items, assessment/Ortho/Ceph drafts and repeat visits against the final combined integration head.
6. Ordinary invoice correction is still the older flow, without this slice's complete retained-command/schedule recovery integration. Review before claiming all financial correction paths are covered.
7. Reconcile shared `lib/http-permissions.ts` and schema/bootstrap changes with root's other branches. Reception checkout/queue/notifications and `CollectPaymentModal` were not edited here. No combined HR/Ortho/reception integration has been tested.
8. Latest historical UI lint/full regression and final remote-head CI were not run. No full rerun was started after the stop instruction.

## Test evidence (observed, with source boundaries)

All database/browser execution used disposable synthetic PostgreSQL 18.6 on localhost; no live patient data. Available tools: Node 22.23.3, Next 16.3.8, Vitest 4.1.11, Playwright 1.63.0, system Chromium, Docker. Local PG container: `aqlan-invoice-acceptance-pg18`; port 55439; test DB `aqlan_p1_test`. HTTP harness recreates `aqlan_sec_http`, app port 3322. Never run two HTTP harnesses concurrently. The synthetic HTTP server was stopped after interruption.

Raw local records are `/workspace/reviews/invoice-workspace/<label>.json` and `.log`; they include command, timing, exit, build ID and before/after source hashes. They are intentionally not committed. Hashes below identify snapshots of tracked plus nonignored untracked source, not Git trees.

| Label / check | Observed result | Source snapshot SHA256 |
|---|---|---|
| `build-historical-save` | Production build passed; build ID `Vpjrxt770vqdC8eIXBAep` | `715a06eb13b923e441e5cbf1069e0b5ff1f2e86f5704df7c7a47a62da70d0e00` |
| `historical-save-ui-types-final` | Typecheck passed | same `715a06…` |
| `historical-save-http-first` | Ordinary/debt browser file passed 7/7 on fresh build. Combined process intentionally interrupted, exit 130; **no historical result** | same `715a06…` |
| `historical-0060-storage-fixed` | 26/26 PG passed: 14 historical, 6 debt storage, 6 schema ownership; includes actual backup/restore | `b1602b22ad5f97faec2758a50fe8144aa3bd2031d71f2e542258c7f3f0dc3074` |
| `historical-0060-unit` | 29/29 passed: receipt validation, discount allocation, candidate/preflight chains | `d968a424535d70f95969e068e81fca860e98de45bda20d0eeecff1a6c386cde6` |
| `historical-http-permissions-before-ui` | 18/18 passed: 14 static permissions + 4 allocation | `9414a7759921ecb37da9eca06f932959147151ba877df1bcae212c03b3dc32f4` |
| `historical-document-pg-edge` | 48/48 passed at narrow historical-core checkpoint (13 document + 3 historical debt + 32 immutable coverage) | `f074a8db96f679f1e69c3505197f6a733017bb0a4376eb8b98f0fd60632ecc12` |
| `resume-repayment-workspace-http-fixed` | 7/7 built-app journeys at earlier 0059 wired checkpoint | `4282279358a3dbff950821fede38157bdcdcb3de223804be771f33fe8d10493d` |

The final implementation commit contains exactly the application files of snapshot `715a06…`; only this handoff document is subsequently added. Earlier PG/unit passes retain their own source boundaries and are not claims of a final full suite pass.

Earlier failures were retained in local evidence: initial historical PG fixture used the wrong service category and preview attempted a row lock in a read-only transaction; fixed before 48-pass checkpoint. First 0060 storage run was 24 pass / 2 fail (cleared opening restore and expected table count); fixed before 26-pass rerun. First final UI typecheck failed on missing optional `priceProvisional` interface field; fixed before final typecheck/build. Earlier 0059 browser 5/7 failures were fixture FX rates; explicit synthetic rates fixed before 7/7. No historical browser failure is being hidden as a pass: that run was interrupted with no file result.

## Migration ownership and restore caveat

Root reserved **0059_invoice_debt_installments.sql** and then **0060_historical_treatment_documents.sql** exclusively for this slice; 0060 reservation followed root's 21:38 UTC main/open-PR collision checks. Preserve 0052–0055 Ortho, 0056–0058 HR. This branch intentionally has 0001–0043,0059,0060; do not invent missing migrations or renumber another author's files.

Both migrations are registered in canonical bootstrap, numbered runner expectations, schema ownership, reset and backup/restore handling. The 0060 SQL and bootstrap string match; the 0059 file was not rewritten. Schema contract: 92 application tables. A dormant periodontal candidate is represented as **test-only 0061**; no numbered 0061 migration was created or reserved.

0060 also replaces the debt-schedule insertion guard to permit restoring an archived schedule whose current opening was cleared **only when matching patient/currency opening history proves prior principal**. Application writers still refuse a new collectible target without current opening. Backup soft-dependencies order opening history before arrangements, and agreements/coverage before ordered historical revisions. Root should explicitly review this additive restore guard change.

## Earlier narrow checkpoints

- 0059 wired checkpoint patch SHA256 `a5a6c6e362d3f304146d500db10c7f1a3125ab4954deafb20bda655199ee96de`; frozen source `428227…`; build `Sq7w1dnRMZgdWWPJIHpjO`. Earlier pricing checkpoint is separate and already held by root.
- Historical core's exact 10-file delta from that checkpoint: `aa0281ed3508ece7c1b2c774fe27c0393fc178bbbf2d9119f79579bf55b674ec`; frozen source `f074a8…`; 48 PG pass. At this earlier boundary mixed UI was preview-only and 0060 had not yet been assigned. Do not confuse it with the current wired WIP.
- Private Library review package IDs previously delivered to root: core `libfile_a227a7158e80819187cbef05c32485a1`, 0059 wired `libfile_e6e99ff1d1488191a3961881894ec2f2`. Those contain exact pre/postimages, patches and raw bounded evidence; current Git source supersedes them as the handoff implementation.

## Account discrepancy and acceptance still needed

Source distinguishes clinical plan remaining (noncancelled item total minus completed item total) from posted financial debt (invoice/opening principal minus applicable posted payments/credits, per currency). Billed but unfinished work can also remain in the plan number. Therefore 252500 SAR plan remaining versus 250000 SAR ledger debt does not itself prove an erroneous debt or prove that exactly 2500 is unbilled. No patient record was accessed. Do not collect planned work solely because it appears in plan remaining.

Root's exact next step: review this WIP source and migration/permission overlaps against the chosen final integration base, then run the focused historical built-app file on a fresh matching build, resolve the unfinished points above, and run the combined financial/clinical preservation suite. Acceptance must cover heterogeneous new/historical lines, 300000/120000/180000 without invoice/receipt, same patient/site/currency, existing plans/drafts, repeat visits without duplicate billing, exact replay, permissions, whole-currency opening schedules and append-only correction. Implementation is stopped here.
