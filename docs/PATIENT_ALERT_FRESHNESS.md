# Confirmed patient alert freshness

This bounded continuation uses the current patient page and hardened readiness
hook. PR234 already released compact presentation; stale draft PR209 is not
merged wholesale. No patient, specialty, visit, finance or schema engine is added.

The canonical readiness response now exposes the editable alert and independent
history-derived warnings under the same existing medical authorization. Combined
alerts stay compatible. Old-server combined warnings are retained conservatively
until an explicitly split response arrives; their sources cannot be guessed.

A successful PatientEditor response or VitalsModal response confirms the actual
committed alert value. The vitals endpoint adds that value only when it was supplied
and committed by the existing transaction, which stores it without normalization.
Unconfirmed/malformed successful responses never publish a guessed value; a vitals
success with unverifiable body cannot be submitted repeatedly from the same modal.

Patient/principal/role/permission owners retire accepted page context and retained
save callbacks across context changes, including A→B→A. Either patient or workflow
hard denial retires page context as soon as its headers settle, before parsing its
body or waiting for the other peer. Same-owner ordinary reload failures preserve
confirmed warning additions, replacements and removals without unmounting drafts.
Older patient reads cannot restore earlier editable text. Later authoritative
readiness reads can accept another staff member's change or removal.

Readiness remains the existing fail-closed operational owner. A confirmed write
does not grant clinical reads or chair operations. Hard denial and an explicitly
redacted 200 visit revoke cached/confirmed clinical warning presentation. Patient,
session, visibility, generation, chair verification and duplicate-write guards
remain active. Independent history warnings survive editable removal, including
when their text is identical.

Targeted unit coverage exercises confirmed changes with failed/delayed reads,
remote edits, old-server fallback, malformed sources, redacted responses, owner
retirement, hard denial with malformed bodies/hung peers, actual page save
callbacks and canonical vitals confirmation. The existing built-app navigation
journey adds synthetic RTL1280/390 PatientEditor add/replace/remove checks with
failed patient/readiness GETs, preserved dirty ENDO input, no extra writes and
exactly two allowlisted screenshots. HTTP tests compare the returned vitals alert
with persisted isolated-test data and check medical source redaction.

Local focused Node22 tests, nonincremental TypeScript and scoped lint are required;
full exact-head CI, PostgreSQL18, HTTP/browser execution, dependency audit, build,
visual screenshot inspection, latest-main integration and exact Railway deployment
verification remain release gates. No Production clinical/financial mutation is
part of this change. Whole-file draft durability and six-section navigation remain
separate roadmap work.
