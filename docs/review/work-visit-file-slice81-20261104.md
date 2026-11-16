# M2 slice 81 — visit ↔ file actions on the canonical runtime (group 3, 2026-11-04)

Tenth contract of group 3. Synthetic data only. No migration, no schema change, no money, no deploy.

## Routes

| Route | Canonical | Legacy |
|---|---|---|
| `PATCH /api/visits/[id]` `link` | `visits.manage`; the visit and the target file inside the scope | role labels with visit and file guards |
| `PATCH /api/visits/[id]` `open_file` | `visits.manage` + `patients.create` (it may create a file); the matched file checked before the link | doctor/admin/reception labels |
| `DELETE /api/visits/[id]` | `visits.delete` (new runtime action; legacy admin label); the visit inside the scope | admin label |

The queue moves of `PATCH` have been canonical since slice 12. `defer` (deferring payment, a money decision) still refuses on the canonical path (409) and moves with the financial group, so the `PATCH` route stays `existing` in the map. The reception handoff (`POST /api/visits/[id]/reception-handoff`) depends on walkout visibility, which is financial follow-up, and also moves with group 4.

## Behaviour

- **No scope by construction.** Opening a file from a visit may match an existing file by phone. On the canonical path, the matched file is checked against the actor's scope *before* the visit is linked: the legacy body's `admit` hook, threaded through `openVisitPatientFileOn`. Without it, linking an assigned visit would itself bring that file into a clinician's scope. The PG test caught exactly this on the first run. A file outside the scope is refused (409, Arabic) without naming it, and nothing is written.
- **Same bodies:**
  - `linkVisitToPatientOn`: signed visits, chart events and lab identities refuse a relink;
  - `openVisitPatientFileOn`: phone match, else a new numbered file;
  - `deleteVisitOn`: signed, invoiced and lab-linked visits refuse; soft links cleared.
  The legacy wrappers keep their transactions (and the post-commit delete audit).
- **Audit in the same transaction:**
  - `visit.link` is a new audit action — the legacy link wrote none;
  - `patient.create` when a file is created;
  - `visit.delete` on delete.
- **Scope.** A visit outside the scope (the queue read's condition) reads as missing (404).

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `visit-file-canonical` (new) | 4/4 — link with audit and a file outside the scope refused; open_file needs `patients.create`, creates with audit, a phone match outside the scope refused and rolled back; delete with audit, signed refused, `visits.delete` required; revocation |
| Legacy visit PG suites (relink, chart integrity, actor audit…) | 75/75 |
| Canonical visit PG suites (slices 11–13, 22, 28) | 68/68 |
| Related unit tests | 23/23 |
| Readiness audits | 10/10 |
| Journey `canonical-visit-file-journey` (portOffset 138) | with the batch gates |
