# M2 slice 90a — the day's receipts on the canonical runtime (2026-11-05)

Owner decision G4-4 (6648682456): payments need `finance.payments.view`.

## The route

`GET /api/payments?date=` uses the record read `read:payments.day` (`finance.payments.view`).
- **Snapshot:** one read-only snapshot.
- **Scope:** the rows stay inside the actor's patient scope. An `own` actor sees only the validated clinician's patients, by the patient-list predicate. This is the same rule as the debtors list (slice 88) and the invoices (G4-8), and narrower than the map's null scope.
- **Body:** the legacy body `{ date, payments }`, with the date defaulting to the clinic's today. The reader `listPaymentsByDateWith` is extracted with an optional patient filter; the legacy call passes none.
- **No substitutes:** the invoice and ledger grants never stand in for the payments view.

The collection writes (`POST /api/payments`, retiring an attempt, deferral) are slices 90b–90d.

## Tests

| Gate | Result |
|---|---|
| PG `payment-day-canonical` | 3/3 |
| Legacy PG touching the reader | 11 files, 215/215, including the manual-cash proof on its own fresh disposable database (44/44), as CI runs it |
| Related unit | 13 files, 199/199 |
| Audits | 10/10, with the projection declared |

The 3 PG tests cover:
- the `all` scope equals the legacy list;
- the `own` scope keeps only its patients, with no other patient's name or amount in the body;
- invoice and ledger grants are refused;
- revocation.
