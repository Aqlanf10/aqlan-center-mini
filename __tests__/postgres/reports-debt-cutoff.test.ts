import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

// Run the identical report fixtures against a fresh PostgreSQL 18 database.
// In particular, validate AT TIME ZONE with a UTC database session.
assertRealPostgresUrl();
stubPostgresEnv();
process.env.TEST_DEBT_CUTOFF_DATABASE_URL = await createIsolatedDatabase("aqlan_reports_debt_cutoff_test");
await import("../reports-debt-cutoff.test");
delete process.env.TEST_DEBT_CUTOFF_DATABASE_URL;
