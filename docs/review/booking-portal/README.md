# Booking portal audit — 2026-10-29

Baseline: `b55401693700d83c063872f957758f249dd1deed`, fetched from `origin/main`.
Independent branch: `codex/booking-portal-audit`. No merge or Production deployment is authorized.

## Discovery (before implementation)

These findings are source-supported, not claims about Production incidents.

| Priority | Finding and evidence | Intended verification |
| --- | --- | --- |
| P1 | `judgeBookingInDay` accepts `outsideHours` unless another capacity rule fails. `judgeFullCapacity` marks it near capacity. | Reject out-of-shift and buffered boundary requests on real PostgreSQL; retain valid split shifts. |
| P1 | Public `/book` generates 21 dates from the browser clock; `/api/book` checks only date shape/horizon. No services, doctors, duty, leave or actual occupancy are consulted. | Clinic timezone, configured closed dates, schedule/leave/capacity changes and stale selections through HTTP. |
| P1 | `/api/booking-requests/[id]` evaluates a service but `confirmBookingRequest` inserts only patient/date/time/duration/note. Provider/chair/service/buffer snapshots are absent. | Assert persisted snapshots and concurrent doctor/chair conflicts. |
| P1 | `existingPatientForBookingRequest` and confirmation choose `ORDER BY id LIMIT 1` on a phone. A shared family phone can silently select the wrong patient. | Two synthetic matching records must require staff resolution; no new appointment or patient. |
| P1 | Public count and insert are separate; retries have no durable key. Confirmation is transactional but a lost successful response returns “already handled,” with no recoverable confirmed snapshot. | Concurrent identical requests, lost responses, changed payload on a reused key, and replay after confirmation. |
| P1 | Case responsibility exists in `clinical_cases.responsible_party_id`; request conversion supplies no case/doctor context. Orthodontic follow-up suggestions are separate. | Explicit case selection, current responsible doctor, conflicts and authorized staff scope. Never change case ownership. |
| P2 | Public form has no review step or visible availability failure/full states; reception starts at fixed 10:00/17:00. | Built application at mobile/desktop widths, back navigation, slow network and retry. |
| P1 | `toPortalAppointment` returns internal appointment `note`; signed portal tokens accept a trailing segment and do not validate positive integer patient IDs. | Minimal response allowlist and malformed/expired/cross-domain token controls. |
| P2 | Portal session validation is stateless; logout removes its cookie but does not revoke a copied token. | Revoke a token fingerprint in the existing audit store, without activating or altering the separate staff identity subsystem. |

## Inventory and boundaries

- Public request: `app/book`, `POST /api/book`, `booking_requests`.
- Staff conversion: `/requests`, `/api/booking-requests`, `/api/booking-requests/[id]`.
- Canonical scheduling: `lib/book-appointment.ts`, day advisory locks in `lib/db.ts`, capacity/service snapshots, provider blocks, doctor advisory roster and appointment availability routes.
- Patient access: `/portal`, `/api/portal/{login,logout,me,appointments,appointments/confirm,intake,messages,statement}`. Patient identity comes from the portal session. Cancellation/rescheduling remain staff operations under the current policy.
- Reception/arrival/cancellation/no-show: existing appointment lifecycle and visit linkage; no parallel appointment table.
- WhatsApp: staff-generated links and existing reminder subsystem. No messages will be sent and no sending credentials/subscriptions will be configured.
- Existing validation: unit Vitest, PostgreSQL 18 integration, built standalone HTTP and Playwright via `__tests__/security-http`. Shared fixture guards require isolated loopback targets.
- No `.agents/skills` exists in this checkout or `/workspace/.agents`. `AGENTS.md` requires installed Next.js documentation; route handler guidance was read.

## Evidence environment

Created a fresh local Docker container `booking-portal-pg18`, labelled `purpose=booking-portal-synthetic-only`, from `postgres:18-alpine`, with loopback port 54329 and an empty `aqlan_p1_test` database. No source database, backup, or deployed connection was used. Node 22 is installed separately under `/workspace/booking-tools` to match the repository contract. Tests create synthetic fixtures only. Evidence and execution results will be appended as stages actually run.

## Release gate

Draft PR: [#492](https://github.com/Aqlanf10/aqlan-center-mini/pull/492). Not ready for release. Complete hosted CI, review and a Staging review are required. Railway metadata identifies `staging-web` in the project's `staging` environment, with two pre-existing staged changes. This branch has not been deployed there; synthetic data provenance and coordination of those changes remain pending. PRs #490/#491 and the active identity branch are outside this branch.

## Implemented behavior

- Public booking remains a **request requiring reception confirmation**. Availability never reserves a slot. The server rechecks it when accepting a new request and again under the appointment day lock when reception confirms.
- `clinic.working_days` is an administrative setting (0 Sunday through 6 Saturday). Its default preserves the previously unspecified seven-day policy; Friday is closed only when the administrator excludes 5. Clinic shifts, service duration/buffers, chair capacity, actual appointments, doctor duty, approved leave and provider blocks constrain available times in the clinic timezone. An unresolved doctor schedule returns no public slots.
- Reception reads current settings and approved responsibility in its transaction. Follow-up services inherit the unique active case's responsible doctor; multiple cases require a staff choice. A stale/conflicting owner is rejected. No code changes case responsibility. The PostgreSQL proof covers eight specialty values.
- A shared family phone requires an explicit existing file selection. Nearby active appointments within two days are shown as a warning; distinct legitimate appointments on the same day remain possible. Actual patient/provider/chair overlap is checked by the existing scheduling engine.
- The unique request key and canonical payload digest survive concurrent retries and a lost response. Replay returns the original result even after staff confirmation. Confirmation replay returns the current persisted appointment instead of inserting again. Per-phone/source quotas are serialized in the same transaction.
- The Arabic public journey has selection, contact, review and received steps, back navigation, loading/unavailable/failure states, and a locked retry after an uncertain response. Only a digest and random request key enter session storage. The reception view preserves the existing design and prepares WhatsApp text from persisted appointment time/status. Test code never follows or sends that link.
- Public availability is a minimal allowlist. Internal appointment notes are withheld from authenticated patient responses too. Portal tokens reject malformed segments, invalid IDs and expired timestamps; the server checks the current patient identity. Logout records only a one-way token fingerprint and rejects copied-cookie reuse; a fresh login remains independent. Existing staff authentication and pending identity migrations are untouched.
- Cancellation/rescheduling remain staff-managed under the current policy. The patient view supplies the configured reception contact. Conversion uses the canonical appointment table and snapshots, preserving existing arrival, cancellation, no-show, visit and patient-file integration.

## Database and concurrency review

`0090_booking_request_preferences.sql` adds three columns and one partial unique index only. Its runtime SQL is byte-identical and checksum registered. The schema contract and reviewed migration inventories include exactly this addition; no guard was disabled. No historical keys are guessed and no financial records or links are rewritten.

The source-only preflight disclosure catalog is regenerated on the isolated PostgreSQL 18 fixture. Its exact delta is three booking-request column identities, the `booking_requests_preferences_not_null` constraint identity and its column/definition text hashes. No existing identity is removed and no internal-trigger disclosure is added. The separate schema-fingerprint tests retain their private-template canary and fail-closed checks.

Reception holds short SHARE locks on settings and existing HR/doctor availability source tables through its write, including inserts of leave/schedules/blocks. Inferred case selection also guards against a concurrently inserted second case. These locks favor a correct decision; Staging must assess contention with real administrative edits. Existing appointments are not retroactively moved when a setting or schedule changes. Ordinary PostgreSQL DDL requires a reviewed deployment window.

## Verification and evidence

All data shown here is synthetic. Local proof uses Node **22.23.4**, PostgreSQL **18.6**, and Chromium **151.0.7922.173**. Clinic timezone is `Asia/Aden`; public browser journeys deliberately use `America/Los_Angeles` to check that selection is still based on the clinic day.

Primary fresh container: `5ea60cd9d73a81555cc0fc10f8e17ee2085918df7649ff617ca617cc7f06574e`, image `sha256:c293117fcecda7344b5480222e813b9f673d7abd69b1dd95eff239b768b04f59`, loopback port 54329, label `purpose=booking-portal-synthetic-only`. HTTP harness creates and drops its own `aqlan_sec_http` database. No deployed database, backup, patient file or credentials were used as a source.

| Check | Actual evidence |
| --- | --- |
| Baseline unit regressions | Eight failures before fixes: outside shifts including override, configured Friday, impossible calendar dates, note privacy, malformed signed tokens. |
| Baseline PostgreSQL regressions | Detached `b5540169`: ten concurrent retries produced ten requests, shared phone selected the first patient, service/chair/buffer snapshots were lost. All three fail before and pass after. |
| Portal session regression | Revoked/mismatched identity accepted before; rejected after. Valid session control still passes. |
| Focused PostgreSQL group | 21 passed across booking requests, capacity concurrency, lifecycle concurrency and rescheduling. Includes schedule-edit locking and approved leave. |
| Built HTTP + browser adjacent group | 69 passed across 7 files, including 15 new portal checks and existing availability, rescheduling, action errors, statement and CSRF checks. Public and reception journeys at 390 and 1440 pixels; slow/lost response, double click, same retry key, settings changes and persisted WhatsApp time. |
| Build / lint | Build passed. Lint: zero errors (209 existing warnings in the first full run). |
| Schema ownership | Passed; zero unexpected/known drift, with 16 previously tracked convergence gaps still open. This is not a claim that runtime and numbered schemas are entirely equal. |
| Operational verification | All 20 journeys passed, including patient portal isolation, schema reconstruction and actual backup/restore of synthetic linked records. |
| Final focused PostgreSQL | 24 passed: five portal regressions (including atomic confirmation audit) and 19 inventory procurement checks on a separate fresh local container. |
| Full unit / PostgreSQL / HTTP / hosted CI | Complete suite status and final head results are maintained in [PR #492](https://github.com/Aqlanf10/aqlan-center-mini/pull/492). Focused passes above are not a substitute for them. The local full unit run had 12,596 passes, one corrected stale audit exemption, and a 5-second runtime tracing timeout under concurrent load. The first full PostgreSQL run exposed a procurement test failure that did not reproduce in isolation on either baseline or branch. |

Synthetic screenshots: [mobile review](evidence/public-review-390.png), [desktop review](evidence/public-review-1440.png), [lost-response retry](evidence/public-response-loss-390.png), [unavailable state](evidence/public-unavailable-390.png), [reception review](evidence/reception-review-390.png), [reception confirmed](evidence/reception-confirmed-1440.png).

Execution logs: [unit before](evidence/unit-before.txt), [unit after](evidence/unit-after.txt), [PostgreSQL before](evidence/postgres-before.txt), [PostgreSQL scheduling group](evidence/postgres-focused.txt), [final focused PostgreSQL](evidence/postgres-final-focused.txt), [69 HTTP/browser checks](evidence/http-browser-adjacent.txt), [20 operational journeys](evidence/operational-journeys.txt). Logs contain synthetic assertions only; no environment dump, real credentials, session cookies or browser storage is attached.

## Staging acceptance still required

Use a proven isolated synthetic Staging database and the reviewed candidate head. Verify real configured weekdays (including a closed Friday and an explicitly open Friday), split shifts, leave, ambiguous doctor linkage, service buffers and chair limits; race two receptions for one slot and change a schedule/settings while confirming. Review single/multiple cases and an approved ownership change with reception/admin/doctor/unauthenticated accounts. Repeat mobile/desktop lost-response retries and patient cancellation/rescheduling contact flow. Confirm links, patient file, arrival/cancellation/no-show and WhatsApp text without sending messages. No Production deployment or merge is authorized by this branch.
