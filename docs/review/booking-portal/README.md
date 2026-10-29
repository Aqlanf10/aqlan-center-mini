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

Draft PR: [#492](https://github.com/Aqlanf10/aqlan-center-mini/pull/492). Not ready for release. Complete hosted CI, review and a Staging review are required. Railway metadata identifies `staging-web` in the project's `staging` environment, with two pre-existing staged changes. This branch has not been deployed there. The parent agent owns Staging coordination and verification of synthetic data isolation after the current release; no Railway changes are authorized here. PRs #490/#491 and the active identity branch are outside this branch.

## Implemented behavior

- Public booking remains a **request requiring reception confirmation**. Availability never reserves a slot. The server rechecks it when accepting a new request and again under the appointment day lock when reception confirms.
- `clinic.working_days` is an administrative setting (0 Sunday through 6 Saturday). Its default preserves the previously unspecified seven-day policy; Friday is closed only when the administrator excludes 5. Clinic shifts, service duration/buffers, chair capacity, actual appointments, doctor duty, approved leave and provider blocks constrain available times in the clinic timezone. An unresolved doctor schedule returns no public slots.
- Reception reads current settings and approved responsibility in its transaction. Follow-up services inherit the unique active case's responsible doctor; multiple cases require a staff choice. A stale/conflicting owner is rejected. No code changes case responsibility. The PostgreSQL proof covers eight specialty values.
- A shared family phone requires an explicit existing file selection. Nearby active appointments within two days are shown as a warning; distinct legitimate appointments on the same day remain possible. Actual patient/provider/chair overlap is checked by the existing scheduling engine.
- The unique request key and canonical payload digest survive concurrent retries and a lost response. Replay returns the original result even after staff confirmation. Confirmation replay returns the current persisted appointment instead of inserting again. Per-phone/source quotas are serialized in the same transaction.
- The Arabic public journey has selection, contact, review and received steps, back navigation, loading/unavailable/failure states, and a locked retry after an uncertain response. Only a digest and random request key enter session storage. The reception view preserves the existing design and prepares WhatsApp text from persisted appointment time/status. Test code never follows or sends that link.
- A rejected retry, including HTTP 429, cannot clear an earlier uncertain result. The same attempt remains locked until a confirmed receipt arrives. A real persisted request followed by a lost response and a rate-limited retry exposed this additional browser defect at both viewport widths; see [two failures before the fix](evidence/retry-429-before.txt). The regression requires the third attempt to reuse the same key and retain exactly one request.
- Public availability is a minimal allowlist. Internal appointment notes are withheld from authenticated patient responses too. Portal tokens reject malformed segments, invalid IDs and expired timestamps; the server checks the current patient identity. Logout records only a one-way token fingerprint and rejects copied-cookie reuse; a fresh login remains independent. Existing staff authentication and pending identity migrations are untouched.
- Cancellation/rescheduling remain staff-managed under the current policy. The patient view supplies the configured reception contact. Conversion uses the canonical appointment table and snapshots, preserving existing arrival, cancellation, no-show, visit and patient-file integration.

## Database and concurrency review

`0090_booking_request_preferences.sql` adds three columns and one partial unique index only. Its runtime SQL is byte-identical and checksum registered. The schema contract and reviewed migration inventories include exactly this addition; no guard was disabled. No historical keys are guessed and no financial records or links are rewritten.

Version/name: `0090` / `booking_request_preferences`. SHA-256: `608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25`. Added fields on `booking_requests`: nullable `request_key TEXT`, nullable `request_hash TEXT`, and `preferences JSONB NOT NULL DEFAULT '{}'::jsonb`. The partial unique index is `booking_requests_request_key_idx` (`request_key IS NOT NULL`). Coordinate the number with other migration branches before merge.

The source-only preflight disclosure catalog is regenerated on the isolated PostgreSQL 18 fixture. Its exact delta is three booking-request column identities, the `booking_requests_preferences_not_null` constraint identity and its column/definition text hashes. No existing identity is removed and no internal-trigger disclosure is added. The separate schema-fingerprint tests retain their private-template canary and fail-closed checks.

Reception holds short SHARE locks on settings and existing HR/doctor availability source tables through its write, including inserts of leave/schedules/blocks. Inferred case selection also guards against a concurrently inserted second case. These locks favor a correct decision; Staging must assess contention with real administrative edits. Existing appointments are not retroactively moved when a setting or schedule changes. Ordinary PostgreSQL DDL requires a reviewed deployment window.

## Weekday setting integration review

Re-fetched `origin/main` remains `b55401693700d83c063872f957758f249dd1deed`. Searching that tree's application, library, component, test and documentation sources found neither `clinic.closed_weekdays` nor `clinic.working_days`. This branch adds only `clinic.working_days` (CSV, 0 Sunday through 6 Saturday). The separate, unmerged implementation reported by the parent uses `clinic.closed_weekdays` (JSON); none of that branch was copied here.

Current readers share the same clinic setting: public catalog and slot selection (`lib/public-booking.ts`); staff doctor availability (`lib/appointment-availability.ts` via `loadCapacityContext`); and the shared admission evaluator (`lib/capacity-context.ts` → `judgeBookingInDay`) used by ordinary booking/rescheduling, reception confirmation, next sessions, planned sessions/rebooking and waiting-list booking. Waiting-list candidate ranking is advisory; its booking writer still uses shared admission. Existing HR `hr_work_schedules.working_days` is a separate doctor's duty schedule, intersected with clinic opening days; it is not a competing clinic setting.

Before combining the branches, choose and validate one canonical clinic representation and update all these readers and administrative controls together. JSON closed days `[5]` corresponds to CSV working days `0,1,2,3,4,6`. Empty JSON closed days `[]` means all days open; empty CSV working days means all days closed. If both persisted settings exist and disagree, require an explicit reviewed resolution rather than guessing precedence. Recheck closed Friday, explicitly open Friday, all-open, all-closed and changed settings against both availability and every admission path. Generate migration inventories/schema contracts from the actual combined tree, preserving versions 0074/0080/0088/0089 as applicable; do not replace either branch's inventory wholesale.

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
| Baseline built HTTP comparison | Two existing failures reproduced on unmodified `b5540169`: legacy financial preview waits for a ledger read, and receipt PDF signature glyph geometry fails. Three other checks in those two files passed. This does not establish the result of hosted CI. See [baseline comparison](evidence/baseline-http-comparison.txt). |
| Baseline orthodontic read-state comparison | Four failures and five passes on separately built unmodified `b5540169`; failures concern waiting for/observing a browser read. The full local branch run also reported failures in this file. See [baseline orthodontic comparison](evidence/baseline-ortho-comparison.txt). |
| Hosted quality on `faa3c052` | All 713 unit files / 12,598 tests, typecheck, lint, money/body guards, dependency audit, build, preflight artifact and runtime dependency proof passed. Focused invoice-currency and payroll workflows also passed. Later source changes up to `ac0edf81` only isolate browser test state and update documentation. This is not a claim of full CI success on a later head. |
| Full local diagnostics | The first PostgreSQL run completed in 3,793.67 seconds: 298 files passed / 5 failed; 3,603 tests passed / 7 failed. It began before the final audit and inventory corrections, so it is not final-head acceptance. Corrected schema/policy inventories and the five portal cases pass in fresh processes. PostgreSQL logs identify the remaining procurement failure as a deadlock between supplier locking and concurrent schema initialization on the synthetic fixture; isolated baseline/branch runs and five focused repeats passed. The earlier full unit run had 12,596 passes, a corrected stale audit exemption, and a runtime tracing timeout under concurrent load; hosted units subsequently passed. |
| Final complete suites | Follow the checks on [PR #492](https://github.com/Aqlanf10/aqlan-center-mini/pull/492) and the handoff for the final head. Focused passes and earlier/cancelled runs are not substitutes for final complete PostgreSQL and HTTP/browser results. The PR body update failed without applying; the checked-in report and handoff carry the newer evidence. |

Synthetic screenshots: [mobile review](evidence/public-review-390.png), [desktop review](evidence/public-review-1440.png), [lost-response retry](evidence/public-response-loss-390.png), [unavailable state](evidence/public-unavailable-390.png), [reception review](evidence/reception-review-390.png), [reception confirmed](evidence/reception-confirmed-1440.png).

Execution logs: [unit before](evidence/unit-before.txt), [unit after](evidence/unit-after.txt), [PostgreSQL before](evidence/postgres-before.txt), [PostgreSQL scheduling group](evidence/postgres-focused.txt), [final focused PostgreSQL](evidence/postgres-final-focused.txt), [69 HTTP/browser checks](evidence/http-browser-adjacent.txt), [20 operational journeys](evidence/operational-journeys.txt). Logs contain synthetic assertions only; no environment dump, real credentials, session cookies or browser storage is attached.

## Staging acceptance still required

Use a proven isolated synthetic Staging database and the reviewed candidate head. Verify real configured weekdays (including a closed Friday and an explicitly open Friday), split shifts, leave, ambiguous doctor linkage, service buffers and chair limits; race two receptions for one slot and change a schedule/settings while confirming. Review single/multiple cases and an approved ownership change with reception/admin/doctor/unauthenticated accounts. Repeat mobile/desktop lost-response retries and patient cancellation/rescheduling contact flow. Confirm links, patient file, arrival/cancellation/no-show and WhatsApp text without sending messages. No Production deployment or merge is authorized by this branch.
