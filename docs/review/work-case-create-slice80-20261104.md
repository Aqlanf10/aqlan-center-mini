# M2 slice 80 — opening a specialty case on the canonical runtime (group 3, 2026-11-04)

Ninth contract of group 3. Synthetic data only. No migration, no schema change, no money, no deploy.

## Route (1 method)

| Route | Canonical | Legacy |
|---|---|---|
| `POST /api/patients/[id]/cases` | `clinical.plans.edit` inside the patient scope, plus the clinician link or the owner; ortho also `clinical.ortho.view` | doctor/admin labels with patient access |

The case list (`GET`) has been canonical since slice 40 and the status change (`PATCH /api/cases/[id]`) since slice 43.

## Behaviour

- **Never wider than legacy.** The documenting grant alone is not enough: an account without the clinician link (a planner) is refused (403, Arabic).
- **Initial responsibility.** This is the legacy rule, now enforced on the canonical path:
  - the owner may name any active doctor;
  - a clinician may name only themself;
  - naming another doctor is refused (400), so opening a case can never become a grant of another doctor's patient.
- **Ortho.** An orthodontic case or an ortho bridge needs `clinical.ortho.view`, the independent ortho projection (as in slice 43). The screen offers no orthodontic option; those cases are opened from the ortho module.
- **Same body.** `createClinicalCaseOn` is the legacy body: patient `FOR NO KEY UPDATE`, the bridge checks, the insert and the `case.create` audit row together. The legacy wrapper keeps its transaction and its session-based responsibility check.
- **Duplicate prevention.** `requestKey` is required. Under a transaction advisory lock on (actor, key), the receipt (the audit row) is looked up first:
  - the same request returns the first case (`replayed`, 200);
  - another request with the same key is refused (409).
  A double press or a retry after a lost response never opens a second case. The editor says so: re-saving after an unclear result is safe.
- **Scope.** A patient outside the scope reads as missing (404).

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `case-create-canonical` (new) | 4/4 — keyed double press opens one case with its audit and a reused key is refused; the responsibility rule (a clinician only themself, the owner any active doctor); refusals without the link, without the grant, outside the scope, ortho without its view, without a key — none writes; revocation |
| Legacy case PG suites | 455/455 in 25 files |
| Related unit tests | 60/60 |
| Readiness audits | 10/10 |
| Journey `canonical-case-create-journey` (portOffset 136) | with the batch gates |
