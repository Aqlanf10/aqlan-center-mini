import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { assertPostgres18VersionNum } from "../../scripts/verify-schema-ownership";
import { isClinicalVisitPayload } from "../../components/ClinicalVisit";
import { addDays, clinicDateString } from "../../lib/schedule";

const routeSession = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: routeSession.requireSession }));

// Exact actual client predicate + actual canonical GET over synthetic PostgreSQL.
// No component rendering, HTTP server, relink, unlinked flow, real patient or file.
// Original target classification is checked before the established env helper.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
process.env.SKIP_SEED = "true";
const db = await import("../../lib/db");
const { GET } = await import("../../app/api/visits/[id]/clinical/route");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> =>
  (await db.getPool().query<T>(sql, values)).rows;
let doctorId: number;
let serviceId: number;
let sequence = 0;

beforeAll(async () => {
  const resetTarget = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
  if (resetTarget.testUrl.toString() !== target.testUrl.toString()) throw new Error("Disposable target changed before reset");
  const verifier = new Client({ connectionString: resetTarget.testUrl.toString(), ssl: false });
  await verifier.connect();
  try {
    const { rows } = await verifier.query<{ version: string }>("SELECT current_setting('server_version_num') AS version");
    assertPostgres18VersionNum(rows[0]?.version ?? "0");
  } finally { await verifier.end(); }
  await dropPublicSchema(resetTarget.testUrl.toString());
  await db.ensureSchema();
  doctorId = (await q<{ id: number }>("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic decoder clinician') RETURNING id"))[0].id;
  serviceId = (await q<{ id: number }>(`INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active)
    VALUES('Synthetic decoder service','cleaning',15000,400,TRUE,TRUE) RETURNING id`))[0].id;
  routeSession.requireSession.mockResolvedValue({ role: "admin", username: "synthetic-decoder-admin", partyId: doctorId });
}, 180_000);
afterAll(async () => { vi.restoreAllMocks(); await db.resetPoolForTesting(); });

async function linkedVisit() {
  const patientId = (await q<{ id: number }>(`INSERT INTO patients(patient_number,full_name,primary_doctor_id)
    VALUES($1,'Synthetic decoder patient',$2) RETURNING id`, [`DECODER-${++sequence}`, doctorId]))[0].id;
  const visitId = (await q<{ id: number }>(`INSERT INTO visits(patient_id,patient_name,doctor_id,billing_currency,diagnosis)
    VALUES($1,'Synthetic decoder patient',$2,'SAR','Synthetic saved diagnosis') RETURNING id`, [patientId, doctorId]))[0].id;
  // Deliberately no SQL cast or global parser override: the driver owns int8 shape.
  const procedureId = (await q<{ id: string }>(`INSERT INTO visit_procedures
    (visit_id,service_id,doctor_id,tooth_code,quantity,unit_price_minor)
    VALUES($1,$2,$3,16,1,400) RETURNING id`, [visitId, serviceId, doctorId]))[0].id;
  return { patientId, visitId, procedureId };
}
const routeGet = (visitId: number) => GET(new Request(`http://localhost/api/visits/${visitId}/clinical`),
  { params: Promise.resolve({ id: String(visitId) }) });
async function read(f: { patientId: number; visitId: number }) {
  const response = await routeGet(f.visitId);
  expect(response.status).toBe(200);
  const payload: unknown = await response.json();
  if (!isClinicalVisitPayload(payload, f.visitId, f.patientId)) throw new Error("Actual client rejected actual canonical PG payload");
  return payload;
}
async function counts() {
  const result: Record<string, string> = {};
  for (const table of ["visits", "visit_procedures", "ortho_adjustments", "invoices", "payments", "audit_log"]) {
    result[table] = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))[0].n;
  }
  return result;
}

describe("actual ClinicalVisit read predicate against canonical PostgreSQL GET", () => {
  it("accepts an ordinary linked payload and preserves the driver's native BIGINT procedure string", async () => {
    const f = await linkedVisit(); const before = await counts();
    const payload = await read(f);
    expect(typeof f.procedureId).toBe("string");
    expect(typeof payload.procedures[0].id).toBe("string");
    expect(payload.procedures[0].id).toBe(f.procedureId);
    expect(payload.procedures[0].unitPriceMinor).toBe(400);
    expect(await counts()).toEqual(before);
  });

  it("accepts persisted package plan context and keeps procedure/sessionPricing raw identities paired", async () => {
    const f = await linkedVisit();
    const planId = (await q<{ id: number }>(`INSERT INTO treatment_plans
      (patient_id,title,total_minor,base_currency,consent_at,consent_by)
      VALUES($1,'Synthetic decoder package',800,'SAR',NOW(),'synthetic') RETURNING id`, [f.patientId]))[0].id;
    const itemId = (await q<{ id: number }>(`INSERT INTO plan_items
      (plan_id,service_id,service_name,category,tooth_code,quantity,unit_price_minor,billing_rule,session_count,doctor_id)
      VALUES($1,$2,'Synthetic packaged step','cleaning',16,1,800,'package',2,$3) RETURNING id`, [planId, serviceId, doctorId]))[0].id;
    await q(`INSERT INTO plan_installments(plan_id,number,due_date,amount_minor) VALUES($1,1,CURRENT_DATE,800)`, [planId]);
    await q(`INSERT INTO treatment_sessions(plan_item_id,sequence,title) VALUES($1,1,'Synthetic first'),($1,2,'Synthetic next')`, [itemId]);
    await q(`UPDATE visit_procedures SET plan_item_id=$2 WHERE id=$1`, [f.procedureId, itemId]);
    const before = await counts(); const payload = await read(f);
    expect(payload.outstanding.find((item) => item.planItemId === itemId)?.billingRule).toBe("package");
    expect(payload.sessionPricing).toHaveLength(1);
    expect(typeof payload.sessionPricing[0].procedureId).toBe("string");
    expect(payload.sessionPricing[0].procedureId).toBe(f.procedureId);
    expect(payload.sessionPricing[0].procedureId).toBe(payload.procedures[0].id);
    expect(await counts()).toEqual(before);
  });

  it("accepts the signed day difference from a future adjustment saved by the canonical writer", async () => {
    const f = await linkedVisit();
    const caseId = (await q<{ id: number }>(`INSERT INTO ortho_cases(patient_id,created_by)
      VALUES($1,'synthetic-decoder') RETURNING id`, [f.patientId]))[0].id;
    const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
    const doneOn = addDays(today, 2);
    const recorded = await db.recordAdjustment({ caseId, visitId: f.visitId, doneOn,
      phase: "aligning", upperWire: "014 NiTi", lowerWire: "012 NiTi", elastics: "none",
      elasticNote: null, done: "Synthetic future adjustment", nextWeeks: 4, note: null,
      recordedBy: "synthetic-decoder", actorRole: "admin" });
    expect(recorded.ok).toBe(true);
    const before = await counts(); const payload = await read(f);
    expect(payload.ortho?.lastAdjustment).toBe(doneOn);
    expect(payload.ortho?.daysSinceLast).toBe(-2);
    expect(await counts()).toEqual(before);
  });

  it("rejects wrong expected owners and unsafe altered IDs without changing the real payload or database", async () => {
    const f = await linkedVisit(); const payload = await read(f); const before = await counts();
    expect(isClinicalVisitPayload(payload, f.visitId + 1, f.patientId)).toBe(false);
    expect(isClinicalVisitPayload(payload, f.visitId, f.patientId + 1)).toBe(false);
    for (const id of ["9223372036854775808", Number.MAX_SAFE_INTEGER + 1, "01", "1e3", " 1", null]) {
      const changed = { ...payload, procedures: [{ ...payload.procedures[0], id }] };
      expect(isClinicalVisitPayload(changed, f.visitId, f.patientId)).toBe(false);
    }
    expect(payload.procedures[0].id).toBe(f.procedureId);
    expect(await counts()).toEqual(before);
  });
});
