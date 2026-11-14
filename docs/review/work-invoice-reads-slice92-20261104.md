# M2 slice 92 — invoice reads on the canonical runtime (2026-11-04)

Group 4, after slice 91. The design is in [financial-group4-contract-design-20261104.md](financial-group4-contract-design-20261104.md).

## Rule

One registered record read, `read:invoices.patient`, needs `finance.invoices.view`. Each read runs on one read-only snapshot and returns the legacy body from the same reader.

- **No substitutes:** `finance.patient-ledger.view` does not stand in for `finance.invoices.view`, and the invoice grant never reveals the patient statement (decision 6629149113, point 2). Clinical grants don't substitute either.
- **Patient scope:** these reads stay inside the actor's patient scope, the same as the patient account (slice 88):
  - an `own`-scoped actor reads only its patients' invoices;
  - an invoice outside the scope reads exactly like a missing one (404).
- **This is narrower than the map**, which lists these reads with no scope:
  - a finance-only account needs patient scope `all` to read every invoice, as legacy reception, cashier and accountant labels did;
  - a doctor read no invoices in legacy.
- **Question G4-8 for the owner** (in the design note): should finance-only roles read invoices without a patient scope?

## Routes

| Route | Canonical read | Body |
|---|---|---|
| `GET /api/invoices?patientId=` | `readCanonicalPatientInvoices` | `listPatientInvoices` |
| `GET /api/invoices/[id]` | `readCanonicalInvoice` | `getInvoice` |
| `GET /api/invoices/archive?patientId=` | `readCanonicalInvoiceArchiveList` | `listInvoiceArchiveWith` (extracted from the legacy reader) |
| `GET /api/invoices/[id]/archive` | `readCanonicalInvoiceArchive` | `invoiceArchiveViewWith` (extracted) |

Archive and restore (`POST /api/invoices/[id]/archive`) is the cancel write, which belongs to slice 93.

## Tests

| Gate | Result |
|---|---|
| PG `invoice-reads-canonical` | 3/3 |
| Legacy PG touching the invoice readers and archive | 24 files, 569/569 |
| Related unit | 10 files, 103/103 |
| Readiness and map audits | 10/10 (projections declared for the four GETs) |
| Typecheck, lint on the changed files | clean |

What the 3 PG tests cover:
- each body equals the legacy reader over the same rows;
- every read is refused without `finance.invoices.view`, with the ledger and clinical grants;
- an `own`-scoped actor reads its patient's invoice and gets 404 for another patient's invoice, list and archive, and for a missing invoice;
- revocation.
