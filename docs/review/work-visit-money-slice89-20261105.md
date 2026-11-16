# M2 slice 89 — the visit's money reads on the canonical runtime (2026-11-05)

This slice implements owner decisions G4-1, G4-4 and G4-6 (6648682456). The field-by-field contract is section 6 of [the group 4 design](financial-group4-contract-design-20261104.md).

## Routes

| Route | Admission | Body |
|---|---|---|
| `GET /api/visits/[id]/walkout` | `read:visits.money`: `finance.invoices.view` | the field groups, each by its own grant (table below) |
| `GET /api/visits/[id]/billing-preview` | `read:visits.money` | the legacy preview: the whole response is dues |
| `GET /api/visits/[id]/financial-context` | `read:visits.financial-context`: `clinical.visits.document` **or** `finance.invoices.view` | coverage for documenters; source references only with `finance.invoices.view` (the legacy redaction, with the grant in place of the role label) |

- **Snapshot:** each route runs on one read-only snapshot, and the visit must be inside the patient scope (its clinician, or its patient inside the scope). Outside reads like missing.
- **No grant substitutes:** the ledger, payment and clinical grants never stand in for the invoice view.
- **G4-6:** `workflow.doctor_financial_view` has no effect here.

### Walkout groups

| Group | Grant |
|---|---|
| Dues (invoice, line prices, new billable) | `finance.invoices.view` (admission) |
| Payments (the day's receipts, paid on the invoice, payments today) | + `finance.payments.view` |
| Account (balances, before and after, previous-balance instalment) | + `finance.patient-ledger.view` |
| Today's remainder (net − paid) | invoices **and** payments |
| Due now, and the due recommendation | invoices **and** payments **and** the ledger |
| The collect action in the recommendation | + `finance.payments.collect` (otherwise `"none"`) |
| Reception handoff status | `visits.manage` |

Every response passes through an explicit allowlist, with no object spreading. A hidden group is **omitted, never zeroed**.

## Extracted readers (legacy unchanged)

| Snapshot variant | Of |
|---|---|
| `readVisitCheckoutInSnapshot` | `readVisitCheckout` |
| `previewVisitBillingWith` | `previewVisitBilling`, now on one client instead of the pool plus a second client |
| `readReceptionHandoffWith` | `readReceptionHandoff` |

## Tests

| Gate | Result |
|---|---|
| Unit `canonical-visit-money-projection` | 10/10 |
| PG `visit-money-canonical` | 4/4 |
| Legacy PG touching the extracted readers | 40 files, 624/624 |
| Related unit | 20 files, 239/239 |
| Audits | 10/10, with projections declared for the three GETs |

What the 10 unit tests cover:
- all 8 grant combinations, each with distinct sentinel amounts per group, so a leak shows in the JSON;
- the handoff gate;
- an allowlist taint check: an unknown source field never reaches the body.

What the 4 PG tests cover:
- the owner carries every legacy value;
- the dues-only actor omits payments, the account and derived dues, and the 12000 payment never appears in the body;
- a full reader without the collect grant sees the action `"none"`;
- refusal for ledger and payments grants;
- outside reads like missing;
- revocation;
- the preview equals the legacy body;
- documenters see coverage without references, and the invoice view sees them.
