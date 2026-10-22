# Personal doctor daily schedule

The existing **My clinical work** page now replaces its today-only appointments card with one personal schedule: Today, Tomorrow, a chosen calendar date, and Refresh. This is a live read, not a persisted end-of-day report. Cancelled appointments remain visible and have a separate count. Arrived appointments on clinic today keep their existing visit-today link. A minimal internal-referral badge is included only when the appointment's linked referral belongs to that same patient; no referral narrative is copied.

## Boundary

`GET /api/appointments/mine?date=today|tomorrow|YYYY-MM-DD` accepts only `date`. The authenticated current user must be a doctor or an admin with their own active doctor party. No client-selected doctor is supported, including for admins. `requireSession` refreshes the user's party association from the database; the reader verifies an active doctor party and selects exact `appointments.doctor_id` and calendar date. It does not reuse the broader appointments feed, owned-patient union, or unassigned slots. Canonical patient-file access is checked before returning any patient identity; a denied check fails the response closed. The route is registered as GET-only CLINICAL in the existing HTTP permission registry; gated-role defaults are unchanged.

The new reader executes SELECTs only through `getPool`, without schema activation, financial reads, roster writes or changes to `lib/db.ts`. The response includes date, clinic timezone, server-generated timestamp, minimal scheduling fields, canonical authorized patient link, and counts. It has private/no-store caching.

## Freshness and safety

Today/tomorrow are resolved by existing clinic-date helpers on the server, not browser-local dates. The client validates date context, counts, timezone, timestamp, row shape and patient link paths before rendering. Date changes, refresh, failed requests, logout, same-account relogin, and replacement session objects cannot redisplay a previous response. Requests are aborted and additionally fenced against delayed completion. Focus/visibility refresh and a 30-second clinic-calendar rollover check keep a mounted relative-day view current.

## Verification

- Focused route tests cover authentication, roles, invalid/inactive party, client override rejection, canonical patient-access denial, cache policy, calendar/timezone, failure, and middleware registration.
- Rendered-hook tests exercise actual controls/effects, delayed responses, date changes, refresh failure/retry, metadata rejection, patient links, focus/visibility, midnight, account switching and same-account relogin.
- PostgreSQL 18 integration tests create a uniquely owned synthetic database with name/OID/owner guarded cleanup. They run actual SQL and signed-session validation, prove exact assignment filtering (including cancelled, excluding owned-but-other-doctor/unassigned), check invalid associations, and run the reader under a read-only connection with matched/mismatched referral fixtures.

No WhatsApp sends, recurring jobs, persisted daily snapshots, production data changes, migrations, financial or HR implementation are included.
