# M2 slice 77 — endodontics on the canonical runtime (group 3, 2026-11-04)

Sixth contract of group 3. Synthetic data only. No migration, no schema change, no money, no deploy.

## Routes (6 methods)

| Route | Canonical | Legacy |
|---|---|---|
| `GET /api/patients/[id]/endo` | `read:patients.clinical` inside the patient scope; plan items and plan progress only with `clinical.plans.view` | patient access; plan items with `canViewPlans` |
| `POST /api/patients/[id]/endo` (open an episode) | `clinical.visits.document` + clinician link or owner, inside the scope | doctor/admin labels |
| `PATCH …/endo/[treatmentId]` (complete / abandon) | the same | the same |
| `PATCH …/crown` (crown decision) | the same; plan-item links also need `clinical.plans.edit` | the same; links with `canEditPlans` |
| `PUT …/visits` (visit record) | the same; the treating party is the validated clinician link | the same; the session's party |
| `POST …/addenda` (signed visits) | the same, plus `clinical.visits.sign` (the map) | the same labels |

## Behaviour

- **Never wider than legacy.** Every write needs the documenting grant *and* the clinician link or the protected owner. A documenting account without the link is refused (403, Arabic), before the patient scope or any body.
- **Same bodies.** `openEndoTreatmentOn`, `changeEndoStatusOn`, `setEndoCrownOn`, `saveEndoVisitOn` and `addEndoAddendumOn` are the legacy bodies, unchanged, on the caller's transaction:
  - the legacy wrappers keep their transaction (`inEndoTransaction`: COMMIT on success, ROLLBACK on a refusal, as the bodies did inline);
  - in the canonical command a refusal throws, so the admitted transaction rolls back whatever the body did;
  - row locks, version checks and audit rows (`endo.open`, `endo.status`, `endo.crown`, `endo.visit_save`, `endo.addendum`) are unchanged and commit with the change.
- **Duplicate prevention is the bodies' own:**
  - a second open on the same tooth is refused while one is in progress;
  - the same visit draft replays without a second effect; edits need `expectedVersion`;
  - addenda carry the legacy request key;
  - a repeated status change is an invalid transition.
- **Scope.** A patient outside the scope reads and writes as missing (404). The scope check takes no row lock.
- **Screen.** The canonical patient file has an on-demand «علاج الجذور» section: nothing is read until it is opened. Recording is offered by the capability projection (`clinical.visits.document` or the owner); plan links by `clinical.plans.edit`.

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `endo-canonical` (new) | 7/7 — open with audit and a refused second open; visit record, replay and conflict; addendum needs the signed visit, `clinical.visits.sign` and replays by key; crown links need `clinical.plans.edit`; abandon and invalid transition; refusals write nothing; reads by grant and scope without plan items; revocation |
| Legacy endodontics PG suites (integrity, workflow, sign-off, invoice revision) | 78/78 |
| Related unit tests (dossier, response permissions, doctor identity, cockpit containment) | 116/116 |
| Journey `canonical-endo-journey` (portOffset 130) | with the batch gates |

## Limits

- The dossier print (`/print/dossier/[id]`) still reads `listPatientEndo` on the legacy path; it moves with the print pages.
- The canonical section opens without the legacy workflow summary. The open visit offered for recording is the patient's latest visit that is not done; the server still refuses a signed visit or another patient's visit.
