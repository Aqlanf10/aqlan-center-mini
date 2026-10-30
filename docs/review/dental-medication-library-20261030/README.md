# Prescription review preview — not clinically activated

Base: `eed6139142bc4b8c571fa2e6bb6f6e00d6d559f9` on `release/login-print-candidate-20261030`, including #496. No merge, deployment, live account/permission/configuration change or real patient access.

## What this change does

Four searchable reference cards inside the existing prescription modal: Paracetamol, Ibuprofen, Amoxicillin and Chlorhexidine 0.2%, with adult/child views, scientific names, Arabic guidance, explicit units, source/version and pending-review status. This is not a complete formulary, local regulatory approval or working clinical autofill library. `MEDICATION_TEMPLATES` remains empty.

A separate synthetic-only arithmetic preview now offers explicitly selected amoxicillin q8h/q12h liquid/tablet profiles. No dose, interval, duration, concentration, device increment or indication is preselected. Its initial narrow scope is >3 months and <12 years and <40 kg; other patients require manual clinician review, not an inference that the drug is forbidden. Local-product validation and owner clinical review are still missing, so no result can be added to the patient's prescription.

Arithmetic checks distinguish per-dose/per-day units, explicit formulation, strict age/weight bounds, minimum interval, PRN maximum, prior/planned rolling-24-hour count/total, absolute and weight-based ceilings, and requested/rounded dose. Actual device increments are required; before/after rounding ceilings and range checks reject excess rather than silently reducing doses. The result reports changed amounts. A checkbox and selected indication do NOT establish clinical appropriateness; the preview says so explicitly. Child duration is clinician-selected, not copied from adult guidance. Paracetamol/ibuprofen/mouthwash stay reference-only pending suitable product profiles; newborn/infant eligibility is not inferred from “under 12”.

The orange draft-only ribbon becomes a small “مسودة للمراجعة” marker. VOID, staging warnings and signature blanks remain. The whole prescription body (diagnosis/Rx/drugs/notes/signature) starts LTR; Arabic instructions and auto-direction text are isolated. Center/patient metadata remains RTL. The penicillin-allergy rule keeps its critical block but no longer suggests fixed clindamycin/azithromycin alternatives.

## Physician identity and approved owner policy

The approved policy is resolved: ordinary doctors issue as themselves; the owner clinician may choose another active registered doctor; employees do not prepare/issue prescriptions. Server checks fresh user ID/username/role/active state, active issuer clinical link, selected doctor and patient scope. Client role/owner/name claims grant nothing.

`0090_prescribing_doctor_snapshot` and `0091_prescribing_doctor_identity` add nullable name/selected-ID snapshots. Existing `doctor_party_id` retains issuer/void semantics; `created_by` and audit actor remain the real account. Selected name/ID and any owner authority witness participate in safety acknowledgement binding. Audit includes owner binding version/fingerprint when present. Existing snapshot-less records are not backfilled or relabelled: print says the physician was not recorded.

Draft URL free-text `doctorName` is ignored. A supplied doctor ID is re-resolved from the current server-authorized options; unauthorized/invalid IDs fail. Missing ID prints no attributed physician. Stored official/void prints ignore URL names and current viewer identities. If the visit doctor differs from the ordinary user's identity, the modal preserves the mismatch, blocks printing/saving, and requires an explicit “issue as myself” action; it no longer substitutes silently.

### One canonical owner adapter, no Rx environment gate

The earlier Rx-specific environment gate was removed after comparison. There are no `PRESCRIPTION_OWNER_*` configuration inputs anymore.

Release base evidence: `lib/staff-capabilities.ts` has `TrustedOwnerContext`, the WeakMap-backed resolver and `ownerContextFromTrustedBinding`; `docs/security/scoped-staff-capability-foundation.md` explicitly describes this as inert, with no live bootstrap. Legacy `admin` is not owner identity.

WORK inspected read-only: remote `feat/work-ci-intake-20261030` at `0bc3a0c57f57a8d0ed9f3cebd1cf56a1e19b11a4`. Its `lib/staff-authority-proof-internal.ts` proves active `staff_authority_control`, ready identity/control epochs, history integrity, canonical account/subject and current provider/clinical epoch. `lib/staff-session-admission.ts` and `lib/staff-durable-issuer.ts` admit/revalidate a durable session. A numeric owner ID plus an environment-version string does not reproduce that proof. No WORK files were copied or merged.

`lib/staff-owner-authority.ts` is the single server adapter contract to the shared authority system. It currently returns null because the release base has no admitted canonical runtime. The Rx adapter accepts only an opaque shared `ResolvedStaffAccess` matching both current user ID and exact clinician party, verified by the shared authorization fingerprint. A cloned JSON proof or changed clinician link fails. Tests supply synthetic shared-resolver proofs; they do not grant live ownership.

Owner binding follow-up design (not implemented): [OWNER_BINDING_DESIGN.md](./OWNER_BINDING_DESIGN.md). The UI explicitly warns that owner-on-behalf selection is unavailable. Prescriber lookup now has loading/error/retry states, blocks save/draft actions until verified, and retires choices and suggestions when patient/visit/session context changes.

**Remaining integration blocker:** connect this shared adapter to the separately reviewed canonical admission runtime before owner-on-behalf issuance can work live. The implementation intentionally fails closed until that integration; no parallel owner identity, guessed account or live binding was introduced. This is a missing authority integration, not an unresolved owner policy.

## Saved prescriptions after visit completion

The visit modal now submits its actual `visitId`; malformed IDs are rejected and the existing server verifies patient/visit equality. No legacy rows are backfilled. Completing treatment leaves the saved prescription unchanged.

`GET /api/patients/[id]/prescriptions/saved` exposes only active prescription ID, visit ID, creation time and stored prescriber name. It does not return notes, diagnosis, drug suggestions or prescriber options. The expandable picker appears in the patient file and filters to the checkout visit when present. It opens the existing record, never POSTs a new prescription.

Reception requires an explicit `canPrintSavedPrescriptions: true` grant through the existing user-permission editor/API. The default is false; no live account was granted permission. The server reads this permission freshly. Existing `canAccessPatient` policy is preserved: reception has broad patient access, not encounter-scoped access; doctor ownership is still enforced. No broader restricted-role routing change was made. Creation, modification, void and draft preview remain forbidden for reception.

The print page independently validates the stored record/patient and rejects missing, void or query-only drafts for reception. The prescription branch of `/api/print-log` resolves the actual active record and patient, checks permission/scope and records the printing actor. The button does not invoke `window.print` after refusal or logging failure. Original prescriber snapshots and issuer/void authority remain unchanged.

Real isolated HTTP/browser journey: doctor issues a linked prescription, signs the visit, administrator grants the synthetic reception user print permission, reception finds the exact record in patient/checkout views and prints it. Before/after SQL equality and row count prove no mutation or duplicate. Tests cover scope mismatch, malformed/missing/void IDs, forbidden create/edit/void, query drafts, permission revocation after opening the page, and no successful print after logging refusal. The test restores the synthetic permission and global teardown drops its database. Three built-app suites pass all 11 tests; additional route tests cover minimal disclosure and fresh revocation. Screenshots: `.settings-ui-artifacts/prescription-reprint/{patient,checkout,revoked-print}.png`.

## Header/footer settings audit

The prescription route uses `getPrescriptionPrintSettings()`: fresh SELECT, no process cache and no safe-reader fallback. Empty/missing clinic identity fields remain empty. Strict rendering is opt-in for this route; other templates keep existing defaults.

| Setting/source | Actual support |
| --- | --- |
| `clinic.name` | Header center name; empty means hidden |
| `clinic.lead_doctor`, `clinic.lead_doctor_title` | Header name/title without orphan separators |
| `clinic.lead_doctor_credentials` | Header qualification, if nonempty and not already in title |
| `clinic.address`, `clinic.phone` | Footer contacts; empty labels/separators removed, phone LTR |
| `clinic.login_photo_asset`, `clinic.login_photo_visible` | Login photo only; not repurposed as print logo |
| `display.tagline` | Waiting-display phrase; Arabic validation calls it “شعار” but it is text, not a logo asset |
| `Logo` in `components/Icon.tsx`, `PrintDocumentWatermark` | Shared `/logo.png` asset; no configured print-logo source |

Registry evidence: `lib/settings.ts` (`SettingKey`, `SETTING_DEFAULTS`, allowlist), `lib/settings-definitions.ts`, `lib/settings-permissions.ts`, `app/settings/page.tsx`, `components/PrintHeader.tsx`, and `components/PrintDocumentWatermark.tsx`. Searched these and other app/lib/components code; WORK likewise has no logo URL/asset or print-header/footer visibility keys. No such switches were fabricated. The fixed dentist specialty under the physician signature was removed. Adding configurable logo/visibility remains a separate explicit gap, not a claimed completion.

## Primary clinical sources checked 2026-10-30

- [AAPD 2025–2026 Useful Medications](https://www.aapd.org/globalassets/media/policies_guidelines/r_usefulmeds25.pdf), pp.669–670.
- [SDCEP Paracetamol](https://sdcepdentalprescribing.nhs.scot/guidance/odontogenic-pain/analgesics/paracetamol/), [SDCEP Ibuprofen](https://sdcepdentalprescribing.nhs.scot/guidance/odontogenic-pain/analgesics/ibuprofen/), [SDCEP Chlorhexidine 0.2%](https://sdcepdentalprescribing.nhs.scot/guidance/ulceration-inflammation/antimicrobial-mouthwashes/chlorhexidine-mouthwash/).
- [ADA/CDC adult dental pain/swelling](https://cdc.gov/antibiotic-use/media/pdfs/ADA-treatment-guidelines-508.pdf), [AAPD antibiotic therapy](https://www.aapd.org/globalassets/media/policies_guidelines/bp_antibiotictherapy.pdf).
- [NHS chlorhexidine eligibility](https://www.nhs.uk/medicines/chlorhexidine/who-can-and-cannot-use-chlorhexidine/), [FDA NSAIDs in pregnancy](https://www.fda.gov/drugs/drug-safety-and-availability/fda-recommends-avoiding-use-nsaids-pregnancy-20-weeks-or-later-because-they-can-result-low-amniotic).
- [NHS adult paracetamol](https://www.nhs.uk/medicines/paracetamol-for-adults/), [HSE low weight/hepatotoxicity risks](https://www2.healthservice.hse.ie/organisation/nqpsd/pst/safety-supplements/paracetamol-dosing-for-adult-patients-under-50-kg-and-those-with-additional-risk-factors-for-hepatotoxicity/), [DailyMed amoxicillin label §2.5](https://www.dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=26e257d5-5b98-3795-e063-6394a90a05bc).

The adult amoxicillin card specifies immunocompetent guideline-eligible adults, review after three days, and stopping 24 hours after complete resolution of systemic signs/symptoms. Renal review and the label's 875mg/GFR<30 caution do not create a renal dosing algorithm. Adult paracetamol notes <50kg, malnutrition/dehydration, chronic alcohol, liver disease and duplicate ingredients; 4g is not an automatic target. No new local dosing ceiling is invented.

## Verification and evidence

Focused units cover Rx safety/security/acknowledgements, identity/snapshots/legacy prints, shared canonical owner proof and relinking, explicit mismatch, arithmetic profiles and clinical review gates. PGlite tests cover actual save/reload/list after registry rename and fresh settings with blanks. Typecheck and focused lint pass. PG18 schema contract includes the two nullable columns. A fresh isolated local PostgreSQL 18 build passed structural drift verification: 133 tables, 1695 columns, 1956 constraints, 413 indexes and 100 triggers.

An isolated local PostgreSQL 18 container and a fresh Node 22 production build enabled actual built-app HTTP/browser verification: prescription diagnosis/context and orthodontic prescription truth suites passed all 10 tests. The harness dropped its synthetic database afterward. Hosted full CI remains required before acceptance. Bundled Playwright download was HTTP403; existing `/usr/bin/chromium` is used for synthetic browser/PDF checks.

255 focused tests in 13 suites and 42 migration/documentation tests in six suites passed. The complete local Node 24 unit run passed 12,875 tests with one skipped; two unrelated CLI reporter-format assertions failed under Node 24 and both passed unchanged under the required Node 22. Hosted Node 22 quality also passed at predecessor bc3c84c2; final-head results must still be checked.

Ignored local evidence: `.settings-ui-artifacts/medication-review/`, including `browser-check.mjs`, `modal-check.mjs`, `calculator-check.mjs`, `browser-results.json`, `prescription-{draft,active,void}.{html,png,pdf}`, `medication-library-{adult,child}-arabic.{png,pdf}`, and `medication-calculator-arabic-review.{png,pdf}`. Synthetic calculator fixture is arithmetic only (including its chosen duration), not patient advice. These component/SSR witnesses are separate from the two built-app HTTP suites reported above; neither substitutes for the complete hosted gates.

### Saved prescription history pagination

The minimal saved-print endpoint filters patient, optional visit and active status in SQL before the page boundary. `تحميل المزيد من الوصفات` traverses every older page with an exact UTC microsecond `created_at` / `id` keyset, 50 records per page. The cursor carries the patient/visit context but grants no access: every request repeats current account, print permission, patient access and visit ownership checks. Context/session changes reset the picker; interrupted next-page reads can be retried without discarding the previous page. Newer inserts do not shift or duplicate the next page. Stored prescription content and original prescriber snapshot are not rewritten by browsing or printing.

The isolated PostgreSQL/browser fixture covers 60 records sharing a microsecond timestamp plus an older visit prescription, a void row, a foreign patient row, insertion between page requests, permission revocation, cursor scope tampering, and visible load-more/retry to the oldest record. This is synthetic evidence only.

### Explicit name-only draft entry

A clinician may now explicitly select one of the four generic names to append a manual draft line. Form, strength/concentration, amount per administration, frequency, duration and instructions start empty. The selection action does not save, print, sign, select a dose, or infer an antibiotic indication. Changes to a selected line clear its manual confirmation. Client and issuance API reject incomplete/unconfirmed selection lines before sanitization can discard a missing name; draft printing rejects them too. Existing stored records remain readable without retroactive requirements.

The manually entered amount and selection review metadata are preserved in the existing items JSON, included in the safety acknowledgement fingerprint, displayed on reprint, and carried into the text of prior-prescription suggestions. These metadata describe a manual entry workflow, not an approved dosing source or an identity proof. The existing free-entry format remains separate; this does not claim to validate the clinical correctness of arbitrary free text. Numeric previews remain synthetic-only and MEDICATION_TEMPLATES remains empty. See [the four clinical decisions for Dr Aqlan](CLINICAL_DECISIONS_AR.md) before any future dose-profile activation.
