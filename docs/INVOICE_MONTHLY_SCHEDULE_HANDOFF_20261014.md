# Invoice monthly schedule follow-up handoff

Branch: `feat/invoice-monthly-schedule-20261014`.
Base main: `9b1ddc0e7d0d2bcf5a5159089e3dc55be6da8216` (remote reconfirmed before commit/push).
Implementation commit: `9d8986161a1cd34b5ae8fca76dbadd752565f018`.
The final branch tip additionally commits this handoff; obtain its exact SHA from `git rev-parse HEAD` and the external push receipt. Product source is identical to the tested implementation commit.

## Delivered

The existing repayment editor now offers an explicit **proposed, uncollected** downpayment, 12/15/18-month presets, a custom count and first monthly due date. Generate distributes remaining debt exactly in minor units, keeps dates anchored to the original day across short months/leap years, and leaves all generated amounts/dates editable. It never creates a receipt or subtracts a proposed amount from ledger debt.

Discounts/amount changes retain the canonical exact-sum save guard and show a regeneration notice. Historical agreements distribute only the authoritative opening remaining after paid-before-system; no second subtraction. The existing 60-total-row limit includes the optional downpayment. No zero-valued rows are created.

Product changes are limited to `components/DebtRepaymentEditor.tsx` and new pure `lib/debt-monthly-schedule.ts`. No API, permissions, schema/migration, settings, catalogue, CI, global/sidebar, reception-owned or other module code changed. Generator controls are controlled owner draft metadata; only validated real rows enter existing fingerprints, commands and server persistence. Current recovery/duplicate/permission guards remain in place.

## Validation

Commands used Node22.23.3/npm11.9 and owned PostgreSQL18.6 on loopback55439. All data was synthetic. Browser tests run the production build on loopback3322 with isolated `aqlan_sec_http`, dropped at teardown; focused storage uses `aqlan_p1_test`. Existing mandatory assertions and gates are unchanged.

| Command | Result |
|---|---|
| `npm test -- __tests__/debt-monthly-schedule.test.ts __tests__/debt-installments.test.ts __tests__/invoice-catalog-price.test.ts __tests__/service-pricing.test.ts __tests__/service-pricing-snapshot.test.ts` | PASS 61 tests / 5 files |
| `npm run typecheck` | PASS, final stable source + tests |
| `npm run lint` | PASS, 0 errors / 185 existing warnings; changed files targeted eslint also PASS with no warnings |
| `npm run scan:money` | PASS |
| `npm run build` | PASS production Turbopack build,98.338s |
| `npm run test:postgres -- __tests__/postgres/debt-installments-storage.test.ts __tests__/postgres/historical-debt-repayment.test.ts` | PASS 9 tests / 2 files |
| `npm run test:security-http -- __tests__/security-http/invoice-monthly-schedule-ui.test.ts __tests__/security-http/invoice-workspace-acceptance-ui.test.ts __tests__/security-http/manual-invoice-discount-http.test.ts __tests__/security-http/debt-repayment-workspace-ui.test.ts __tests__/security-http/historical-document-workspace-ui.test.ts __tests__/security-http/invoice-currency-transition-ui.test.ts` | PASS 49 tests / 6 files,129.835s |
| `npm test` | PASS 9252 tests / 519 files,336.842s |

The first build attempt failed because Turbopack refuses a node_modules symlink outside its worktree root. Local dependencies replaced that symlink; the same source then built successfully. No application/configuration workaround was added. This failed attempt is retained in `monthly-build.log` and its metadata.

App source SHA256: `4f16a55bfb65992964d07eb78d44feb607e09a8025b4f0fcadb066dfbe01bed0`.
Stable app + test source SHA256: `fff7d34de9d3826ee2454244618b1c6d85a8b080876f55a710865fd1543630ea`.
Build, full unit and initial focused checks began while HTTP test authoring was finishing; app hash and included unit tests stayed identical. The final stable typecheck, targeted eslint and HTTP suite cover the finished tests. The61-test focused set also passed after the implementation commit. Final documentation changes do not alter app/test hashes; exact final-head CI remains required before any later merge/deployment decision.

## Actual evidence

`docs/INVOICE_MONTHLY_SCHEDULE_EVIDENCE_20261014.json` records hashes for four implemented browser screenshots and the receptionist pricing audit JSON. Screenshots include SAR normal agreement at390/1280, historical at390, and converted/unpriced SAR at390. Normal save double-click persisted exactly one invoice and zero payments; generated terms survived reload. Historical original1500 / paid-before500 persisted opening1000, one agreement and zero invoices/payments. Month-end browser dates include Feb28 and leap-year Feb29.

External evidence directory: `/workspace/reviews/invoice-resume-20261014/`.
Archive: `invoice-monthly-schedule-evidence-20261014.zip`, SHA256 `f2c9331f20231751702b43a2de66d3258e144a6d784dae3e301614a8748121e4`.
It contains screenshots, pricing audit, focused check logs and machine-readable command/hash receipts. Full unit log/receipt are adjacent. Requirement mapping: `INVOICE_MONTHLY_SCHEDULE_CHECKLIST_20261014.md`.

## Receptionist pricing findings / remaining decisions

`INVOICE_CONVERTED_QUOTE_PROPOSAL_20261014.md` is **proposal only**. Parent's live evidence confirms native-only versus converted-display mismatch; the user is reception, not the manager used by the earlier live test. Synthetic reception HTTP reproduces native SAR1500 priority and YER2200 with null native fields displaying converted SAR5/USD1 under explicitly seeded fixture rates. Invoice selection remains unpriced under current policy. No live rates were read or inferred.

Receptionist native preview/save works; native increase is refused even with a reason; native decrease requires a reason; invoice discounts still require reasons and configured limits. Doctor/cashier/accountant preview/create are denied. A reasoned unpriced manual agreement previews200, saves201 and is audited. **Pre-existing gap:** unpriced catalogue manual preview also returns200 without a reason; ordinary server pricing allows null unpriced reasons despite showing the field in UI. This follow-up records that gap without cementing acceptance as a regression contract or silently changing shared visit/plan policy.

Next pricing work requires review of the proposal: native priority, server-validated converted quote with immutable rate/source/rounding snapshot, stale invalidation/idempotent replay, and the explicit permission choice for converted offers versus configured override baselines. A separate invoice-specific reason requirement should be reviewed alongside that choice. No invented rates or catalogue mutation.

## Review boundary

Push this branch for review and run required CI against its exact final head. This follow-up has **no merge or deployment authorization**; no merge, Staging/Production action, Railway/configuration change or external notification was performed. Full PostgreSQL and full HTTP/regression suites beyond the focused local run are left to required CI; do not claim this follow-up release-ready based on focused tests. The earlier merged invoice release remains on main unchanged.
