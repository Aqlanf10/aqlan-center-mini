import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.TEST_EXPENSE_REPORT_LEGACY_URL = await createIsolatedDatabase("aqlan_report_expense_payee_test");
await import("../reports-expense-payee-legacy.test");
delete process.env.TEST_EXPENSE_REPORT_LEGACY_URL;
