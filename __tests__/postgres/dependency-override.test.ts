import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (CASE-MODEL-1b) بندٌ يتطلب غيره ولم يتحقق: تحذيرٌ على الشاشة، والتوقيع يطلب سببًا يُدقَّق —
 * لا منعٌ صامت ولا متابعةٌ صامتة. على PostgreSQL 18.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, createPlanV2, addPlanItemDependency,
  addVisit, setVisitProcedures, signClinicalVisit, getClinicalVisit, patientWorkflow,
  createPatientProblem, createClinicalCase, changeClinicalCaseStatus,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let patientId = 0;
let doctorId = 0;
let endoServiceId = 0;
let crownServiceId = 0;
let endoItem = 0;
let crownItem = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctorId = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. محمد') RETURNING id`))[0].id;
  patientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('P-DEP-1', 'محمد أحمد') RETURNING id`))[0].id;
  const service = async (name: string, category: string) => (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 50000, TRUE, TRUE, $2) RETURNING id`,
    [name, category]))[0].id;
  endoServiceId = await service("علاج عصب", "endo");
  crownServiceId = await service("تاج زيركون", "crown");
  const plan = await createPlanV2({
    patientId, title: "الخطة الشاملة", specialty: null, primaryDoctorId: doctorId, billingMode: "per_procedure",
    baseCurrency: "YER", startDate: "2026-09-01", note: null, createdBy: "admin",
    items: [
      { serviceId: endoServiceId, serviceName: "علاج عصب", category: "endo", toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 50000, billingRule: "on_completion", sessionCount: 1, note: null },
      { serviceId: crownServiceId, serviceName: "تاج زيركون", category: "crown", toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 90000, billingRule: "on_completion", sessionCount: 1, note: null },
    ],
    installments: [],
  });
  if (!plan.ok) throw new Error(plan.message);
  await q(`UPDATE treatment_plans SET consent_at = NOW() WHERE id = $1`, [plan.planId]);
  const rows = await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1 ORDER BY id`, [plan.planId]);
  endoItem = rows[0].id; crownItem = rows[1].id;
  const added = await addPlanItemDependency({ itemId: crownItem, requiresItemId: endoItem, requirement: "completed", note: null, actor: "admin" });
  if (!added.ok) throw new Error(added.reason);
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function crownVisit(): Promise<number> {
  const visit = await addVisit({ patientName: "محمد أحمد", patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, diagnosis = 'تحضير تاج' WHERE id = $1`, [visit.id, doctorId]);
  await setVisitProcedures({
    visitId: visit.id,
    procedures: [{ serviceId: crownServiceId, toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 90000, priceReason: null, doctorId, note: null, planItemId: crownItem }],
  });
  return visit.id;
}

describe("(CASE-MODEL-1b) unmet plan dependencies at the chair", () => {
  it("the visit shows what the crown still requires", async () => {
    const visitId = await crownVisit();
    const visit = await getClinicalVisit(visitId);
    const crown = visit?.outstanding.find((item) => item.planItemId === crownItem);
    expect(crown?.unmetRequirements).toEqual(["علاج عصب — سن 21 (بعد اكتماله)"]);
    expect(visit?.outstanding.find((item) => item.planItemId === endoItem)?.unmetRequirements).toEqual([]);
  });

  it("the patient summary says what is waiting: blocked item, waiting case, active problems", async () => {
    await createPatientProblem({ patientId, label: "التهاب لب", site: "21", specialty: "endodontics", caseId: null, actor: "dr" });
    const created = await createClinicalCase({ patientId, specialty: "prosthodontics", title: "تاج ٢١", site: "21", problem: null, responsiblePartyId: doctorId, orthoCaseId: null, actor: "dr" });
    if (!created.ok) throw new Error(created.reason);
    await changeClinicalCaseStatus({ id: created.case.id!, status: "waiting", outcome: null, actor: "dr" });
    const summary = await patientWorkflow(patientId, "2026-09-29");
    const byKind = (kind: string) => summary?.alerts.filter((alert) => alert.kind === kind).map((alert) => alert.text) ?? [];
    expect(byKind("plan_blocked")).toEqual(["«تاج زيركون — سن 21» بانتظار: علاج عصب — سن 21 (بعد اكتماله)"]);
    expect(byKind("case_waiting")).toEqual(["حالة «تاج ٢١» بانتظار."]);
    expect(byKind("active_problems")).toEqual(["مشاكل نشطة: التهاب لب (21)."]);
  });

  it("signing without a reason is refused and writes nothing; with a reason it signs and audits the override", async () => {
    const visitId = await crownVisit();
    const refused = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr-mohammed" });
    expect(refused.reason).toBe("unmet_dependency");
    expect(refused.unmetRequirements).toEqual(["تاج زيركون يتطلب: علاج عصب — سن 21 (بعد اكتماله)"]);
    expect(await q(`SELECT signed_at FROM visits WHERE id = $1`, [visitId])).toEqual([{ signed_at: null }]);
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toEqual([]);

    const signed = await signClinicalVisit({
      visitId, baseCurrency: "YER", signedBy: "dr-mohammed", dependencyOverrideReason: "العصب أُنجز في عيادة خارجية — الأشعة مرفقة",
    });
    expect(signed.reason).toBeNull();
    expect(signed.invoiceId).not.toBeNull();
    const [audit] = await q<{ action: string; actor: string; entity_id: string; details: Record<string, string> }>(
      `SELECT action, actor, entity_id, details FROM audit_log WHERE action = 'plan.dependency_override' ORDER BY id DESC LIMIT 1`);
    expect(audit).toMatchObject({ action: "plan.dependency_override", actor: "dr-mohammed", entity_id: String(visitId) });
    expect(audit.details.السبب).toContain("عيادة خارجية");
  });

  it("once the requirement is met, no reason is asked", async () => {
    await q(`UPDATE plan_items SET status = 'done' WHERE id = $1`, [endoItem]);
    const [plan] = await q<{ plan_id: number }>(`SELECT plan_id FROM plan_items WHERE id = $1`, [endoItem]);
    const [second] = await q<{ id: number }>(
      `INSERT INTO plan_items (plan_id, service_id, service_name, category, tooth_code, quantity, unit_price_minor, billing_rule, session_count)
       VALUES ($1, $2, 'تاج زيركون', 'crown', 22, 1, 90000, 'on_completion', 1) RETURNING id`, [plan.plan_id, crownServiceId]);
    const added = await addPlanItemDependency({ itemId: second.id, requiresItemId: endoItem, requirement: "completed", note: null, actor: "admin" });
    expect(added.ok).toBe(true);
    const visit = await addVisit({ patientName: "محمد أحمد", patientPhone: null, note: null, patientId });
    await q(`UPDATE visits SET doctor_id = $2, diagnosis = 'تاج ٢٢' WHERE id = $1`, [visit.id, doctorId]);
    await setVisitProcedures({
      visitId: visit.id,
      procedures: [{ serviceId: crownServiceId, toothCode: 22, surfaces: null, quantity: 1, unitPriceMinor: 90000, priceReason: null, doctorId, note: null, planItemId: second.id }],
    });
    const signed = await signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "dr-mohammed" });
    expect(signed.reason).toBeNull();
  });
});
