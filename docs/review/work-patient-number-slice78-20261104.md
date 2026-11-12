# M2 slice 78 — the patient file number on the canonical runtime (group 3, 2026-11-04)

Seventh contract of group 3. Synthetic data only. No migration, no schema change, no money, no deploy.

## Routes (2 methods)

| Route | Canonical | Legacy |
|---|---|---|
| `GET /api/patients/[id]/number` | the admitted `patients.number.manage` operation inside the patient scope, under the numbering locks | admin label, under the same locks |
| `PATCH /api/patients/[id]/number` | one admitted `patients.number.manage` transaction inside the patient scope | admin label |

`patients.number.manage` becomes a runtime action (registered in the runtime and pinned in the readiness audit). The catalogue already makes it depend on `patients.edit`. No new grant.

## Behaviour

- **Lock order as legacy:**
  - admission (identity) first;
  - then the numbering locks (import, numbering);
  - then the patient row `FOR UPDATE`.
  The operation is re-asserted after each wait, so a revoked grant or an ended session fails closed — as the legacy path re-authorized.
- **Same body.** `changePatientNumberOn` is the legacy body:
  - a stale version or number is refused (409);
  - the same number is refused (400);
  - a used or retired number is refused (409, Arabic);
  - the update and the `patient.number.change` audit row commit together;
  - the database retires the old number.
- **Scope.** A patient outside the scope reads and writes as missing (404).
- **The GET is an operation, not a record read.** It takes the numbering locks like the legacy read, so it never shows a number a running import is changing. It returns only the id, the number and its version.
- **Screen.** The canonical patient file offers the dedicated editor (an optional `canManage` prop) to the owner or a `patients.number.manage` holder; it loads the number only when opened and reloads the file after a change.

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `patient-number-canonical` (new) | 4/4 — read and change with audit and the retired number; stale, same and duplicate refused; two concurrent changes (one wins, one stale); without the grant, outside the scope (nothing written); revocation |
| Legacy numbering PG (`patient-numbering`, `patient-numbering-restore`) | 21/21 |
| Route and runtime unit tests | 139/139 |
| Readiness audits | 10/10 |
| Journey `canonical-patient-number-journey` (portOffset 132) | with the batch gates |

## Limits

- The numbering floor (`/api/settings/patient-numbering`, `settings.operational.edit`) moves with the unified settings, not here.
