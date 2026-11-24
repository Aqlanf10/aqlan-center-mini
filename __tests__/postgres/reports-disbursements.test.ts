import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

// The same synthetic API/official print contract runs on PostgreSQL 18 in UTC.
assertRealPostgresUrl();
stubPostgresEnv();
process.env.TEST_REPORT_DISBURSEMENTS_DATABASE_URL = await createIsolatedDatabase("aqlan_reports_disbursements_test");
await import("../reports-disbursements.test");
delete process.env.TEST_REPORT_DISBURSEMENTS_DATABASE_URL;
