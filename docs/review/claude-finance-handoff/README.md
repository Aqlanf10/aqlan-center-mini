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
- [#392](https://github.com/Aqlanf10/aqlan-center-mini/pull/392): pristine unpaid six-direction currency candidate; activation remains blocked. Exact composed recovery/restore artifacts are being published separately and are intentionally NOT duplicated here.
- [#394](https://github.com/Aqlanf10/aqlan-center-mini/pull/394): Vitest mocker security repair.
- [#395](https://github.com/Aqlanf10/aqlan-center-mini/pull/395): schema index owning-constraint catalog repair.

## Integration and release boundaries

Start from current main, identify overlap and choose one canonical financial implementation. Preserve immutable receipts, currency-specific minor units, source identity, fail-closed authorization, exact idempotency, rollback and audit invariants. Port useful tests rather than assuming old mock contracts describe new behavior. Require real isolated PostgreSQL 18 evidence where transaction/concurrency behavior matters; full Node 22 typecheck, lint, unit, hosted security/browser and required-completion gates on the final composed SHA.

Production deployment remains paused due to the current Railway security incident. A green branch is not release permission. This PR does not resolve that incident or change credentials. Source code, workflows, dependencies, migrations, environment and production data are unchanged by this handoff. No raw logs, internal notes, credentials or real patient records are included.
