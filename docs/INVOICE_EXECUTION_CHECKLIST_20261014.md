# Invoice execution requirements and evidence

Latest invoice-only repair: **13634e1f**, [parent financial refresh checklist](INVOICE_FINANCIAL_REFRESH_REPAIR_20261014.md). Collection/recovery/receipt/opening acknowledgement callbacks now invalidate parent workflow authority through the existing contract. Root before9 failed; after10 passed; focused units109 passed; build/static passed. Full final-head verification remains required. No design-owned file, new merge or deployment is included.

Branch: `feat/invoice-resume-20261014`. Execution resumed from independently verified remote `d8822f30660bd3f5cd19b99c2c4f3f1714bbf263`. Only the invoice writer is active. No main merge, Production access or patient-data access is authorized. No deployment has occurred. The latest scope permits invoice-only currency defect verification; no further merge or deployment is currently authorized.

Invoice delivery **961f498b** passed [required CI 38548186976](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38548186976), all 83 steps / zero skipped. The selected-service currency defect reported on deployed add3b2b5 is already repaired in that invoice source: [source/test/evidence checklist](INVOICE_CURRENCY_SWITCH_VERIFICATION_20261014.md). Fresh actual-app verification passed **19/19 browser/API** and **9/9 units**, with 35 before/after PNGs. The enclosing test/documentation follow-up retains identical application bytes and requires its own exact-head CI. The paused local design integration and its unresolved cross-owner refresh defect are excluded.

## Exact failed gate

GitHub run `38518088911`, job `115701627479`, at d8822f30 passed typecheck, lint, money scan, units, PostgreSQL, schema, operational journeys, audit, build, preflight and runtime gates. HTTP and the raw-category screenshot upload failed. `gh run view --job ... --log-failed` returned HTTP 403 from the signed results endpoint; the GitHub connector returned Transport closed. `gh api repos/Aqlanf10/aqlan-center-mini/check-runs/115701627479/annotations --paginate` succeeded and retained ten HTTP failure annotations and the absent-PNG error.

Local untouched-head reproduction used Node 22.23.3, installed Next 16.3.8, system Chromium and a new disposable `postgres:18-alpine` container, `aqlan-invoice-resume-20261014-pg18`, bound only to `127.0.0.1:55439`. HTTP creates/drops `aqlan_sec_http`, serves loopback 3322, and uses only synthetic fixtures. The restored environment contained a clean main checkout rather than the earlier `/workspace/compat-invoice-03d325a8` worktree. The invoice branch was fetched and checked out without discarding work. Earlier local evidence paths in older handoffs are absent from this restored filesystem; their committed reports remain historical evidence, not newly executed checks.

The five failing browser files reproduced **13 failed / 9 passed** on the unchanged d8822f30 build `ewegaeMUJuCCNJpFXg-Fv`:

| File | Exact failure / repair |
|---|---|
| `legacy-treatment-ui-journey.test.ts` | Retired single-line form, endpoint and preview-response assumptions. Tests now use the unified historical document and preserve original totals, no invented per-line paid allocation, no cash/receipt/consent, coverage, double submit, draft/key ownership, preview failure and A→B→A assertions. This also exposed real historical bridge splitting; historical prosthetic selection now retains one original episode value, while ordinary per-tooth invoice behavior is unchanged. The optional historical note is retained in the unified form and command. |
| `invoice-correction-ui-journey.test.ts` | Retired correction group/price/save/success selectors. The same persisted original/replacement and reception-permission assertions now use the implemented editor. |
| `legacy-reconciliation-preview-built-page.test.ts` | Independent Account sibling GETs `/debt-repayments` and `/historical-documents` were unknown to its strict interception fixture. Exact empty read responses added; every write and unknown read still aborts. |
| `invoice-visual-evidence-journey.test.ts` | Retired historical input plus a mobile provider/proof/Save span exceeding the 901px unobscured viewport. Invoice-local mobile summary spacing and payment choices corrected; geometry, all nine hit points, fixed viewport and all six required accepted PNG scenes remain mandatory. Native wheel framing waits for fonts and can reframe after Account siblings settle; no forced click or DOM scrolling is accepted. |
| `service-raw-category-display.test.ts` | Compact `ServiceSelect` hid the selected category entirely. Category text is again shown; duplicate catalogue price remains omitted in compact mode. The unchanged raw-category tests retain strict zero-write, financial-facts, label, geometry and both mandatory PNG assertions. |

Raw evidence lives under `/workspace/reviews/invoice-resume-20261014/`; generated images and logs are not committed. No timeout, CI workflow, security setting, tracing guard, audit exception or migration changed in this repair.

## Requirement-to-code and acceptance checklist

Statuses below distinguish prior implementation from acceptance still required on the eventual final invoice head.

| Requirement | Code / tests | Status |
|---|---|---|
| Unified approved new/historical form, native prices/currencies, service units, provider, sites, discounts and terms | `components/PatientLedger.tsx`, `InvoiceWorkspace.module.css`, `dental/invoice-tooth-selection.ts`; premium, historical, tooth and catalogue suites | Implemented; historical group and grouped-unit guards repaired. Actual new/historical forms cover all three currencies at 390/1440; final full suite recorded below. |
| Historical original/paid facts, opening debt only, canonical treatment linkage without fake cash | `lib/legacy-treatment-document*.ts`, `legacy-treatment-db.ts`; historical storage/coverage/backup, historical UI journeys | Implemented, including immutable original facts and current-positive opening-date recalculation. Historical storage/coverage/restore and actual credit/recovery journeys verify this; final full suite recorded below. |
| Ordinary and historical corrections, immutable original, reason/audit, installments, payments/credit and safe clinical identity changes | `lib/invoice-revision-db.ts`, `legacy-treatment-document-db.ts`, correction editors/view decoders; revision/history/commission/refund suites | Implemented guarded financial/terms and safe ordinary clinical identity amendments. Executed/shared/paid identity changes and unsupported pre-system credits refuse explicitly. In-system overpayment credits preserve receipts without automatic refund. |
| Durable recovery and two-tab serialization for creation/correction/collection/receipt correction, live permissions | `financial-command-journal.ts`, invoice recovery, correction editors, money command components; browser journal and recovery suites | Implemented exact durable recovery plus competing-tab creation/correction/collection/receipt correction; live server permission/period/shift gates retained. Full-suite results below. |
| Explicit visit in normal/catalogue/template intent, fingerprints, replay and acknowledgement; no latest-visit inference | `invoice-visit-context.ts`, `invoice-linkage-db.ts`, `invoice-template*.ts`; explicit-visit PG/HTTP suites | Implemented and repaired original-command replay through validated descendants after visit relinking; unrelated visits refuse. Explicit visit persists in commands, fingerprints and acknowledgements. |
| Correction-chain settlement/proof adapter, preserved original receipt IDs and stale-proof invalidation | `invoice-settlement-position.ts`, `invoice-settlement-lineage.ts`, `debt-installments-db.ts`; scoped settlement PG suite | Adapter documented in INVOICE_SETTLEMENT_ADAPTER.md; whole structured lineage/refund/proof coverage, original receipt links preserved; old unstructured replacements refuse explicitly. Reception-owned consumers remain paused. |
| Lock order patient → visit → invoice, including repayment schedules | invoice/repayment transaction writers | Implemented; real two-connection NOWAIT regression proves a waiting schedule writer has not acquired its invoice before the visit. |
| Exact final head full required CI/unit/PG/HTTP/browser/build, real screenshots, committed handoff | Existing CI and isolated harnesses | Pending; this checkpoint does not claim release readiness or Staging deployment. |

Reception remains owned by paused checkpoint `a91fec440709cc9e46fa7bc015da51eab42f8170`. Its no-additional-fee signature fix is not overwritten or copied. Combined consultation → explicit visit → no-charge signature → one collection task must be verified after coordinated reception integration. Invoice adapter work does not modify those screens.

## First repaired checkpoint verification

All five previously failing HTTP/browser files passed together **22/22** on fresh build `8H6KVtI_ZzgZKWQqk-_g3`. Both required raw-category PNGs exist. All six required visual scenes were accepted through the unchanged bounded stdout codec, decoded with SHA256 verification, and retained beside the actual historical form/saved screenshots under `accepted-ui/`.

Commands (prefix with Node 22 on PATH and the synthetic environment described above):

```sh
npm run build
npm run test:security-http -- __tests__/security-http/legacy-treatment-ui-journey.test.ts __tests__/security-http/legacy-reconciliation-preview-built-page.test.ts __tests__/security-http/invoice-visual-evidence-journey.test.ts __tests__/security-http/invoice-correction-ui-journey.test.ts __tests__/security-http/service-raw-category-display.test.ts --reporter=json --outputFile=/workspace/reviews/invoice-resume-20261014/http-repair-final.json
npx vitest run __tests__/invoice-tooth-selection.test.ts __tests__/service-select-raw-category.test.tsx __tests__/service-select-visit-catalog.test.tsx __tests__/legacy-treatment-ui-safety.test.ts __tests__/invoice-visual-evidence-protocol.test.ts
npm run test:postgres -- __tests__/postgres/historical-document-storage.test.ts __tests__/postgres/legacy-treatment-immutable-coverage.test.ts __tests__/postgres/invoice-catalog-authority.test.ts
npm run scan:money
```

Build/typecheck passed; focused units **89/89**; focused PostgreSQL **37/37**; money scan passed; focused lint zero errors / one pre-existing previewOwner warning. The final browser rerun changed only the obsolete close/reopen test selector after the build; application bytes stayed fixed. No full final-head CI or release acceptance is implied by this bounded checkpoint.

| Local evidence filename | SHA256 |
|---|---|
| `http-repair-final.json` | `4c6830727a66580838651e7f9865d9f7a9d8867d93952b8a32a5f726d8e13a0d` |
| `http-repair-final.log` | `de28494fa72e3f99c36d02f8cc85864e72dc5f2f81321e290a7915e6489d2fa5` |
| `http-repair-final-build.log` | `5ec3d62cd86946cd0c4a8a3f094d36e88031b1ed34f26666032154c392a65094` |
| `http-repair-final-units.log` | `686e3eb65bb06b32ecbc71a80f8d3c9841193e28ecf4117e4375e303ceba21d9` |
| `http-repair-historical-pg.log` | `48f1d150e56acd692140d960e4a6d48b6569d76c527b512b02dadb2f8b56e259` |
| `http-repair-final-lint2.log` | `e1ed7b53f84866160427ee9f0b293f52b38167b2bfa68a45d8c01bcf9d016123` |
| `http-repair-money.log` | `7ef0e2672d648112053d08a80b29fe55d2a8eb54efaa635fc9cc0e19c2e269b7` |
| `accepted-ui-sha256.json` | `f11985a424628400072f1d00a2b7fa2244010db486b08a9028edb56fffd08c6f` |

## Follow-up implementation checkpoint

- Explicit creation recovery now validates the visit's same-patient/currency correction ancestry; it returns the original command acknowledgement after two replacements (and later cancellation), without changing visit or receipt references. An unrelated reassignment still refuses. PostgreSQL regression first failed on the old exact-invoice equality and then passed.
- Historical correction recomputes the owned opening's as-of date from current positive document revisions and live standalone agreements. Zero-debt facts cannot drag the date backwards. The new PostgreSQL test first reproduced the stale old date and passed after repair.
- Repayment schedule and collection locks fence linked visits before invoices. A real two-connection test holds a visit, observes the schedule writer waiting, and successfully takes the invoice lock with NOWAIT before releasing the visit.
- Safe ordinary service/provider/site amendments now update one existing unstarted canonical plan item/case. Immutable correction receipts retain original clinical display facts, including later invoice/print reads. Duplicate-site overlap, saved clinical work/assessment, shared cases, payments/refunds, commission overrides, linked problems/referrals/dependencies/outcomes and incompatible specialty/unit changes are explicitly refused. No new migration or receipt is introduced.
- Arch/region catalogue prices cover their scope once; the UI fixes their quantity and the server refuses multiplication. Historical prosthetic original group values remain singular. Existing per-tooth and ordinary financial unit rules remain available.
- Historical treatment already began before the system: its clinical identity remains immutable and an attempted amendment receives an explicit clinical-review refusal. A correction implying a pre-system credit receives an explicit independent-reconciliation refusal. Verified in-system overpayment credit is supported without a cash refund. These are deliberate safety boundaries; no historical cash or credit is invented.
- The protected settlement adapter contract and exact reception integration examples are documented in `INVOICE_SETTLEMENT_ADAPTER.md`. Reception screens and its paused signature fix remain untouched.

Bounded evidence at this checkpoint: five-file PG batch **63/63**; the later expanded revision file **20/20** (four additional historical-reference guards). A clean detached 31b7219a worktree with the new positive amendment regression reproduced the old unsupported-field failure; only its test overlay changed. Recovery/browser batch **26/26**, including real two-tab correction, collection and receipt correction plus lost reply/reload; separate currency/historical/installment batch **34/34**. The latter two used built application `YV7Du8GFw-UzQVwuAGp-M`, before the final protective-reference query additions. Focused unit batch **71/71**, build/typecheck and money scan passed; whole-repository lint zero errors / 185 warnings. The broad unit discovery began before the final four protective-reference additions and is not pinned final acceptance. Final committed-head full suites/CI and Staging remain pending.

Exact new commands and raw results are retained under `/workspace/reviews/invoice-resume-20261014/`: `identity-baseline-before.log`, `visit-lineage-before.log`, `opening-date-before.log`, `completion-pg.log`, `protected-identity-history-pg.log`, `completion-recovery-browser2.{json,log}`, `completion-currency-browser.{json,log}`, `completion-unit.log`, `completion-full-lint.log`, and `completion-actual-ui-sha256.json`. Actual correction images are in `artifacts/invoice-identity-correction/`; current new/historical/installment currency images are in `.settings-ui-artifacts/invoice-premium/`. They are real synthetic app captures, not generated proposals.

The frozen 4551d9bcad966fbb95afb323de667fbc9796e8ae checkpoint subsequently passed the complete unit suite **9203/9203**, with identical before/after application and test hashes (`committed-4551-all-unit.metadata.json`). A final PostgreSQL compatibility regression reproduced an old unstructured correction silently dropping its original receipt (**1 failed / 12 passed**, `unstructured-legacy-lineage-before.log`). The adapter now explicitly refuses the unsupported legacy record without inferring receipt ancestry from its note (**13/13**, `legacy-lineage-after.log`). Final full verification must include this guard.

## Full frozen c9cc450a verification and follow-up gate repairs

Frozen source c9cc450a completed all **9203/9203 unit tests** (518 files), **1824/1824 PostgreSQL tests** (181 files), **20/20 operational journeys**, build/typecheck/lint/money/body/schema/ownership/baseline/preflight/runtime. Source hash remained `59eba12f092e2f049993d01f37e14171fc6bd1b15f97f97156ff7c33fe3be134`. Full CI-flagged local HTTP was **1380 passed / 9 failed / zero skipped**, 196 files; it is not reported green. Raw run `final-c9-ci-env-http-clean` includes exact stable before/after hashes. Its actual 64 invoice images (77 files including manifests/geometry) were copied and hash-indexed under `final-actual-ui/` / `final-actual-ui-manifest.json`; the manifest explicitly retains full HTTP exit 1.

GitHub [38537739747](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38537739747) passed every mandatory gate before HTTP (including dependency audit) and successfully uploaded both raw-category screenshots, but HTTP failed on six older invoice/shared receipt contract assertions. `ci-c9-annotations.json` retains exact remote assertions. Locally, three additional failures concern invoice-label native hit testing and two untouched PDF assertions; the latter are reproduced on pristine d8822f30, not waived.

Follow-up is bounded to invoice status layout plus acceptance fixtures: separate date/status layout retains actual `inline-block` and nine-point text containment; the YER fixture explicitly marks its stated catalogue price configured; missing-ID manual financial lines still succeed without clinical records while unknown explicit catalogue references now assert rejection with zero writes; collection close uses the persisted command recovery rather than attempting a new disabled command. Two reception-reader test files receive complete synthetic receipt DTOs matching the invoice-owned durable acknowledgement contract, with exact target/currency/key and strict unknown-read/write guards retained. Reception production screens/readers and adapter wiring remain untouched. Candidate intermediate runs 40/42 and 40/42 exposed exact geometry/display and later foreign-receipt/read-fixture issues; their raw logs are retained rather than counted as acceptance. Final candidate acceptance and delivery-head results follow below.

## Final local product checkpoint c27f685b — financial-priority repair

User's live wrong-account example remains unspecified and is not claimed reproduced. A separate real PG read race was proved: old opening0 + new receipt400 yielded an impossible −400 credit while the fresh real debt was600 after principal1000. All three YER/SAR/USD regressions failed before, then passed with one read-only repeatable-read ledger snapshot. The repair changes no formula, writer, receipt, period, permission, migration or financial fact. See INVOICE_FINANCIAL_RECONCILIATION_20261014.md for exact contract/writer evidence and before/after records.

Final source c27f685b11cf15f6f1184828c49b54de8c960c71 / app hash204edb2b84038118007fb4b5b89fb8c45dc0ff80adc314dbba4987ffe5c94d92: **9203/9203 units, 1827/1827 PostgreSQL, 150/150 relevant HTTP/browser, 20/20 operational journeys**, all zero skips; build/environment/typecheck/lint/money/body/schema/ownership/baseline/preflight/runtime passed. All seven final-run metadata files have identical before/after application+test hashes and HEAD. Complete exact commands/results/log SHA256 are indexed in `snapshot-verification-index.json`; actual64 PNGs and geometry are fresh on build4h-_Kt7PgtwFDtmSGqMYR, under `snapshot-actual-ui/` with `snapshot-actual-ui-manifest.json`. Earlier broad local PDF/audit failures remain explicitly unwaived; no full local196-file HTTP green is asserted.

The committed implementation handoff now records final local code/test/evidence mapping, source SHA/tree, exact commands, actual API contract proof, rejected unsafe changes, all known failures and release boundaries. Exact delivery-head whole CI remains pending; only a reviewed combined Staging head may be released. The existing Staging patient-design head is not an ancestor, and paused reception adapter/no-fee integration remains separate. No Staging deployment occurred.
