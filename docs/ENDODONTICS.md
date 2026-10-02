# Endodontics clinical workflow (ENDO-0 … ENDO-4)

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
  without a version is refused (never overwrites unseen work).
* **Completion** — needs at least one canal, every canal obturated, and a restoration (temporary at least).
  Abandoning needs a reason (also a DB check).
* **Crown / restorative dependency** — "does the tooth need a crown?" is recorded on the episode and linked to
  the patient's own crown plan item for the same tooth. When the RCT plan item is supplied the dependency
  "crown after RCT completed" is written through the existing `addPlanItemDependency` (no second dependency
  system). The crown plan item being `done` is the source of truth for "restoration complete".
* **Sign-off** — a structured endo record counts as clinical work (`canSign … hasEndoRecord`), so an endo-only
  visit can be signed; it produces no invoice by itself. Billing stays on `visit_procedures` / plan items.
* **Timeline** — signed visits show "علاج جذور سن N (stage)" next to their procedures.
* **Audit** — `endo.open`, `endo.visit_save` (with changed fields), `endo.addendum`, `endo.status`, `endo.crown`,
  written in the same transaction.

## API (`/api/patients/[id]/endo…`, all in the HTTP permission matrix)

`GET` (clinic roles, central patient isolation) · `POST` open · `PATCH [treatmentId]` complete/abandon ·
`PATCH [treatmentId]/crown` · `PUT [treatmentId]/visits` save record · `POST [treatmentId]/visits/[endoVisitId]/addenda`.
Writes: doctor/admin. Role check precedes body validation. Linking plan items additionally needs `canEditPlans`.
Every 4xx/5xx carries an Arabic `message`; no exception detail is returned.

## Cockpit (`components/PatientEndo.tsx`)

A chairside strip answers, at a glance: **Diagnosis → Canals → Working lengths → Sessions → Status → Next step**;
below it the canal table (latest working length per canal), the record form for today's open visit (canals
prefilled from the FDI tooth, last working length shown as a hint), the session history (signed/open, addenda),
and the crown/complete controls. Reception reads; only doctor/admin write.

## Tests

Unit (`endodontics`, `endodontics-schema`, `clinical`), PG18 (`endodontics-schema`, `endodontics-workflow`,
`endodontics-signoff`), built-app HTTP (`endodontics-http`: roles, Arabic errors, idempotency, freeze, addenda,
audit), browser journey (`endodontics-ui-journey`: open tooth → diagnosis + canals + working lengths → reload
survives → sign-off freezes → addendum → obturation → crown → completion → reception read-only).

## Not in scope / follow-ups

Radiograph-to-tooth linkage (documents still have no tooth/case link), printable endo report, AI tools for endo,
and a per-tooth recall after completion are deliberate follow-ups, not part of this workflow.
