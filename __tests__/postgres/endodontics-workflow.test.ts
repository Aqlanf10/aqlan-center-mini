import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { checkEndoVisitDraft } from "../../lib/endodontics";

/**
 * (ENDO-2) سير عمل علاج الجذور على PostgreSQL 18: العزل (مريض/سن)، قنواتٌ متعددة، زياراتٌ متعددة،
 * نسبة الطبيب، التزامن، التكرار، تجميد الموقَّع والملاحق، وربط التاج باعتماديات الخطة.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const endo = await import("../../lib/endodontics-db");
const { ensureSchema, getPool, resetPoolForTesting } = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const draftOf = (body: Record<string, unknown>) => {
  const checked = checkEndoVisitDraft(body);
  if (!checked.ok) throw new Error(checked.message);
  return checked.value;
};
const actor = { actor: "dr.ahmad", actorRole: "doctor" };

let doctor1 = 0;
let doctor2 = 0;
let supplier = 0;
let patient = 0;
let other = 0;
let caseId = 0;
let otherCase = 0;
let surgeryCase = 0;
const newVisit = async (patientId: number, doctorId: number | null) => (await q<{ id: number }>(
  `INSERT INTO visits (patient_name, patient_id, doctor_id) VALUES ('x', $1, $2) RETURNING id`, [patientId, doctorId]))[0].id;
const sign = (visitId: number) => q(`UPDATE visits SET signed_at = NOW(), signed_by = 'dr' WHERE id = $1`, [visitId]);
const audits = async (action: string) => q<{ actor: string; details: Record<string, unknown> }>(
  `SELECT actor, details FROM audit_log WHERE action = $1 ORDER BY id`, [action]);

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const party = async (kind: string, name: string) => (await q<{ id: number }>(
    `INSERT INTO parties (kind, name) VALUES ($1, $2) RETURNING id`, [kind, name]))[0].id;
  doctor1 = await party("doctor", "د. أحمد");
  doctor2 = await party("doctor", "د. سالم");
  supplier = await party("supplier", "مورّد");
  const mkPatient = async (n: string) => (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [n]))[0].id;
  patient = await mkPatient("P-E2-1");
  other = await mkPatient("P-E2-2");
  const mkCase = async (patientId: number, specialty: string, status = "active") => (await q<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, site, status, completed_at, created_by)
     VALUES ($1, $2, 't', '36', $3, CASE WHEN $3 IN ('active','waiting') THEN NULL ELSE NOW() END, 'admin') RETURNING id`,
    [patientId, specialty, status]))[0].id;
  caseId = await mkCase(patient, "endodontics");
  otherCase = await mkCase(other, "endodontics");
  surgeryCase = await mkCase(patient, "surgery");
});

afterAll(async () => { await resetPoolForTesting(); });

describe("opening a treatment", () => {
  it("validates tooth and case ownership/specialty/state", async () => {
    expect(await endo.openEndoTreatment({ ...actor, patientId: patient, caseId, toothCode: 19, kind: "initial" })).toEqual({ ok: false, reason: "bad_tooth" });
    expect(await endo.openEndoTreatment({ ...actor, patientId: patient, caseId: otherCase, toothCode: 36, kind: "initial" })).toEqual({ ok: false, reason: "bad_case" });
    expect(await endo.openEndoTreatment({ ...actor, patientId: patient, caseId: surgeryCase, toothCode: 36, kind: "initial" })).toEqual({ ok: false, reason: "bad_case" });
    const closed = await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id, specialty, title, status, completed_at, created_by) VALUES ($1, 'endodontics', 'c', 'completed', NOW(), 'a') RETURNING id`, [patient]);
    expect(await endo.openEndoTreatment({ ...actor, patientId: patient, caseId: closed[0].id, toothCode: 36, kind: "initial" })).toEqual({ ok: false, reason: "case_closed" });
    expect(await endo.openEndoTreatment({ ...actor, patientId: 999999, caseId, toothCode: 36, kind: "initial" })).toEqual({ ok: false, reason: "no_patient" });
  });

  it("concurrent opens on the same tooth produce exactly one episode; other tooth/patient are independent", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      endo.openEndoTreatment({ ...actor, patientId: patient, caseId, toothCode: 36, kind: "initial" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "tooth_busy")).toBe(true);
    const case46 = (await q<{ id: number }>(`INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by)
      VALUES($1,'endodontics','SYNTHETIC 46','46','synthetic') RETURNING id`, [patient]))[0].id;
    expect((await endo.openEndoTreatment({ ...actor, patientId: patient, caseId: case46, toothCode: 46, kind: "initial" })).ok).toBe(true);
    expect((await endo.openEndoTreatment({ ...actor, patientId: other, caseId: otherCase, toothCode: 36, kind: "initial" })).ok).toBe(true);
    const rows = await q(`SELECT 1 FROM endo_treatments WHERE patient_id = $1 AND tooth_code = 36`, [patient]);
    expect(rows).toHaveLength(1);
    const [opened] = await audits("endo.open");
    expect(opened.actor).toBe("dr.ahmad");
  });

  it("each patient only ever lists their own treatments", async () => {
    const mine = await endo.listPatientEndo(patient);
    const theirs = await endo.listPatientEndo(other);
    expect(mine.map((t) => t.toothCode).sort()).toEqual([36, 46]);
    expect(theirs.map((t) => t.toothCode)).toEqual([36]);
    expect(mine.every((t) => t.patientId === patient)).toBe(true);
  });
});

describe("multi-visit, multi-canal treatment on tooth 36", () => {
  let treatmentId = 0;
  let v1 = 0; let v2 = 0; let v3 = 0;
  beforeAll(async () => {
    treatmentId = (await endo.listPatientEndo(patient)).find((t) => t.toothCode === 36)!.id;
    v1 = await newVisit(patient, doctor1);
    v2 = await newVisit(patient, doctor1);
    v3 = await newVisit(patient, null);
  });
  const save = (visitId: number, body: Record<string, unknown>, extra: Partial<Parameters<typeof endo.saveEndoVisit>[0]> = {}) =>
    endo.saveEndoVisit({
      ...actor, patientId: patient, treatmentId, visitId, draft: draftOf(body), expectedVersion: null, actorPartyId: null, ...extra,
    });

  it("visit 1: assessment with diagnosis and found canals; the doctor is the visit's doctor", async () => {
    const result = await save(v1, {
      stage: "assessment", chiefComplaint: "ألم ليلي", pulpalDiagnosis: "symptomatic_irreversible_pulpitis",
      apicalDiagnosis: "symptomatic_apical_periodontitis", vitalityCold: "prolonged", percussion: "tender",
      radiographicFindings: "آفة ذروية صغيرة", canalsFound: 3,
      canals: [{ label: "MB" }, { label: "ML" }, { label: "D" }],
    });
    expect(result).toMatchObject({ ok: true, created: true, unchanged: false });
    const [row] = await q<{ doctor_id: number; version: number }>(`SELECT doctor_id, version FROM endo_visits WHERE visit_id = $1`, [v1]);
    expect(row).toEqual({ doctor_id: doctor1, version: 1 });
  });

  it("visit 2: working lengths per canal with reference point and method; history keeps visit 1", async () => {
    const view = await save(v2, {
      stage: "shaping", irrigation: "NaOCl 2.5%", medicament: "Ca(OH)2", nextStep: "حشو القنوات", nextVisitWeeks: 1,
      canals: [
        { label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "both", masterApicalSize: 25, taperPercent: 6 },
        { label: "ML", workingLengthMm: 19.5, referencePoint: "cusp_tip", measurementMethod: "apex_locator" },
        { label: "D", workingLengthMm: 21, referencePoint: "cusp_tip", measurementMethod: "both" },
      ],
    });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.treatment.summary.canals.map((c) => [c.label, c.workingLengthMm])).toEqual([["MB", 20.5], ["ML", 19.5], ["D", 21]]);
    expect(view.treatment.nextAction).toMatch(/التشكيل ثم الحشو|حشو القنوات/);
    expect(view.treatment.visits).toHaveLength(2);
    expect(view.treatment.visits[0].canals.every((c) => c.workingLengthMm === null)).toBe(true); // visit 1 untouched
  });

  it("visit 3: no visit doctor → falls back to the signing doctor's party; obturation + temporary restoration", async () => {
    const view = await save(v3, {
      stage: "obturation", obturationTechnique: "lateral condensation", obturationMaterial: "gutta-percha + sealer",
      restorationAfter: "temporary", prognosis: "favorable",
      canals: [{ label: "MB", obturated: true }, { label: "ML", obturated: true }, { label: "D", obturated: true }],
    }, { actorPartyId: doctor2 });
    expect(view.ok).toBe(true);
    const [row] = await q<{ doctor_id: number }>(`SELECT doctor_id FROM endo_visits WHERE visit_id = $1`, [v3]);
    expect(row.doctor_id).toBe(doctor2);
    if (!view.ok) return;
    expect(view.treatment.summary).toMatchObject({ sessions: 3, allCanalsObturated: true, prognosis: "favorable" });
    expect(view.treatment.restorativeStatus).toBe("temporary");
    // the latest measurement per canal is remembered with its visit
    expect(view.treatment.summary.canals.find((c) => c.label === "MB")).toMatchObject({ workingLengthMm: 20.5, lastMeasuredVisitId: view.treatment.visits[1].id });
  });

  it("no treating doctor at all (or a non-doctor party) refuses the save", async () => {
    const orphan = await newVisit(patient, null);
    expect(await save(orphan, { stage: "review" })).toEqual({ ok: false, reason: "no_treating_doctor" });
    const viaSupplier = await newVisit(patient, supplier);
    expect(await save(viaSupplier, { stage: "review" }, { actorPartyId: supplier })).toEqual({ ok: false, reason: "no_treating_doctor" });
  });

  it("isolation: another patient's visit or patient id cannot touch this treatment", async () => {
    const foreignVisit = await newVisit(other, doctor1);
    expect(await save(foreignVisit, { stage: "review" })).toEqual({ ok: false, reason: "wrong_patient" });
    expect(await endo.saveEndoVisit({ ...actor, patientId: other, treatmentId, visitId: v1, draft: draftOf({ stage: "review" }), expectedVersion: null, actorPartyId: null }))
      .toEqual({ ok: false, reason: "not_found" });
    expect(await save(999999, { stage: "review" })).toEqual({ ok: false, reason: "visit_not_found" });
  });

  it("retry / idempotency and concurrent edits", async () => {
    const v = await newVisit(patient, doctor1);
    const body = { stage: "review", note: "مراجعة", canals: [{ label: "MB" }] };
    const first = await save(v, body);
    expect(first).toMatchObject({ ok: true, created: true });
    const retry = await save(v, body); // lost response, same content
    expect(retry).toMatchObject({ ok: true, created: false, unchanged: true });
    expect(await q(`SELECT 1 FROM endo_visits WHERE visit_id = $1`, [v])).toHaveLength(1);
    expect(await save(v, { ...body, note: "مختلف" })).toEqual({ ok: false, reason: "exists" });

    // concurrent updates from the same loaded version: exactly one wins
    const results = await Promise.all([
      save(v, { ...body, note: "من أ" }, { expectedVersion: 1 }),
      save(v, { ...body, note: "من ب" }, { expectedVersion: 1 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(["version_conflict"]);
    expect(await save(v, { ...body, note: "قديم" }, { expectedVersion: 1 })).toEqual({ ok: false, reason: "version_conflict" });
    const [row] = await q<{ version: number; note: string }>(`SELECT version, note FROM endo_visits WHERE visit_id = $1`, [v]);
    expect(row.version).toBe(2);
    expect(["من أ", "من ب"]).toContain(row.note);
    // a create with a stale expectedVersion is also a conflict, never a silent create
    const fresh = await newVisit(patient, doctor1);
    expect(await save(fresh, { stage: "review" }, { expectedVersion: 3 })).toEqual({ ok: false, reason: "version_conflict" });
    const saved = await audits("endo.visit_save");
    expect(saved.length).toBeGreaterThanOrEqual(5);
    expect(saved.some((a) => "الحقول_المعدّلة" in a.details)).toBe(true);
  });

  it("completion needs signed visits, obturation and a restoration", async () => {
    expect(await endo.changeEndoStatus({ ...actor, patientId: patient, treatmentId, status: "completed", outcome: null }))
      .toEqual({ ok: false, reason: "unsigned_visit" });
    for (const row of await q<{ visit_id: number }>(`SELECT visit_id FROM endo_visits WHERE treatment_id = $1`, [treatmentId])) await sign(row.visit_id);
    expect(await endo.changeEndoStatus({ ...actor, patientId: other, treatmentId, status: "completed", outcome: null }))
      .toEqual({ ok: false, reason: "not_found" });
  });

  it("signed history is immutable: saves are refused, addenda append (and only on signed records)", async () => {
    expect(await save(v1, { stage: "assessment", note: "تعديل صامت" }, { expectedVersion: 1 })).toEqual({ ok: false, reason: "visit_signed" });
    const [{ id: endoVisitId, note }] = await q<{ id: number; note: string | null }>(`SELECT id, note FROM endo_visits WHERE visit_id = $1`, [v1]);
    expect(note).toBeNull();

    const added = await endo.addEndoAddendum({ ...actor, requestKey: "workflow:addendum-key", patientId: patient, treatmentId, endoVisitId, text: "تصحيح: الألم ليس ليليًا" });
    expect(added.ok).toBe(true);
    if (added.ok) {
      const visit = added.treatment.visits.find((v) => v.id === endoVisitId)!;
      expect(visit.addenda).toHaveLength(1);
      expect(visit.addenda[0]).toMatchObject({ body: "تصحيح: الألم ليس ليليًا", author: "dr.ahmad" });
      expect(visit.pulpalDiagnosis).toBe("symptomatic_irreversible_pulpitis"); // original untouched
    }
    expect(await endo.addEndoAddendum({ ...actor, requestKey: "workflow:addendum-key", patientId: other, treatmentId, endoVisitId, text: "x" })).toEqual({ ok: false, reason: "not_found" });

    const open = await newVisit(patient, doctor1);
    const openRecord = await save(open, { stage: "review" });
    expect(openRecord.ok).toBe(true);
    const [{ id: openId }] = await q<{ id: number }>(`SELECT id FROM endo_visits WHERE visit_id = $1`, [open]);
    expect(await endo.addEndoAddendum({ ...actor, requestKey: "workflow:addendum-key", patientId: patient, treatmentId, endoVisitId: openId, text: "x" })).toEqual({ ok: false, reason: "not_signed" });
    await sign(open);
    expect((await audits("endo.addendum"))).toHaveLength(1);
  });

  it("crown dependency uses the plan's dependency machinery and is evaluated from the plan item", async () => {
    const plan = (await q<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status) VALUES ($1, 'خطة', 200000, 'YER', 'active') RETURNING id`, [patient]))[0].id;
    const item = async (name: string, tooth: number) => (await q<{ id: number }>(
      `INSERT INTO plan_items (plan_id, service_name, tooth_code, category, case_id, quantity, unit_price_minor) VALUES ($1, $2, $3, $4, $5, 1, 100000) RETURNING id`, [plan, name, tooth, name === "علاج عصب" ? "rct" : "crown", caseId]))[0].id;
    const rct = await item("علاج عصب", 36);
    const crown = await item("تاج", 36);
    const wrongTooth = await item("تاج", 46);
    const otherPlan = (await q<{ id: number }>(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status) VALUES ($1, 'x', 1, 'YER', 'active') RETURNING id`, [other]))[0].id;
    const foreign = (await q<{ id: number }>(`INSERT INTO plan_items (plan_id, service_name, tooth_code, quantity, unit_price_minor) VALUES ($1, 'تاج', 36, 1, 1) RETURNING id`, [otherPlan]))[0].id;

    const base = { ...actor, patientId: patient, treatmentId, crownRequired: true, rctPlanItemId: rct };
    expect(await endo.setEndoCrown({ ...base, crownPlanItemId: wrongTooth })).toEqual({ ok: false, reason: "bad_item" });
    expect(await endo.setEndoCrown({ ...base, crownPlanItemId: foreign })).toEqual({ ok: false, reason: "bad_item" });
    expect(await endo.setEndoCrown({ ...base, patientId: other, crownPlanItemId: crown })).toEqual({ ok: false, reason: "not_found" });

    const done = await endo.setEndoCrown({ ...base, crownPlanItemId: crown });
    expect(done.ok).toBe(true);
    const deps = await q(`SELECT item_id, requires_item_id, requirement FROM plan_item_dependencies WHERE item_id = $1`, [crown]);
    expect(deps).toEqual([{ item_id: crown, requires_item_id: rct, requirement: "completed" }]);
    // repeating is harmless (the dependency already exists)
    expect((await endo.setEndoCrown({ ...base, crownPlanItemId: crown })).ok).toBe(true);
    expect(await q(`SELECT 1 FROM plan_item_dependencies WHERE item_id = $1`, [crown])).toHaveLength(1);
    if (done.ok) expect(done.treatment.crown).toBe("waiting_rct");

    // complete the episode → the crown becomes "ready"
    const completed = await endo.changeEndoStatus({ ...actor, patientId: patient, treatmentId, status: "completed", outcome: null });
    expect(completed.ok).toBe(true);
    if (completed.ok) expect(completed.treatment.crown).toBe("ready");
    // the plan item being done is the source of truth for the crown
    await q(`UPDATE plan_items SET status = 'done' WHERE id = $1`, [crown]);
    expect((await endo.listPatientEndo(patient)).find((t) => t.id === treatmentId)!.crown).toBe("planned_done");
    expect((await audits("endo.crown")).length).toBe(1); // an unchanged retry writes no second decision audit
  });

  it("a finished episode accepts no new records and never reopens; the tooth can start a retreatment", async () => {
    const v = await newVisit(patient, doctor1);
    expect(await save(v, { stage: "review" })).toEqual({ ok: false, reason: "closed" });
    expect(await endo.changeEndoStatus({ ...actor, patientId: patient, treatmentId, status: "abandoned", outcome: "x" }))
      .toEqual({ ok: false, reason: "invalid_transition" });
    const again = await endo.openEndoTreatment({ ...actor, patientId: patient, caseId, toothCode: 36, kind: "retreatment" });
    expect(again.ok).toBe(true);
    expect((await audits("endo.status")).length).toBe(1);
  });
});

describe("completion preconditions", () => {
  it("cannot complete without canals/obturation/restoration; abandoning needs the reason in the database too", async () => {
    const case17 = (await q<{ id: number }>(`INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by)
      VALUES($1,'endodontics','SYNTHETIC 17','17','synthetic') RETURNING id`, [patient]))[0].id;
    const t = await endo.openEndoTreatment({ ...actor, patientId: patient, caseId: case17, toothCode: 17, kind: "initial" });
    if (!t.ok) throw new Error("open failed");
    const v = await newVisit(patient, doctor1);
    await endo.saveEndoVisit({ ...actor, patientId: patient, treatmentId: t.treatment.id, visitId: v, draft: draftOf({ stage: "assessment", canals: [{ label: "MB" }] }), expectedVersion: null, actorPartyId: null });
    await sign(v);
    const refused = await endo.changeEndoStatus({ ...actor, patientId: patient, treatmentId: t.treatment.id, status: "completed", outcome: null });
    expect(refused).toMatchObject({ ok: false, reason: "not_ready" });
    await expect(getPool().query(`UPDATE endo_treatments SET status = 'abandoned', completed_at = NOW() WHERE id = $1`, [t.treatment.id])).rejects.toBeDefined();
    expect((await endo.changeEndoStatus({ ...actor, patientId: patient, treatmentId: t.treatment.id, status: "abandoned", outcome: "المريض لم يعد" })).ok).toBe(true);
  });
});
