# Incremental invoice statement selector repair

Parent/candidate: `4f27d47e4cca4ad87f32ce7abe9ef85d2299f618` (Draft #377).
This follow-up is independent of the compatibility-panel changes in that commit
and is intended for incremental propagation into the composed #379 branch.

## Authorized failure evidence

The parent supplied normal check-run annotation observations, not raw logs:

- #370 exact head `2bbad3d2586d5a5a76c542301a856564ff1a2c7f`, run 39515427335.
- #371 exact head `e32efbaa15ef4996a8bc375a6ef01579683bab8a`, run 39515456162.
- Both fail `__tests__/security-http/invoice-quote-contract-ui.test.ts:143`,
  admin/reception cases “sees native/converted currency sources, saves once and
  prints the actual saved schedule”, waiting 30000ms for invoice rows
  INV-00038 / INV-00039 in that run.

These observations alone did not prove a cause. No denied log download was
retried, and no alternate route was used to obtain it. No supplied annotation
establishes a separate prescription assertion failure.

## Demonstrated mismatch

The current statement presentation, introduced in `171f2ce8`, prints each invoice
as `table.statement-invoice[data-invoice-id]`. Its invoice number is in `thead`;
`tbody` contains stored treatment lines, gross, discount and net totals. The old
browser selector searches only `tbody tr` for the number. The next assertion also
uses the obsolete collected-total label rather than the current explicit net
collection label. The relevant test/presentation are identical between #370 and
#371, and the product code is unchanged at #377's parent.

A browser-free built-app HTTP witness creates the same converted-quote/manual
SAR 1500 invoice and four-row 490 + 1010 installment schedule through the normal
invoice API, for admin and reception. It verifies:

- exact quote (440 exchange rate, 500 minor proposed quote), real creation and
  idempotent replay, one invoice/arrangement/revision and no payment;
- SAR billed/due 150000, collected zero, and zero YER/USD due;
- actual HTTP statement 200, exactly one persisted-ID invoice table, invoice
  number in its header and absent from its body (old selector negative control);
- stored net 1500 and current net-collection label;
- actual saved installment contract HTTP 200, SAR, patient, 490 and 1010 amounts;
- unchanged financial rows after statement/contract reads.

Both roles pass on Node 22.23.3 / owned disposable PostgreSQL 18.6 using the
existing built app and unchanged HTTP harness. This supports an obsolete test
selector, not a missing-invoice application regression. No invoice was inserted
by SQL to satisfy the test; only synthetic patient/service fixtures were seeded.

## Patch and gates

The hosted browser journey now selects the exact invoice table by persisted ID,
asserts its header number and its net-total row, and uses the current net
collection label. It additionally asserts statement HTTP 200. Native/converted
pricing, currencies, double-click single-write, replay, ledger balances, audit,
saved schedule, contract print/PDF, role refusals and final row-count assertions
remain. No timeout, skip, application, schema or footer changes.

Validation: two HTTP/SSR witnesses, 30 statement unit tests, typecheck, targeted
ESLint and diff whitespace checks. Local evidence is preserved separately at
`/workspace/reviews/pr371-http-repair/invoice-follow-up/`.

The actual browser journey still requires hosted execution at the new head.
Old-head run 39522862571 cannot validate this incremental change. Do not claim
all original failures fixed or a separate prescription defect established.
