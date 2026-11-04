/** M2 slice 83: the canonical clinical navigation context on real PostgreSQL, synthetic
 * data only. A clinical grant inside the patient scope; plan references need
 * clinical.plans.view; ortho references clinical.ortho.view; exact edges only (another
 * patient's plan reads as not found, a mismatched case as context_mismatch); no money. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-clinical-context-secret-26");
const db = await import("../../lib/db");
const reads = await import("../../lib/canonical-patient-reads");

const ACCOUNTS = {
  owner: { username: "SYN-CX-OWNER", role: "admin" },
  planner: { username: "SYN-CX-PLAN", role: "reception", patientScope: "all", grants: { "clinical.plans.view": true } },
  documenter: { username: "SYN-CX-DOC", role: "assistant", patientScope: "all", grants: { "clinical.visits.document": true } },
  doctor: { username: "SYN-CX-DR", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number }) => error);
const ids = { mine: 0, other: 0, plan: 0, otherPlan: 0, item: 0, caseId: 0, otherCase: 0, visit: 0 };

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000721',$3) RETURNING id", [number, `SYN CX ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-CX-1", fx.parties.doctor!);
  ids.other = await patient("SYN-CX-2", null);
  const kase = async (patientId: number) =>
    (await q("INSERT INTO clinical_cases (patient_id, specialty, title, status, created_by) VALUES ($1,'endodontics','حالة سياق اصطناعية','active','SYN') RETURNING id", [patientId]))[0].id as number;
  ids.caseId = await kase(ids.mine);
  ids.otherCase = await kase(ids.mine);
  ids.plan = (await q("INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, 'خطة سياق', 9900) RETURNING id", [ids.mine]))[0].id;
  ids.otherPlan = (await q("INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, 'خطة غيره', 9900) RETURNING id", [ids.other]))[0].id;
  ids.item = (await q("INSERT INTO plan_items(plan_id,service_name,quantity,unit_price_minor,case_id) VALUES($1,'بند سياق',1,9900,$2) RETURNING id", [ids.plan, ids.caseId]))[0].id;
  ids.visit = (await q("INSERT INTO visits (patient_name, patient_id) VALUES ('SYN CX', $1) RETURNING id", [ids.mine]))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("clinical context", () => {
  it("resolves an exact item → plan → case graph by a plan viewer; no money in the result", async () => {
    const result = await reads.readCanonicalClinicalContext(await fx.session("planner"), ids.mine, { planItemId: ids.item });
    expect(result).toMatchObject({ ok: true, context: { patientId: ids.mine, planItemId: ids.item, planId: ids.plan, clinicalCaseId: ids.caseId } });
    expect(JSON.stringify(result)).not.toMatch(/minor|price|total|9900/i);
  });
  it("exact edges only: another patient's plan is not found, a mismatched case is a mismatch", async () => {
    expect(await reads.readCanonicalClinicalContext(await fx.session("planner"), ids.mine, { planId: ids.otherPlan })).toEqual({ ok: false, reason: "not_found" });
    expect(await reads.readCanonicalClinicalContext(await fx.session("planner"), ids.mine, { planItemId: ids.item, clinicalCaseId: ids.otherCase }))
      .toEqual({ ok: false, reason: "context_mismatch" });
  });
  it("plan references need clinical.plans.view; ortho references clinical.ortho.view; a visit context needs only the clinical grant", async () => {
    expect(await refusal(reads.readCanonicalClinicalContext(await fx.session("documenter"), ids.mine, { planId: ids.plan }))).toMatchObject({ code: "plan_view_required", status: 403 });
    expect(await refusal(reads.readCanonicalClinicalContext(await fx.session("planner"), ids.mine, { orthoCaseId: 1 }))).toMatchObject({ code: "ortho_view_required", status: 403 });
    expect(await reads.readCanonicalClinicalContext(await fx.session("documenter"), ids.mine, { visitId: ids.visit })).toMatchObject({ ok: true });
  });
  it("a patient outside the scope reads like a missing one", async () => {
    expect(await refusal(reads.readCanonicalClinicalContext(await fx.session("doctor"), ids.other, { planId: ids.otherPlan }))).toMatchObject({ code: "patient_not_found" });
  });
});
