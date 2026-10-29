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
| P2 | Portal session validation is stateless; logout removes its cookie but does not revoke a copied token. | Record the limitation explicitly; coordinate any identity/session storage change separately from the active identity work. |

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

Not ready. The discovery issues, exact-head CI and a Staging review must be resolved before release. No Staging target has yet been identified or tested. PRs #490/#491 and the active identity branch are outside this branch.
