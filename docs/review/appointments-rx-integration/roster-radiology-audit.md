# Read-only roster and radiology boundary audit — 2026-11-04

Source reviewed: appointment/Rx candidate
`70f5114ed6f205d4651e2cf8143c110dc43b8680`. No application code, live data,
deployment, grants or doctor mappings were changed by this audit. No PostgreSQL
container was started. Root owns publication and deployment-source checks.

## Doctor schedule compatibility

Fresh focused tests passed **62/62 across three files**, with no failures:
`doctor-clinical-roster.test.ts`, `doctor-booking-window.test.ts` and
`appointment-availability-route.test.ts`.
Log: `/tmp/appointment-roster-compatibility-audit.log`.

The existing HR source adapter supports a unique explicit
`hr_staff.user_id → users.party_id` relationship, or an open explicit staff-party
link when that optional table is already installed. It does not infer identity
from names, contracts or appointment history, and does not activate the optional
identity schema. Doctor party, linked account and staff must be active; staff
employment dates must cover the relevant shift date.

Staff-specific schedules take precedence over matching department schedules.
Exactly one applicable schedule must be provable. Morning, evening, contiguous,
split and explicitly overnight schedules are supported, including the previous
day's proven overnight tail. Effective dates and weekdays remain authoritative.
Approved full-day leave removes availability; partial leave without clock bounds
is unresolved and refuses admission. Appointment duration, service buffers,
provider blocks and configured center hours further restrict the usable window.

Missing or conflicting mapping, overlapping applicable schedules and invalid
schedule evidence fail closed. Existing synthetic browser evidence separately
proves unlinked and ambiguous mappings return 409 without an appointment,
receipt or override. The warning now says verification is required before
booking can be confirmed. These checks prove implementation behavior, not the
correctness or completeness of actual staff records.

**Actual roster readiness remains unverified.** The connected Railway tools offer
deployment/configuration metadata but no SQL-query operation. This session has
neither a provisioned database connection nor an authenticated clinical session
for a narrowly scoped roster inspection. Plaintext Railway variables were not
retrieved, database networking was not changed, and no patient data was read.
An authorized read-only review of real mappings, schedules and leave remains a
rollout prerequisite; synthetic fixtures must not be presented as that review.

## Radiology boundary

GitHub metadata confirmed [PR #521](https://github.com/Aqlanf10/aqlan-center-mini/pull/521)
is open and draft at `4f3e3d6314b422afa51bb78d2a4ace852d40e09f`, based on
`1414a3514df3e01f0513dfc00b4358d482d862ef`. That base is also the common ancestor
with the audited candidate. The current radiology delta contains 81 paths;
the PR body still describes an earlier 79-path snapshot, so this audit uses the
current head and changed-file inventory.

Radiology owns `0094_radiology_requests.sql`. Its SHA-256 is
`963212479d2450fda2c4cf0dc81fac2165be251710a9499249d96560fa1a9193`.
It creates `radiology_requests`, three named functions, one explicit history
index and two explicit triggers. None of those seven CREATE names collides with
the current candidate's migration declarations. The candidate has no 0094 file;
its appointment migrations remain 0095 and 0096. Radiology was not imported.

There are **28 shared changed paths**, listed exactly in
[roster-radiology-audit.json](roster-radiology-audit.json). The JSON contains only
commit IDs, repository paths, schema-object names and a migration checksum.
Important shared boundaries are the migration registry/validators, runtime
initialization, patient-merge refusals, reset error classes/history fences and
empty-only TRUNCATE list, settings, permission/audit declarations, schema
contracts, ownership verification and exact-chain fixtures.

A future authorized composition must retain the Rx, appointment and radiology
history protections together, preserve every published migration's bytes and
regenerate native schema artifacts. Object-name compatibility alone does not
prove a clean merge, upgrade compatibility, concurrency correctness or release
readiness. The current publication candidate should continue excluding PR #521;
no radiology branch was modified or merged during this audit.
