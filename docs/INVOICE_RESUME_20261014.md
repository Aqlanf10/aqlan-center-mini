# Invoice completion — resumed, not release-ready

## Source truth

Resumed original saved worktree `/workspace/compat-invoice-03d325a8`, clean at `1a19d65f7621e7ebf30c30699d938cd4dbdc9e42` / tree `08e9b9091340865f8d0e59851cbfd62f78aa10cd`. New branch: `feat/invoice-resume-20261014`. No prior local work was discarded.

Read-only remote verification on 2026-10-14: main `148fcbeac229cb279848e6ea37049d1599a4fafe`; `feat/invoice-completion-local-20261012` and handoff both `1a19d65f`; reception PR327 `d9690edf747d34da2195badb9c7b7863e7270abd`; design staging PR329 `175957f4e074d28b819d00a51f3f1e6d53b3d78b` / tree `be6da19feeafa9f0e89b91cf7082154be5f6f64e`. These refs were fetched for inspection, not merged.

Coordinator-only continuation `5df523be39e6ef589b7f19d6e7d07636793df4f4` / reported tree `91d8eb4b6f38f6564fdbc79035b061e7037ff0aa` is **absent** from this Git object store and saved worktrees/review folders. No claim is made about its implementation or tests. Requested its correction/account-refresh/print delta rather than recreating known independent work blindly. Continue independent recovery work meanwhile.

## Identified approved invoice reference

Coordinator resolved the owner's 2026-10-12 21:09 “ممتاز التصميم” approval to the four local app previews shown at 21:05. Files remain at `/workspace/reviews/invoice-workspace/owner-preview-final/images/`; manifest created at 21:00:04 records preview build `5w_ynkOekx5xQ771hhwYH`. All four images were reopened on resumption. This is the invoice reference, distinct from the patient-file designer's gallery and current Staging appearance.

| File | SHA256 |
|---|---|
| new-treatment-1280.png | `33df4ec1c33713dab85facd4d36dc667482dfb31f29bdf8e88a4c5dd8d1872aa` |
| new-treatment-390.png | `f7dc46bde712454297c90b631840b7fd86ea29f4f3a263a05c823e9686f62c97` |
| historical-design-1280.png | `aa28b39ac4db9a0078cc341f0ef7af8bc16147d4022d928b7d3fddfb395dca8f` |
| historical-design-390.png | `6dc89aae30133ae31124671055ce68de709d97855800ca57a4473b97494d14cb` |

Images are evidence only, not included in Git. Historical save was intentionally disabled in that preview; current functionality needs new actual-app evidence. No general patient branding/sidebar changes are authorized in this slice.

## First bounded checkpoint

Added `lib/financial-command-journal.ts`: actual IndexedDB transactions persist immutable original intent before sending, isolate actor/patient namespaces, arbitrate simultaneous tabs, preserve uncertain commands, and leave a revision tombstone after validated completion to refuse stale drafts. No auth token, role authority or financial truth is stored. Browser data is recovery evidence only; server authority still controls every write. Payload is erased after acknowledged completion. Storage failures fail closed.

**At this checkpoint the journal is not yet wired into application writes.** Browser primitive checks are not end-to-end financial recovery acceptance. Next: wire create/historical/debt flows; add actual lost-reply → reload → exact replay and concurrent-tab journeys. Integrate coordinator correction changes when available; follow the full original handoff's unresolved items.

Observed on preserved application build `Vpjrxt770vqdC8eIXBAep`, disposable local PG18.6 only:

- Historical baseline: admin save/reload passed; reception save remained disabled. Cause confirmed by source and rerun: synthetic discount limit was 0% for its 6.25% positive-case discount. Fixture explicitly permits 10%; app/default authority unchanged.
- `resume-20261014-journal-browser`: historical app file **7/7 passed** after fixture correction. New journal test initially failed because the test bundle was not assigned to `window`; no product failure claimed from that harness error.
- `resume-20261014-journal-browser-fixed`: actual Chromium/IndexedDB **5/5 passed** (reload, actor/patient separation, two-tab race, exact acknowledgement/stale draft, original preservation, unavailable storage). Source snapshot `f5a340f2fa666ee2046814368a807561453886d9df38012c78dd003eb961a20c`; log SHA256 `f134d74d294f369581cac219a79ccd659873a0b14f7559b0078635498916e2ce`.
- Typecheck passed at source `1e256b681c08126af12d0993f464d8d7b16671fa93d39631c28a0022f9e8b347`, before the test-only bundle assignment fix. No final integration type/lint/full-suite pass claimed.

Raw logs/command records remain in `/workspace/reviews/invoice-workspace/`. No patient data, credentials, build outputs or bulky evidence are committed. No live database, deployment, merge or CI alteration.

Migration ownership remains 0059/0060 as documented in `INVOICE_INSTALLMENTS_COORDINATION.md`; no new number allocated or migration added. Shared integration review with reception must cover `lib/db.ts`, `lib/http-permissions.ts`, `lib/audit.ts`. Its checkout implementation was not copied.

## Second checkpoint — recovery connected to writes

Invoice and historical entry now persist the complete original command and receipt expectations before network submission, restore them on reload, and clear them only after a fully validated receipt. Debt arrangement and collection use the same journal. Competing tabs adopt the already-persisted command instead of sending their own different key. Other financial entry controls stay blocked while recovery is unresolved. This does not yet cover general collection or correction dialogs; those remain open integration work.

Observed evidence (disposable loopback PostgreSQL and synthetic actors/patients only):

- Production build passed: `build-resume-20261014-journal-wired`, build `cE0exICVXG-3F-wNypNtt`, source snapshot `34249848dfd7e4606e6c029a277cf86494de47fef77386ba0bee49044d94f7d4`, log SHA256 `c5e905ef0cceb3caf4f43ba49bd643f4fa2f8f0e9b78a107c3b4f14ba5fadb95`.
- Focused lint at that source passed with zero errors and one existing `previewOwner` dependency warning; log SHA256 `67ccc07b0c6c79ec81ad804cb9eb1261d4ec9485e72f0034b04fab9854bc486a`.
- `resume-20261014-reload-http-first`: **22/22 passed** at that same source/build. New invoice and historical document journeys include lost and malformed replies, reload, exact-body/key replay, and one persisted document, for admin desktop and reception mobile. Log SHA256 `706948a1e7b316c0f44df7b86535e76ea52ec143ed4dc9f1a1af31e1de41b1e3`.
- Bounded React hook fixtures now expose stable setter identities and an empty ready journal; real storage remains covered by Chromium tests. Existing feedback tests were adapted from the retired single-line legacy form to the historical invoice form, preserving refusal/notice/body assertions. `resume-20261014-feedback-microtask`: **4/4 passed**, source `a188ca8362bde4b3a00488af5aed0f156dd33a94ea8eaa0df2447a9dcea0f8ef`, log SHA256 `0da084d96284c9050c4cce833860bb0dd632d5cc507805db2ad0eec70e21a381`. The transport schedules fetch in a microtask; success retirement is asserted before that microtask runs.

CI for checkpoint `62f22cba` failed at the money aggregation guard. Local reproduction identifies `unallocatedPaidGuard` in `legacy-treatment-document-db.ts`: refunds already join on the payment currency but the explicit GROUP BY omits that currency. This needs a product SQL correction, not a CI/allowlist exception. Remaining artifact-upload failures occurred after the first guard failure; no green CI or final acceptance claimed.

Owner subsequently requested two proposed invoice/historical images matching the designer's premium gallery before visual publication. Generated proposals are review material, not actual app screenshots; no redesign was applied here. Exact reference HTML download is blocked, so its reported hash is not locally verified. Designer branch `4538f57bb0171ee8d4b9428316633b331e024c0b` supplied the inspected account/summary reference images.

The owner supplied `invoice-cloud-handoff.zip` on 2026-10-14. Library metadata resolves a 222,059-byte archive (`libfile_a62b086db2bc8191abde49338cfe59dd`), but signed download returns proxy 403, including after approved network escalation. Its contents have **not** been read, verified, or applied. The unpublished coordinator continuation remains unavailable; an accessible Git ref was requested.

Final bounded checkpoint checks: `resume-20261014-checkpoint-types` passed; `resume-20261014-checkpoint-units` passed **133/133** across recovery labels, legacy reconciliation preview and write feedback. Both tested source `e12a260914b5cfec12614f4bae8a7b67eaed4d4195c1a232b58eaff85931dce9`; respective log SHA256 values `494c5900ca50ac372426c03ff676bd53571e0b70b3e4fe8eed6ce84138fd526d` and `682b6319044e5dc43ca4b80fbf39bf6d04640c535ebbe9941ab1377c512aae40`. Only this evidence paragraph was added afterward. No broader suite pass implied.

## Third checkpoint — historical edge cases and concurrent acknowledgement

Owner explicitly instructed continuing from available code without waiting for the inaccessible coordinator package. `5df523b` remains unreceived. Owner approved the two new premium invoice proposals on 2026-10-14 01:03:51 UTC (relay evidence `Sentinel_feda0f25fbd881919ea9615f5ae68440`). Approved Library IDs: new invoice `libfile_4fa53d4168548191afa4ebd4c3116791`, historical `libfile_ca16db8c99ac8191ba5b6fc4af484593`. Their SHA256 values are `2b48fc7cda6ff6775142341b9745140b85cc0c4a7b4f05275bf8b9df1a3e31a6` and `315c160e138724ff4a367a0624756bec5227b70f9916cecdd06490af67915487`. Approval authorizes implementing the proposed layout; it is not permission to repeat the rejected crowded Staging interface or publish without actual-app evidence.

The journal now keeps only a key/kind/original-hash completion marker after clearing sensitive payload. An exact retry or acknowledgement from a second tab stays idempotent; a stale different command still fails closed. Real Chromium journal checks passed **6/6** (`resume-20261014-journal-ack-browser`, source `0a2feda6c6c455588835062d09f239edb6ad8b83c34c1f66553e4a7595867367`, log `8fba321baa35ddbce090300ff89782defb0f952b60a8cd99c876b4428422e483`). This specifically exercises the freshly bundled journal; the application build at that point predates this additional completion marker.

Three newly added PostgreSQL regressions first failed, demonstrating separate jaw groups rejected, fully-paid work changing an unrelated opening date, and historical evidence disappearing after manual opening adjustment. Fixes preserve the existing opening on zero additions and keep historical reads available while refusing unowned corrections. Grouped services now use distinct case identities; **0060** also adds a deferred immutable-coverage overlap guard so this is not merely removing a uniqueness check. Single-tooth uniqueness is preserved, unknown legacy coverage is conservative, and actual overlapping groups remain rejected. The deferred check observes the complete restored snapshot at commit; an initial immediate variant failed the backup/restore test and was corrected before this checkpoint.

- `resume-20261014-historical-groups-restore`: **29/29 PostgreSQL checks passed**, including historical documents, immutable coverage and canonical backup/restore. Source `f054dcd514c126db4b74e5558cb8b369132e70cee4f3ed00eda34ad30010b301`; log `bc4892030ee9d27215e75c11e0d088acab58fcfd942ccb4a41a8d8cae0535b41`.
- Regenerated current schema contract from fresh disposable PG18.6: 92 tables, 1,206 columns, 1,165 constraints, 288 indexes, 36 triggers. Baseline contract and CI rules were not modified.
- `resume-20261014-schema-owned`: **19/19 passed**; migration/runtime ownership and current manifest. `resume-20261014-historical-types` also passed. Source for both `a7622ec7fad1acdac0c3268689d6bf17704e538dfbc7bbf86424d0f3a16b623f`; schema log `ffa6a06dad02a749aa27d57e0844f57247106e962f1ec18e40e3959a34262ee9`.
- Money guard passed after adding the existing payment currency explicitly to GROUP BY; no allowlist exception (`resume-20261014-money-guard-fixed`, source `626526c8d1e5ce9ee217187a16312e6a210aeaaa9cdfb0d98dd72ecac690bdce`, log `9c0a4f2e4de676364f5b67d8189c427b541fd54ddd77d41aa3bb286759a43f78`). Later changes do not modify that query.

UI redesign and complete corrections/general collection recovery remain in progress. These bounded results are not a final integrated release claim.


## Fourth checkpoint — unified approved entry, not full correction completion

New/historical type selection now sits inside the same invoice form; historical date and previously-paid facts appear only for historical origin. Services, scope/teeth, provider, price, quantity and total use a desktop table and a narrow-screen layout. The financial summary is singular; existing-plan/clinical linkage details are expandable and installment fields appear when chosen. General patient layout/sidebar files were not changed. The existing ordinary issued-invoice trigger now says “تصحيح الفاتورة”; its underlying reduction-only behavior is **not** the complete newly requested correction workflow.

Actual app evidence and acceptance matrix are in `INVOICE_UNIFIED_ACCEPTANCE_20261014.md`. Owner-visible Library IDs: `libfile_0945478048e081918997fcee554d07cc` (new), `libfile_7d6e9390af5c8191b8941fe884297910` (historical). These are real synthetic local app screenshots, not generated proposals, and do not yet show the unfinished correction workflow.

- Build `Focxkb3mrpYNXj8qNzniQ`, source `0455776bff25f883492230497bb97c6882503d4d1ef916a454661feaee31aac8`: build/typecheck passed; focused lint zero errors / one existing warning; visual + tooth + first-invoice HTTP batch **16/16 passed**.
- First premium HTTP run was **33 passed / 2 failed**: successful clinical details had moved into collapsed disclosures. Tests now open the actual disclosure before asserting its visible contents; the revised tooth/new-invoice batch passed.
- Broad unit discovery: **9180 passed / 10 failed**; this discovery run spans a UI-only source change and is not pinned release evidence. Corrected old fixtures/source contracts/migration docs; reran without the local runner's preclassified DATABASE_ENVIRONMENT: **123/123 passed**. No CI rule or timeout changed. One exact read-only preview route remains unclassified in the audit coverage guard; see the acceptance document.
- At checkpoint request time, `resume-20261014-unified-acceptance` was still running on the already built application. It had found one provider journey failure and two explicit-selection/lost-reply failures; diagnosis and reruns pending. It must not be reported as passed. Adding this checkpoint documentation while it runs does not change its built application.

Latest owner requirement adds full post-issue corrections (ordinary + historical), including clinical identifiers/providers, increases/decreases, discount/terms, reason/audit/original retention, idempotency, period/shift locks, existing receipts/commissions, executed-work conflict handling and credit settlement without automatic refund. This scope is **not complete**. Receipt correction remains a separate requirement. The unreceived 5df continuation is still not claimed, and no final integration head or Staging publication has been accepted.

## Fifth checkpoint — journey recovery and exact audit classification

The fourth checkpoint is remote `2232ff135ef8ab89b78c7a63f2c6be78c790b517`. Full six-file acceptance completed at 54 passed / 4 failed; the failure paths used the retired ordinary Save retry instead of the retained-command retry. The repaired tests keep all single-invoice/body/key assertions and now explicitly assert the ordinary Save lock. Provider reset is exercised before submission, followed by frozen provider/service after ambiguous HTTP 503.

Three-file follow-up: 33 passed / 1 failed, no unhandled errors; the last failure was the new test expecting null instead of the JSON-omitted provider. Corrected to assert property absence; the focused provider journey passed. Actual clinical journeys (Ortho, Endo with response loss, Endo→Crown with competing tabs) and all six explicit-plan selection journeys passed. Exact logs, hashes and remaining limitations are in `INVOICE_UNIFIED_ACCEPTANCE_20261014.md`.

Coordinator relayed explicit owner instruction to continue through full correction completion, and specifically authorized the historical read-only preview classification. Added only that exact documented exemption without changing the guard or workflow. Audit 14/14 and historical PostgreSQL 17/17 passed, including an added assertion that preview makes zero financial/clinical records. This checkpoint does not finish the expanded correction scope. No Production/Staging access, deployment or merge.
