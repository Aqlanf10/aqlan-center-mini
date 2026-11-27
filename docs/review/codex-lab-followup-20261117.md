# Grouped laboratory follow-up, 2026-11-17

This is a bounded laboratory repair checkpoint, not the completed non-orthodontic candidate. No merge, deployment, live database connection, schema activation or permission change is included.

## Verified source inputs

Read issue #483 and its final handoff; checked remote refs rather than relying on the handoff's historical values:

| Source | Verified head |
| --- | --- |
| `feat/claude-grouped-lab-order-0136-20261117` | `ba468764adf0c530691585c553207c0bd45b47c0` |
| `feat/claude-non-ortho-candidate-20261117` | `c8580ebc4d0c8a3dd255d4919e1cda0bafe1bc23` |
| `wip/claude-shared-lab-cost-0134-20261116` | `b2580abcb0491f0af6b79a2b9a19c1d2b1dc2ffb` |
| Integration #541 | `4e88b6a791d859cc9a066888f54c0eddff91dde7` |

The independent working branch is `codex-grouped-lab-followup-20261117`, based on the published 0136 head. Unpublished changes from another environment were not available or assumed recovered.

At the initial CI read, run 43989495408 on `ba468764` had failed quality/unit, passed synthetic print, skipped browser/HTTP, and still-running PostgreSQL. #541's historical CI was green, which does not certify this branch. The failed job log download returned HTTP 403. Local readiness scanning independently reproduced inventory drift: its source digest was stale. Regeneration changes the digest only, keeps NOT_READY and all classifications, and does not relax assertions.

## Repairs

- The commission query now retains the currency alongside every tooth's immutable price. For multiple doctors, mixed, mismatched or partially missing monetary weights hold the deduction and increment the existing visible `labCostNotDeductedCount`. They cannot silently weight SAR against YER. All-missing prices retain the existing equal-weight behavior; comparable prices retain the existing split. The manual payable remains one payable in its explicit currency. A sole known member doctor receives the explicit manual total without comparing tooth prices, preserving that existing path.
- Grouped member attribution takes precedence over an incidental visit doctor. The old order/visit fallback remains for orders without grouped members.
- The laboratory board shows the tooth number, clinic service, mapped laboratory service and price in its own currency, or pending cost. The financial member-price collection is separate from the clinical member collection. Canonical reads expose prices only with their existing cost capability; legacy doctor reads omit the new collection when cost access is absent.
- External dispatch stays on its existing allowlist. The member-price collection, internal notes and grouped free instructions are not added to it.
- Reviewed and applied the four-file source-label repair from `b293486472ffdf70dd2066ad005ed7786df73ca4`; an unsent invoice order no longer claims a signed-visit origin.

## Reproduction and verification

The new mixed-currency regression was run against a detached `ba468764` checkout with only the new test copied in. It failed at the expected commission assertion: the first doctor incorrectly received a 180-minor-unit deduction, with zero exceptions. The fixed implementation passes that assertion with no deduction and one exception per affected doctor.

All database work used a new local PostgreSQL 18.6 container bound to loopback, synthetic data only. Initial runs used host Node 24; the decisive rerun used Node 22.23.5 and `npm ci` against the unchanged lockfile. Early harness failures (missing synthetic session secret, stale installed lint dependencies, missing Playwright browser) are not passing tests.

- Node 22 PostgreSQL: 54/54 across grouped order, commission lineage, automatic doctor attribution, canonical reads and canonical dispatch policy. The grouped suite includes two concurrent identical submissions, both successful, yielding one invoice/order/payable and a matching replay.
- Focused Node 22 units: 86/86 across grouped contract, source labels, dispatch privacy/print privacy, patient lab query and audit inventories.
- Typecheck: passed. Scoped ESLint: zero errors, 12 pre-existing warnings in the touched board/patient/lab files.
- Production build: passed locally with the locked dependencies. One existing dynamic-filesystem tracing warning in `lib/migration-files.ts`; no security warning blocked this run. This does not replace dependency audit or hosted CI.
- Built-app browser: 3/3 on Chromium at `/usr/bin/chromium`, after fixing the test to select the existing unsent filter. Verified invoice grouping, displayed tooth prices and legacy doctor price omission over real HTTP, missing-price warning and settings mapping. The managed-browser download was blocked with HTTP 403; the installed system browser ran successfully.
- Full units: running with the CI-style environment on source `d0babec218a8db38d96f85a1bad9105d0904ca49` at report creation. Two earlier incorrectly configured full runs were interrupted (missing synthetic SESSION_SECRET, then extraneous DATABASE_ENVIRONMENT causing environment-contract failures). No full-pass claim is inferred.
- Source checkpoints: `ce1593b9080f602ade73f296ceab285dbf41ded4` contains the currency/visibility/source-label repair; `d0babec218a8db38d96f85a1bad9105d0904ca49` adds the sole-doctor preservation case. The 54 PostgreSQL assertions passed against the latter source. Browser 3/3 used the first checkpoint; the only later product change is the sole-doctor commission branch.
- Full PostgreSQL, full HTTP/browser matrix, migration upgrade rehearsal and final-head hosted CI are not certified by these targeted checks.

## Publication boundary

Read-only Railway configuration inspection showed staging-web and production web tracking `main`, with no staged changes; the backup runner uses an image. No variable values or live database contents were read. This new branch is not a deployment source. Repository workflows deploy no application on this branch, and no PR or deployment operation is part of this checkpoint. A manually dispatched CI workflow is test-only. The token could not enumerate GitHub webhooks (HTTP 403); Railway's direct source configuration was checked instead.

Only source, tests and this report are intended for publication. Logs, generated browser screenshots, runtime state and build output stay local and ignored.

## Remaining separation work — not implemented here

1. **0079 is still present and active in the inherited base.** Do not call this the finished non-orthodontic candidate. Its SQL and embedded source remain byte-identical. SQL SHA-256: `5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99`; embedded-source SHA-256: `b4e70b75c3967b2e3dce85e4beecb912f75e2bdf8534713c38e7bde80576f9a9`.
   Removing only runtime registration is insufficient: `loadMigrationFiles` still discovers SQL, and `migrationStatus` considers unknown applied versions inconsistent. The separate cut must preserve the exact historical contract and registry while suppressing fresh application and new writers, then prove both fresh and already-populated synthetic databases without deletion. No such cut or proof is claimed here.
2. Finance 0128/0129/0133 and owner funding 2108 have not been extracted from #541. Preserve source contracts and tests in `docs/finance/EXPENSE_COMMANDS_0128.md`, `SHIFT_OPENING_REVIEWS_0129.md`, `EXPENSE_REQUEST_RETIREMENTS_0133.md` on that source head.
3. Booking/Rx migrations 0090–0093 and the drug-catalogue capability still need extraction from mixed orthodontic commits. Do not cherry-pick their entire source commits into this branch.
4. 0134 remains the incomplete independent WIP; it was not integrated.
5. Daily adjustment steps were not edited. The requested A/B dependency comparison (minimal 0109 support versus main-screen extension) and its owner decision remain open; excluded workup/navigation/cephalometric changes were not imported.
6. Rehearse the eventual extracted candidate against synthetic copies of both old/new migration histories, including the 0125 history; retain all historic records and fingerprints. No live staging rehearsal is authorized.
