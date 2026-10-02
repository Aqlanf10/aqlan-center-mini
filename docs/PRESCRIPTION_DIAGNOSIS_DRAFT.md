# Prescription diagnosis draft ownership

## Bounded defect

Audited on 2026-10-02 UTC against remote main `60600afe` and its local
source-tree equivalent `062ee538` (tree `cc5566825256cfc31475d7489107c4cb7b3e3ec4`).

After a clinical visit loads, `ClinicalVisit` keeps `PrescriptionModal` mounted
even when closed and supplies `notes.diagnosis` as `defaultDiagnosis`. The modal
previously copied that prop only in its first `useState` initializer. A diagnosis
entered or corrected later in the visit therefore failed to appear on first open
or an untouched reopening, and the official-save handler sent the stale value.
The patient-page entry supplies no default diagnosis; it still starts empty.

The tests-only reproduction had three failing cases (late first open, corrected
untouched reopen, and submitted payload) and three passing preservation controls
(manual diagnosis/medicine/notes, deliberate clearing, and an explicit template).
All requests and window operations were synthetic mocks; no historical or live
patient impact was established.

## Ownership contract

`diagnosisOverride === null` means that the prescription inherits the current
visit diagnosis. This is derived during render, without a synchronization effect,
whole-form reset, or remount key.

- Manual editing, including clearing to an empty string, claims the diagnosis
- An explicit procedure-template choice also claims it, even if its text happens
  to match the visit diagnosis
- A print/save request pins the current diagnosis before the asynchronous request.
  Later parent-note changes cannot silently alter the displayed prescription
  while a captured payload is saving or awaiting safety acknowledgment
- Cancel/reopen retains claimed diagnosis, medications, notes and the existing
  prescription workflow state. An untouched, unsubmitted diagnosis keeps
  inheriting the current visit text, including clearing that text

The original save/print response workflow remains authoritative. Official print
uses the saved prescription ID. Warning acknowledgment still requires an explicit
click and the server's canonical signature check. Deliberately editing the Rx
diagnosis after preview still invalidates the token; a rejection does not open an
official print or automatically fall back to a draft. Merely editing the parent
visit diagnosis after submission leaves the pinned prescription unchanged.

## Verification and limits

- `__tests__/prescription-visit-diagnosis-audit.test.ts`: 11 passing hook/handler
  regressions, including the original three red cases, explicit ownership,
  inherited clearing, medicine/notes preservation, pending-save parent changes,
  cancel/reopen while saving, and acknowledgment across parent changes versus
  deliberate Rx edits. The acknowledgment scenarios use the actual pure token
  issuer/verifier with synthetic drafts and a fixed time
- Independent review found no blocking product issue and passed 104 tests across
  the six non-database prescription/medication suites. Focused ESLint and
  TypeScript, including Next ambient types, pass for the component and both
  regression files
- Five built-app synthetic browser cases are supplied in
  `__tests__/security-http/prescription-diagnosis-ui.test.ts`; exact-head CI is
  required before release. Browser API data/writes and print opening are
  intercepted. The pending-save/acknowledgment case captures one synthetic draft
  screenshot; CI uploads only its exact path as
  `prescription-diagnosis-ui-screenshot`, which still requires visual review.
  Local browser execution is unavailable under this executor's
  socket restriction; no local browser pass is claimed
- Full exact-head CI, merge and Railway Production verification are pending

This repair covers diagnosis ownership within the same mounted patient/visit
context. It does not establish cross-patient navigation or visit-relink safety,
add a visit ID to prescriptions, add timeline events, or close the wider
prescription/post-treatment roadmap. There are no API, database, schema,
clinical-template content, medication-rule, prescriber or financial changes.
No relink proof, live prescription, Production data update or historical repair
was performed.
