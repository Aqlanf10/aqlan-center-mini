import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ortho_visit_identity_test");
const db = await import("../../lib/db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query(sql, values)).rows as T[];
let patientId: number;
let otherPatientId: number;
let caseId: number;

beforeAll(async () => {
  await db.ensureSchema();
  [{ id: patientId }, { id: otherPatientId }] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES
      ('ORTHO-VISIT-OWN', 'Synthetic orthodontic owner'),
      ('ORTHO-VISIT-OTHER', 'Synthetic other patient') RETURNING id`);
  const created = await db.createOrthoCase({ patientId, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: null, startDate: "2026-10-01", plannedMonths: 18, planId: null, note: null,
    createdBy: "synthetic-clinician" });
  if (!created.ok) throw new Error(created.message);
  caseId = created.id;
});
afterAll(async () => { await db.resetPoolForTesting(); });

async function visit(owner: number | null) {
  return (await q<{ id: number }>(`INSERT INTO visits(patient_name, patient_id, status)
    VALUES ('Synthetic visit identity', $1, 'waiting') RETURNING id`, [owner]))[0].id;
}
const adjust = (visitId: number) => db.recordAdjustment({ caseId, visitId, doneOn: "2026-10-02", phase: "working",
  upperWire: "016 NiTi", lowerWire: null, elastics: "none", elasticNote: null, done: "Synthetic adjustment",
  nextWeeks: 4, note: null, recordedBy: "synthetic-clinician", actorRole: "doctor" });
async function footprint() {
  return {
    visits: await q("SELECT id, patient_id FROM visits ORDER BY id"),
    sessions: await q("SELECT id, visit_id FROM ortho_adjustments WHERE case_id = $1 ORDER BY id", [caseId]),
    case: await q("SELECT upper_wire, lower_wire, phase FROM ortho_cases WHERE id = $1", [caseId]),
    finance: await q(`SELECT (SELECT count(*) FROM invoices)::int AS invoices,
      (SELECT count(*) FROM payments)::int AS payments,
      (SELECT count(*) FROM treatment_plans)::int AS plans`),
    audits: await q("SELECT id FROM audit_log WHERE action = 'ortho.adjustment' ORDER BY id"),
  };
}

describe("orthodontic sessions require exact visit patient identity", () => {
  it.each(["unassigned", "foreign"] as const)("rejects an explicitly selected %s visit without clinical or financial writes", async (kind) => {
    const visitId = await visit(kind === "unassigned" ? null : otherPatientId);
    const before = await footprint();
    expect(await adjust(visitId)).toEqual({ ok: false, message: "الزيارة وحالة التقويم لمريضين مختلفين." });
    expect(await footprint()).toEqual(before);
  });

  it("accepts an exact owned visit and replays it once without invoices or a new visit", async () => {
    const visitId = await visit(patientId);
    const first = await adjust(visitId);
    expect(first).toMatchObject({ ok: true, created: true, visitId });
    if (!first.ok) throw new Error(first.message);
    const before = await footprint();
    expect(await adjust(visitId)).toMatchObject({ ok: true, id: first.id, created: false, visitId });
    expect(await footprint()).toEqual(before);
    expect(before.finance).toEqual([{ invoices: 0, payments: 0, plans: 0 }]);
    await q("UPDATE visits SET signed_at = NOW() WHERE id = $1", [visitId]);
    expect(await adjust(visitId)).toMatchObject({ ok: true, id: first.id, created: false, visitId });
    expect(await footprint()).toEqual(before);
  });

  it.each([false, true])("does not bless a pre-existing unassigned visit link on replay (signed=%s)", async (signed) => {
    const visitId = await visit(null);
    await q(`INSERT INTO ortho_adjustments(case_id, visit_id, done_on, recorded_by)
      VALUES ($1, $2, '2026-10-02', 'synthetic-historical-invalid-link')`, [caseId, visitId]);
    if (signed) await q("UPDATE visits SET signed_at = NOW() WHERE id = $1", [visitId]);
    const before = await footprint();
    expect(await adjust(visitId)).toMatchObject({ ok: false });
    expect(await footprint()).toEqual(before);
  });
});
