# PR333 HTTP CI repair

Branch: `feat/invoice-monthly-schedule-20261014`. PR: https://github.com/Aqlanf10/aqlan-center-mini/pull/333 (draft). Failed reviewed head: `62168f21265640bf71fe2c98678b0f19136cac34`. Main remains `9b1ddc0e7d0d2bcf5a5159089e3dc55be6da8216`; no merge or deployment is part of this repair.

## Exact diagnosis

PR run38638155465, job116107120168 failed only **HTTP security integration tests**. Push run38638152750, job116106709594 failed the same step. Required artifact steps succeeded. GitHub signed log downloads were forbidden; the check-run failure annotations were retrieved successfully and the failures reproduced on the unchanged exact head using the isolated built app/PostgreSQL harness.

The PR annotations contain ten failures:

* Five native mouse-click cases in `invoice-preview-state-journey.test.ts`: the new-command refusal journey at390/1280, independent invoice after lost-acknowledgement recovery at390/1280, and independent invoice after BUSY recovery at one viewport. They timed out waiting for POST at original lines238/184 (callers373/434). Coordinate clicks lack Locator.click enabled-state auto-wait. Financial-only consultation now correctly requires its current server preview, so the click could hit disabled Save before that preview completed and no POST was sent.
* Five absent-quote cases in `invoice-currency-transition-ui.test.ts`: ordinary/historical SAR/USD and rapid currency change with a late SAR preview. Original lines113/153 expected empty but received1786.00SAR /472.00USD. Other HTTP fixtures store SAR140/USD530; with the approved invoice conversion behavior those are legitimate converted offers for250000YER. The absent-FX test did not own its assumed settings precondition.

The unchanged local40-test reproduction failed12 /passed28 in302.461s: all six native-click viewport cases, all five currency cases, and the delayed clinical→financial test at original line627. The latter had the same obsolete immediate-enable assumption and could pass by timing in CI. App and app+test hashes remained unchanged throughout that before run. The synthetic reproduction explicitly stored USD530/SAR140 before the currency suite, matching the existing opening-balance-currency HTTP fixture. Only the owned loopback `aqlan_sec_http` database on55439 was written; teardown dropped it.

## Repair and retained assertions

Only the two invoice HTTP test files change. The native-save helper and refusal journey explicitly assert Save enabled within the existing15000ms readiness bound before attaching response observers and issuing the existing native mouse click. POST, authoritative ledger/workflow reads, exact command/replay, one independent new command, zero duplicate clinical/financial writes, refusal retirement and geometry assertions remain.

The currency file snapshots stored FX values and their exact timestamps, removes them only inside its isolated fixture and restores them after the file. It adds an assertion that the server invoice quote is `none` with null amount/rate. Empty-price/save-blocked, rapid-change stale response, native-priority, manual reason, permissions, no cash/no visit and actual currency evidence assertions remain. Configured-FX conversion remains covered separately in `invoice-quote-contract-ui.test.ts`.

The delayed clinical→financial test now holds each response independently. It proves financial Save is disabled initially and remains disabled after the obsolete clinical response, then becomes enabled only after the current financial response. Existing no clinical proof/tooth-chip checks remain before and after current evidence.

No app code, financial authority, timeouts, security settings, workflows, migrations, mandatory evidence paths or unrelated modules changed. The earlier development-runtime-tracing timeout repair is untouched.

## Verification records

Exact command arrays, exits, source snapshots, duration and log SHA256 are in `INVOICE_CI_HTTP_REPAIR_20261014.json`; full logs are under `/workspace/reviews/invoice-resume-20261014/`.

* Before: `npm run test:security-http -- __tests__/security-http/invoice-preview-state-journey.test.ts __tests__/security-http/invoice-currency-transition-ui.test.ts` →12failed /28passed /2files.
* After: the same two files plus `invoice-quote-contract-ui.test.ts` →PASS50 /3files in210.858s,0failures.
* `npm run typecheck` →PASS.
* `npx eslint` on the two changed test files →PASS,0errors/0warnings.

App source SHA256 remains `7df15b9b7ab5c010fad2b149706ec0d1496eba0facacfb23575fae83152f9862`; the22 committed actual image/PDF artifacts and earlier build/storage/unit/financial linkage evidence remain applicable to the identical application code. The broader requirement checklist is `INVOICE_PRICE_CONTRACT_ACCEPTANCE_20261014.md`.

Resolve exact repair SHA from PR333 head / git HEAD. Required unfiltered CI must complete successfully on that exact pushed head before any later owner merge decision; do not treat a focused pass as completed CI. The final pushed head/run IDs and result are recorded in the external final receipt and PR body, avoiding a docs-only self-referencing commit. Next action: push this repair, verify exact-head required CI, keep PR draft for owner review. No merge, Staging or Production action is authorized here.
