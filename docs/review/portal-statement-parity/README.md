# FIN-INT-8 — Patient portal statement equals the printed statement

Base: `finance/integration-20261022` @ `60e797ba` (#408, frozen). Separate draft slice.

## Defects found on the base (reproduced in `unit-red-before-fix.log`)

| # | Portal «حسابي» before | Printed statement | Effect |
|---|---|---|---|
| 1 | Listed cancelled invoices, labelled «ملغاة» | Omits cancelled invoices (`currentStatementInvoices`) | Patient saw a document the clinic no longer bills |
| 2 | Invoice amount = `totalMinor` (gross, before discount) | «صافي الفاتورة بعد الخصم» | Rows did not add up to «إجمالي الفواتير» |
| 3 | Every non-cancelled invoice «معتمدة» | «مسدّدة» / «مفتوحة» | Paid state invisible |
| 4 | Refund shown only as «−» | «استرداد» / «عكس سند …» from the stored reversal edge | Reversal unexplained |
| 5 | Full `Invoice`/`Payment`/`OpeningBalance` rows sent to the patient's browser | — | Staff usernames (`createdBy`), receipt/invoice/opening notes, shift ids, payment method, row ids, line items and doctor ids and the opening's stored phone reached the portal |

## Change

- `lib/statement-lines.ts`: the one statement rule (current invoices, payment label), now shared by the print (`app/print/statement/[id]/presentation.tsx` re-exports it, behaviour unchanged) and the portal.
- `lib/portal-statement.ts`: `portalStatementView` — explicit patient-safe projection; balances pass through from `ledgerBalancesByCurrency` unchanged.
- `app/api/portal/statement/route.ts`: returns the projection. Legacy `opening`/`balance` keys dropped (no consumer; the portal reads `openings`/`balances`).
- `app/portal/page.tsx`: shows net after discount, «مسدّدة»/«مفتوحة», and the reversal label.

No schema, migration, permission, balance-calculation or workflow change. Session handling (`requirePortalSession`, Arabic 401/500 without exception detail) unchanged and covered.

## Tests

`__tests__/portal-statement-parity.test.tsx` (7): current invoices at net with paid/open; same labels as the print and identical canonical balances; exact allowed keys and no internal strings; the print renders the same documents, nets, labels and due balance from the same ledger; Arabic 401 with no read; Arabic 500 without detail; projection does not mutate input. 4 of 7 fail on the base, 7/7 pass after.

## Not connected / out of scope

- The portal does not show the treatment-agreement «المتبقي من الاتفاق» block the print shows; adding it is a product decision (portal content), not a parity defect in shared numbers.
- Staff ledger screen keeps showing cancelled invoices with their state (audit view, not a statement).
