# M2 slice 88 — the patient account on the canonical runtime (2026-11-04)

This is the first slice of group 4 (financial), following the design note [financial-group4-contract-design-20261104.md](financial-group4-contract-design-20261104.md) under the owner's money rule (6615124926) and decisions 6629149113.

## Rule

Every read below is admitted by one registered record read:
- `read:patients.ledger` for the per-patient reads;
- `read:finance.debts` for the debtors list.

Both need `finance.patient-ledger.view` and run inside the actor's patient scope, on one owning read-only snapshot.
- **Outside the scope:** a patient outside it reads exactly like a missing one (404 `patient_not_found`).
- **No substitutes:** `finance.invoices.view` never substitutes (decision 6629149113, point 2), and neither do the clinical grants. Both refusals are tested.
- **Revocation:** applies on the next read. Tested.
- **Never wider than legacy:**
  - legacy admitted these routes by role labels (admin, reception, cashier and accountant per their finance switches, and a doctor through the patient-payments switch);
  - the canonical rule needs an explicit grant;
  - the debtors list, which legacy showed whole, now keeps only rows inside the actor's patient scope (`own` = the validated clinician link, by the same predicate as the patient list).

## Routes

| Route | Canonical read | Body |
|---|---|---|
| `GET /api/patients/[id]/ledger` | `readCanonicalPatientLedger` | the legacy payload by the shared builder `buildPatientLedgerPayload` (the legacy route now uses it too) |
| `GET /api/patients/[id]/statement` | `readCanonicalPatientStatement` | the statement document (print, export and share payload) from `patientStatementSnapshotOn`, with the legacy checks and assembly (`patientStatementDocumentFrom`) |
| `GET /api/patients/[id]/treatment-financial-context` | `readCanonicalTreatmentFinancialContext` | `treatmentFinancialReferencesInSnapshot`, the legacy projection extracted from its own transaction |
| `GET /api/patients/[id]/legacy-balance-arrangement` | `readCanonicalLegacyBalanceArrangements` | the arrangements; `canManage` by grant |
| `GET /api/patients/[id]/debt-repayments` | `readCanonicalDebtRepaymentWorkspace` | `debtRepaymentWorkspaceInSnapshot`, read only |
| `GET /api/finance/debts` | `readCanonicalPatientDebts` | the legacy rows (500 cap, base currency), filtered to the scope |

The legacy readers keep their exact behaviour: each opens its own snapshot and calls the extracted body.

## Controls follow grants, never role labels

The legacy route switched controls on role labels. Each switch now maps to the grant the map gives the matching write:

| Control | Legacy | Canonical |
|---|---|---|
| Receipt remainders (the "correct receipt" control) | admin label | `finance.payments.void` or the owner |
| Opening balance add / edit | admin, or reception "add" by setting | `finance.opening-balances.manage` (the map's grant for both writes) |
| Legacy balance arrangement manage | admin or reception label | `finance.legacy.record` |

These are display flags only. Each write route proves its own grant again in its own slice (91, 95, 97).

## Held for the owner — G4-7

`GET/PATCH /api/patients/[id]/responsibility` changes the case's responsible doctor, but the map gives it `finance.patient-ledger.manage` ("payment responsibility").
- The case-doctor link is what decision 6629149113 uses for the "no charge" authority, and what the clinician's own patient scope follows.
- Putting it under a finance grant would let that grant decide a clinical-financial authority, which that decision rules out.
- The route stays on legacy: a canonical session is refused (401 from the legacy session read) until the owner decides.
- The question and two options are in the design note (G4-7).

## Tests

| Gate | Result |
|---|---|
| PG `patient-ledger-canonical` | 6/6 |
| Legacy PG touching the extracted readers (ledger, statement, treatment references, debt workspace, debts report, arrangements) | 32 files, 319/319 |
| Related unit (statement, treatment context, debts, routes, record reads) | 29 files, 477/477 |
| Readiness and map audits | 10/10 (projections declared for the four migrated GETs with legacy role signals) |
| Typecheck, lint on the changed files | clean |

What the 6 PG tests cover:
- each body equals the legacy body over the same rows (ledger, statement detailed and summary, treatment references, workspace, arrangements);
- controls by grant;
- the debtors list scoped (`own` sees only their patient, and nothing about the other);
- every read refused without the ledger grant;
- `finance.invoices.view` and clinical grants refused;
- outside the scope reads like missing;
- revocation.

