import { afterAll, beforeAll, vi } from "vitest";
import {
  validateLocalVerificationTarget, validateOperationalVerificationEnvironment,
} from "../../lib/verification-target-policy.mjs";
import { patientTimelineCurrencyContract } from "../helpers/patient-timeline-currency-contract";

// Before any environment rewrite or application import, require the standard
// disposable loopback PG test database. This file never drops a schema/table,
// deletes a fixture, disables a constraint, or contacts Production.
validateOperationalVerificationEnvironment(process.env);
if (process.env.USE_LOCAL_DB === "true") throw new Error("Timeline PG contract requires PostgreSQL, not PGlite.");
const target = validateLocalVerificationTarget(process.env.TEST_DATABASE_URL, process.env, {
  varName: "TEST_DATABASE_URL", databaseName: "aqlan_p1_test",
});
vi.stubEnv("DATABASE_URL", target.toString());
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("SKIP_SEED", "true");
const db = await import("../../lib/db");

beforeAll(async () => { await db.ensureSchema(); }, 180_000);
afterAll(async () => {
  await db.resetPoolForTesting();
  vi.unstubAllEnvs();
});
patientTimelineCurrencyContract(db, "PostgreSQL");
