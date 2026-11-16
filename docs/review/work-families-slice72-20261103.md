# M2 slice 72 — patient families on the canonical runtime (group 3, 2026-11-03)

First contract of group 3 (remaining clinical and patient workflows) in the [remaining plan](work-remaining-plan-20261101.md). Synthetic data only; no migration, no schema change, no money written, no deploy.

## Routes (8 methods)

| Method and route | Canonical authority | Legacy rule |
|---|---|---|
| `GET /api/families` (`?q`, `?phone`) | record read `read:families.search`: `patients.edit` + patient scope | admin/reception labels |
| `POST /api/families` | `patients.edit`, every member and guarantor patient in scope, `requestKey` | admin/reception labels |
| `GET /api/families/[id]` | record read `read:families.record`: patient scope | admin/reception/cashier/accountant all; doctor its patients |
| `PATCH /api/families/[id]` | `patients.edit`, a member in scope | admin/reception labels |
| `PUT /api/families/[id]/guarantor` | `patients.edit`, guarantor patient in scope | admin/reception labels |
| `POST /api/families/[id]/members` | `patients.edit`, patient and family in scope | admin/reception labels |
| `DELETE /api/families/[id]/members/[patientId]` | `patients.edit`, patient and family in scope | admin/reception labels |
| `GET /api/patients/[id]/family` | `read:families.record`, the patient in scope (404 like missing) | patient access |

## Privacy and money

- A family is a set of patient records. Members are shown inside the actor's patient scope only. An `own` scope never learns a family without its patients: it reads as missing, and search and phone suggestions match, name and count only members inside the scope.
- A guarantor patient outside the scope is shown as «a guarantor» with no name or number.
- **Owner rule 6615124926:** balances, family totals and the guarantor's phone appear only with `finance.patient-ledger.view`. They come from the canonical ledger engine in the same snapshot. Without the grant there is no figure and no zero. Write responses never carry money.

## Writers, concurrency and duplicate prevention

- The five legacy writer bodies were extracted unchanged into `…On(client, …)`, and the legacy wrappers keep their transaction. Locks are the same (family row, then patient rows; members locked in id order on create), as are the refusals and the same-transaction audit rows.
- Create needs a `requestKey`, held under an advisory lock on (actor, key). The receipt is the `family.create` audit row of the same transaction, so there is no schema change:
  - a concurrent double press, or a retry after a lost response, returns the first family (`replayed: true`);
  - a reused key with a different body is refused (409);
  - a failed attempt commits nothing.
- Two concurrent links of one patient to two families: exactly one wins and the other gets `already_in_family` (409).

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `families-canonical` (new) | 9/9 |
| PG `patient-families` (legacy) | 12/12 |
| Unit tests touching families / profile / permissions / page selection | 100/100 in 5 files |
| Audits (`scripts/audits`) after inventory regeneration | 10/10 |
| Journey `canonical-families-journey` (portOffset 120), patients and entry journeys | run with the combined head's gates |
| `tsc --noEmit`; eslint on the changed files | clean (one pre-existing warning) |

## Not changed / limits

- The family statement print page `/print/family-statement/[id]` stays legacy: it reads the legacy session only, so a canonical session gets «not found» there and no figure. Moving it belongs to the financial group (4), behind `finance.patient-ledger.view`. It is recorded in the [money visibility inventory](work-money-visibility-inventory-20261103.md).
- No grant is given to any real account. View and edit stay separate (`patients.edit` writes; the ledger grant only shows money).
