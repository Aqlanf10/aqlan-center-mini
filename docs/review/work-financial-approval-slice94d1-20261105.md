# M2 slice 94d-1 — the plan's financial approval on the canonical runtime (2026-11-05)

Owner decisions G4-1 and G4-8 (6648682456). The contract is section 12 of the [Group 4 design](financial-group4-contract-design-20261104.md), written before the code. The route is `POST /api/plans/[id]/financial-approval`.

## Grants

| Source | Grant |
|---|---|
| A new agreement | `finance.invoices.create` (the map's grant) |
| Matching an existing source (`invoice` or `opening`); the legacy route allowed the administrator label only | `finance.invoices.create` **and** `finance.agreements.manage` |

## The writer

The writer is unchanged:
- key and request hash;
- patient row, debt-account and plan locks;
- the existing-source, history and clinical-history guards;
- the source ownership lineage;
- the schedule-equals-total check;
- the approval row and the `plan.financial_approval` audit in the same transaction.

It is split into `approveAgreementOn(client, input, afterLocks)`; the legacy wrapper keeps its transaction. The slice 91 branded actor re-proves exactly these grants wherever the writer revalidated its session.

## Scope

- The scope is decided right after the patient row lock. An `own` actor needs a positive ownership witness `FOR SHARE NOWAIT`, held until commit.
- On the canonical path the replay before the locks is skipped, so nothing answers before the scope is decided.
- Outside the scope reads like a missing plan.
- Legacy status codes are unchanged. A missing plan answers 404 on the canonical path only.

## Tests

| Gate | Result |
|---|---|
| PG `financial-approval-canonical` | 4/4 |
| Race failure-first | Without the admission, the outside approval went through (the test failed). Restored, it passes. |
| Legacy PG (every suite using `approveAgreement`) | 19 files, 265/265 |
| Audits | 10/10 |
| tsc | Pass |
| lint | Clean |

The 4 PG tests cover:
- a new approval with its invoice and audit, and replay;
- an existing source refused without `finance.agreements.manage` and handed to the writer's own rules with it;
- view grants, collect alone and the label refused;
- outside equals missing;
- revocation;
- the race.

The test fixture gives the agreement manager `finance.patient-ledger.view`, which the capability catalogue requires alongside `finance.agreements.manage`.

No Production, no merge, no activation.
