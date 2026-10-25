# Shared repayment reads inside the statement snapshot

## Proven fanout and bounded change

Prior #444 head5930bed4 batched invoice-candidate discovery but still called `readDebtRepayments(client, patientId, today)` once per invoice-backed plan. That function enumerates all patient arrangements; each arrangement reads its latest revision, validated invoice settlement/lineage/currency evidence, account balance and revision history. Its multiplication by plan count caused the demonstrated growth.

Captured call stacks and SQL frequencies are in attribution.json. At40 plans (20 invoice-backed,20 approved),27 arrangements include the retained histories from7 invoice corrections. The prior batch performs20 patient-arrangement scans,540 latest-revision reads and580 invoice identity/settlement reads. The relevant stack is `patientStatementSnapshot → hydratePlans → readPlanInvoiceFinancialPositions → resolvePlanInvoiceFinancialPosition → readDebtRepayments → readDebtPosition → readInvoiceSettlementPosition`, plus `readDebtRepayments → debtAccountDue → readCurrencyReclassificationEvidence`.

The batch now owns a **lazy Map of patient→Promise**, created and discarded within that one call on the existing RR read-only transaction client. Today/client are fixed for the invocation. Concurrent plan resolvers await the same patient repayment result. No global/client-persistent cache; no writer or standalone-reader changes. Ownership/classic/legacy checks still happen before schedules are requested; every schedule's original settlement, account-due, source-drift, revision and currency validation still executes. Rejections propagate through the existing rollback handling. Financial results are not approximated or rederived from weaker ledger semantics.

| Plans (half invoice, half approved) | Frozen#439 SQL | Prior#444 SQL | Shared-read SQL |
|---:|---:|---:|---:|
|2|64|63|63|
|10|643|638|214|
|40|8533|8513|799|

Full canonical snapshots match frozen#439 at all three scales, including ledger, complete plan DTOs and currency mappings. Query capture proves one RR READ ONLY BEGIN and COMMIT. Query count includes transaction commands. These are fixture-specific budgets, not globally constant SQL or constant work: invoice settlements, approved agreements and account validations still scale, and underlying rows/lineage depth matter.

## Executable checks

`__tests__/postgres/statement-populated-read-scaling.test.ts` seeds2/10/40 populated plans with payments, approved agreements, invoice corrections and YER/SAR/USD. It asserts a generous total query budget (40 calls/plan), one patient-wide repayment scan, complete plan parity and approved financial amounts. It is RED on prior5930bed4:10 plans638 calls exceeds400. It is GREEN after the change through40 plans.

A concurrent payment committed while the shared schedule read is executing stays out of every component of that RR snapshot; the next request sees it. A forced shared-read error must produce one rollback, and a later request must succeed with fresh data. The existing financial-source matrix and print/portal interleaving/error-cleanup tests remain unchanged.

## Timing methodology and reproducibility

Reuse the synthetic seed recipe and immutable fixture IDs in ../reproduction/, on the owned loopback PG18.6 container (2CPUs/1GiB), Node22.23.3, pool5. No real records, server provisioning or network load. The code-level fixture is identical to prior scaling evidence; it resides in the unchanged `aqlan_populated_scale_test` database. Tests use a separate disposable database.

Copy paired-read.mts.txt to `/workspace/statement-performance-evidence/v2/paired-read.mts`, then run run-paired.py with the two isolated checkout paths shown. For a fresh reproduction, run the prior reproduction/populated-scale-parity reader against frozen#439 **after seeding** and write its output to /workspace/statement-performance-evidence/populated-parity-control.json. Keep the newly generated fixture IDs at the explicit path in the script. Do not reuse archived snapshot hashes against a newly seeded database: creation timestamps legitimately differ. Archived hashes bind the original measurements; the fresh base run establishes the equivalent new fixture oracle. It rejects any database outside127.0.0.1:55449/aqlan_populated_scale_test. Set up offline dependencies first; no package download is part of the recipe. It does not create a container/database or mutate application data.

Three paired blocks: control→candidate, candidate→control, control→candidate. Each version/process uses3 excluded warmups and10 measured serial reads per scale, n30/version/scale. **No SQL instrumentation or stack capture runs during wall-time measurements.** Canonical snapshot hashing happens after the measured interval. No concurrent local tests/builds run during measurement. Warm DB/OS caches are retained; source hashes bind the measured implementation. Cold probe:12 alternating pairs of fresh processes at40 plans, first service call after import, caches retained; import cost separately recorded. Its p95/p99 equal the maximum at n12 and cannot establish production-tail reliability. All samples/errors are retained. Prior complete52-sample cold history stays committed, labelled as measurements of the earlier product head; no historical slow samples are discarded or relabelled as this version.

The original five-empty-draft fixture is separately repeated with600 samples/version (same three paired200-sample blocks,10 excluded warmups), using the earlier exact harness with new owned clone names. Do not combine its samples with populated-plan or process-cold observations. No HTTP/browser latency claim follows from service-level timings.

The separate PDF extraction failure/reproducer and unchanged assertions remain unresolved; later-payment/second-PDF acceptance is not claimed. Dependency audit remediation remains separately owned. No migration, collection writer, permission, accounting, main/#439 update, merge or deployment is included.

## Complete observed timing results (milliseconds)

Control is frozen#4399881d33. Candidate source is bound by product-hashes.json. All errors zero; full raw runs and a recalculate.py that verifies every summary value are committed.

| Fixture/cohort | n/version | p50 base→candidate | p95 base→candidate | p99 base→candidate |
|---|---:|---:|---:|---:|
|2 populated, initial|30|48.884→49.494|55.005→63.952|56.148→67.844|
|10 populated|30|352.886→145.662|428.065→177.379|434.573→183.314|
|40 populated|30|5092.411→456.918|6919.927→554.192|9612.721→557.137|
|40 populated, process-cold|12|5200.241→848.842|6037.722→994.212|6037.722→994.212|
|2 populated, larger follow-up|600|49.980→47.683|59.775→72.576|93.093→82.347|
|5 empty drafts, first repeat|600|20.144→15.835|24.141→36.446|27.180→127.045|
|5 empty drafts, reverse-order follow-up|600|20.136→15.409|24.020→18.363|27.677→20.491|
|Both empty-draft cohorts together|1200|20.144→15.609|24.121→24.367|27.599→57.847|

The large populated improvement repeats across all3 paired blocks (40-plan medians about5.2/5.4/4.8s versus0.47/0.47/0.43s). Source-level multiplicative queries have been removed; this does not promise every small-path tail improved. The larger2-plan follow-up retains worse candidate p95. One200-sample candidate block in the first empty-draft repeat has p95~92ms and maximum473ms; **every pause is retained**. The reverse-order cohort does not reproduce that episode, but the combined1200-sample p99 is still worse. No root cause for those pauses was proven; do not label them harmless outliers or claim blanket no-regression. Production/no-slowdown acceptance remains open despite the justified populated-plan improvement.

The follow-up was triggered by the initial small-path/tail observations, not pre-registered; report both cohorts separately and together. It does not replace failed or slow observations. The two-plan follow-up uses3 paired200-sample blocks,10 warmups, no tracing, same fixed fixture. For reproduction copy small-read.mts.txt to the small/read.mts path referenced by small-600.py. Empty cohorts use the historical exact bench.mts harness and fresh clone names in empty-600.py and empty-repeat-600.py; the latter reverses block order (candidate→control /control→candidate /candidate→control). Never overwrite historical samples. The bounded database fixture/harness recipes and synthetic-only target safeguards remain applicable.
