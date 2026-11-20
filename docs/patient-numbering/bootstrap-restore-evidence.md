# Synthetic bootstrap + actual dump/restore checkpoint

Parent base: 8a3438dfc2e283ccc200409506b0a61c74d46768.
Only new fixture helper/tests and this evidence file. No numbered migration, app
startup change, backup behavior change, actual binding, route or live connection.

Executable bootstrap fixture imports legacy P last_value/is_called under the config
lock, reconciles canonical historical IDs separately for each prefix, refuses
ambiguous stored IDs before mutation, and commits a one-time bootstrap marker.
Repeat bootstrap does not rewind subsequent allocations. The synthetic placeholder
P7000 is not a minimum: inherited pending37 remains37. Used900000 stays used.
ALTER SEQUENCE RESTART + conditional consumption preserves is_called in this fixture.
Source IDs are synthetic strings only; no source patient data was accessed.

Actual PostgreSQL18.6 pg_dump(custom archive)/pg_restore ran to freshly created,
randomly named aqlan_numbering_restore_<UUID> databases on the owned loopback test
cluster. Namespace-complete dump restored pending37 and called900000 correctly.
A separately held synthetic checkpoint from the quiesced source detected a dump
older than an issued number. Missing checkpoint was refused. A successful public-only
restore omitted the numbering namespace and failed admission. This demonstrates the
namespace coverage blocker without modifying production backup code.

IMPORTANT: admitRestoredFixture is a separate TEST admission helper, not wired to
runtime allocation. The adapter alone is NOT protected against an old backup.
Checkpoint capture here relies on a quiescent fixture and in-memory trusted test
state; production durable external attestation/lineage and activation fencing are
NOT implemented. No deployment or production readiness is claimed.

Final result: 21 PostgreSQL tests passed (8 bootstrap/restore +13 adapter). Targeted
ESLint and strict helper compilation passed. Initial public-only target restore
failed because the fresh DB already contained public; corrected the fixture to
remove only its empty public schema before restoring. Final run passed all tests.
Owned restore DBs and temporary synthetic dumps were removed by teardown; fixture
source schemas removed; test cluster explicitly stopped. No app DB was modified.

Reproduce only against an owned synthetic PG18 cluster:

    TEST_DATABASE_URL='postgresql://agent@127.0.0.1:55439/aqlan_p1_test?sslmode=disable' NUMBERING_PG_BIN='/path/to/owned-postgresql-18/bin' NODE_ENV=test npx vitest run --config vitest.config.postgres.mts __tests__/postgres/patient-numbering-bootstrap.test.ts __tests__/postgres/patient-numbering-adapter.test.ts

Smallest integration gap remains: translate the proven fixture into governed schema
ownership/migration/backup contracts and bind restore admission to real activation,
with a durable trusted high-water checkpoint. Owner-account/session safeguards and
all four live allocator callers remain deliberately unwired.
