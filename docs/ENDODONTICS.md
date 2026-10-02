# Endodontics clinical workflow (ENDO-0 … ENDO-4)

Release boundary (2026-10-02 21:43 UTC): docs-only PR196 is released. This document describes
the corrected PR197/199/201 implementation candidate, whose final integrated CI, browser artifacts,
merge and Railway verification remain required. Local focused checks are not Production proof.
The [canonical execution matrix](MASTER_ROADMAP_GAP_MATRIX.md) distinguishes this bounded slice
from unfinished radiograph linkage, printing, recall and broader specialty acceptance.

Endodontics lives **inside the patient file** (العلاج ← «علاج الجذور»), reusing the existing chain
Patient → Specialty Case (`clinical_cases`, specialty `endodontics`) → Master Treatment Plan (`plan_items`) →
Visit (`visits`) → treating doctor (`visits.doctor_id`) → Timeline. Nothing here is a new patient silo, ledger,
plan, case or billing model; the gap audit and PR split are in `docs/ENDODONTICS_GAP_AUDIT.md`.

## Data model (migration `0040_endodontics.sql`, additive, no money)

| Table | Role |
|---|---|
| `endo_treatments` | One episode per patient × tooth, tied to a case. At most one `in_progress` episode per tooth (partial unique index). Fields: kind (`initial`/`retreatment`), status (`in_progress`/`completed`/`abandoned`, terminal never reopens), restorative status, crown decision + linked crown plan item, optimistic `version`. |
| `endo_visits` | One structured record per (episode, clinical visit): assessment (symptoms, pulpal/apical diagnosis, cold/heat/EPT, percussion, palpation, mobility, perio, previous treatment, radiographic findings), session data (canals found, instrumentation, irrigation, medicament, obturation technique/material, restoration after, complications), prognosis, next step/visit, `doctor_id`, `version`. History lives here, so signed rows are never updated in place. |
| `endo_canal_records` | Per canal in a record: label (MB, MB2, ML, D, P …), working length (mm), reference point, measurement method, master apical size/taper, obturated. |
| `endo_addenda` | Append-only corrections to a signed record (text, author, time). |

Vocabularies (diagnoses, vitality, tenderness, prognosis, reference points, methods) are validated in
`lib/endodontics.ts`; unknown values are errors, never silently dropped.

## Rules (enforced in `lib/endodontics-db.ts`, not in the UI)

* **Isolation** — every function takes `patientId` and checks the episode belongs to that patient; a foreign
  episode/visit is "not found"/"wrong patient". Tooth isolation = the unique index + patient row lock.
* **Doctor attribution** — the record's doctor is the visit's doctor, else the signer's doctor party (must be
  `parties.kind = 'doctor'`); no doctor ⇒ the save is refused. No new attribution rule.
* **Frozen at sign-off** — saves on a signed visit are refused (409, Arabic message). Corrections are addenda
  (author + time, audited). Completion requires every record to be signed.
* **Concurrency / retry** — episode then visit are row-locked; editing an existing record needs
  `expectedVersion` (stale ⇒ 409); a byte-identical retry succeeds without a second effect; different content
  without a version is refused (never overwrites unseen work). Addendum appends carry a shared-format request key retained across uncertain retries; the same key and content append once, conflicting reuse is rejected.
* **Completion** — needs at least one canal, every canal obturated, and a restoration (temporary at least).
  Abandoning needs a reason (also a DB check).
* **Crown / restorative dependency** — "does the tooth need a crown?" is recorded on the episode and linked to
  the patient's own crown plan item for the same tooth. When the RCT plan item is supplied the dependency
  "crown after RCT completed" is written through the existing `addPlanItemDependency` (no second dependency
  system), atomically. Crown and RCT are explicit selections of the correct categories for the same tooth; the RCT belongs to this episode’s case. The crown plan item being `done` is the source of truth for "restoration complete".
* **Sign-off** — a meaningfully documented endo record counts as clinical work (`canSign … hasEndoRecord`), so an endo-only
  visit can be signed; an empty row, stage alone, canal count or suggested canal labels cannot authorize signing. It produces no invoice by itself; any ordinary billable procedures still use the existing signing/invoice engine. Billing stays on `visit_procedures` / plan items.
* **Timeline** — signed visits show "علاج جذور سن N (stage)" next to their procedures.
* **Audit** — `endo.open`, `endo.visit_save` (with changed fields), `endo.addendum`, `endo.status`, `endo.crown`,
  written in the same transaction.

## API (`/api/patients/[id]/endo…`, all in the HTTP permission matrix)

`GET` (clinic roles, central patient isolation) · `POST` open · `PATCH [treatmentId]` complete/abandon ·
`PATCH [treatmentId]/crown` · `PUT [treatmentId]/visits` save record · `POST [treatmentId]/visits/[endoVisitId]/addenda`.
Writes: doctor/admin. Role check precedes body validation. Linking plan items additionally needs `canEditPlans`.
Every 4xx/5xx carries an Arabic `message`; no exception detail is returned.

## Cockpit (`components/PatientEndo.tsx`)

The current-visit clinical note is the primary workspace. Its essentials follow the selected stage;
assessment starts with six editable controls (stage, complaint, two diagnoses, work note and next step).
Measurements are prominent for canal work; examination tests, extra instrumentation, prior records and
crown/completion controls remain available through named disclosures. Selecting a stage changes only
presentation: it never fills a finding, copies a prior measured value, marks obturation, adds a procedure,
signs a visit or creates a charge. The same full draft is serialized whether a field is visible or folded.
Saved optional data is indicated by a count; saved signed records and addenda stay readable.

Design basis (official product documentation, reviewed 2026-10-02):

- [Open Dental: Enter Treatment](https://www.opendental.com/manual/entertreatment.html) uses tooth context,
  focused procedure selection and reusable procedure information rather than repeated entry in separate silos.
- [Dentrix Ascend: Entering clinical notes](https://hsps.pro/DentrixAscend/Help/Entering_clinical_notes.htm)
  uses a focused note editor with reference/template content and separate save/sign choices; see the
  [official clinical-note dialog](https://hsps.pro/DentrixAscend/Help/assets/images/add_clinical_note_dialog_-_blank.png).
- [Dentrix Ascend: Patient overview](https://hsps.pro/DentrixAscend/Help/Using_the_patient_overview.htm)
  links concise context to the relevant canonical workspaces.

This is an adaptation to MINI's existing structured endodontic model, not a claim those products use
MINI's canal schema or these stage-specific field groups. Clinical validation remains required.

The compact plan context uses only authorized `/cases` projections (`planVisible === true`) and matches
RCT items by both tooth and case. Denied/failed reads never mean "no plan". The optional Today/Plans/Account
callbacks open the existing canonical workspaces; they do not preselect, add, price or bill any item.
The exact-item contextual handoff to ClinicalVisit is a separate, unfinished integration. There is no
second procedure, price, payment or ledger form in Endodontics. This slice provides an optional navigation-guard registration API. Wiring that guard and the canonical
callbacks into the parent patient-file page belongs to the dependent navigation slice; the callbacks are
not active in the parent in this component-only change. That integration must block navigation during
a pending save and confirm before discarding a draft.

A synchronous mutation lock disables editing, cancellation and tooth controls until a response arrives. Failed saves retain the submitted draft. A created clinical case is retained when opening its episode fails; an uncertain case-creation response requires reloading/selecting the saved case before another creation. Patient/permission changes get a fresh component identity. Forms and status/addendum actions retain their captured episode identity; form saves also retain the visit ID. Reordering, removing or closing an episode during reload never retargets a draft: it remains blocked until explicit recovery/discard. A replacement open visit cannot receive an older draft. New-tooth and existing-record drafts are mutually exclusive. Invalid numeric input and populated canal rows without a label are rejected without losing the draft. Switching teeth or patient-file tabs asks before discarding a draft, and full-page navigation warns about unsaved work.

## Tests

Unit (`endodontics`, `endodontics-schema`, `clinical`), PG18 (`endodontics-schema`, `endodontics-workflow`,
`endodontics-signoff`), built-app HTTP (`endodontics-http`: roles, Arabic errors, idempotency, freeze, addenda,
audit), browser journey (`endodontics-ui-journey`: open tooth → diagnosis + canals + working lengths → reload
survives → actual signing dialog/API (including cancellation and refusal of blank/stage/labels-only records) → freeze → addendum → obturation → crown → completion → explicit crown/RCT dependency → reception read-only). The synthetic journey captures 1280px and 390px RTL screenshots in CI. Isolated cockpit tests cover interrupted saves, retries, context changes, navigation and authority changes. Passing technical tests does not constitute clinical validation.

## Not in scope / follow-ups

Radiograph-to-tooth linkage (documents still have no tooth/case link), a printable endo report, and per-tooth recall after completion remain separate, unfinished roadmap work. They are not delivered by this slice. Future AI/Dot features are excluded from the authorized scope.
