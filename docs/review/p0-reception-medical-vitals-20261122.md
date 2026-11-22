# P0: reception medical-history and vital-signs access boundary

Date: 2026-11-22 (Asia/Aden). This is a review-only, synthetic-data change.

## AUDIT (verified against Railway Staging source)

Base: `b0196b02ded454f7973e8f8cd87cd49b7940f4d3`.
The medical-history and vitals GET/POST handlers used generic
`canAccessPatient(session, id)` / `canEditPatient`; the legacy helper allows
`reception` without checking for clinical-file read privileges.
The GET handlers returned structured diagnoses, allergies, medications and
vital readings. POST also allowed reception to create/edit clinical records,
including medical alerts. The existing HTTP permission table explicitly
allowed reception. This contradicts the owner's upload-only clinical privacy
requirement.

## IMPLEMENT / REUSE

* Deny reception and other nonclinical roles on both endpoints **before**
  patient DB reads and writes; allow only admin or scoped authorized doctors
  through the original patient-access checks.
* Align `HTTP_PERMISSIONS` with the existing `CLINICAL` role set.
* Retain separate document POST upload authority. Do not alter patient
  collections, ledger, reception appointment projections or file storage.
* The existing PostgreSQL-backed HTTP fixture for reception questionnaire
  entry has been changed to administrator entry to preserve business logic
  coverage without contradicting the new privacy policy.

## TEST / REVIEW

* Added synthetic API denial tests covering medical history and vitals for
  reception, cashier, accountant, and assistant, with no DB reader/writer
  invoked, plus authorized admin/doctor read/write and doctor scope checks.
* Updated isolated HTTP/PostgreSQL fixture to check reception gets 403 on
  both endpoints and admin still produces the prior clinical outcomes.
* CI gates (unit, PostgreSQL 18, HTTP, browser, audit, print) **must pass
  before adoption**. No claim of success until hosted results are available.
* No real patient identifiers, images, records, backups, secrets or production
  database reads were used.
* This change does not fix other clinical endpoints (e.g. patient clinical
  context, reports, exported documents); inventory those in separate P0 reviews.
* WARNING: legacy reception clinical-history UI may now display a 403; it
  must be hidden or replaced by an upload-only surface in the integration
  review. This is NOT a Staging/Production release candidate by itself.
