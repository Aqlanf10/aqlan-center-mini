# Invoice implementation handoff — verified invoice delivery

Current release continuation: [PR332 signing/walkout integration](INVOICE_RELEASE_INTEGRATION_PR332_20261014.md). The user explicitly included the previously deferred consumers in invoice release scope. Three synthetic release failures are repaired on this branch; final new-head full/combined CI is required before merging invoicePR332. No paused branch merge or manual deployment/config change is authorized. Earlier no-merge/pending-reception notes below describe their original checkpoints.

Latest product checkpoint: **13634e1f758ed9fe588d7fbef9ce67f03f3b4ade** repairs missing parent financial invalidation inside invoice-owned `PatientLedger`, without a merge or design-file changes. [Bounded repair and evidence](INVOICE_FINANCIAL_REFRESH_REPAIR_20261014.md): root before9/9 fail; after10/10 pass; focused units109/109; fresh build/static gates pass. Current application/test hashes and pending full/exact-head verification are recorded there. The older source-bound verification below remains evidence for its explicitly named checkpoints, not a claim that the latest head has already completed CI.

Update: invoice delivery **961f498b9edd7dc1b3c10b5661b828d244ffc8ff** passed [required CI 38548186976](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38548186976), job 115800102883: all 83 steps successful, zero skipped, including full HTTP/browser and raw-category artifacts. The later selected-service currency defect reproduces on deployed design add3b2b5 but is already repaired here; [currency verification](INVOICE_CURRENCY_SWITCH_VERIFICATION_20261014.md) records the actual before/after, 19/19 browser/API checks, 9/9 units and 35 screenshots. This follow-up adds tests/documentation only and awaits its own exact-head CI. No merge or deployment is currently authorized; the paused local design integration and its separate unresolved parent-projection refresh bug remain excluded.

Branch: `feat/invoice-resume-20261014`. Starting remote head independently verified as d8822f30660bd3f5cd19b99c2c4f3f1714bbf263. Earlier financial snapshot product checkpoint: **c27f685b11cf15f6f1184828c49b54de8c960c71**, tree **167fecaf2389c4f21404c38fdfb27af36c6a5a48**, pushed and remote-verified. Invoice delivery 961f498b changed documentation only and passed required CI as recorded above. Current product checkpoint13634e1f is identified in the latest note. Resolve the enclosing documentation delivery SHA with `git rev-parse HEAD`; its exact-head CI remains required. No Staging deployment is claimed.

Application SHA256: `204edb2b84038118007fb4b5b89fb8c45dc0ff80adc314dbba4987ffe5c94d92`; source plus tests SHA256: `48e4c45d9e6eaea63bf51c2e71b770e4414d5ab5863f0513b0bbb765a431de30`. The retained runner hashes tracked/untracked source/config/schema/scripts, excludes documentation and generated assets, and records both before/after values. All final local runs below have matching before/after hashes and c27f685b HEAD.

## Confirmed financial repair and limits

The latest user steering prioritizes incorrect account calculations. The reported live expected/actual example remains unspecified and **is not claimed reproduced or fixed**. No real patient data was read or modified.

An independent real-PostgreSQL race was reproduced in YER/SAR/USD: canonical opening 1000 minor followed by actual collection 400 minor leaves 600 owed, but separate parallel ledger reads combined old opening 0 with new receipt 400 and returned an impossible **−400 credit**. Three before-tests failed with that exact result. `patientLedger` now reads invoices/items, opening principal and receipts on one `REPEATABLE READ READ ONLY` client. The same three interleavings now return coherent earlier zero snapshots; fresh reads return 600. No formula, receipt, opening fact, period, permission or writer lock changed. Focused financial regression batch passed 79/79, then the complete PostgreSQL suite passed 1827/1827.

[Financial reconciliation record](INVOICE_FINANCIAL_RECONCILIATION_20261014.md) contains the exact commands, before/after witnesses, canonical server contracts and captured real synthetic API responses. It also proves that an unresolved collection resumes its original body/key, creates one original receipt, and then releases the user to create a separate new-key payment. Those browser fixture changes are not asserted to fix the unspecified live discrepancy.

## Invoice outcome

- Approved unified new/historical form retained, with native YER/SAR/USD prices, correct service units, multiple services including orthodontics, provider/site selection, discounts and installment terms. Historical prosthetic group value is retained once; arch/region quantities cannot multiply a scope price. Patient layout/sidebar were not redesigned.
- Historical original agreed/previously-paid facts produce opening principal only, without invented invoices/cash receipts. Current positive revisions determine the owned opening date. Each work line retains its canonical item/case and immutable coverage.
- Ordinary/historical financial corrections retain original facts, reasons, audit, existing receipts, idempotency, permissions and period locks. Safe ordinary service/provider/site amendments affect one unstarted unshared canonical item/case; executed/shared/paid/commission-linked or otherwise unsafe amendments reject explicitly. Historical clinical identities and unsupported pre-system credit assertions require review. Actual in-system overcollection credit is supported without automatic refund.
- Durable recovery and competing tabs are verified for creation/correction/collection/receipt correction, with current server authority. Explicit visits bind normal/catalogue/template commands, fingerprints, recovery and acknowledgement; no latest-visit inference. Creation recovery remains valid after owned correction descendants relink the visit.
- The [settlement adapter contract](INVOICE_SETTLEMENT_ADAPTER.md) covers the complete explicit same-patient/currency correction lineage, ancestor receipts/refunds and stale-proof invalidation. Original receipt invoice IDs stay unchanged. Original1000/paid400/replacement900 yields remaining500; paid1000/replacement900 yields credit100. Old unstructured replacement ancestry refuses instead of silently dropping original receipts. Schedule locks fence patient → visit → invoice.

## Verification

Evidence root: `/workspace/reviews/invoice-resume-20261014/`.

| Final local check on c27f685b | Result / evidence |
|---|---|
| Complete units, 518 files | **9203/9203**, zero skipped; `snapshot-full-unit.{log,metadata.json}`, results JSON |
| Complete real PostgreSQL18.6, 182 files | **1827/1827**, zero skipped; `snapshot-full-postgres.*` |
| Invoice/recovery/native-currency browser + HTTP, 25 files | **150/150**, zero skipped; `snapshot-http.*` |
| All operational journeys | **20/20**; `snapshot-operational.*` |
| Fresh build / environment / typecheck / full lint / money scan / raw-body guard / preflight / runtime dependency proof | Passed; `snapshot-build-static.*`; build **4h-_Kt7PgtwFDtmSGqMYR**; lint zero errors / existing185 warnings |
| Fresh schema drift + ownership | Passed; `snapshot-schema.*`, fresh95 tables/1224 columns/1206 constraints/296 indexes/40 triggers; ownership zero unexpected differences and existing16 convergence findings |
| Baseline manifest generation/verification | Passed; `snapshot-baseline-manifest.*` |
| Actual UI evidence | **64 PNGs**, 77 files including geometry/manifests; `snapshot-actual-ui/`, `snapshot-actual-ui-manifest.json` |

`snapshot-verification-index.json` retains every exact command array, source hash, elapsed time, exit code and raw log SHA256. `snapshot-deliverable-sha256.json` hashes the results and actual UI manifest. These are source-bound checks, not tests of main.

Commands use `/tmp/invoice-test-env.sh`: Node22.23.3/npm11.9.0, Asia/Aden, systemChromium151 and the newly created disposable PG18.6 container on loopback55439. Unit runner has no DATABASE_ENVIRONMENT override. Full PG uses `CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE=1 MANUAL_CASH_CI_DISPOSABLE_FIXTURE=1`. HTTP owns recreated `aqlan_sec_http` and port3322, with CI flags and synthetic runID0 (not a GitHub run). Operational/schema commands use the same synthetic server's maintenance database. No two harnesses share a database/port. A separate disposable container55440/app3323 was used for unchanged-base/candidate checks only.

```sh
npm test -- --reporter=json --outputFile=/workspace/reviews/invoice-resume-20261014/snapshot-full-unit-results.json
CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE=1 MANUAL_CASH_CI_DISPOSABLE_FIXTURE=1 npm run test:postgres -- --reporter=default --reporter=json --outputFile=/workspace/reviews/invoice-resume-20261014/snapshot-full-postgres-results.json
npm run build
npm run verify:environment
npm run typecheck
npm run lint
npm run scan:money
npm run ci:scan:body
npm run build:preflight
node scripts/verify-braces-runtime.mjs
npm run verify:ci
bash /tmp/invoice-final-schema.sh
npm run db:baseline:manifest -- --output /workspace/reviews/invoice-resume-20261014/snapshot-baseline-schema-manifest.json
npm run db:baseline:manifest:verify -- --fresh /workspace/reviews/invoice-resume-20261014/snapshot-baseline-schema-manifest.json
```

The precise 25-file HTTP command and synthetic CI environment are in `snapshot-http.metadata.json`; all tests within selected files ran. The schema wrapper compares a freshly generated contract against `git show HEAD:schema/current-schema-contract.pg18.json`, restores only its generated working-file bytes in a trap, and runs unmodified ownership characterization with source SHA c27f685b. Generated c27 artifacts are also copied to `snapshot-current-schema-contract.pg18.json` and `snapshot-schema-ownership-characterization.json`. No migration or schema baseline changed.

## Exact HTTP CI diagnosis and unwaived differences

Original run38518088911/job115701627479 on d8822f30 failed HTTP and raw-category PNG upload. Signed log download returned403; check-run annotations succeeded. Untouched-head five-file reproduction was **13 failed/9 passed**. It exposed retired historical/correction selectors and DTO assumptions, missing exact sibling GET fixtures, a mobile provider/proof/Save span exceeding the viewport, a hidden compact category label, and incorrect historical bridge splitting. Repair31b7219a passed those five files **22/22**, with all six bounded stdout PNG scenes and both raw-category images preserved. No tracing timeout was changed.

Full frozen c9 local HTTP later finished **1380 passed/9 failed**, not green. Remote [38537739747](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38537739747) failed six invoice/shared receipt assertions, but audit/build/etc and raw-category artifact upload passed. Canonical real-writer contract evidence justified fixture updates; native status geometry was repaired in product markup while retaining all display/nine-point assertions. Candidate intermediate failures40/42 and40/42 are preserved; final candidate **42/42**, followed by branch-source **150/150** and now snapshot-source **150/150**, are distinct runs.

Two additional local PDF failures reproduce on pristine detached d8822f30: lab-dispatch privacy “PDF service label must occur in exactly one field block”, and receipt provenance “PDF signature receipt fragments violate exact glyph geometry”. Five relevant lab/privacy files hash identically to starting source. Diagnostic-only failed PDF and verified stdout codec are retained under `baseline-lab-diagnostic/` (SHA83ec9e4c61653a6672b09bbc830a8c94f2731e066d610411cd5148ce2106fd2d, acceptancefalse). The local bundled PlaywrightChromium153 download was blocked403 “Domain forbidden”; no browser difference is claimed proven cause, no privacy assertion was changed, and no local whole196-file HTTP green is claimed. Exact delivery-head GitHub HTTP remains mandatory.

Local dependency audit also rejects empty advisory ranges (`BRACES_EXCEPTION_REJECTED: invalid node range @next/eslint-plugin-next`). This reproduced byte-for-byte on pristine d8822f30 and with official registry selected. Manifests, lockfile, audit/exception code and CI workflow are identical to starting head; exact raw reports/provenance are in `final-c9-audit-rejected-raw/` and `audit-base-comparison.json`. Remote c9 audit passed. Neither local failure is waived or transformed into success.

## Release boundaries and next step

Required CI for invoice delivery 961f498b: [38548186976](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38548186976), job 115800102883, completed successfully, all 83 steps / zero skipped. The earlier c27 run was superseded by that documentation delivery. The selected-service currency test/documentation follow-up triggers its own exact-head run; use that immutable head and final status. Final CI receipt/status is recorded separately after the delivery commit, avoiding a recursive documentation commit that invalidates its own head. Do not claim release completion while the relevant delivery-head CI is pending/red.

Read-only Railway metadata proves staging-web serves patient-design **add3b2b5076964dcf39c106075970018b0dac096**, branch `staging/patient-codex-reviewed-add3b2b-20261014`, deployment4a78152d-8230-4863-b83e-4c3c6da14816. It is not an ancestor of the invoice branch. Project7f3b5a7b-4508-4b7f-be3d-ad268fc5675a / Staging72f23813-8b82-4a53-a470-3c5eb7ef583b / staging-web60eaf891-e7ae-4de9-88a9-0d4cefd11e75. Directly deploying this branch would replace preserved work. No Railway mutation, variable value or database read occurred; `staging-readonly.json` retains provenance.

Reception's paused checkpoint **a91fec440709cc9e46fa7bc015da51eab42f8170** retains its targeted no-additional-fee signing fix. It was not overwritten or copied here. Reception production readers/screens remain unchanged; their correction-lineage adapter wiring and combined no-fee signature → one collection-task journey require coordinated integration afterward. Only their exact synthetic receipt DTO/read fixtures were aligned with the existing invoice-owned durable contract.

Next: verify the latest invoice product/delivery head, retain the currency proof, and diagnose the historical blank-preview observation when its exact scenario is available. The latest scope authorizes the bounded invoice-owned parent refresh repair; no further merge or deployment is authorized. The earlier local integration remains paused/unpushed at8d50eb67 and does not contain the newer repair. PR330's laterfec2249 WIP and receptiona91fec44 are excluded here. The reported broader live account discrepancy remains unspecified. No main merge, real-data/credential operation, CI/security weakening, migration-number change or external notification is authorized.


Daily-close release integration: see `INVOICE_RELEASE_INTEGRATION_PR332_20261014.md` exact00f4CI finding. `lib/daily-clinic-report.ts` reads aggregate historical header/revision cash facts once and verifies canonical lines; `daily-clinic-report-model.ts` validates arithmetic/identity; the existing daily report table displays all clinical links without invented per-line paid cash. Evidence maps to `postgres/historical-document-storage.test.ts` (three real native-currency writer/read/correction/receipt/no-write regressions), `postgres/daily-clinic-report*.test.ts` (migrated SQL/reader contracts), `daily-clinic-report.test.ts` (fail-closed arithmetic/duplicates) and `security-http/daily-clinic-real-records-ui.test.ts` (real current headers, both widths, three currencies and mandatory A4/checksummed evidence). The walkout security fixture restores its deliberate foreign link after unchanged rejection assertions. Both00f4CI failures remain recorded; candidate final-head verification is pending, not waived.


Daily-close repair code checkpoint: `47586910b457f8f43ed31ee5a98e4fab4ef3411d` on `feat/invoice-resume-20261014` (parent00f4e6ac). It repairs actual CI report integration; main remains148fcbeac229cb279848e6ea37049d1599a4fafe. Both00f4CI runs are failed evidence, not acceptance. Exact commands/results: `npm run test:postgres -- __tests__/postgres/historical-document-storage.test.ts -t 'daily close reads unified'` failed3/3before (19nonselected); the5-file report/historical PostgreSQL batch passed33/33after; `npm test -- __tests__/daily-clinic-report.test.ts __tests__/daily-clinic-invoice-linkage.test.ts __tests__/daily-clinic-report-route.test.ts` passed83/83; the5-file walkout/daily-report browser batch passed51/51after the corrected existing200historical-correction fixture contract. Raw exact argument arrays, source/build identities, logs, checksummed16-file actual UI/A4 evidence and diagnostic results are in `/workspace/reviews/invoice-resume-20261014/invoice-daily-*`. Final full source-bound unit/PostgreSQL/browser/operational/static/schema gates, new push/combined-PR CI and bounded review are the next step. A documentation-only checkpoint follows this code SHA and is the release verification head. No merge, manual deployment, config or real patient operation has occurred.
