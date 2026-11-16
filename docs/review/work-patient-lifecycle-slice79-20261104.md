# M2 slice 79 — patient merge and delete on the canonical runtime (group 3, 2026-11-04)

Eighth contract of group 3. Synthetic data only. No migration, no schema change, no deploy.

## Routes (2 methods)

| Route | Canonical | Legacy |
|---|---|---|
| `POST /api/patients/[id]/merge` | `patients.merge`; the original and the duplicate both inside the patient scope | admin label |
| `DELETE /api/patients/[id]` | `patients.delete`; the file inside the patient scope; the confirmation checked on the locked row | admin label |

`patients.merge` and `patients.delete` become runtime actions (registered in the runtime and pinned in the readiness audit). The catalogue already makes both depend on `patients.edit`. No new grant.

## Behaviour

- **Same bodies.** `mergeDuplicatePatientOn` and `deletePatientCascadeOn` are the legacy bodies, unchanged, on the caller's transaction:
  - row locks: both files `FOR UPDATE` in id order, or the single file;
  - the financial guard (payments, opening balances, inventory movements, earlier finance records, retired collection keys);
  - for delete, the clinical guard;
  - the all-or-nothing move of every foreign key, and the cascade.
  The legacy wrappers keep their transaction and still write the audit row after the commit. The canonical command writes `patient.merge` / `patient.delete` inside the same transaction. A refusal rolls everything back.
- **Money (owner rule 6615124926).** A refusal for financial history says so in words, in Arabic. Counts of financial records go only to an actor holding `finance.patient-ledger.view` or to the protected owner:
  - the refusal for financial history carries no counts without the grant;
  - the refusal for clinical history and the delete result drop the payment and invoice counts without the grant.
- **Scope.** Any file outside the scope reads as missing (404), as the original or as the duplicate.
- **Projection.** The merged record is returned with the file's projection: care fields by a clinical grant, coordination flags by the operational grant.
- **Screen.** The canonical patient file has a closed «دمج ملف مكرر أو حذف الملف» section. It shows the merge form to `patients.merge` holders and the delete form to `patients.delete` holders (or the owner). Each form needs the file number typed again and sends once per press; after a delete, the user returns to the patient list.

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `patient-lifecycle-canonical` (new) | 6/6 — merge with joined alerts, projection and audit; financial refusal with and without the ledger grant; refusals without the grant, outside the scope, same file; delete with confirmation and audit; financial and clinical refusals roll back (counts by grant); outside scope; revocation |
| Legacy merge/delete PG suites (identity, deletion guard, source, families, medical history, collection retirement, document associations, periodontal, ortho union…) | 147/147 in 16 files |
| Related unit tests | 348/348 |
| Readiness audits | 10/10 |
| Journey `canonical-patient-lifecycle-journey` (portOffset 134) | with the batch gates |
