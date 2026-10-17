# Outstanding debt report cutoff regression

Base: `4f65b60793db94c1ca8c8a52a32acd83d666c5fb` (fetched `origin/main`).

The outstanding report already calculated balance, last payment and aging through
`filters.to`, but displayed invoice/payment totals over all dates and included an
opening balance before its effective date. The fix applies the same inclusive
clinic-date cutoff to those displayed components, separately for YER/SAR/USD.
`filters.from` is intentionally not a lower bound for an outstanding balance.

Synthetic reproduction was run **before** changing `lib/reports.ts`: 7 of the
initial 10 tests failed. For an October invoice of 100 and November payment of 40,
October showed billed 100 / paid 40 / debt 100. After the fix it shows
100 / 0 / 100; November shows 100 / 40 / 60. Foreign-currency fixtures use their
native minor-unit scale (100 SAR/USD = 10,000 minor units).

Current agreement totals and payments retain their existing calculations. Their
column labels explicitly identify them as current reference values, not historical
cutoff values; a proposed plan alone creates no debt row. Cancellation remains the
existing current-status exclusion, not a reconstruction of cancellation history.
Refunds remain signed recorded movements, including links to cancelled invoices.
No debt principal, live records, schema, migration or `lib/db.ts` was changed.
This synthetic defect does **not** establish the cause of any reported patient case.

## Verification

- `npm test -- __tests__/reports-debt-cutoff.test.ts __tests__/reports.test.ts __tests__/reports-collections-projection.test.ts __tests__/p01-final-read-path-guards.test.ts`: 72 passed.
- `npm run test:postgres -- __tests__/postgres/reports-debt-cutoff.test.ts`: 11 passed on isolated PostgreSQL 18.6.
- Coverage: three currencies separately and together; future invoice/payment/opening
  exclusion; opening and payment inclusion on the end date; prior-to-`from`
  invoices retained; clinic midnight boundary; cancellation; reversal before/after
  cutoff; unchanged current plan values; proposed-plan-only exclusion; a payment
  query failure rejects the report rather than returning zero.
- PGlite's local adapter strips `AT TIME ZONE`, so its session is explicitly set
  to Asia/Aden. The identical PostgreSQL fixtures run in UTC and exercise the real
  `AT TIME ZONE` SQL, including 20:59:59.999Z versus 21:00:00Z.
- PostgreSQL wrapper creates its own `aqlan_reports_debt_cutoff_test` database using
  the existing test harness. Local execution used a disposable localhost-only
  PostgreSQL container, never a live database.
- `npm run typecheck`: passed.
- `npm run lint`: passed, 0 errors / 208 repository warnings.
- `npm run scan:money`: passed.
- `npm run build`: passed with database connection variables removed.
- `git diff --check`: passed.
