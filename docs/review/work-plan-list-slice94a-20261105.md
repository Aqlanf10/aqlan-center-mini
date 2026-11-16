# M2 slice 94a — the plan list on the canonical runtime (2026-11-05)

Owner decisions G4-1, G4-6 and G4-8 (6648682456).

The contract is section 9 of the [Group 4 design](financial-group4-contract-design-20261104.md), written before the code. The route is `GET /api/plans`: one patient's plans with `?patientId=`, otherwise the active plans.

## Admission

The registered read is `read:plans.list`. It admits a reader holding any one of:
- `clinical.plans.view`;
- `finance.invoices.view`;
- `finance.patient-ledger.view`.

It runs on one snapshot. The rows stay inside the patient scope:

| Scope | Rows |
|---|---|
| `own` | The validated clinician's patients. With `?patientId=`, a patient outside the scope reads like a missing one (404). Without it, the active list is filtered in SQL with the patient-list predicate before the legacy limit of 300. |
| `all` | Every plan. |

What decides nothing:
- the role labels;
- the legacy `workflow.doctor_financial_view` setting (G4-6).

## Projection

The projection is an allowlist. A hidden group is omitted, never nulled or zeroed.

| Group | Grant | Contents |
|---|---|---|
| Identity | Any admitting grant | Identity fields. The plan picker's structure, as legacy gave every reader through `withoutPlanPayments`: `agreementApproved`, `hasInstallments`, and instalment identities `{ id }` only. |
| Clinical | `clinical.plans.view` | Title, note, items without money, counts, consent. A finance-only reader sees the title `خطة مالية #<id>`, as legacy finance roles did. |
| Agreement total | `finance.invoices.view` or `finance.patient-ledger.view` | The agreement total. |
| Prices | `finance.invoices.view` | The instalment schedule (dates and amounts), item prices and billing (on items, so only with the clinical group), item money progress. |
| Account | `finance.patient-ledger.view` | Paid, `progress`, reminders, the invoice-backed and approved-agreement positions, the debt source. |

`canSeeFinancial` is true only when both money groups are present, so a screen never shows an absent group as zero.

## Corrections made before the commit

Two corrections came out of the tests and the screen review:

1. **The agreement total.** The first draft of the contract put it under prices alone. The PostgreSQL sentinel test found that the account `progress` repeats it. The slice 88 ledger summary (`planLedgerSummary`), already reviewed, shows the total and the full instalment progress under `finance.patient-ledger.view`. The contract now follows that: one answer per grant across both reads.
2. **The plan picker.** A review of the screens found that `OrthoPackageLink` refuses a plan without an `installments` array. Instalment identities (ids only) therefore stay for every reader, as in legacy.

## Screens

| Screen | With an absent group |
|---|---|
| `/finance/plans` | Filters by `debtSource` before reading `progress`, so a reader without the account group sees empty lists, not an error. |
| `/finance` | Reads `progress` with optional chaining. |
| The ortho package link | Receives the identities it requires. |

## Tests

| Gate | Result |
|---|---|
| PG `plan-list-canonical` | 5/5 |
| Unit `canonical-plan-list-projection` (all 8 grant combinations plus the allowlist) | 9/9 |
| Scope filter failure-first | Without the own-scope filter, the own list included the other patient's plan (the test failed). Restored, it passes. |
| Legacy and related PG (plan instalments, status audit, statement plans, patient ledger, record-read catalogue suites) | 6 files, 89/89 |
| Related unit | 5 files, 184/184 |
| Audits | 10/10 (GET with its projection) |
| tsc | Pass |
| lint | Clean |

The 5 PG tests cover:
- **The grant matrix,** with a distinct sentinel per group: the clinical text, the later instalment amount, the reminder date. The item price, the total and the next due amount are each checked against the grants that may show them.
- **Scope:** `own` against `all`, with and without `patientId`.
- **Refusals:** a role label without grants, and an unrelated grant.
- **G4-6:** the legacy setting turned on changes nothing.
- **Revocation and narrowing:** a removed grant refuses the next read; a narrowed grant drops its group.

No Production, no merge, no activation.
