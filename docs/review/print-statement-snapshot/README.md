# Current printed statement: one coherent read

**Base:** #436 `e6416bfa`. This depends on its `patientStatementSnapshot()`; nothing else from #436 is copied or changed.

## Defect
- **Where:** the current (no-query) printed patient statement read the ledger, the plan currencies and the agreement progress independently (`Promise.all` of `patientLedger`, `patientPlanCurrencies`, `listPatientPlans`).
- **Effect:** a payment committed between those reads could put pre-payment receipts and balances next to post-payment agreement progress on one sheet.
- **Origin:** an inherited pattern, kept out of scope in #436 and scoped here.

## Fix
- The no-query path now reads `ledger`, `planCurrencies` and `plans` through the shared `patientStatementSnapshot()`: one `REPEATABLE READ READ ONLY` snapshot via `withFinancialReadSnapshot`, which keeps the original error and discards a client whose `ROLLBACK` failed.
- `getPatient` and `getSettingsSafe` stay as they were; they are not financial inputs.
- **Unchanged:**
  - the dated / as-of print (`?to=` / `?from=` through the report path);
  - staff authorization (`requireSession` + `canViewMoney`) and the path-only patient authority;
  - currency separation, canonical arithmetic, cancelled-document filtering and the printed content.
- No writes and no new financial reader.

## Evidence (local, synthetic data)
| Check | Result |
|---|---|
| New `postgres/print-statement-snapshot`, **before** the fix | the interleaving case fails: the sheet shows agreement paid `1,270.00 ر.س` (post-payment) while collected is still pre-payment (`red-before-fix.log`) |
| Same file **after** the fix (3/3) | interleaving: during the request the sheet shows collected 1,290.00 and paid 1,200.00 (both pre-payment); the next request shows collected 1,360.00, paid 1,270.00 and remaining 1,730.00 together. Content: lines, discount 20.00, net 180.00, the reversal label, the agreement; no cancelled line; no other patient. Failed `ROLLBACK`: original error, client discarded, pool usable. |
| `postgres/portal-statement-detail-parity` | still green (with the file above: 10/10) |
| Print and statement unit files (`patient-statement-print`, `-account-consistency`, `-asof`, `portal-statement-parity`, `role-routes`) | 30 + 7 + 7 + 9 + 7 passed. The mocks now compose `patientStatementSnapshot` from the same reader mocks; **no assertion changed**. The dated-path test still proves the ledger reader is never called there. |
| Full unit suite | 662/662 files, 11 580 tests |
| `npm run build` | OK |
| HTTP/browser on the built app: `patient-statement-current-print-ui` (current print and PDF), `patient-statement-cutoff-ui` (dated print), `invoice-quote-statement-http`, `legacy-treatment-ui-journey`, `portal-statement-detail-ui` | 5 files, 14/14 |
| `tsc --noEmit`, `eslint` on changed files | clean |
