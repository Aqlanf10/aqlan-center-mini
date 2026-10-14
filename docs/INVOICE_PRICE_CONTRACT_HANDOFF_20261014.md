# Invoice pricing and printable installment contract handoff

PR: https://github.com/Aqlanf10/aqlan-center-mini/pull/333 (draft, owner review required).
Branch: `feat/invoice-monthly-schedule-20261014`.
Base main: `9b1ddc0e7d0d2bcf5a5159089e3dc55be6da8216`.
Resume head: `fdc1d54685e355d019bf4f2062184335c606a594`.
Implementation checkpoint: `d8339f7ff17847553f153c8bf06e34a10b816b88`.
Owner-reviewed checkpoint: `7c6df4be010212e9ea6b85989788cbdbef807889` (independent review reported no financial/security blocker within its scope; it requested the bounded rounded-zero display correction below).
The final follow-up additionally commits the currency/refund/statement tests, actual evidence, this handoff and a display-only fix numbering monthly installment1 separately from the proposed downpayment. Resolve exact final SHA from PR333 head / `git rev-parse HEAD`; external final push/CI receipt records it without a self-referencing commit.

## Implemented

Invoices and template invoices prioritize the explicit chosen-currency price, including zero, otherwise offer the existing configured conversion from stored centre rates. The server revalidates exact source/rate/base amount/rounding before writing and again under settings/catalogue locks. Creation audit records agreed source (manual/native/converted), requested minor amount, reason and a SHA256 quote snapshot. Rate drift rejects a new command even if its rounded price stays unchanged; successful quoted-command recovery returns the original receipt without repricing.

Converted pricing is an offer, not a newly configured native comparison baseline. Manual changes to unpriced/converted catalogue invoice services require reasons. Native increase, individual/combined discount and role guards remain. Invoice-only enforcement uses an explicit flag at invoice/historical boundaries; no plan, visit or free-text policy was changed. New quote/rate metadata is restricted to admin/reception. No native catalogue field is overwritten.

The existing monthly editor now keeps proposed payment separate from receipt, supports12/15/18/custom months, exact minor allocation, month-end/leap-year dates, edits and regeneration after amount changes. Repeated ordinary summary rows and a scroll-only review action were removed. Generation controls collapse after application; the saved rows remain authoritative and their first proposed-payment kind is not duplicated by a second checkbox. The first monthly installment is numbered1.

Final owner-review correction: a computed converted0 is retained as source evidence but no longer auto-fills an invoice price or labels itself as an accepted offer. The UI shows a specific rounding-to-zero message, leaves price blank and exposes the manual-reason field. A positive manual price/reason follows unchanged unpriced agreement authority. Server zero refusal remains, with the same clear message; templates explain the manual-line path. Explicit native0 and the existing rounding rule are unchanged. Only an explicit `currency` effect dependency was additionally made complete; the prior preview-owner lint warning remains.

Saved active current installment versions link to the existing plan print route with explicit repayment source/version. The adapter reads patient, invoice/opening reference, currency, actual settlement and saved schedule in one read-only snapshot. It reuses existing terms and signature wording, refuses stale/cancelled/review-required versions and never creates a plan, invoice, receipt or debt. The original no-query plan route is retained. Historical contracts label the actual opening-debt source rather than inventing an invoice for paid-before-system money.

## Verification and exact records

Node22.23.3/npm11.9, owned PostgreSQL18.6 on loopback55439; storage fixtures use isolated `aqlan_p1_test`; built HTTP uses `aqlan_sec_http` on loopback3322 and drops it at teardown. Current app/test hashes and exact command arrays, durations, exits and log hashes are committed in `INVOICE_PRICE_CONTRACT_EVIDENCE_20261014.json`. External logs/metadata are in `/workspace/reviews/invoice-resume-20261014/`.

| Verification | Result / receipt label |
|---|---|
| Complete `npm test -- --reporter=default --reporter=json --outputFile=…` | PASS9263 /520files; `invoice-quote-complete-full-unit` at implementation checkpoint |
| Focused invoice/template/plan regressions | PASS152 /6files; `invoice-quote-source-complete-unit` |
| Expanded PostgreSQL invoice/catalogue/template/history/collection/correction/refund/shift/report suites | PASS157 /15files; `invoice-quote-financial-postgres` |
| Final three-currency correction and printable-lineage matrix | PASS26 /1file; `invoice-contract-currency-refund-lineage`; includes18 increase/decrease cases with0/partial/full paid and9 explicit ancestor-refund scenarios |
| Expanded real HTTP/browser suites including mandatory invoice visuals, real daily report records and clinical continuity | PASS68 /11files; `invoice-quote-financial-http` |
| Added actual statements and currency-state captures | PASS8 /1file; `invoice-contract-final-browser` |
| Final monthly-numbering browser regression | PASS12 /2files; `invoice-final-numbering-browser` |
| Final production build including numbering | PASS; `invoice-final-numbering-build` |
| Typecheck / full lint / money scan | PASS; `invoice-final-review-typecheck`, `invoice-final-review-lint`, `invoice-final-review-money`; lint retains185 existing warnings,0errors |
| Rounded-zero focused SAR/USD/native0/template/authority regressions | PASS99 /4files; `invoice-rounded-zero-boundary-unit`; unchanged rounding below/at half and no new native price authority |
| Rounded-zero final production build and changed-file lint | PASS; `invoice-rounded-zero-final-build`, `invoice-rounded-zero-final-lint` (0errors,1existing preview-owner warning) |
| Rounded-zero actual admin/reception browser + all prior quote/contract/statement cases | PASS10 /1file; `invoice-rounded-zero-browser`; zero write footprint on rejected0; positive reasoned7.25 creates725minor invoice and no receipt |

The broad financial suites and complete unit suite preceded only the final display-numbering correction and added regression assertions/evidence, with no subsequent financial logic change. The final build/browser regression verifies the numbering. Exact final-head required CI remains mandatory; use the PR checks and external final CI receipt as source of truth, not these earlier local commit labels.

The subsequent rounded-zero fix changes automatic offer/display and a previously rejected path's message, preserving server0 refusal, positive manual authority, rounding, ledger/till/report/lineage writers and contract data. Its focused unit/build/browser checks cover that final change; earlier broad suites were not unnecessarily repeated. CI is restarted on its exact final commit; superseded checkpoint CI is not final-head evidence.

The added matrix ties the current replacement invoice and one active arrangement to the actual statement-reader balances in YER/SAR/USD, preserves original payment targets and prevents old-contract printing. Corrections, including credit creation, leave till expectations unchanged. An explicit ancestor refund changes only its own till currency and signed due and invalidates the prior contract. Actual browser statement lists the posted invoice once and does not count proposed downpayment as received. Existing report/collection/cancellation/receipt-correction suites and three-currency real historical report scenarios also pass. No report or till source was edited.

## Review evidence and failed-run accounting

Twenty-two actual PNG/PDF artifacts are committed under `docs/evidence/invoice-pricing-contract-20261014/`, with hashes in the evidence manifest: admin1280/reception390, YER/SAR/USD, converted templates, ordinary/historical contracts, actual statements and rounded-zero manual-price guidance. Normal3-month contracts are1A4 page; historical15-month contracts are2A4 pages with complete signatures. These are screenshots/PDFs from the built app and synthetic database, not generated mockups.

Failed development runs are retained and not waived: the first broad unit run found invoice reason enforcement leaking through a shared plan caller. This was repaired by invoice-only opt-in; unchanged plan payloads and the shared plan-currency unit test pass. Positive USD/SAR invoice fixtures now provide reasons and additionally assert missing-reason refusal while preserving original amount/currency assertions. Initial print-role tests assumed404 for every role; the existing proxy instead sends cashier/accountant307 to `/finance`, which is now asserted exactly along with no patient content. Relative Location parsing and an incorrect test helper import were corrected. Strict quote-decoder typing/optional-key failures were repaired without weakening mandatory line/session/evidence assertions. The worktree dependency symlink build problem was previously repaired locally; no configuration workaround or CI gate change was made.

## Boundary / next step

Review PR333 and its committed acceptance/evidence map, then require all final-head CI gates. Do not merge without the owner's review. No merge, deployment, Railway/Staging/Production configuration change, migration, catalogue mutation, live data access or external notification was performed. Earlier invoice release and paused modules remain untouched. The only remaining verification at handoff creation is exact final-head CI; failures must be diagnosed without waiving gates. Do not claim release/deployment completion from these local results.
