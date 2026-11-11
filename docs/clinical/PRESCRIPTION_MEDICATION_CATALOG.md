> Historical preservation note (2026-11-11): recovered from Staging commit `779bf35`. This document records its original review context, not current deployment state or authorization. Branches, migration prerequisites and commands below must be revalidated against the selected candidate and target before use.

# Prescription medication catalogue

## Distinct layers
- Scientific reference cards describe sources and limitations; selecting a card copies **only the generic name**, not a regimen. There is no clinically activated numerical seed.
- `/settings/medications` manages the clinic's manual templates: generic name, form, labelled concentration, optional amount/frequency/duration/instructions, population, indication, cautions and source URL. Availability is **not clinical approval**.
- Selecting a clinic template copies its current values into an unconfirmed prescription draft with catalogue UUID/revision. The prescribing clinician still checks patient age/weight, indication, allergies, interactions, product, amount, interval and duration. The existing per-item review and server safety acknowledgement remain mandatory. No antibiotic or allergy alternative is selected automatically.

## Integrity and access
The bounded exact JSON uses existing `settings` storage under `clinical.medication_catalog`; no migration or provisioning runs. Settings management permission is unchanged. API requests affecting this key must carry `__expectedActor` as an exact UI-context match; the server derives authority/audit identity from its authenticated session, never this field.

Writes serialize even the first missing-row insertion with the existing advisory lock, then revalidate the session, validate transitions/CAS and write the settings+audit atomically. Every changed entry increments its revision. Entries are disabled instead of deleted; IDs are never reused by the supported editor. The legacy unaudited settings writer refuses this key. Restoring an older value through a generic endpoint is not a backdoor around transition validation.

New issuance rechecks referenced catalogue entry state/revision under a share lock, after command replay has been resolved. A changed/disabled entry therefore stops a new stale draft but does not revoke an already issued document. Saved history, printing, command replay and recovery continue reading immutable Rx snapshots under their existing current-access checks. Catalogue edits never rewrite saved Rx values. Both idempotency and safety-ack semantics bind catalogue UUID/revision when present; pre-catalogue command bytes are unchanged.

## Review and deployment
Clinical source review is separate from software acceptance. The reference collection is neither a local product-registration claim nor an individualized dosing recommendation. Non-covered populations, missing concentrations and ambiguous source limits require clinician review/manual entry rather than inferred doses.

The canonical protected-owner cross-doctor feature remains unavailable on this legacy Rx release. Catalogue administration does not grant clinical issuance permission or establish owner identity.

Required verification includes native first-write CAS, authority revocation while waiting, failed-audit rollback, stale/disabled new selection denial, unchanged saved replay/history, and real browser/print journeys on the exact approved image. Unit/synthetic component tests alone are not deployment acceptance.

Do not expose catalogue-enabled UI to a mixed fleet of pre-catalogue issuance servers: older binaries can strip new provenance and lack the fresh catalogue check. Quiesce/drain writers and verify every serving image is the same reviewed catalogue-aware build before enabling the journey. Existing non-catalogue command semantics remain compatible, but that is not permission for a mixed writer rollout.
