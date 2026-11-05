# Claude finance handoff: UNAPPLIED review artifacts

This Draft is a documentation/patch inventory, NOT a mergeable feature, release candidate, or proof that all local work is validated. No patches have been applied to application source. Main was independently verified as `2667b71f815ee14781cdac6b37ebad3b4f8e246d` on 2026-10-21 at publication.

Claude Code owns financial implementation and integration from current main. Dot retains independent release review. Read each source and preserve its invariants rather than stacking all old branches indiscriminately. Re-fetch main and all candidate heads before integrating. No merge, deployment, Production writes, secret changes, backup deletion or new AI/Dot features are authorized by this artifact.

## Included, explicitly UNAPPLIED

See [manifest.json](manifest.json) for exact SHA-256, byte counts, source/base provenance and evidence limits.

- Statement settlement regression: one synthetic server-rendering test for reclassified settlement, partial reversal, three-currency positions, cancellation, immutable original receipts and non-cash explanation. Its source checkout reported 64 focused tests plus full Node 22 typecheck; these were not rerun for publication.
- Currency writer/route matrix: two test files with 47 previously passing mock tests. They encode the original v1 writer boundaries and must be adapted deliberately to a new six-direction contract. Mocks do not prove real PostgreSQL atomicity or concurrency.
- Legacy snapshot: an unmounted pure collector-output contract and 28 prior passing offline tests, exported together as a patch so no TypeScript file becomes active under docs. It always returns readOnly=true, executionReady=false, financialEffect=none. This is NOT recovered legacy-management implementation.

The legacy contract assumes a trusted collector supplies complete child sets, exact primary IDs, revisions and generation. Its fingerprint cannot authenticate input, prove completeness, authorize deletion or independently solve ABA. Recover and verify original cloud management source `199ea44c5768427123472b8149576629b78808fe` before adapting these vectors; its existence and content remain unverified. Do not invent an owner identity from admin role, username or environment defaults.

## Existing candidates, not duplicated here

[pr-snapshots.json](pr-snapshots.json) records exact connector-observed heads/state. These are snapshots, not approval or CI attestations.

- [#383](https://github.com/Aqlanf10/aqlan-center-mini/pull/383): visit financial source context. Observed head `95367f465a60bbc68310df6ef138c2f8bfe1bfac`; full hosted CI was reported green for that exact source, but it diverges from current main 2667 and GitHub reports mergeable=false. Six paths changed on both branches are NOT six proven textual conflicts. Port carefully and rerun the exact composed candidate gates.
- [#386](https://github.com/Aqlanf10/aqlan-center-mini/pull/386): supplemental hosted visits/PDF acceptance, not independent product code. Validate exact product pin, same-run PDF/preprint/raster evidence and manifest. Historical PR body notes may be stale.
- [#380](https://github.com/Aqlanf10/aqlan-center-mini/pull/380): unique monthly fixture work using REPORT_VISIT_TEMP_SCHEMA plus visit_procedures truncate/snapshot is missing from both main and #383; targeted adaptation is needed, not a blanket old-branch merge.
- [#388](https://github.com/Aqlanf10/aqlan-center-mini/pull/388): HTTP collection idempotency keys.
- [#389](https://github.com/Aqlanf10/aqlan-center-mini/pull/389): correction refusals and historical balances, combined with key-related work. Compare with #388 to avoid duplicate application.
- [#390](https://github.com/Aqlanf10/aqlan-center-mini/pull/390): externally authored dated agreement amendment, split settlement and stale recovery candidate; review its exact source independently.
- [#391](https://github.com/Aqlanf10/aqlan-center-mini/pull/391): test-only browser acceptance for #389, not runtime implementation.
- [#392](https://github.com/Aqlanf10/aqlan-center-mini/pull/392): pristine unpaid six-direction currency candidate; activation remains blocked. Exact composed recovery/capture artifacts are published separately in [#397](https://github.com/Aqlanf10/aqlan-center-mini/pull/397) and intentionally NOT duplicated here.
- [#394](https://github.com/Aqlanf10/aqlan-center-mini/pull/394): Vitest mocker security repair.
- [#395](https://github.com/Aqlanf10/aqlan-center-mini/pull/395): schema index owning-constraint catalog repair.

## Additional handoff and pending review (2026-10-21 22:27 UTC)

- [#397](https://github.com/Aqlanf10/aqlan-center-mini/pull/397): reviewed synthetic capture handoff, verified head `d236bf435ae2736cf627a13317d28b8f800eff48`, based on #392 `f2c9c98c2ac8c7a6f3fd3fdf89bc8c7afcc37dc1`. Source tree `1c7d6780a9f647e82ac18f0f6b917c7bc8fb2b47`; final tree with handoff documentation `d22f590edd3d9ca37623dd27ee7a4b0719dca14b`. Separate review reported verification of 156 unit tests and 6 real PostgreSQL tests. These results belong to that exact candidate, not current-main integration. No replay activation or Production permission follows.
- [#393](https://github.com/Aqlanf10/aqlan-center-mini/pull/393): duplicate-collection advisory on `feature/duplicate-collection-warning`, verified head `7279a3bab5be8e5391ef3a4b990a2add3f368eec`, recorded base `2667b71f815ee14781cdac6b37ebad3b4f8e246d`. The independent source review below supersedes the initial pending-review note. Dynamic race reproduction remains unperformed. The user explicitly forbids merging or deploying #393.

Claude remains the sole financial implementation/integration owner. Independent read-only review continues. These documentation links neither activate the candidates nor transfer authority to alter Production.

## Integration and release boundaries

Start from current main, identify overlap and choose one canonical financial implementation. Preserve immutable receipts, currency-specific minor units, source identity, fail-closed authorization, exact idempotency, rollback and audit invariants. Port useful tests rather than assuming old mock contracts describe new behavior. Require real isolated PostgreSQL 18 evidence where transaction/concurrency behavior matters; full Node 22 typecheck, lint, unit, hosted security/browser and required-completion gates on the final composed SHA.

Production deployment remains paused due to the current Railway security incident. A green branch is not release permission. This PR does not resolve that incident or change credentials. Source code, workflows, dependencies, migrations, environment and production data are unchanged by this handoff. No raw logs, internal notes, credentials or real patient records are included.

## Claude task: finish advisory-only duplicate-collection warning

The user explicitly included this task on 2026-10-21. Implement it as an advisory, not automatic deduplication: when the same patient has a collection for the same native amount and currency within 24 hours, show the prior receipt and time. Offer cancel or continue as an independent payment. Do not require a manager or mandatory reason, and do not automatically deduplicate, reverse or cancel recorded payments. Preserve durable idempotency keys and financial integrity. Integrate through Claude's current-main financial implementation, not a blind merge of #393. Preserve #390's distributed plan-routing behavior when composing overlapping changes.

### Independent review of #393: NOT READY

Reviewed source head: `7279a3bab5be8e5391ef3a4b990a2add3f368eec`. The following are source-established control-flow/interleaving findings, not reproduced real-database races or independent dynamic test results.

1. P1: A debt retry can observe no receipt from getPaymentByIdempotencyKey before the original request commits, then see that newly committed original in findSimilar and return 409. DebtRepaymentPanel's 409 path acknowledges/clears its durable operation despite the original commit. Preserve exact-key replay and unknown-outcome recovery through the entire check/write protocol.
2. P1: Requests using distinct device keys can both observe empty similarity prechecks, then both writers commit without a warning. This does not by itself establish broken accounting consistency; it means a pre-write advisory is not race-complete. #388's mandatory idempotency key does not solve similarity between distinct keys.
3. Omitting optional similarityReview bypasses the advisory protocol; the reversed-installment early-return path also bypasses it. Define and test intended advisory coverage without silently treating the warning as an authorization or automatic duplicate-prevention control.

[Hosted CI run 39678615032](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/39678615032): typecheck and lint passed; the money guard failed; unit, PostgreSQL, build and HTTP gates were skipped. The reviewed SUM is same-currency semantically, while the scanner recognizes only a literal currency filter and does not recognize the parameter/correlation proof. Repair the narrow query/scanner compatibility with explicit regressions; do not broadly weaken the money guard or claim the failed gate is green.

Independent dynamic tests did not run: the execution service disconnected before process creation. Existing evidence covers sequential YER and the common modal, not the above races or all collection entry points. Require targeted synthetic PostgreSQL/concurrent and hosted UI/HTTP evidence on the final composed SHA before release review. The user forbids merging or deploying #393. No Production or credential changes are part of this task.

Source references on the reviewed SHA:
- [Debt UI clearing/acknowledgement](https://github.com/Aqlanf10/aqlan-center-mini/blob/7279a3bab5be8e5391ef3a4b990a2add3f368eec/components/DebtRepaymentPanel.tsx#L122-L125); [debt precheck](https://github.com/Aqlanf10/aqlan-center-mini/blob/7279a3bab5be8e5391ef3a4b990a2add3f368eec/app/api/patients/%5Bid%5D/debt-repayments/%5BarrangementId%5D/collect/route.ts#L22-L28); [same-key writer](https://github.com/Aqlanf10/aqlan-center-mini/blob/7279a3bab5be8e5391ef3a4b990a2add3f368eec/lib/debt-installment-collection.ts#L21-L28).
- [Separate payment precheck](https://github.com/Aqlanf10/aqlan-center-mini/blob/7279a3bab5be8e5391ef3a4b990a2add3f368eec/app/api/payments/route.ts#L166-L177); [subsequent writers](https://github.com/Aqlanf10/aqlan-center-mini/blob/7279a3bab5be8e5391ef3a4b990a2add3f368eec/app/api/payments/route.ts#L199-L211); [direct-plan optional review](https://github.com/Aqlanf10/aqlan-center-mini/blob/7279a3bab5be8e5391ef3a4b990a2add3f368eec/app/api/plans/%5Bid%5D/route.ts#L71).
- [Earlier reversed-installment return](https://github.com/Aqlanf10/aqlan-center-mini/blob/7279a3bab5be8e5391ef3a4b990a2add3f368eec/app/api/payments/route.ts#L59-L86); [same-currency similarity/refund query](https://github.com/Aqlanf10/aqlan-center-mini/blob/7279a3bab5be8e5391ef3a4b990a2add3f368eec/lib/similar-collection.ts#L41-L61).
