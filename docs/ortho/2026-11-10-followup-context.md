# Ortho integration and retention follow-up — 2026-11-10

This slice follows commit `45e2814aac51310e3f930143f467ca51666094a7` on `feat/ortho-reconcile-20261109`, based on PR530. It is not full clinical acceptance or deployment authorization.

## Existing behavior and concrete gap

The retention ledger already recorded delivery, device-specific reviews and explicit follow-up instructions, with full-history source checks and correction lineage. The operational follow-up board always displayed retention recall as unavailable. Individual milestone tests existed, but did not compose all milestones on one service-created case.

## Implemented

- Read the complete verified retention history in the board's existing repeatable-read transaction, after patient ownership filtering. Reuse the ledger's source-permission and historical witness checks; do not begin a transaction per case.
- Return only instruction timing, date provenance, device/review identities, ambiguity and source-match state. Clinical notes, image IDs, source descriptions, device descriptions and findings are excluded. Unavailable sources withhold the complete context; unknown dates remain unknown.
- Show a compact summary and an accessible disclosure on the board. Show the evidence expanded in print. The original adjustment-derived due date and lapsed-treatment buckets remain disabled for retention.
- Fix the board’s existing “Ortho file” link to retain patient/case identity via the canonical navigation helper, and select the retention section for retention follow-up. The previous link opened only the generic treatment tab.
- Keep recorded intentions distinct from appointment booking and fulfillment. A later device review neither completes nor cancels an earlier intention. No lifecycle, scheduling, financial, migration or permission-policy write was added.
- Add one real PostgreSQL journey: service-created intake/bridge → assessment → explicit clinician review and problem creation → problem-bound strategy → explicit treatment start → actual signed visit/session → documentary retention → draft and documented study with all five source identities. Exact retries do not duplicate milestones. A neighboring episode of the same patient cannot borrow the problem or sources. Later strategy revisions do not rewrite the saved study.

## Validation

All fixtures are synthetic. Local PostgreSQL18.6 is isolated from deployed data.

- New integrated journey: 1/1 PostgreSQL test passed; targeted TypeScript and ESLint passed. The later test-only type fix uses the identical fixture string.
- Retention context and surrounding unit/UI contracts: 112/112 passed in6 files. After the compact disclosure/print adjustment, the affected subset passed27/27; these are overlapping counts.
- Retention context + existing ledger persistence + follow-up authority: 37/37 PostgreSQL tests passed in3 files.
- Existing follow-up worklist PostgreSQL regression: 12/12 passed, including account/ownership changes, expiry, audit rollback and current-case isolation.
- Initial full TypeScript invocation observed test typing errors that were corrected. Final Next production build, including its TypeScript gate, succeeds (build `PpApvcggdOz7hEY2R7EY_`). The initial failed invocation is not presented as passing.
- Changed-file lint for the retention slice: no errors; one pre-existing effect warning in the board. The new browser test also passes lint.
- Built HTTP/browser: final11/11 passed in4 files at390px/1280px. The new scenarios save documentary milestones through the real API/journal, read the real board, render print through the server, inspect the canonical case link and follow it into that case’s retention region. Existing booking-default, reminder and planned-case tests also pass. Screenshots were visually inspected. The print date assertions are document-wide, not an assertion of all PDF layouts.
- Extra board regression exposed13 failures in its shallow test harness/copy assertions. The helper now executes the actual pure context component by identity; hooked leaves remain isolated. Updated assertions retain source refusal, no stale adjustment date/wires, no booking-as-completion, patient isolation and exact URL keys while ignoring parameter order. Focused final rerun:44/44 passed in2 files (overlaps4 context tests above).
- Independent read-only review found no additional actionable defect in source authorization, timing interpretation, immutable source checks, or the final link/test adaptations. It did not independently run tests or establish clinical acceptance.

## Limits and remaining acceptance

O20 is improved but remains partial: an operational due/fulfilled/cancelled recall workflow needs an explicit relationship between the instruction and the event resolving it. This slice does not infer that relationship or reopen closed cases. Current closed cases remain outside the daily board.

Context admission is bounded: at most100 retention cases are enriched per board read,200 projected items per case and64KiB per context. Beyond these limits the context is unavailable, not a truncated history or empty result. Broader clinic-scale performance remains to be measured before acceptance.

The original [O01–O52 matrix](acceptance-matrix.md) remains a timestamped source audit. This additional evidence does not turn all rows into accepted clinical scenarios. Full illustrated export/archive authority, unsupported cast analyses, closure/reopening, actual migration-history reconciliation and staging isolation/restore acceptance remain outstanding. No production/staging deployment or main merge occurred. The Windows worktree and other-cloud partial integration patch remain unavailable and unapplied.
