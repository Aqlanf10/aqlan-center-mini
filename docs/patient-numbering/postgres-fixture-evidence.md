# PostgreSQL fixture checkpoint (not an app migration or activated backend)

Base worktree: 97724c2 + local numbering/owner preflight commits.
Files: __tests__/postgres/fixtures/patient-numbering-adapter.ts and
__tests__/postgres/patient-numbering-adapter.test.ts.

Implemented a PoolClient transactional adapter of the inert command contract in
TEST SUPPORT ONLY. Randomly named owned schemas contain isolated config, fixed
A-Z sequences, synthetic history, audit, receipts and issued-number tables. The
existing _safe-target validates TEST_DATABASE_URL before pool creation. No ambient
DATABASE_URL fallback. No migration ID reserved, no app import or route binding.
Synthetic owner authority is injected; this is deliberately NOT production auth.

Confirmed PostgreSQL 18.6. Eleven integration tests passed:
- atomic configuration/audit/receipt and exact first issuance;
- 20 concurrent duplicate commands produce one audited commit;
- competing prefix commands reject stale global state;
- audit constraint failure rolls back sequence restart/config/receipt;
- rolled-back issue consumes nextval and invalidates prior preview;
- configuration vs allocation cannot duplicate or rewind;
- pool/connection recreation retains pending number and used-prefix high-water;
- historical/incomplete provenance refuses unsafe fresh-series selection;
- 50 concurrent allocations are unique and advance exactly;
- inherited P high-water stays high while a fresh B may start at 1;
- same durable request key with different intent refuses without extra audit.

Targeted ESLint and strict TypeScript of the adapter passed. This is NOT a full
app build/HTTP/Playwright/migration/restore proof. Connection recreation is NOT a
server-crash or old-backup restore test. Restore fencing remains an open blocker.
The fixture's serialized config-row lock is not proof that existing app allocators
use that lock: they do not. The fixture history ledger is explicitly seeded; actual
legacy-history reconciliation is not implemented. P=7000 is fixture data only.

Reproduction on an OWNED loopback PG18 test database:

    TEST_DATABASE_URL='postgresql://agent@127.0.0.1:55439/aqlan_p1_test?sslmode=disable' NODE_ENV=test npx vitest run --config vitest.config.postgres.mts __tests__/postgres/patient-numbering-adapter.test.ts

This run used a newly initialized disposable local cluster, not Railway or an
existing application DB. Initial Unix socket creation was unavailable; it was
replaced by loopback TCP only. A later independent command found the process had
ended (ECONNREFUSED); the final run restarted the SAME owned cluster, passed all
11 tests, and stopped it explicitly. No failed connection is counted as success.
Fixture schemas were dropped by afterEach; cluster files remain private and are
not included in the repository/patch.

Integration blockers: protect all owner account-control paths, trusted binding and
transaction-time revalidation, wire every allocator, privacy compatibility, actual
history reconciliation, migration ownership/reset classification, complete backup
and restore lineage fences, full Node22 quality/PG/HTTP/Playwright verification.
