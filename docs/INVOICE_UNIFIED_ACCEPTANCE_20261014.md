# Unified invoice / historical agreement acceptance

## Verified source and isolation

Saved worktree: `/workspace/compat-invoice-03d325a8`, branch `feat/invoice-resume-20261014`. Last pushed checkpoint before the UI review: `a36ccc491cfd2d7f4ebde50571fd1d165765a62a`, tree `91c570a040e55a02f17a760093ccf0a7cc0eb2e8`.

Read-only GitHub/API and local Git checks on 2026-10-14 verified main `148fcbeac229cb279848e6ea37049d1599a4fafe`, PR308 `8ff09304ef3fbf8f01f04a1f09de2a08f6c403c5` (tree `349aa17ce31646bae0d2fdb79f4471b529f65314`), and PR322 `443fd28f330f5f9bdda0ba6cfc67cfe30b12cff1` (tree `538d0bd685d341744176cd5b985bb46824a26644`). Git confirms PR322 is an ancestor of that PR308 head. These are reference heads, not the tested final integration head. The unreceived coordinator continuation `5df523be39e6ef589b7f19d6e7d07636793df4f4` is not claimed.

AGENTS.md and installed Next route-handler documentation were read. No executor skills are exposed in the resumed environment. The inaccessible ZIP was not read or applied; the owner explicitly authorized continuing without it.

Actual capabilities: Node 22.23.3, installed Next 16.3.8 / React 19.2.8, Vitest 4.1.11, Playwright 1.63.0, system Chromium 151.0.7922.173, Docker PostgreSQL 18.6. The disposable container is `aqlan-invoice-acceptance-pg18`, loopback port 55439; PostgreSQL suites use `aqlan_p1_test`, the HTTP harness creates/drops `aqlan_sec_http` and serves the built app at loopback 3322. Unit tests also support isolated PGlite. Tests use synthetic actors, patients and catalogues. No Production/Staging database, deployment, merge or CI-rule change.

## Acceptance matrix

| Area | Required acceptance | Existing automated coverage / current evidence |
|---|---|---|
| New treatment | One invoice command atomically creates/reuses the intended plan items and specialty cases, with no clinical consent invented. | `postgres/invoice-clinical-linkage`, `invoice-template-linkage`, `invoice-first-signoff`; HTTP `invoice-first-ui-journey` and `invoice-tooth-chart-journey`: 12 checks passed on UI build `Focxkb3mrpYNXj8qNzniQ`. |
| Historical aggregate | 320000 gross − 20000 discount = 300000 agreed; 120000 paid before system; only 180000 opening principal. Zero fake invoices, receipts, historical cash or allocated per-line paid amounts. | `postgres/historical-document-storage`, `historical-debt-repayment`; HTTP `historical-document-workspace-ui`. Prior PostgreSQL historical/immutable/restore batch: 29 passed; historical HTTP batch: 11 passed on first premium build. Later UI integration rerun recorded separately. |
| Existing records | Preserve existing plans, patient links, specialty identity, assessment drafts, signed work and clinical consent. Ambiguity requires explicit selection; refusal is atomic. | `postgres/invoice-explicit-selection`, `invoice-journey-financial-containment`, `legacy-treatment-identity-drift`; HTTP `invoice-explicit-selection-ui-journey`, `invoice-clinic-continuity-journey`. Final combined head not yet supplied/tested. |
| Site and currency | Separate per-tooth treatment; grouped arch/case value once; native service prices, patient/case/site/currency alignment, no implicit foreign-currency conversion. | `invoice-catalog-price`, `invoice-tooth-selection`, PostgreSQL `invoice-catalog-authority`; actual HTTP tooth selection: 9 passed; both desktop/mobile visual states passed, including 16 + 17 and both arches. |
| Repeat visits | Use the already-covered plan item/case; signing/follow-up cannot create another invoice for the same treatment. Preserve historical coverage. | PostgreSQL `invoice-first-signoff`, `invoice-journey-financial-containment`, `legacy-treatment-immutable-coverage`; real HTTP continuity journeys. Must rerun on final reception/clinical integration. |
| Idempotency and recovery | Exact duplicate/retry returns one original result; changed payload/key conflict; lost/malformed response survives reload; another tab cannot mint another financial command. | Journal Chromium primitive 6 passed; new/historical application reload batch 22 passed; premium first batch debt + historical 22 passed. General collection and correction journal wiring remains incomplete. |
| Permissions and races | Current server authority, patient access, discount limits and session revocation checked under transaction; stale catalogue/version/source rejected. | PostgreSQL catalogue/history permission checks and HTTP reception/admin journeys; doctor next-step reads passed. Latest full correction authority/revocation matrix remains unrun. |
| Installments | Schedule allocates the actual remaining debt once; partial collection preserves receipts; schedule revisions do not increase principal; whole-currency opening schedule remains singular. | `postgres/historical-debt-repayment`, HTTP `debt-repayment-workspace-ui`: 11 passed on first premium build, including reload recovery. |
| Unified layout | Type choice inside one invoice screen; historical-only facts appear only for historical origin; one financial summary; usable 1440/390 layouts without horizontal overflow. | NEW HTTP `invoice-premium-visual-review`: 4 passed on real app and local PG. Actual screenshots supplied below. |
| Correction after issue | Explicit “تصحيح الفاتورة”, required reason, old version retained, audited delta, increase/decrease, unpaid/partial/full/history, exact retry/concurrency, period/shift locks, payment/commission preservation, installments and credit settlement. | Existing ordinary correction is reduction-only; existing historical backend appends financial revisions preserving clinical identities. Neither meets the complete new requirement. Historical editor, general correction recovery, safe clinical identity amendment and overpayment-credit settlement remain unfinished. Existing correction tests do not prove this expanded scope. |

## Plan remaining versus posted debt

`lib/plans.ts:planItemsProgress` totals noncancelled plan items and subtracts completed item value. This is clinical work remaining, independent of invoice/payment settlement; unfinished billed work may also be included. `components/PatientPlans.tsx` displays that value as “باقي العلاج” when the installment-progress branch is not selected. Its installment branch instead displays `plan.progress.remainingMinor`, derived from the agreement/plan total and payments.

`lib/money.ts:patientBalancesByCurrency` uses posted opening + net noncancelled invoices − net settled payments/refunds, separated by settlement currency. `lib/debt-account-position.ts` calls this same ledger engine. Unbilled planned work is not added to posted debt merely because it appears in the plan.

Thus 252500 SAR in a plan and 250000 SAR ledger debt can be different valid measures. Source alone cannot identify which branch the reported screen used or prove exactly 2500 is unbilled. No patient data was accessed. Do not collect the difference solely from the plan display.

## Actual UI evidence (not generated mockups)

Build `Focxkb3mrpYNXj8qNzniQ`, application source snapshot `0455776bff25f883492230497bb97c6882503d4d1ef916a454661feaee31aac8`. The 16-check visual/tooth/new-invoice batch passed with unchanged before/after source hash, log SHA256 `c8ed288ba23ba82f25b2d84285078b77714242e149bd4de5743d48998b44f622`. Typecheck/build passed; focused lint has zero errors and one existing `previewOwner` dependency warning.

- New treatment: `libfile_0945478048e081918997fcee554d07cc`, SHA256 `95815df0c33a52dfd04586bda266562ea379b2af65c3c48762af4b23a363d793`.
- Historical: `libfile_7d6e9390af5c8191b8941fe884297910`, SHA256 `f2f3dc5da29fbe880758832f56857b49b3c9d7ba600beb67f68e0767cad24bda`.

These are unsaved real application forms with synthetic catalogue/preview data. They do not depict the unfinished correction workflow. Full/mobile originals and capture metadata are in `.settings-ui-artifacts/invoice-premium`; immutable review copies are under `/workspace/reviews/invoice-workspace/unified-actual-20261014`.

## Regression findings and remaining gate

Broad local discovery run: 9180 passed / 10 failed across 516 unit files. The source changed only in UI files during that discovery run; do not describe it as a pinned final suite. Findings: currency fixture lacked the new transactional session dependency and configured catalogue flag; two source contracts expected the retired single-line historical path; new migrations were missing from the migration documentation; local runner set `DATABASE_ENVIRONMENT=test`, invalidating two tests that intentionally start unclassified; one runtime tracing check exceeded its unchanged 5-second timeout.

Follow-up on fixed fixtures/docs and unclassified unit runner: 123/123 passed, source `46d08656cb64a3a2ce60a24e2f90f7317a6e50b4bcdb02f0195653b53fd7eb7f`, log SHA256 `afc3627e2b4be8a83e0e5ccf2fc2ed2b6faecf33e44212ab4e8a039da77e7d1f`. Runtime tracing passed without increasing timeout. Source guards retain the canonical historical document writer and shared clinical decision reader assertions.

The remaining known audit-coverage failure identifies `POST /api/patients/[id]/historical-documents/preview`: the new endpoint performs a READ ONLY preview but is not registered beside the existing invoice/legacy read-only previews. No audit-guard/allowlist/CI rule was changed. Its exact read-only classification needs integration-owner resolution; fake financial writes or fake success audits are not a suitable workaround. No green full CI or release readiness claimed.
