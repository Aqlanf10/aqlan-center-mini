import { afterAll, beforeAll, vi } from "vitest";
import { validateOperationalVerificationEnvironment } from "../lib/verification-target-policy.mjs";
import { patientTimelineCurrencyContract } from "./helpers/patient-timeline-currency-contract";

// Inspect the inherited target before selecting the real in-memory adapter.
// No mocks, network, schema deletion, or external data are needed by this file.
validateOperationalVerificationEnvironment(process.env);
vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("SKIP_SEED", "true");
const db = await import("../lib/db");

beforeAll(async () => { await db.ensureSchema(); }, 60_000);
afterAll(async () => {
  await db.resetPoolForTesting();
  vi.unstubAllEnvs();
});
patientTimelineCurrencyContract(db, "PGlite");
