# M2 slice 83 — the clinical navigation context on the canonical runtime (group 3, 2026-11-04)

Twelfth contract of group 3. Read only. Synthetic data only. No migration, no schema change, no money, no deploy.

## Route (1 method)

| Route | Canonical | Legacy |
|---|---|---|
| `GET /api/patients/[id]/clinical-context` | `read:patients.clinical` inside the patient scope; plan references also `clinical.plans.view`, ortho references `clinical.ortho.view` | patient access; `canViewPlans` with plan references |

## Behaviour

- **Exact edges only, unchanged.** `resolveClinicalNavigationContextWith` is the legacy reader, run on the owning snapshot:
  - it validates the recorded item → plan → case, episode and visit edges;
  - another patient's plan reads as not found;
  - a mismatched case is `context_mismatch`;
  - it never links, creates or chooses the latest work.
- **Grants.** A plan or item reference needs `clinical.plans.view`, as the legacy guard required. An ortho reference needs `clinical.ortho.view`, the independent ortho projection (slice 43). A visit or case reference needs only the clinical grant.
- **No money.** The result carries ids and the treatment tab, never a plan total or price. The PG test seeds priced items and checks this.
- **Scope.** A patient outside the scope reads as missing (404).

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `clinical-context-canonical` (new) | 4/4 — exact graph by a plan viewer without money; another patient's plan not found, mismatched case a mismatch; plan and ortho grants required, a visit context with the clinical grant only; outside the scope like missing |
| Readiness audits | 10/10 |
