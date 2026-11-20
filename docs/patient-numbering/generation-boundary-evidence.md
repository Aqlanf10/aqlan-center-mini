# Synthetic generation admission at the existing writer transaction boundaries

Private base `615cb9dadb971a5708f69bf672945b04dbf47d0f`. No application
route, runtime installer, auth bypass, role/credential write, numbered
migration, or external action. The generation adapter remains restricted to
synthetic fixture schemas. This is **not** a built-Next HTTP or staff-session
test: a SQL generation token is not staff authentication.

## Exact proof

The test starts from a fresh identity-verified owned PostgreSQL database,
initializes the existing app schema with seeding disabled, and calls the
four actual application DB entry points (no mock of a domain write). For
testing only, the pool facade intercepts each explicit transaction's real
BEGIN and acquires generation admission on that same connection. The
allocator-numbering injection is the established private synthetic scope.
The trace is from queries actually sent to PostgreSQL, not generated
source assertions. The existing application routes and DB functions are
unchanged, and this facade is not mounted in Next.

| Existing HTTP path | Actual transaction exercised | First domain lock observed |
| --- | --- | --- |
| POST /api/patients | `createPatient → withTransaction` | Shared patient_import |
| PATCH /api/visits/[id] open_file | `openVisitPatientFile` | Visit row FOR UPDATE, then shared patient_import |
| POST /api/patients/import commit | `commitPatientImport → withTransaction` | Exclusive patient_import |
| PATCH /api/booking-requests/[id] confirm | `writeAppointmentInDay → confirmBookingRequest(…, same client)` | Appointment-day advisory lock, then request row and shared patient_import |

The shared generation lock precedes every listed lock and the allocator
config update lock, on the one transaction client. MANAGED allocates
A-01500 through A-01503, keeps historical P-07000, and links the booking.
FENCED and stale MANAGED exercise all four real transaction boundaries but
reach no first domain lock, nextval, commit, new file, import audit, visit
link or booking appointment. The existing-client admission seam also
refuses a pool/autocommit caller with no held transaction.

## Concrete release-shaped follow-up, not mounted

1. Resolve real authentication/authorization **and** a trusted installed
   writer epoch server-side. Never accept a test header, environment bypass,
   or raw mode/token from the caller as production authority.
2. Acquire that epoch's shared generation admission as the first action
   after BEGIN in ordinary create and CSV commit, and in the walk-in
   transaction **before** locking its visit. Booking confirmation must
   use the existing outer `writeAppointmentInDay.beforeLocks` seam before
   the day lock; putting it only in the nested confirm/INSERT helper is
   too late. Direct/alternate callers (visit signing/session creation,
   automation, direct confirm, import/reset, maintenance) still require
   full entry-point audit and equivalent ordering; never add a nested TX.
3. Correlate a refused generation with an explicit retry-safe write refusal
   at the authentic route boundary, with no legacy fallback. Run the four
   built Next HTTP routes on an isolated proved target with real canonical
   session validation once a governed installer exists; adding a temporary
   fake Next auth/mode route to product code is not a substitute.
4. Before activation, prove the independent DB-level old-binary writer
   fence and exact application-archive/bound freshness proof. This direct
   boundary test cannot exclude non-cooperative binaries, preflight auth
   or capacity regressions, or demonstrate a live switch.

Owned PostgreSQL 18.6, Node 22.23.3: 26 focused tests passed across these
boundaries, earlier generation races and cold reconciliation. The local
cluster was stopped.

Targeted ESLint, isolated source TypeScript and the full project
`npm run typecheck` passed without suppressing checks.
