# Portal statement: treatment lines and agreement remaining

This is mandate §10, and bounded item 3 in Dot's review on #429 (comment 6353219387). It is read-only, with no new arithmetic.

## What the patient portal now shows
- **Treatment lines:** for each **current** invoice, the lines exactly as printed on the statement: description, quantity, unit price and line total, at the stored invoice prices.
  - No line, service, doctor or lineage ids are sent.
  - A cancelled invoice and its lines never appear.
- **Agreements:** for each **active agreement**, the printed total, paid and remaining in the agreement's own currency.
  - The amounts come from the canonical plan progress (`listPatientPlans(..., today).progress`), the same reader as the printed statement.
  - Nothing is derived by adding agreement totals to invoices.
  - An item-summed plan (`totalFromItems`) and a non-active plan are not listed, as in the print.

## How parity is kept
- **Agreement selection:** it lives in one shared function, `statementAgreements()` in `lib/statement-lines.ts`. The printed statement page and the portal projection both call it.
- **Invoices:** both sides use `currentStatementInvoices()` and the stored `invoice.items`.
- **Balances:** they remain the canonical `ledgerBalancesByCurrency` per currency, unchanged.
- **Unchanged:**
  - current versus as-of: the dated print still uses the report path, and the portal stays a current copy;
  - privacy: still no staff names, notes, shifts, methods or row ids;
  - authorization: the patient comes from the portal session only, and an unauthenticated request is refused in Arabic before any read.

## Deliberate change to an earlier expectation
- **Before:** #427's parity test listed `LINE-ITEM-DETAIL` among the strings that must not reach the patient.
- **Now:** this item asks for the printed treatment lines, so that line text is now expected for **current** invoices only.
- **Still hidden:** the cancelled invoice's line (`CANCELLED-OLD-TREATMENT`) and every item id field. Each line must have exactly the four printed fields.

## Evidence (local)
| Check | Result |
|---|---|
| `__tests__/portal-statement-parity.test.tsx` (unit, synthetic mocks) | lines, agreements, keys and print parity, plus the earlier cases: part of 59/59 across 4 portal/statement unit files |
| `__tests__/postgres/portal-statement-detail-parity.test.ts` (PG18, real write paths) | 4/4: a discounted two-line SAR invoice with a receipt and its reversal; a cancelled YER invoice; a paid YER invoice; a consented SAR agreement of 300,000 with 120,000 paid on account; another patient's line. The real portal route and the real print page are read from the same database. |
| Full unit suite | 662/662 files, 11 580 tests |
| `npm run build` | OK |
| HTTP security: `rbac`, `session`, `csrf` (portal statement endpoint) | 50/50 |
| `tsc --noEmit`, `eslint` on changed files | clean |

## Review fix: one coherent read boundary (Dot, #436 comment 6353634670)
- **Race:**
  - **Before:** the route read the ledger (its own snapshot), the plan currencies (pool, no snapshot) and the plans (another snapshot) in parallel.
  - **Effect:** a payment committed between them could pair pre-payment balances with post-payment agreement progress in one response.
  - **Proof:** `race-red-before-fix.log`. The interleaving test commits a real on-account agreement payment after the receipts are listed and before the plans are read. The old route returned a SAR `collected` delta of 0 next to an agreement `paid` delta of 5,000 (`expected +0 to be 5000`).
- **Fix:**
  - `patientStatementSnapshot(patientId, today)` in `lib/db.ts` reads the ledger, plan currencies and plans in **one** `REPEATABLE READ READ ONLY` snapshot. It goes through the shared `withFinancialReadSnapshot`, which keeps the original error and discards a client whose `ROLLBACK` failed. The portal route uses it.
  - The standalone `patientLedger`, `patientPlanCurrencies` and `listPatientPlans`, and the printed statement page, are unchanged.
  - The print page keeps its inherited separate reads; that is out of scope here.
- **Tests (`postgres/portal-statement-detail-parity`, now 7/7):**
  - the interleaving case: the in-between payment appears in neither section, then in both together on the next read;
  - a failed-`ROLLBACK` case for the new snapshot: original error, `release(true)`, pool still usable;
  - an unauthenticated request opens **no** database connection.
- **Browser journey `security-http/portal-statement-detail-ui` (390 px and 1280 px), on the built app with synthetic data for portal patient A:**
  - the "حسابي" tab renders each invoice's lines cell by cell (description, quantity, unit price, line total) exactly as the API feed, with discount and net in the invoice's own currency;
  - the seeded SAR invoice is 15,000 + 2 × 2,500 − 2,000 = 18,000 net;
  - YER lines never show SAR amounts;
  - the agreement card shows 300,000 / 120,000 / 180,000 SAR and its "not all due now" note;
  - the current SAR due is shown separately and never as due + remaining.
- **Results:** 4/4 for the journey together with `rbac`, `session` and `csrf` (54/54); full unit suite 662/662 files.
