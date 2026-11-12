# M2 slice 74 — clinical record writes on the canonical runtime (group 3, 2026-11-04)

Third contract of group 3. The reads of these records have been canonical since slice 3; this slice moves their writes. Synthetic data only. No migration, no schema change, no money, no deploy.

## Routes (4 methods)

| Route | Canonical | Legacy |
|---|---|---|
| `POST /api/patients/[id]/medical-history` | `clinical.visits.document`, patient scope, `requestKey` | role labels with «edit patient» access |
| `POST /api/patients/[id]/vitals` | the same; the alert written with the reading | the same |
| `POST /api/patients/[id]/intake-history` | the same | role labels with patient access |
| `POST /api/patients/[id]/diagnoses` | the same, plus the validated clinician link or the protected owner | doctor and admin labels |

## Behaviour

- **Scope:** outside the scope answers like a missing patient (404). The scope check takes no row lock, so each legacy writer keeps its own lock order:
  - vitals lock the patient row first;
  - a diagnosis takes the per-patient advisory lock, then the patient `FOR KEY SHARE`.

  A canonical write therefore cannot deadlock a concurrent legacy write.
- **Writers:** the four bodies are extracted unchanged into `…On` functions, and the legacy wrappers keep their transaction. The audit row (after the commit, or fire-and-forget, on the legacy path) commits with the record here.
- **Duplicate prevention:** `requestKey` with an advisory lock and a receipt in the same-transaction audit row:
  - a double press or a retry returns the first record (`replayed`);
  - a reused key with another body is refused (409).

  The medical history, intake and vitals forms send a key and rotate it after a save. For a diagnosis the key is optional: the reviewed diagnosis panel is hash-pinned and left unchanged. Its own tests pin the exact body and a single submission under repeated presses, and each version is serialized by the writer's advisory lock.
- **Screens:**
  - an «التوثيق السريري» section in the canonical patient file for `clinical.visits.document` holders (medical history panel, intake history, vitals modal);
  - each canonical ortho case shows its diagnosis versions, with a new version for a linked clinician or the owner.

## Tests (local, PostgreSQL 18)

| Suite | Result |
|---|---|
| PG `clinical-records-canonical` (new) | 5/5 |
| Legacy PG `medical-history`, `patient-diagnosis-integrity` | 17/17 |
| Journey `canonical-clinical-records-journey` (portOffset 124) | with the batch gates |

## Limits

- No grant is given to any account.
- The vitals alert stays the same clinical field the legacy route wrote. A vitals-free alert change goes through the canonical patient edit (`patients.edit`, slice 8).
