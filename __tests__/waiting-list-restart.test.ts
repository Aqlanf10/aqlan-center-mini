import { afterAll, expect, it, vi } from "vitest";

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
vi.stubEnv("SKIP_SEED", "true");

const { ensureSchema, getPool, addWaitingEntry, schemaReadyReset, resetPoolForTesting } = await import("../lib/db");
afterAll(async () => { await resetPoolForTesting(); });

it("legitimate service-specific waiting entries survive repeated runtime initialization", async () => {
  await ensureSchema();
  const pool = getPool();
  const { rows: [patient] } = await pool.query("INSERT INTO patients(patient_number,full_name) VALUES ('SYNWR1','Synthetic restart') RETURNING id");
  const { rows: services } = await pool.query("INSERT INTO appointment_services(code,name_ar) VALUES ('syn-wr-a','Synthetic A'),('syn-wr-b','Synthetic B') RETURNING id");
  for (const serviceId of [services[0].id, services[1].id, null]) {
    expect((await addWaitingEntry({
      patientId: patient.id, serviceId, preferredPeriod: "any", urgency: "normal",
    }, { actor: "synthetic-reception", actorRole: "reception" })).ok).toBe(true);
  }
  const before = (await pool.query("SELECT * FROM waiting_list ORDER BY id")).rows;
  const auditBefore = (await pool.query("SELECT * FROM audit_log ORDER BY id")).rows;
  expect(before).toHaveLength(3);
  for (let restart = 0; restart < 2; restart++) {
    schemaReadyReset();
    await ensureSchema();
    expect((await pool.query("SELECT * FROM waiting_list ORDER BY id")).rows).toEqual(before);
    expect((await pool.query("SELECT * FROM audit_log ORDER BY id")).rows).toEqual(auditBefore);
  }
}, 60_000);
