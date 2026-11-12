# M2 slice 82 — consumables reads on the canonical runtime (group 3, 2026-11-04)

Eleventh contract of group 3. Read only. Synthetic data only. No migration, no schema change, no deploy.

## Routes (2 methods)

| Route | Canonical | Legacy |
|---|---|---|
| `GET /api/patients/[id]/materials` | `read:patients.clinical` (a clinical grant) inside the patient scope | patient access by role |
| `GET /api/visits/[id]/materials` | the same grant; the visit inside the scope by the queue read's condition (`all`, the clinician's assigned visit, or its patient inside the scope) | patient access by role (walk-ins open) |

## Behaviour

- **No money.** Both reads return items, quantities, dates and reasons. A movement carries `unit_cost_minor`, but no canonical (or legacy) response includes it. The PG test seeds a costed consumption and proves the cost never appears (owner rule 6615124926).
- **Scope.** A patient or visit outside the scope reads as missing (404). A walk-in visit with no file is visible to the whole scope (`all`) or to its assigned clinician only. The legacy read left walk-ins open to every role.
- **One reader.** The legacy patient route now uses the same reader (`listPatientMaterialsWith`), so the query exists once.

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `materials-canonical` (new) | 2/2 — patient and visit reads by grant and scope with a costed movement (cost never returned); outside reads like missing; no clinical grant refused |
| Readiness audits | 10/10 |
