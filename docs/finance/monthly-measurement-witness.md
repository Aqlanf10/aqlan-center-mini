# Monthly report measurement witness

Base: `e32efbaa15ef4996a8bc375a6ef01579683bab8a` from
`fix/ortho-canonical-financial-read`. Independent branch:
`fix/monthly-measurement-basis`.

## Finding and limited repair

`monthlyReport` subtracted `periodSummary.expensesMinor` from the base-currency
invoice bucket and described it as accrual net revenue. `loadContext` actually
loads `expenses.base_amount_minor` by `expenses.created_at` in `CLINIC_TIME_ZONE`.
These are disbursement vouchers (including signed reversals), not the complete
expense accrual population. Unpaid `payables` are absent. Invoice amounts use
invoice date and net discount; collection uses payment/refund date and canonical
settlement currency. Therefore this difference cannot represent accrual profit
or net cash flow.

The repair preserves `net` and all arithmetic for compatibility, but labels it
“فرق الفواتير وسندات الصرف (الأساس)” and explicitly explains the mixed sources.
Invoice, collection and voucher cards and comparisons now identify their actual
basis. Notes disclose clinic timezone, event dates, unpaid-payable exclusion,
refund treatment, and stored base/settlement evidence. Existing generic screen
and print renderers consume these same API labels, hints and notes.

No change to supplier helpers, expense writers, shared db/schema, accounting
policy, financial history, exchange rates, or production. No claim that an
unpaid payable necessarily establishes an expense recognition policy: that needs
an approved accounting contract beyond this limited repair.

## Synthetic witness (integer minor units)

All data reside in a private in-memory PGlite instance with session TEMP tables,
`search_path=pg_temp` and host session timezone UTC. Application SQL, including
`AT TIME ZONE`, runs unchanged. Schema initialization and the connection/snapshot
boundary are mocked; no application writers or public tables are used.

| Event / period | Net YER invoices | Settlement collections YER | Stored voucher base YER | Legacy difference |
| --- | ---: | ---: | ---: | ---: |
| Sep 30 23:59:59 Aden: invoice 10,000, discount 1,000; unpaid supplier payable 6,000 | 9,000 | 0 | 0 | 9,000 |
| Oct 1 00:00 Aden: patient partial payment 4,000; supplier partial voucher (native SAR 20, stored YER equivalent 2,000) | 0 | 4,000 | 2,000 | -2,000 |
| Oct 31 23:59:59 Aden: patient refund 500 | 0 | 3,500 | 2,000 | -2,000 |
| Nov 1 00:00 Aden: further refund 100 | 0 | -100 | 0 | 0 |

A separate SAR invoice 5,000 less discount 500 remains SAR 4,500 and never enters
the YER difference. Sep+Oct difference is YER 7,000. September reads remain
identical after the subsequent payments/refunds. A separate reversal witness
keeps -2,000 on Oct 2, while the Oct 1 comparison remains +2,000.

Before the repair, the numeric witness already passes, demonstrating the source
mismatch rather than an arithmetic bug. Running the initial two-test regression
against the actual base `lib/reports.ts` produced one failure: the API still
returned “صافي الإيراد (الأساس)” instead of the explicit difference label.
After the repair the numbers are unchanged and the disclosure regression passes.

## Validation and limits

- Three new regression tests execute real report SQL and projection, an authorized
  API GET, screen SSR and printable-document SSR. They verify clinic midnight at
  both month boundaries, stored currency values, comparisons, signed reversal,
  refunds, no unpaid-payable deduction, and before/after fixture fingerprints.
- Focused suite: 6 files, 119 tests passed (monthly measurement, reports,
  generation-time API/renderers, collections projection, expense URL guards).
- `npx tsc --noEmit`: passed. `git diff --check`: passed.
- Targeted ESLint: no errors; existing unused `ReportColumn` warning in reports.ts.
- Real PostgreSQL integration suite not run: no local PostgreSQL server/binary
  available. Its expense comparison selectors were updated for the new labels.
- No Chromium, browser visual/layout test, full production build, CI, production
  data, Railway action, period-closing race, merge or deployment performed.
- This does not implement accrual profit, reconcile the ledger, or audit every
  financial report. It repairs the demonstrated monthly measurement claim only.
