# Patient statement cutoff consistency

## Contract

The existing patient-statement report is an opening-through-selected-date ledger,
not a movement report with a lower bound. It shows every settlement currency in
its own bucket, using the existing `balancesByCurrencyAt` authority and clinic-date
movement records. It does not apply doctor, specialty, service, payment-method or
currency filters inherited from a report drill. The heading now says this plainly.

Invoice gross/discount totals, payment/refund totals, opening entries, ledger rows,
last payment and last visit all use the same inclusive cutoff. Future entries no
longer appear next to an earlier-date closing balance.

The official print action remains `/print/statement/[id]` and carries the resolved
`from` and `to`. With a cutoff, that existing route renders the canonical report
through the existing printable report component. The path patient ID is authoritative;
conflicting query IDs, repeated dates, impossible dates, missing cutoffs and reversed
ranges fail closed. Query movement filters cannot retarget or narrow the ledger.
The no-query print keeps its existing current all-history ledger and plan view.

Running balances are explicitly non-additive (`aggregate: "none"`) in the existing
column contract. Screen, print and grouped totals retain debit/credit sums but
leave the running-balance total blank; the existing canonical closing-balance KPI
remains authoritative. Other money columns keep their previous default sums.
Payment/refund descriptions use `formatMoney`, so SAR/USD minor units are not
mislabelled as whole currency amounts.

The existing statement role gate and proxy restrictions are unchanged. This does
not authorize doctors to print financial statements or alter any ledger data.

## Verification

- Five new pure report regressions reproduced the original failures, then passed:
  row count 10 instead of 7, future amounts in totals, dropped print cutoff, false
  inherited-filter labels, and future-only activity beside a zero historical balance
- Actual page tests cover existing allowed/denied roles, canonical report input,
  truthful patient/period/currency output, malformed/repeated/conflicting query
  values, leap days, missing patients and unchanged no-query behavior
- Nonempty screen/print/group regression: 100 opening + 900 invoice - 300 payment
  closes at 700; running values must not sum to 1800. Multi-currency groups keep
  separate debit/credit totals, and other report totals remain unchanged
- Synthetic fixtures only; no private patient export or Production writes

These tests establish report/render behavior, not a point-in-time database snapshot.
Historical document mutation/cancellation semantics remain those of the existing
canonical movement loader. PostgreSQL/browser release validation remains required.

## Built-app release gate

`security-http/patient-statement-cutoff-ui.test.ts` uses the existing isolated
`aqlan_sec_http` harness and a dedicated synthetic patient. It seeds dated YER/SAR
movements, exercises the real API and ReportsPage official-print link, checks
closing balances and non-additive totals, invalid cutoff/retargeting refusal and
legacy behavior. It captures only the two explicitly allowlisted synthetic
statement screen/print PNGs. The journey must pass in CI before release; source
compilation alone is not browser or PostgreSQL execution evidence.
