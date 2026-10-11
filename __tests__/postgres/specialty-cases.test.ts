import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (CASE-MODEL-1) مريضٌ واحد ← سجلٌّ واحد ← حالاتٌ تخصصية كثيرة — على PostgreSQL 18.
 *
 * «محمد أحمد»: حالة تقويم قائمة (د. عقلان)، ثم علاج عصب ٢١ (د. محمد) قبل الحاصرة، ثم تاج بعده.
 * خطة شاملة واحدة، وثلاث حالات، وبنودٌ مرتبة باعتمادياتها، وقائمة مشاكل — وحسابٌ واحد لا يُمسّ.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, createPlanV2, listPatientCases, createClinicalCase,
  changeClinicalCaseStatus, createPatientProblem, changePatientProblemStatus, listPatientProblems,
  listCasePlanItems, setPlanItemCase, addPlanItemDependency, removePlanItemDependency,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let patientId = 0;
let otherPatientId = 0;
let orthodontist = 0;
let endodontist = 0;
let orthoCaseId = 0;
const items: Record<"ortho" | "endo" | "crown", number> = { ortho: 0, endo: 0, crown: 0 };

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const doctor = async (name: string) => (await q<{ id: number }>(
    `INSERT INTO parties (kind, name) VALUES ('doctor', $1) RETURNING id`, [name]))[0].id;
  orthodontist = await doctor("د. عقلان");
  endodontist = await doctor("د. محمد");
  patientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('P-CASE-1', 'محمد أحمد') RETURNING id`))[0].id;
  otherPatientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('P-CASE-2', 'مريض آخر') RETURNING id`))[0].id;

  const service = async (name: string, category: string) => (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 100000, TRUE, TRUE, $2) RETURNING id`,
    [name, category]))[0].id;
  const orthoService = await service("تقويم ثابت", "ortho");
  const endoService = await service("علاج عصب", "rct");
  const crownService = await service("تاج زيركون", "crown");
  const plan = await createPlanV2({
    patientId, title: "الخطة الشاملة", specialty: null, primaryDoctorId: orthodontist, billingMode: "per_procedure",
    baseCurrency: "YER", startDate: "2026-09-01", note: null, createdBy: "admin",
    items: [
      { serviceId: orthoService, serviceName: "تقويم ثابت", category: "ortho", toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 600000, billingRule: "per_session", sessionCount: 6, note: null },
      { serviceId: endoService, serviceName: "علاج عصب", category: "rct", toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 80000, billingRule: "on_completion", sessionCount: 2, note: null },
      { serviceId: crownService, serviceName: "تاج زيركون", category: "crown", toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 120000, billingRule: "on_completion", sessionCount: 2, note: null },
    ],
    installments: [],
  });
  if (!plan.ok) throw new Error(plan.message);
  const rows = await q<{ id: number; service_name: string }>(`SELECT id, service_name FROM plan_items WHERE plan_id = $1 ORDER BY id`, [plan.planId]);
  items.ortho = rows[0].id; items.endo = rows[1].id; items.crown = rows[2].id;
  orthoCaseId = (await q<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, plan_id, created_by) VALUES ($1, $2, 'admin') RETURNING id`, [patientId, plan.planId]))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(CASE-MODEL-1) one patient, one record, many specialty cases", () => {
  it("an existing orthodontic case appears in the unified list as a read model — nothing is written for it", async () => {
    const before = await q(`SELECT COUNT(*)::int AS n FROM clinical_cases`);
    const cases = await listPatientCases(patientId);
    expect(cases).toEqual([expect.objectContaining({
      id: null, kind: "ortho", orthoCaseId, specialty: "orthodontics", status: "active",
      responsiblePartyId: orthodontist, responsibleName: "د. عقلان", itemsTotal: 3, itemsDone: 0,
    })]);
    expect(await q(`SELECT COUNT(*)::int AS n FROM clinical_cases`)).toEqual(before);
  });

  it("opens an endodontic case with its responsible doctor — audited in the same transaction", async () => {
    const created = await createClinicalCase({
      patientId, specialty: "endodontics", title: "علاج عصب — سن ٢١", site: "21", problem: "التهاب لب غير عكوس",
      responsiblePartyId: endodontist, orthoCaseId: null, actor: "dr-mohammed", actorRole: "doctor",
    });
    if (!created.ok) throw new Error(created.reason);
    expect(created.case).toMatchObject({ kind: "specialty", specialty: "endodontics", status: "active", responsibleName: "د. محمد" });
    const [audit] = await q<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_log WHERE action = 'case.create' ORDER BY id DESC LIMIT 1`);
    expect(audit).toEqual({ action: "case.create", actor: "dr-mohammed" });
  });

  it("refuses a non-doctor responsible party and another patient's orthodontic case", async () => {
    const [lab] = await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('lab', 'معمل') RETURNING id`);
    expect(await createClinicalCase({
      patientId, specialty: "prosthodontics", title: "تاج", site: null, problem: null,
      responsiblePartyId: lab.id, orthoCaseId: null, actor: "x",
    })).toEqual({ ok: false, reason: "bad_responsible" });
    expect(await createClinicalCase({
      patientId: otherPatientId, specialty: "orthodontics", title: "تقويم", site: null, problem: null,
      responsiblePartyId: null, orthoCaseId, actor: "x",
    })).toEqual({ ok: false, reason: "bad_ortho" });
  });

  it("bridging the orthodontic case replaces its read-model row — once only", async () => {
    const bridged = await createClinicalCase({
      patientId, specialty: "general", title: "تقويم الأسنان — د. عقلان", site: null, problem: null,
      responsiblePartyId: orthodontist, orthoCaseId, actor: "admin",
    });
    if (!bridged.ok) throw new Error(bridged.reason);
    expect(bridged.case.specialty).toBe("orthodontics");
    const cases = await listPatientCases(patientId);
    expect(cases.filter((item) => item.kind === "ortho")).toEqual([]);
    expect(cases.filter((item) => item.orthoCaseId === orthoCaseId)).toHaveLength(1);
    expect(await createClinicalCase({
      patientId, specialty: "orthodontics", title: "مكرر", site: null, problem: null,
      responsiblePartyId: null, orthoCaseId, actor: "admin",
    })).toEqual({ ok: false, reason: "already_bridged" });
  });

  it("links plan items to their cases with a priority — one master plan feeds many cases", async () => {
    const cases = await listPatientCases(patientId);
    const endoCase = cases.find((item) => item.specialty === "endodontics")!;
    const orthoCase = cases.find((item) => item.specialty === "orthodontics")!;
    expect(await setPlanItemCase({ itemId: items.endo, caseId: endoCase.id, priority: 1, actor: "dr-mohammed" })).toEqual({ ok: true });
    // Legacy persisted attribution remains editable as a same-case priority save.
    // A new arch relink cannot infer scope from the target case or free-text note.
    expect(await setPlanItemCase({ itemId: items.ortho, caseId: orthoCase.id, priority: 2, actor: "admin" }))
      .toEqual({ ok: false, reason: "scope_unknown" });
    await q(`UPDATE plan_items SET case_id = $2 WHERE id = $1`, [items.ortho, orthoCase.id]);
    expect(await setPlanItemCase({ itemId: items.ortho, caseId: orthoCase.id, priority: 2, actor: "admin" })).toEqual({ ok: true });
    // حالةُ مريضٍ آخر لا تُربط.
    const other = await createClinicalCase({
      patientId: otherPatientId, specialty: "periodontics", title: "لثة", site: null, problem: null,
      responsiblePartyId: null, orthoCaseId: null, actor: "admin",
    });
    if (!other.ok) throw new Error(other.reason);
    expect(await setPlanItemCase({ itemId: items.crown, caseId: other.case.id, priority: null, actor: "admin" }))
      .toEqual({ ok: false, reason: "bad_case" });
    const { items: listed } = await listCasePlanItems(patientId);
    expect(listed.map((item) => [item.id, item.priority])).toEqual([[items.endo, 1], [items.ortho, 2], [items.crown, null]]);
    expect((await listPatientCases(patientId)).find((item) => item.specialty === "endodontics")?.itemsTotal).toBe(1);
  });

  it("dependencies: the brace waits for the root canal and the crown after it; a cycle is refused", async () => {
    expect(await addPlanItemDependency({ itemId: items.ortho, requiresItemId: items.endo, requirement: "clearance", note: "حاصرة ٢١ بعد العصب", actor: "admin" })).toEqual({ ok: true });
    expect(await addPlanItemDependency({ itemId: items.crown, requiresItemId: items.endo, requirement: "completed", note: null, actor: "admin" })).toEqual({ ok: true });
    expect(await addPlanItemDependency({ itemId: items.endo, requiresItemId: items.crown, requirement: "completed", note: null, actor: "admin" }))
      .toEqual({ ok: false, reason: "cycle" });
    expect(await addPlanItemDependency({ itemId: items.crown, requiresItemId: items.endo, requirement: "completed", note: null, actor: "admin" }))
      .toEqual({ ok: false, reason: "exists" });

    let { dependencies } = await listCasePlanItems(patientId);
    expect(dependencies.map((dep) => [dep.itemId, dep.met])).toEqual([[items.ortho, false], [items.crown, false]]);

    // العصب بدأ ⇒ «الإذن» متحقَّق للحاصرة، والتاج ما زال ينتظر اكتماله.
    await q(`UPDATE plan_items SET status = 'in_progress' WHERE id = $1`, [items.endo]);
    ({ dependencies } = await listCasePlanItems(patientId));
    expect(dependencies.map((dep) => [dep.itemId, dep.met])).toEqual([[items.ortho, true], [items.crown, false]]);
    await q(`UPDATE plan_items SET status = 'done' WHERE id = $1`, [items.endo]);
    ({ dependencies } = await listCasePlanItems(patientId));
    expect(dependencies.every((dep) => dep.met)).toBe(true);

    expect(await removePlanItemDependency({ itemId: items.crown, requiresItemId: items.endo, actor: "admin" })).toEqual({ ok: true });
    expect(await removePlanItemDependency({ itemId: items.crown, requiresItemId: items.endo, actor: "admin" })).toEqual({ ok: false, reason: "not_found" });
    const actions = await q<{ action: string }>(
      `SELECT action FROM audit_log WHERE action LIKE 'plan.dependency%' ORDER BY id`);
    expect(actions.map((row) => row.action)).toEqual(["plan.dependency_add", "plan.dependency_add", "plan.dependency_remove"]);
  });

  it("problem list: active first; resolving stamps who and when; reactivating clears it", async () => {
    const endoCase = (await listPatientCases(patientId)).find((item) => item.specialty === "endodontics")!;
    const pulpitis = await createPatientProblem({ patientId, label: "التهاب لب غير عكوس", site: "21", specialty: "endodontics", caseId: endoCase.id, actor: "dr-mohammed" });
    const crowding = await createPatientProblem({ patientId, label: "ازدحام أمامي", site: null, specialty: "orthodontics", caseId: null, actor: "admin" });
    if (!pulpitis.ok || !crowding.ok) throw new Error("problem");
    expect(pulpitis.problem.caseTitle).toBe("علاج عصب — سن ٢١");
    const resolved = await changePatientProblemStatus({ id: pulpitis.problem.id, status: "resolved", actor: "dr-mohammed" });
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.problem).toMatchObject({ status: "resolved", resolvedBy: "dr-mohammed" });
    expect(resolved.problem.resolvedAt).not.toBeNull();
    expect(await changePatientProblemStatus({ id: pulpitis.problem.id, status: "resolved", actor: "x" })).toEqual({ ok: false, reason: "unchanged" });
    expect((await listPatientProblems(patientId)).map((problem) => problem.label)).toEqual(["ازدحام أمامي", "التهاب لب غير عكوس"]);
    const reopened = await changePatientProblemStatus({ id: pulpitis.problem.id, status: "active", actor: "x" });
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(reopened.problem).toMatchObject({ status: "active", resolvedBy: null, resolvedAt: null });
    expect(await createPatientProblem({ patientId: otherPatientId, label: "x", site: null, specialty: null, caseId: endoCase.id, actor: "x" }))
      .toEqual({ ok: false, reason: "bad_case" });
  });

  it("case lifecycle: allowed moves only; a finished case never reopens; cancel needs a reason (DB-enforced too)", async () => {
    const endoCase = (await listPatientCases(patientId)).find((item) => item.specialty === "endodontics")!;
    const waiting = await changeClinicalCaseStatus({ id: endoCase.id!, status: "waiting", outcome: null, actor: "x" });
    expect(waiting).toMatchObject({ ok: true, case: { status: "waiting", completedAt: null } });
    const done = await changeClinicalCaseStatus({ id: endoCase.id!, status: "completed", outcome: "حشو قنوات ناجح", actor: "dr-mohammed" });
    if (!done.ok) throw new Error(done.reason);
    expect(done.case).toMatchObject({ status: "completed", outcome: "حشو قنوات ناجح" });
    expect(done.case.completedAt).not.toBeNull();
    expect(await changeClinicalCaseStatus({ id: endoCase.id!, status: "active", outcome: null, actor: "x" }))
      .toEqual({ ok: false, reason: "invalid_transition" });
    await expect(q(`INSERT INTO clinical_cases (patient_id, specialty, title, status, completed_at, created_by)
                    VALUES ($1, 'general', 'x', 'cancelled', NOW(), 'x')`, [patientId])).rejects.toThrow();
  });

  it("a bridged orthodontic case takes its status from the orthodontic module only", async () => {
    const orthoCase = (await listPatientCases(patientId)).find((item) => item.orthoCaseId === orthoCaseId)!;
    expect(orthoCase.status).toBe("active");
    // الإغلاق من وحدة التقويم ينعكس هنا — لا مصدران للحالة.
    await q(`UPDATE ortho_cases SET status = 'discontinued', closed_at = NOW(), closed_by = 'admin', closed_note = 'سافر' WHERE id = $1`, [orthoCaseId]);
    const after = (await listPatientCases(patientId)).find((item) => item.orthoCaseId === orthoCaseId)!;
    expect(after).toMatchObject({ status: "closed", outcome: "سافر" });
    expect(await changeClinicalCaseStatus({ id: after.id!, status: "completed", outcome: null, actor: "x" }))
      .toEqual({ ok: false, reason: "ortho_managed" });

    // وجسرُ حالة تقويمٍ منتهية يولد منتهيًا، لا «جاريًا».
    const [finished] = await q<{ id: number }>(
      `INSERT INTO ortho_cases (patient_id, status, closed_at, closed_by, closed_note, created_by)
       VALUES ($1, 'completed', NOW(), 'admin', 'انتهى بمثبّت', 'admin') RETURNING id`, [otherPatientId]);
    const bridged = await createClinicalCase({
      patientId: otherPatientId, specialty: "orthodontics", title: "تقويم سابق", site: null, problem: null,
      responsiblePartyId: null, orthoCaseId: finished.id, actor: "admin",
    });
    if (!bridged.ok) throw new Error(bridged.reason);
    expect(bridged.case).toMatchObject({ status: "completed", outcome: "انتهى بمثبّت" });
    expect(bridged.case.completedAt).not.toBeNull();
  });

  it("one patient ledger: nothing here writes invoices or payments", async () => {
    expect(await q(`SELECT COUNT(*)::int AS n FROM invoices`)).toEqual([{ n: 0 }]);
    expect(await q(`SELECT COUNT(*)::int AS n FROM payments`)).toEqual([{ n: 0 }]);
  });
});
