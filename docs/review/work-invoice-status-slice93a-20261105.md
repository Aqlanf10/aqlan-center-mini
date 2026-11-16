# M2 slice 93a — invoice status on the canonical runtime (2026-11-05)

Group 4. `PATCH /api/invoices/[id]` carries three different decisions. Each gets its own rule, never wider than legacy:

| Status | Canonical rule | Legacy |
|---|---|---|
| `open` (reopen a paid invoice) | `finance.invoices.create` (the map's grant) | admin, reception |
| `cancelled` | `finance.invoices.cancel` and a written reason | admin |
| `paid` (manual, no receipt) | `finance.invoices.mark-paid` (the catalogue grant named for exactly this) | admin |

No grant substitutes for another. The patient-ledger view grant changes nothing here.

## How it runs

There is one admitted operation. The legacy body, `setInvoiceStatusOn`, is extracted unchanged, and its lock order is kept: patient, then visits and plans, then items, then the invoice. After all of those locks, on the locked invoice row, two decisions are made:
- **The patient scope:** an `own` actor needs a positive ownership witness held `FOR SHARE NOWAIT`. A lock-order contention is a bounded 409, and an invoice outside the scope reads like a missing one (404).
- **`finance.locked_before`:** checked against the invoice's **clinic date**, the same rule as invoice archiving. The legacy route compared the UTC date outside the transaction, which misdates invoices made just after midnight Aden time.

The `invoice.cancel` audit row, carrying what was paid on the invoice, commits **with** the cancel. The legacy route wrote it after the commit. The response is the legacy body, including the guidance about the patient's credit.

## Tests

| Gate | Result |
|---|---|
| PG `invoice-status-canonical` | 5/5 |
| Race failure-first | With the pre-fix pattern (an unlocked scope check before the writer's locks), the cancel went through on a patient that had left the scope: the race test failed. With the fix it passes |
| Legacy PG touching the extracted writer | 22 files, 372/372 |
| Related unit | 4 files, 59/59 |

The 5 PG tests cover:
- cancel with its reason and the same-transaction audit (with what was paid);
- each status needing its own grant, refused to the ledger and invoice viewers;
- the locked period;
- an `own` actor limited to its patients, outside and missing reading alike;
- revocation;
- the race, proved through `pg_stat_activity`.
