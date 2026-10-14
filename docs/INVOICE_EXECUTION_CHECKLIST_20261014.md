# Invoice execution requirements and evidence

Branch: `feat/invoice-resume-20261014`. Execution resumed from independently verified remote `d8822f30660bd3f5cd19b99c2c4f3f1714bbf263`. Only the invoice writer is active. No main merge, Production access, patient-data access or deployment is authorized by this checkpoint.

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
| Unified approved new/historical form, native prices/currencies, service units, provider, sites, discounts and terms | `components/PatientLedger.tsx`, `InvoiceWorkspace.module.css`, `dental/invoice-tooth-selection.ts`; premium, historical, tooth and catalogue suites | Existing implementation; historical group regression repaired; final full UI/currency acceptance pending. |
| Historical original/paid facts, opening debt only, canonical treatment linkage without fake cash | `lib/legacy-treatment-document*.ts`, `legacy-treatment-db.ts`; historical storage/coverage/backup, historical UI journeys | Existing implementation; current repair PG checks passed 37/37. Further historical correction edge cases require verification. |
| Ordinary and historical corrections, immutable original, reason/audit, installments, payments/credit and safe clinical identity changes | `lib/invoice-revision-db.ts`, `legacy-treatment-document-db.ts`, correction editors/view decoders; revision/history/commission/refund suites | Financial correction foundation exists. Safe clinical identity amendments, historical below-pre-system-paid treatment and opening-date recalculation remain active work. |
| Durable recovery and two-tab serialization for creation/correction/collection/receipt correction, live permissions | `financial-command-journal.ts`, invoice recovery, correction editors, money command components; browser journal and recovery suites | Existing implementation. Final integrated recovery/permission matrix pending. |
| Explicit visit in normal/catalogue/template intent, fingerprints, replay and acknowledgement; no latest-visit inference | `invoice-visit-context.ts`, `invoice-linkage-db.ts`, `invoice-template*.ts`; explicit-visit PG/HTTP suites | Existing implementation; creation replay after correction relinks visit remains to repair. |
| Correction-chain settlement/proof adapter, preserved original receipt IDs and stale-proof invalidation | `invoice-settlement-position.ts`, `invoice-settlement-lineage.ts`, `debt-installments-db.ts`; scoped settlement PG suite | Existing adapter; document public contract and final lineage/refund acceptance. Reception-owned consumers remain paused. |
| Lock order patient → visit → invoice, including repayment schedules | invoice/repayment transaction writers | Review and regression pending. |
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
