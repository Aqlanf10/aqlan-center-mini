# Astra integration review — 2026-11-04

Reviewed the isolated composition of appointments `f90069176bb428ed3369ece3aa0bb90c8a1df7c0`
onto approved Rx candidate `b804d515ca454c15507af94429d31546893f94fc`. No shared branch
was merged, no deployment was performed, and no live clinical records or roster
were read. This review does not establish actual clinic roster readiness.

## Conflict and protection review

- All 13 approved Rx presentation paths remain byte-identical to the Rx base.
  The change to appointment UX is limited to truthful roster/refusal wording;
  it does not alter the approved prescription layout or issuance protocol.
- Published migrations 0093, 0095 and 0096 match their original bytes. The
  combined chain contains 72 migrations; reserved radiology 0094 is excluded.
- Runtime initialization retains the Rx lineage and issuance calls before the
  appointment migrations. Both runtime and numbered migration paths retain
  prescription lineage/issuance validation and appointment-purpose validation.
- Reset retains the original prescription EXCLUSIVE lock, nonempty-history
  refusal and route-specific 409 response. Appointment history gets additional
  fences; all three receipt families remain KEEP tables. Their inclusion in the
  empty-only TRUNCATE does not remove the preceding refusal or database guards.
- Patient merge retains the original prescription source-history check and
  response before the appointment source-history check. Neither path reassigns
  immutable command ownership. The surviving target's history is not rewritten.
- Independently reviewed `appointments-rx-composed-restore.test.ts`: it uses
  owned disposable databases, upgrades a populated 0093 chain, compares all four
  prescription/receipt tables after both official restore entry points, checks
  the exact migration registry and exercises deletion/truncation refusal.
  Its SQL fixtures establish storage integrity; actual authorization and
  issuance are covered by the real HTTP/browser journey, not inferred from SQL.

No lost original Rx protection was found in these unions. Following review,
the upgrade test now snapshots both the prescription body and its issuance
receipt before applying the appointment migrations and compares both afterward.
Root owns the final rerun of that strengthened test; its result is recorded
with the broader validation evidence rather than assumed here.

## Executed validation

- Composed production build, including TypeScript: passed.
  Log: `/tmp/appointment-rx-build.log`.
- Five real HTTP/browser files: **21 passed, zero failed**, 113.64 seconds.
  Log: `/tmp/appointment-rx-integrated-browser-final.log`.
  These include invoice continuity, planned rebooking, saved Rx reprinting,
  doctor-schedule suggestions and the new connected integration journey.
- The new journey books through the browser, records arrival through the real
  appointment action, verifies the resulting patient/doctor/visit identities,
  documents the visit, issues and replays one keyed synthetic prescription,
  signs the visit, reprints the saved prescription with explicit reception
  permission at 390/1280 widths, validates A5 output, and creates the follow-up
  from that same visit. Saved prescription and issuance receipt remain unchanged.
  All medication/dose text is explicit synthetic fixture text.
- Missing and ambiguous HR mappings each produce an actual 409, no appointment
  or booking receipt, no override input, and no leaked private HR details. The
  user sees that verification is required before booking can be confirmed.
- Initial new-browser assertions passed 7/7 but teardown refused deletion of a
  synthetic doctor with protected commission history. Cleanup now deactivates
  that owned test party and preserves history until disposal of the database.
  The final 21-test run completed teardown successfully.
- Focused merged-chain/API/reset recheck: **27/27 passed**. The earlier seven-file
  run had 59/60 passing; the remaining expectation was corrected to explicitly
  accept the already-reviewed appointment-only chain without Rx 0093. Unknown
  filenames and unsupported chain variants remain rejected.
- New browser-test ESLint: zero errors or warnings. Focused source lint had
  zero errors and four existing QuickAppointmentModal warnings. Diff check passed.

Nine synthetic PNG/PDF artifacts and a SHA-256 manifest are available at
`/tmp/appointment-rx-integration-evidence`. They include roster warnings at
390/1280 widths and saved Rx screenshots/A5 PDF. The browser harness stopped and
removed its disposable database after the final run.

## Limits and handoff

The local browser is Chromium 151, while the lockfile requests Chrome 153.
Root-owned broader native/unit/print checks are reported separately. These
focused results do not claim full HTTP-suite or exact-head hosted CI success
for the composed candidate. No hosted CI has run for this unpushed integration.

Unlinked or ambiguous real doctor mappings will intentionally prevent doctor
bookings. Authorized verification of real roster links, schedules and approved
leave remains a separate rollout prerequisite. No automatic mapping, inference
from clinical text, manual admission bypass, or deployment is authorized by
this review. Root owns the final local commit and handoff; this agent did not
commit or publish the composition.
