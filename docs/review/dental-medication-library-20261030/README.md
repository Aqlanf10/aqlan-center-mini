# Dental medication library: owner review preview

Base: `eed6139142bc4b8c571fa2e6bb6f6e00d6d559f9` on `release/login-print-candidate-20261030`, including #496.

This change shows four reference-only cards within the existing prescription modal: Paracetamol, Ibuprofen, Amoxicillin and Chlorhexidine 0.2%. Search supports English/scientific and Arabic names, with adult/child views. Every card is `pending-owner-review`; adding it to a prescription is disabled. This is not a complete formulary or local regulatory approval. Numerical ranges use LTR isolation inside Arabic text.

The orange draft-only ribbon is replaced with a small neutral “مسودة للمراجعة” marker. The void banner, signature areas, patient access, safety 409 responses and ten-minute acknowledgements retain their existing behavior. The penicillin-allergy alert keeps its critical rule but no longer recommends fixed clindamycin/azithromycin alternatives.

## Review surface and clinical boundaries

`lib/prescription-medication-library.ts` is the complete review preview, with source URLs, versions, units and review state per entry. Primary sources were opened and checked on 2026-10-30:

- [AAPD Useful Medications 2025–2026](https://www.aapd.org/globalassets/media/policies_guidelines/r_usefulmeds25.pdf), pp. 669–670: pediatric paracetamol per-dose and amoxicillin per-day ranges.
- [SDCEP Paracetamol](https://sdcepdentalprescribing.nhs.scot/guidance/odontogenic-pain/analgesics/paracetamol/) and [SDCEP Ibuprofen](https://sdcepdentalprescribing.nhs.scot/guidance/odontogenic-pain/analgesics/ibuprofen/): adult examples, with SDCEP-only pediatric ibuprofen reference and ceilings.
- [ADA/CDC adult dental pain and swelling](https://cdc.gov/antibiotic-use/media/pdfs/ADA-treatment-guidelines-508.pdf) and [AAPD antibiotic therapy](https://www.aapd.org/globalassets/media/policies_guidelines/bp_antibiotictherapy.pdf): indication review and stewardship.
- [SDCEP Chlorhexidine 0.2%](https://sdcepdentalprescribing.nhs.scot/guidance/ulceration-inflammation/antimicrobial-mouthwashes/chlorhexidine-mouthwash/) and [NHS eligibility](https://www.nhs.uk/medicines/chlorhexidine/who-can-and-cannot-use-chlorhexidine/).
- [FDA NSAIDs in pregnancy](https://www.fda.gov/drugs/drug-safety-and-availability/fda-recommends-avoiding-use-nsaids-pregnancy-20-weeks-or-later-because-they-can-result-low-amniotic).

The separate arithmetic scaffold has no clinical seed and is not connected to UI prescribing. Synthetic tests distinguish mg/kg/dose from mg/kg/day, explicit mg/mL conversion, invalid inputs, missing context, and pre/post-rounding ceilings. Excess selected doses are rejected, not silently reduced. The 0.01 mL arithmetic precision is not an approved measurement-device policy.

Pending before clinical activation: owner review of each reference/profile, exact age/current weight and product-concentration input workflow, chosen dose/interval/duration with patient-specific bounds, measuring-device rounding policy, editable draft application and auditable calculation/source snapshot. The current RxItem sanitizer deliberately remains unchanged; no claim is made that calculation provenance is saved. Ibuprofen remains reference-only; no mixed-source calculator. Amoxicillin at exactly 40 kg requires manual review. No procedure template receives drugs.

## Verification

- Typecheck passed locally (Node 24 environment; CI uses supported Node 22).
- Full lint: zero errors, 208 warnings; focused new-file lint separately checked.
- Prescription safety/security/context/diagnosis, medication safety, print semantics and synthetic arithmetic: 238 tests passed in 13 suites after the owner-policy follow-up, including PGlite persistence.
- Synthetic Chromium browser: Arabic search, child view, disabled add; draft/active/void print checks passed. A5 PDFs generated for all three; draft PDF text includes the neutral label and is one page. Actual CSS compiled for library preview. No real patient data accessed.
- Local HTTP test setup blocked: no TEST_DATABASE_URL/DATABASE_URL or PostgreSQL test service configured. Must pass hosted CI before acceptance.
- Bundled Playwright browser download returned HTTP 403 (domain forbidden); existing `/usr/bin/chromium` was used successfully for synthetic browser/PDF verification.

Local reproducible evidence directory: `.settings-ui-artifacts/medication-review/` (ignored), including `browser-check.mjs`, `browser-results.json`, `library-child-review.png`, and `prescription-{draft,active,void}.{html,png,pdf}`. The browser script is synthetic component/SSR evidence, not built-app HTTP acceptance.

## Prescriber, direction and clinic identity follow-up

- The entire Rx heading and medicine block now starts LTR; Arabic instructions have their own RTL/right-aligned block. Patient identity/layout and staging markers are unchanged.
- Migration `0090_prescribing_doctor_snapshot` adds a nullable `prescribing_doctor_name` snapshot, without backfilling old prescriptions. The existing `doctor_party_id` remains the authenticated issuer and retains void-authorization semantics. The new UI sends the selected visit doctor's ID; the server verifies the account clinical identity and target active doctor, and snapshots the selected name and ID. Ordinary clinicians must select themselves; only the explicitly bound owner clinician may select another doctor. Arbitrary submitted names are ignored for official issuance. Snapshot participates in the acknowledgement digest. `created_by` and audit actor remain the real acting account.
- The owner approved direct issuance by the owner clinician as another registered doctor; employees do not prepare prescriptions for approval. The misleading free-text field is replaced by a server-provided owner-only doctor picker, or the ordinary clinician's own read-only identity. Draft-only preview may display its submitted, sanitized name and always carries the neutral draft marker. Saved prints never take physician names from query parameters or the current viewer. Legacy records without a snapshot say the physician was not recorded.
- Prescription printing now reads current settings directly without the process cache or the safe-reader fallback. Empty/missing clinic identity fields stay empty. Header/footer rendering uses strict identity mode only for prescriptions; contact separators/labels disappear when fields are blank, credentials come from settings, and the fixed dentist specialty under the signature is removed.
- The existing repository has a shared `/logo.png` asset but no logo-source setting or print visibility switches. That shared asset remains; adding such settings is not claimed as completed.
- PGlite persistence tests passed (3): migration/runtime SQL equivalence; save/reload/list retain the snapshot after registry rename and preserve actor/issuer; uncached settings preserve newly emptied values. The schema contract adds nullable name and selected-party-ID columns; it was updated structurally and still requires PostgreSQL 18 CI regeneration/verification (not claimed locally generated on PG18).

## Approved owner exception and activation prerequisite

The policy is resolved: ordinary doctors issue as themselves; the owner clinician may choose another active registered doctor; non-clinical staff may not issue. Server checks fresh user ID/username/role/active status, active issuer doctor linkage, selected doctor validity and patient scope. Client role, owner and free-text name claims do not grant authority. `prescribing_doctor_party_id` and name are independent snapshots; existing `doctor_party_id` remains issuer/void identity. Both selected fields participate in acknowledgement binding. A new additive migration `0091` follows already-pushed `0090`; no checksum was rewritten.

This branch has no deployed trusted owner binding. The existing staff capability foundation explicitly does not activate/bootstrap owner identity. The new server-only boundary reads `PRESCRIPTION_OWNER_USER_ID` (verified immutable users.id) and `PRESCRIPTION_OWNER_BINDING_VERSION` from deployment configuration, never staff settings, role alone, username or first-user inference. Missing/invalid binding fails closed. Values were set only synthetically in tests; no production/staging configuration was read or changed. Before live activation, the parent must verify the actual owner ID and arrange this trusted binding through the separately authorized deployment/configuration workflow. This is a configuration prerequisite, not an unresolved policy question.

The prescription-history endpoint returns minimal eligible prescriber choices (ID/name only). The ordinary clinician receives only their active registry identity; the bound owner receives active doctors. Browser tests exercise the actual modal for both cases and verify selected IDs reach POST without client name authority. Clinical references remain review-only, and the pediatric paracetamol card explicitly does not enable newborns/infants without a confirmed minimum age/product profile.
