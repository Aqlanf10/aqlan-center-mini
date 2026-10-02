# ENDO-0 — Endodontics: Gap Audit and PR Split

Status: audit only (no code). Branch `feat/endodontics-clinical-workflow`, from `main` @ `11f7f00`.
Rule followed: AUDIT → REUSE → EXTEND → TEST → DOCUMENT. AQLAN Dental Pro was used as a *functional*
benchmark only (what an endodontic chart records); no schema, architecture or code was copied.

## 1. What exists today (measured on main)

| Area | Where | What it gives endo |
|---|---|---|
| Template | `lib/specialty-templates.ts` (`endo`) | Plan template: RCT (3 sessions), post, crown — items per tooth, billing rules, lab step |
| Specialty case | `clinical_cases` (migration 0032, `lib/cases.ts`, `/api/patients/[id]/cases`) | `specialty = 'endodontics'`, `site`, `responsible_party_id` (doctor), status machine (terminal states never reopen), `visits.case_id`, `plan_items.case_id` |
| Problem list | `patient_problems` | Free-text problem + site, linked to case/plan item |
| Tooth chart | `tooth_conditions` (append-only, FDI `tooth_code`), `lib/dental.ts`, `DentalChart.tsx`; `CATEGORY_TO_CONDITION` turns an `rct` service into condition `rct` at sign-off | Condition history per tooth |
| Visit | `visits` (`doctor_id`, `case_id`, `chief_complaint`, `examination`, `diagnosis`, `treatment_done`, `next_plan`, `signed_at/by`, `addendum`) | Free-text SOAP-like note; signed visits are immutable; correction = `addVisitAddendum` (append-only text) |
| Procedures | `visit_procedures` (`tooth_code`, `doctor_id`, `plan_item_id`) | The billed unit of work; doctor frozen at sign-off (DOCATTR-1) |
| Sign-off | `signClinicalVisit` (one transaction: procedures, invoice, chart, plan items, lab, materials, ortho session) | The single door that produces billing + commission attribution |
| Specialty record precedent | `ortho_adjustments` written by `writeOrthoSessionInTx` | Pattern: row lock on the case, once per (case, visit), patient/visit ownership check, audit row in-transaction |
| Dependencies | `plan_item_dependencies` + `addPlanItemDependency`, sign-off refuses unmet ones (override with reason) | Crown after RCT is expressible today |
| Documents | `patient_documents` | Radiograph files per patient (no tooth/case link) |
| Timeline | `patientTimeline` | Signed visits with procedures, doctor, case title |
| Support content | `post-op-care.ts` (endodontics), `consent-templates.ts` (endo), Rx template for endodontic flare-up, doctor commission category `endo` | Printable instructions, consent, prescription, commission |
| Audit | `insertAuditRow`, `lib/audit-coverage.ts` guard | Every new mutating route must be audited (static guard enforces it) |

## 2. What is missing

The visit note is free text. Nothing structured exists for: pulpal/apical diagnosis, vitality tests,
percussion/palpation, mobility/perio, retreatment status, canal count and identification, per-canal
working length with reference point and method, instrumentation, irrigation, medicament, obturation,
temporary/permanent restoration status, complications, prognosis, next-step, completion, and the
crown/restorative dependency state after RCT. There is also no per-tooth endodontic episode that spans
several visits, so "where is tooth 36 in its treatment?" cannot be answered without reading notes.
Radiographs cannot be tied to a tooth/treatment/visit.

## 3. What will be reused (nothing re-invented)

* Patient → `clinical_cases` (specialty `endodontics`) → plan items → `visits` → `visits.doctor_id` → timeline.
* Doctor attribution: the visit's treating doctor (the same `parties.kind = 'doctor'` resolution used at
  sign-off). No new attribution field with its own rules.
* Billing: untouched. RCT stays a `visit_procedure` on the plan item; the endo record carries no money.
* Sign-off immutability + addendum pattern (visit signed ⇒ endo visit record frozen; corrections are
  append-only addenda, each audited).
* Row-lock-then-once-per-(parent, visit) idempotency from `writeOrthoSessionInTx`.
* Crown dependency through `plan_item_dependencies` (not a second dependency system).
* Audit via `insertAuditRow`; HTTP permission matrix; `guardPatient` doctor/admin write rule.

## 4. Design (additive, no destructive migration)

* `endo_treatments` — one episode per patient × tooth × specialty case: kind (initial/retreatment),
  status (in_progress/completed/abandoned), crown/restorative dependency fields, optimistic `version`.
  Partial unique index: one in-progress episode per (patient, tooth).
* `endo_visits` — one row per (treatment, clinical visit): assessment (diagnoses, tests, radiographic
  findings), per-visit procedure data (irrigation, medicament, temporary restoration, complications),
  prognosis, next step. History lives here, so signed history is never updated in place.
* `endo_canal_records` — per (endo visit, canal): working length, reference point, measurement method,
  preparation/instrumentation, obturation.
* `endo_addenda` — append-only corrections to a frozen endo visit.
* Writes only while the linked `visits` row is unsigned; after sign-off only addenda.

## 5. Proposed PRs (small, in order)

1. **ENDO-0** (this) — audit + design doc.
2. **ENDO-1** — additive schema (migration 0040 + `ensureSchema` mirror, per the ortho precedent) and pure
   logic (`lib/endodontics.ts`: FDI canal expectations, validators, status machine, summaries) with unit tests.
3. **ENDO-2** — DB layer + API (`/api/patients/[id]/endo…`), permission matrix, audit, PG18 tests
   (patient/tooth isolation, multi-canal, multi-visit, doctor attribution, concurrency, idempotency,
   signed-history immutability, crown dependency) + HTTP permission tests.
4. **ENDO-3** — cockpit UI inside the patient file (treatment sub-tab), timeline event, sign-off
   recognises endo work as clinical content.
5. **ENDO-4** — browser E2E flow + docs.

## 6. Out of scope / stop conditions

No new ledger, billing engine, case or plan model; no change to `ensureSchema()` ownership beyond the
standard additive mirror used by every recent feature (documented in the PR). Production data is not
touched. If a requirement would need more than that, the work stops and is documented instead.
