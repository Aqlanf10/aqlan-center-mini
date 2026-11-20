# Unwired application adapter checkpoint

`lib/patient-numbering-postgres.ts` now implements the executable PostgreSQL
transaction backend and typed allocation bridge. The test fixture provisions only
its owned schema and calls THIS library implementation for all transaction tests.
No app route or lib/db.ts caller imports it. No schema is provisioned by the lib.

Default factory returns null. `withPatientNumberingMode(null, legacy, configured)`
executes the existing legacy callback untouched; it does not read settings, connect
or change the 7000 floor. If a backend is explicitly installed and fails, there is
NO legacy fallback. A missing config row fails closed. Creation work must execute
inside the provided transaction/client; an allocation callback expires when that
scope ends. Authority loader receives that same client to lock/revalidate identity,
not a cached external boolean. No production authority loader is supplied.

Verified current allocator sites: lib/db.ts lines 2941 (walk-in), 3618 (ordinary),
3702 (CSV import), 5170 (booking) at base 97724c2. All use PATIENT_NUMBER_SQL.
Startup lines1539-1548 still impose7000 and aggregate digits across existing IDs.
These sites are intentionally unchanged. Startup MUST become prefix-aware before
any configured prefix activation; otherwise another prefix can inflate P on boot.
Import/creation/reset advisory locks require a single audited lock order with this
backend; nesting its transaction inside existing transactions is unsupported.

Restore lib/restore/staging.ts currently probes public tables and runs migrations;
proposed dedicated numbering schema is NOT proven included by the existing backup,
restore or schema-ownership contracts. No migration ID is reserved. Before choosing
its namespace, implement schema-contract/backup/reset preservation evidence and
restore lineage fencing. Do not apply prototype schema to application databases.

Tests on final code: 13 PostgreSQL18.6 fixture tests passed using this lib adapter;
206 focused unit tests passed across8 suites. Targeted ESLint and strict TypeScript
adapter/fixture compilation passed. The owned local server was explicitly stopped.
No full build, HTTP, browser, app-caller integration or restore proof is claimed.

Smallest next code slice: create a synthetic bootstrap/migration contract fixture
that reconciles legacy P last_value/is_called and canonical historical IDs into the
new namespace, preserves ambiguous-history refusal, proves idempotent cold startup,
and verifies the exact proposed schema namespace is backed up and restored. Then
wire one synthetic-only patient insertion journey to the typed bridge, before any
production caller change. Separate owner-binding/account protection remains a gate.
