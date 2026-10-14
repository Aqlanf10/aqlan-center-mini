# Invoice financial reconciliation — 2026-10-14

Branch `feat/invoice-resume-20261014`. Prior source checkpoint e674ff97cce54fc72aa37788019506a3cb191559 (tree 7007dc67add2bf02893a2228dcc8d7122490cacf). The source accompanying this record adds the minimal ledger snapshot repair described below. Current application hash: `204edb2b84038118007fb4b5b89fb8c45dc0ff80adc314dbba4987ffe5c94d92` under the retained verification runner. Resolve its enclosing commit with `git rev-parse HEAD`.

The user's live expected/actual discrepancy remains unspecified and **has not been reproduced**. No real patient data was read or modified. The independently reproduced race below is not asserted to be the cause of that report. Staging currently serves separate patient-design SHA add3b2b5076964dcf39c106075970018b0dac096, not this invoice branch; source attribution matters before comparing numbers.

## Confirmed wrong-account read and minimal repair

`patientLedger` previously called invoice, receipt and opening readers with `Promise.all` on separate pool connections. It could combine principal from before a write with receipts committed afterward. Real PostgreSQL reproduction:

| Native currency | Canonical writes on other connections | Old sampled inputs / result | Repaired sampled result | Fresh result |
|---|---|---|---:|---:|
| YER | Opening 1000 minor, then receipt 400 minor | Old opening 0 + new receipt 400 → **−400 credit** | 0 | 600 owed |
| SAR | Opening 1000 minor, then receipt 400 minor | Old opening 0 + new receipt 400 → **−400 credit** | 0 | 600 owed |
| USD | Opening 1000 minor, then receipt 400 minor | Old opening 0 + new receipt 400 → **−400 credit** | 0 | 600 owed |

The balance −400 never existed: the real states were 0, then 1000, then 600. The regression controls query timing only; all rows come from real PostgreSQL and both writes call the canonical writers. There are no fabricated result rows, sleeps, skipped assertions or longer gate timeouts.

Repair: `lib/db.ts:patientLedger` uses one `REPEATABLE READ READ ONLY` transaction for invoices (including their items), openings and receipts. The three existing readers accept an optional transaction client. Reads take no financial row locks, release the client on success/failure, and preserve their public result shape. No financial facts, receipt targets, writer locks, periods, permissions, formula, migration or currency conversion rule changed.

Before: `ledger-snapshot-before.log`, **3 failed**, sampled due −400 / fresh due 600 in each currency. After: `ledger-snapshot-after.{log,metadata.json}`, **79/79 passed** across snapshot, invoice revision/settlement, historical documents, opening-currency, multi-currency accounting and refund-aware commission suites. After-source hash remained identical before/after execution.

```sh
npm run test:postgres -- __tests__/postgres/patient-ledger-snapshot.test.ts __tests__/postgres/invoice-settlement-position.test.ts __tests__/postgres/invoice-revision.test.ts __tests__/postgres/historical-document-storage.test.ts __tests__/postgres/multi-currency-ledger.test.ts __tests__/postgres/opening-balance-currency.test.ts __tests__/postgres/commission-refund-aware.test.ts --reporter=default --reporter=json --outputFile=/workspace/reviews/invoice-resume-20261014/ledger-snapshot-after-results.json
```

All execution uses only disposable PG18.6 loopback 55439/55440, `aqlan_p1_test` / separately owned `aqlan_sec_http`, and synthetic actors/patients. Detailed evidence is under `/workspace/reviews/invoice-resume-20261014/`.

## Canonical contract evidence for the HTTP fixture repairs

The fixture changes are justified by server contracts and actual synthetic writer responses, not by relabelling failures as stale:

| Reported assertion | Canonical source / actual API evidence | Preserved or strengthened coverage |
|---|---|---|
| YER catalogue fallback expected 201 from an unconfigured service | `lib/invoice-catalog-price.ts:invoiceCatalogPrice` returns null when `priceConfigured === false`; `lib/invoice-input.ts` rejects missing effective prices. Actual API: same stated 15000 price with flag false → 400, flag true → 201 / total 15000. | Positive fixture explicitly configures its price. Foreign missing-price/stale-price/disabled/zero-value guards remain. |
| Manual line with an unknown explicit service ID expected a financial fallback | `lib/invoice-input.ts` rejects unknown/inactive explicit IDs. `lineLinkage` treats an omitted catalogue ID as financial; it cannot infer clinical identity from free text. Actual API proves unknown ID → 400 with no invented case. | Omitted-ID explicit financial line still creates no plan/case/payment. Unknown ID now has a separate rejection/zero-write assertion. No clinical service/provider/site input was removed. |
| ID-only mocked receipts were expected to close collection dialogs | `app/api/payments/route.ts` returns `{...payment,idempotencyKey}` from the real writer, status 201 / exact replay 200. `lib/durable-money-command.ts:readDurableMoneyAcknowledgment` requires matching actor/patient/key/target/native amount/currency/receipt and valid FX metadata. Actual reception API response for SAR 50: amountMinor 5000, baseAmountMinor 7000 YER, rate 140, full receipt identity and original key; exact replay returns the same DTO, one receipt. ID-only acknowledgement is null. | Only synthetic receipt DTOs in the two reception-reader tests changed. All target/currency/key, write interception, stale-read and receipt-count assertions remain. No reception production reader/screen changed. |
| A pending command's ordinary “new collection” button was expected to reopen it | `MoneyCommandRecovery` resumes the persisted exact command; the normal entry guard remains closed until a validated acknowledgement. | Real API browser recovery keeps body/key identical and creates one original receipt; after resolution, the user can start a separate 700 payment with a new key. Original 500 remains one receipt. No trapped user or force-enabled button is accepted. |
| Native caption geometry failed | Actual text-fragment hit tests showed the inline date wrapper painting over the status caption. The final local wrapper separates date/status while retaining the original `inline-block` contract. | Original nine-point hit tests, viewport/row bounds and display assertion remain unchanged at 1280 and 390. |

The real API contract probe additionally verifies that clinical RCT **without a tooth is rejected**; with tooth 36, the returned invoice item and stored canonical plan item/case retain tooth 36, the treating doctor and matching IDs. Manual financial tests do not waive clinically required linkage. The initial diagnostic probe wrongly looked for toothCode on a response summary link; that failed probe is preserved. Corrected verification checks the actual item and stored case/plan, plus three native-currency bucket cases: **6/6 passed**.

Evidence: `canonical-api-contract-evidence-verified.{log,metadata.json}`, `canonical-api-contract-evidence.json` SHA256 `9edeea1620baef0c90ecb0b2fb9ac871558c839c02fedf298249963a85279a21`. Its source reproducer is retained in `/workspace/invoice-final-ui-candidate/__tests__/security-http/invoice-canonical-contract-evidence.test.ts`. It uses the same application bytes as e674ff97 (hash 4588167b9dd5e6b3f6f71ddf9ad225fec19dad15ad673b0eb82a2dfb7c5889ed), before the read-only snapshot fix; no receipt-writer code changed in that fix.

Candidate failures 40/42 and 40/42 remain preserved under `candidate-http-gate-repairs*`. Final candidate **42/42**, then branch-source **150/150** across 25 invoice/recovery/browser files, plus **9203/9203** units passed on e674ff97. These are prior-source results, not claimed verification of the subsequent ledger repair. `durable-recovery-user-resume` passed **3/3** with the additional independent-next-command assertion.

## Financial invariants inspected

- Posted debt per native currency is opening principal + noncancelled invoice net − actual net receipts/refunds allocated to that currency. Cancelled ancestors are excluded from billed totals but their original receipt targets remain resolvable.
- Historical agreed 300000 − paid-before-system 120000 creates only 180000 opening principal. Actual in-system collection 20000 leaves 160000; paid-before-system is not another receipt. In-system overcollection creates credit without an automatic refund. Unsupported pre-system credit assertions refuse for reconciliation.
- Original 1000 / receipt 400 / replacement 900 gives 500 remaining through explicit ancestry. Fully paid 1000 / replacement 900 gives credit 100. Multiple corrections and ancestor refunds update settlement and invalidate proof; receipt invoice IDs remain unchanged. Old unstructured replacement ancestry refuses explicitly.
- `settlePaymentMinor` uses native amount for the native target; a YER target may use its recorded base snapshot. Foreign-to-foreign settlement without a recorded target is rejected. The actual API probe proves SAR/USD opening collection affects that opening currency, leaving other buckets unchanged.
- Remaining planned work and posted account debt are distinct projections. No conclusion about the live report is drawn from that distinction without its expected/actual example.

Next: complete full exact-head gates for the ledger repair, retain actual invoice screenshots and the unwaived local audit/PDF differences, then push and review exact-head CI. Reproduce the user's specific expected/actual case synthetically when supplied. Staging still requires a reviewed combined head preserving patient-design and paused reception work; do not deploy this branch directly over it.
