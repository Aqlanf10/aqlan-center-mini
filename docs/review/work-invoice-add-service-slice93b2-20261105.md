# M2 slice 93b-2 — adding a service to an issued invoice on the canonical runtime (2026-11-05)

Owner decisions:
- **G4-1:** writing a price needs the write grant matching the act, plus the settled price controls.
- **G4-8:** invoice writes stay inside the patient scope.

The contract was written before the code: section 7 of the [Group 4 design](financial-group4-contract-design-20261104.md).

The addition is a **new dated invoice** linked to the original, never a rewrite of an issued one. No cash moves.

## Admission

Every route needs `finance.invoices.create`, together with the price controls by grants. In legacy, only the administrator label could add a service; here the explicit grant replaces the label, as in every slice. The administrator label alone and the view grants never read or write this.

| Route | Canonical behaviour |
|---|---|
| `GET /api/invoices/[id]/add-service` | The registered read `read:invoices.add-service`, on one snapshot. The invoice's patient must be inside the scope; outside answers exactly like a missing invoice (404, same message). Returns the legacy context body. |
| `PUT` (preview) | The same read. The price controls use the same grants as the save, and the request fingerprint is bound to the actor (`userId`, `username`, `role`), as at save time. Writes nothing. |
| `POST` | One admitted operation on the legacy writer, `addInvoiceServiceOn`. |

The `POST` writer keeps, unchanged:
- the per-key lock;
- the replay;
- the lock order;
- the source proof;
- the invoice writer;
- the `invoice.create` and `invoice.service_add` audits.

## Inside the write

- **Actor:** the branded invoice actor (slice 93b) re-proves the live operation and its grants wherever the legacy writer revalidated its session. It always carries the slice-87 lab actor, because the invoice writer materialises lab work (possibly none) for every invoice; whether lab lines are allowed remains the `clinical.visits.document` check.
- **Scope:** decided right after the patient row lock (`admit`). An `own` actor needs a positive ownership witness, taken `FOR SHARE NOWAIT` and held until commit. An early unlocked look comes first.
- **Stale attempts:** a stale attempt still commits its rejection evidence before the refusal, as in legacy. The writer returns `rejected`; the operation commits; then the route refuses.

The legacy wrapper runs the same function and keeps its order and failure mapping.

## Tests

| Gate | Result |
|---|---|
| PG `invoice-add-service-canonical` | 5/5 |
| Race test failure-first | Without the admission, the outside addition was issued (the test failed). Restored, it passes. |
| Legacy invoice PG regression | 39 files, 567/567, including the legacy add-service suite |
| Related unit | 2 files, 38/38 |
| Audits | 10/10 (GET with its projection) |
| tsc | Pass |
| lint | Clean |

The 5 PG tests cover:
- read, preview and add, with the audit and replay;
- a discount without `finance.discounts.apply` refused, and with it allowed;
- the label and view grants refused;
- a stale attempt: rejection evidence committed, nothing issued;
- an `own` creator inside, versus outside reading like missing;
- a forged request on an outside invoice refused;
- revocation;
- the race in which the patient leaves the scope during the patient row lock.

No Production, no merge, no activation.
