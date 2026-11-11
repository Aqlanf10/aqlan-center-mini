> Historical preservation note (2026-11-11): recovered from Staging commit `779bf35`. This document records its original review context, not current deployment state or authorization. Branches, migration prerequisites and commands below must be revalidated against the selected candidate and target before use.

# Source-specific dose review — partial, code-only tranche

## What this change does and does not complete
The library keeps 24 separate research reference records and their 28 primary-source locators. Four explicit mathematical adapters are implemented: SDCEP adult paracetamol tablet example, AAPD child paracetamol, and the distinct AAPD child amoxicillin q8/q12 regimens. The other 20 records remain readable references, with an explicit unsupported-calculation explanation. **Four adapters are not completion of the full requested dosing catalogue.** No automatic antibiotic selection, clinical sign-off, owner delegation, identity grant, migration, Stage activation or Production change is included.

Sources independently rechecked on 2026-11-01:
- AAPD Useful Medications, revision2025, pp669–670: https://www.aapd.org/globalassets/media/policies_guidelines/r_usefulmeds25.pdf
- SDCEP paracetamol: https://www.sdcepdentalprescribing.nhs.scot/guidance/odontogenic-pain/analgesics/paracetamol/
- SDCEP amoxicillin was reviewed for comparison, not mixed into AAPD: https://www.sdcepdentalprescribing.nhs.scot/guidance/bacterial-infections/dental-abscess/first-line-antibiotics/amoxicillin/

The JSON is a traceable display reference, not a settings seed or approved executable formulary. Rules are explicit TypeScript, never inferred by parsing its prose. Source ranges, daily totals derived from a regimen, and actual ceilings must remain distinct. Reference warnings are not an exhaustive drug-interaction service.

## Choice and calculation boundary
The physician selects a profile and indication, completed age in months verified from date of birth, current verified weight, explicit dose, schedule, duration/review plan, actual product and label URL, ingredient, formulation, strength, minimum labelled age, and measurement increment. Inputs start empty. Completed months are a conservative scope: the >3-month AAPD adapter first admits a verified completed4months; it does not infer precision from birthYear. Child paracetamol is limited to a conservative app subset6months–<12years, plus the actual product label's age restriction.

The adult SDCEP example is specifically500mg tablets,1000mg four times daily, source duration5days, adult app scope18years+, and requires weight>=50kg without special-population adjustments. A different duration belongs to explicit manual prescribing, not a false claim to that example. Child paracetamol requires a separately verified label single-dose limit, also bounded by the source adult single dose; its PRN administration count is a maximum, not a fixed schedule. AAPD amoxicillin uses mg/kg/day divided by3 or2 and its respective single-dose ceiling; no duration is invented from the adult ADA/SDCEP regimen. Duration1–30 is only a bounded input policy for the manually documented duration, not a recommendation for every infection.

There is no mg/g, units, percentage or combination-ratio conversion in these four adapters. Product ingredient and single-ingredient formulation must match. Tablet splitting and dose capping/rounding are not guessed. Liquid volume must be measurable at the explicitly supplied increment. Special-population or interaction adjustments stop the calculator and require a separately reviewed manual decision. A label checkbox is an attestation to review, not an authority token or proof that a product is locally registered.

## Immutable provenance and server enforcement
`selection.doseReview` is versionedv1: either reference-only, or calculated with the complete required input snapshot and numeric results. The strict boundedv1 transport parser is immutable; future schema versions need their own parser. It must not be narrowed when current clinical rules change, or old history would be damaged.

New issuance validates current source/version, redoes calculation, compares claimed results and exact prescribed fields AFTER receipt reservation and authorized replay, and repeats before persistence. Audit and Rx/receipt remain atomic. Admission before receipt validates only the bounded snapshot shape; an old valid receipt does not depend on today's reference admission. Modified payload cannot borrow the old receipt because tagged canonical provenance is in both command and safety acknowledgement. Non-profile canonical bytes remain unchanged.

Manual editing clears calculated provenance to explicit reference-only and invalidates the row confirmation. It never leaves a calculated badge on changed directions. The final Rx row starts unconfirmed even after the profile preview was reviewed. Existing permission, patient scope and safety-ack controls still apply; no client fingerprint is authority.

Snapshot input/result is stored with the immutable Rx, not sessionStorage. Draft print query items deliberately omit it, and saved print reads actual prescribed fields from the stored record. Reception has no picker or clinical input access; existing explicit saved-print permission remains required, before and after visit closure. Product label URL and age/weight inputs are not placed into print markup or diagnostic error messages.

## Release / rollout gates
This is a separate tranche over corrected catalogue510 application88238e14. Preserve all existing image workflows and catalogue fixes. Do not deploy a mixed fleet of pre-profile writers that silently strips new provenance; the exact candidate and all issuance workers must be verified before enabling the new UI. No deployment is authorized by this document.

Required evidence on the exact published head:
1. Full typecheck/lint/unit/audit/build, native SQL, HTTP and image gates.
2. Native profile test: actual snapshot persistence, forged-result rollback with no Rx/receipt/audit, simulated reference retirement permits original authorized replay but refuses a fresh command, tampered payload conflicts, revoked actor denied. The retirement hook is simulated; the SQL and authority/audit paths are real.
3. Built-app browser journey in `prescription-reprint-journey.test.ts`: choose profile, inspect dose/volume, change weight/concentration and lose confirmation, re-review, issue exactly once, recover/replay, reception saved-print persists after clinical sign, snapshot does not leak to picker/print.
4. Actual A6 CSS/PDF test in `compact-print-regressions.test.tsx`, calculated amount/concentration/directions and long review text, page geometry and field retention. Long actual-product input is deliberately snapshot-only, not silently used as a clinical display identity.
5. Controlled Stage journey only after deployment identity/image and existing test-account permissions are verified. No missing owner or print grant is manufactured.

Local hook/model tests are not browser/native/PDF proof. The broader local attempt that loaded a hidden database helper and lost a worker is retained as a failed resource-limited attempt, not counted as green. No local full build or native database run is claimed. Owner selection remains a separate canonical-authority dependency and an open acceptance item.
