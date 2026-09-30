import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (REF-2) الإحالة الداخلية بعد الحجز — على PostgreSQL 18:
 * الوصول يفتح سياق الحالة، سقوط الموعد يعيدها لانتظار الحجز، التوقيع يُقدّمها، والعائق يُقرأ —
 * ثم رحلة القبول «محمد أحمد» كاملةً مع المال: سجلٌّ واحد، وعمولة طبيب العصب على عمله وحده.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, createInternalReferral, transitionInternalReferral, getReferral,
  arriveAppointment, closeBookedAppointment, deleteAppointment, addVisit, setVisitProcedures, signClinicalVisit,
  commissionReport, patientWorkflow, patientTimeline, listPatientCases, myClinicalWork, createClinicalCase,
  createPlanV2, addPlanItemDependency, CLINIC_TIME_ZONE,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let orthodontist = 0;
let endodontist = 0;
let endoServiceId = 0;
let crownServiceId = 0;

type Action = "accept" | "decline" | "schedule" | "complete" | "acknowledge" | "cancel";
const step = (id: number, action: Action, extra: Partial<{ note: string; appointmentId: number; procedurePerformed: string }> = {}, actor = "dr-mohammed") =>
  transitionInternalReferral({
    id, action, note: extra.note ?? null, appointmentId: extra.appointmentId ?? null,
    procedurePerformed: extra.procedurePerformed ?? null, followupRequired: null, mayReturn: null, actor, actorRole: "doctor",
  });

async function patient(number: string, name = "محمد أحمد"): Promise<number> {
  return (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [number, name, orthodontist]))[0].id;
}

async function referral(patientId: number, extra: Partial<{ caseId: number; blocksCaseId: number; planItemId: number }> = {}) {
  const created = await createInternalReferral({
    patientId, doctorPartyId: orthodontist, toPartyId: endodontist, toSpecialty: "endodontics",
    reason: "علاج عصب 21 قبل تركيب الحاصرة", teeth: "21", urgency: "soon",
    caseId: extra.caseId ?? null, blocksCaseId: extra.blocksCaseId ?? null, planItemId: extra.planItemId ?? null,
    requestedServiceId: endoServiceId, actor: "dr-aqlan", actorRole: "doctor",
  });
  if (!created.ok) throw new Error(created.reason);
  return created.referral.id;
}

/** موعدٌ اليوم (بتاريخ العيادة) مع طبيب العصب. */
async function appointmentToday(patientId: number, time = "10:00"): Promise<number> {
  return (await q<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, doctor_id)
     VALUES ($1, (NOW() AT TIME ZONE $2)::date, $3, $4) RETURNING id`,
    [patientId, CLINIC_TIME_ZONE, time, endodontist]))[0].id;
}

const auditOf = async (patientId: number) => (await q<{ action: string }>(
  `SELECT action FROM audit_log WHERE entity = 'patient' AND entity_id = $1 AND action LIKE 'referral.%' ORDER BY id`,
  [String(patientId)])).map((row) => row.action);

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const doctor = async (name: string) => (await q<{ id: number }>(
    `INSERT INTO parties (kind, name, commission_percent) VALUES ('doctor', $1, 10) RETURNING id`, [name]))[0].id;
  orthodontist = await doctor("د. عقلان");
  endodontist = await doctor("د. محمد");
  const service = async (name: string, category: string) => (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 50000, TRUE, TRUE, $2) RETURNING id`,
    [name, category]))[0].id;
  endoServiceId = await service("علاج عصب", "endo");
  crownServiceId = await service("تاج زيركون", "crown");
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(REF-2) appointment outcomes on a scheduled referral", () => {
  it("no-show returns it to accepted, shows «لم يحضر», is audited; reception rebooks it", async () => {
    const p = await patient("P-R2-NS");
    const id = await referral(p);
    await step(id, "accept");
    const first = await appointmentToday(p);
    expect(await step(id, "schedule", { appointmentId: first }, "reception")).toMatchObject({ ok: true });
    expect(await closeBookedAppointment(first, "no_show", { actor: "reception", actorRole: "reception" })).toBe(true);
    expect(await getReferral(id)).toMatchObject({ workflowState: "accepted", missedAppointment: "no_show", appointmentId: null });
    const later = (await q<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, doctor_id) VALUES ($1, CURRENT_DATE + 7, '09:00', $2) RETURNING id`,
      [p, endodontist]))[0].id;
    expect(await step(id, "schedule", { appointmentId: later }, "reception")).toMatchObject({
      ok: true, referral: { workflowState: "scheduled", missedAppointment: null, appointmentId: later },
    });
    expect(await auditOf(p)).toEqual(["referral.create", "referral.accept", "referral.schedule", "referral.unschedule", "referral.schedule"]);
  });

  it("cancel (and delete) of the appointment returns it; booked before acceptance → back to requested", async () => {
    const p = await patient("P-R2-CX");
    const id = await referral(p);
    const booked = await appointmentToday(p);
    await step(id, "schedule", { appointmentId: booked }, "reception");
    expect(await closeBookedAppointment(booked, "cancelled", { actor: "reception", reason: "طلب المريض" })).toBe(true);
    expect(await getReferral(id)).toMatchObject({ workflowState: "requested", missedAppointment: "cancelled" });

    await step(id, "accept");
    const again = await appointmentToday(p, "11:00");
    await step(id, "schedule", { appointmentId: again }, "reception");
    expect(await deleteAppointment(again, { actor: "reception", actorRole: "reception", reason: "خطأ إدخال" })).toMatchObject({ ok: true });
    expect(await getReferral(id)).toMatchObject({ workflowState: "accepted" });
    const [last] = await q<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'referral.unschedule' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [String(p)]);
    expect(last.details).toMatchObject({ الإحالة: id, من: "scheduled", إلى: "accepted" });
  });
});

describe("(REF-2) arrival and sign-off progress", () => {
  it("arrival moves scheduled → arrived and the opened visit carries the referral's case", async () => {
    const p = await patient("P-R2-AR");
    const endoCase = await createClinicalCase({
      patientId: p, specialty: "endodontics", title: "علاج جذور 21", site: "21", problem: null,
      responsiblePartyId: endodontist, orthoCaseId: null, actor: "dr-aqlan",
    });
    if (!endoCase.ok) throw new Error(endoCase.reason);
    const id = await referral(p, { caseId: endoCase.case.id! });
    await step(id, "accept");
    const appointment = await appointmentToday(p);
    await step(id, "schedule", { appointmentId: appointment }, "reception");
    expect(await arriveAppointment(appointment, { actor: "reception", actorRole: "reception" })).toBe(true);
    expect(await getReferral(id)).toMatchObject({ workflowState: "arrived" });
    const [visit] = await q<{ id: number; case_id: number | null; doctor_id: number | null }>(
      `SELECT id, case_id, doctor_id FROM visits WHERE appointment_id = $1`, [appointment]);
    expect(visit).toMatchObject({ case_id: endoCase.case.id, doctor_id: endodontist });

    /* المستقبِل يوقّع زيارة الإحالة (بلا بند خطة): الحالة نفسها + الموقِّع هو المستقبِل → «قيد العلاج». */
    await q(`UPDATE visits SET diagnosis = 'فحص' WHERE id = $1`, [visit.id]);
    await setVisitProcedures({
      visitId: visit.id,
      procedures: [{ serviceId: endoServiceId, toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 50000, priceReason: null, doctorId: endodontist, note: null, planItemId: null }],
    });
    const signed = await signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "dr-mohammed", signerDoctorPartyId: endodontist });
    expect(signed.reason).toBeNull();
    expect(await getReferral(id)).toMatchObject({ workflowState: "in_progress" });
    expect((await auditOf(p)).filter((action) => action === "referral.progress")).toHaveLength(1);
  });

  it("a visit in the referral's case signed only by another doctor does not progress it", async () => {
    const p = await patient("P-R2-OD");
    const endoCase = await createClinicalCase({
      patientId: p, specialty: "endodontics", title: "علاج جذور 11", site: "11", problem: null,
      responsiblePartyId: endodontist, orthoCaseId: null, actor: "dr-aqlan",
    });
    if (!endoCase.ok) throw new Error(endoCase.reason);
    const id = await referral(p, { caseId: endoCase.case.id! });
    await step(id, "accept");
    const visit = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId: p });
    await q(`UPDATE visits SET doctor_id = $2, diagnosis = 'فحص', case_id = $3 WHERE id = $1`, [visit.id, orthodontist, endoCase.case.id]);
    await setVisitProcedures({
      visitId: visit.id,
      procedures: [{ serviceId: endoServiceId, toothCode: 11, surfaces: null, quantity: 1, unitPriceMinor: 50000, priceReason: null, doctorId: orthodontist, note: null, planItemId: null }],
    });
    expect((await signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "dr-aqlan", signerDoctorPartyId: orthodontist })).reason).toBeNull();
    expect(await getReferral(id)).toMatchObject({ workflowState: "accepted" });
  });
});

describe("(REF-2) acceptance journey «محمد أحمد»", () => {
  it("ortho case → internal referral blocking it → schedule → arrive → sign root canal → complete → acknowledge", async () => {
    const p = await patient("P-R2-MA");
    const ortho = await createClinicalCase({
      patientId: p, specialty: "orthodontics", title: "تقويم ثابت", site: null, problem: null,
      responsiblePartyId: orthodontist, orthoCaseId: null, actor: "dr-aqlan",
    });
    const endo = await createClinicalCase({
      patientId: p, specialty: "endodontics", title: "علاج جذور 21", site: "21", problem: null,
      responsiblePartyId: endodontist, orthoCaseId: null, actor: "dr-aqlan",
    });
    if (!ortho.ok || !endo.ok) throw new Error("case");
    const orthoCaseId = ortho.case.id!;
    const endoCaseId = endo.case.id!;

    /* الخطة الشاملة: عصب 21 (د. محمد) ثم تاج 21 يتطلب اكتماله. */
    const plan = await createPlanV2({
      patientId: p, title: "الخطة الشاملة", specialty: null, primaryDoctorId: orthodontist, billingMode: "per_procedure",
      baseCurrency: "YER", startDate: "2026-09-01", note: null, createdBy: "admin",
      items: [
        { serviceId: endoServiceId, serviceName: "علاج عصب", category: "endo", toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 50000, billingRule: "on_completion", sessionCount: 1, note: null },
        { serviceId: crownServiceId, serviceName: "تاج زيركون", category: "crown", toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 90000, billingRule: "on_completion", sessionCount: 1, note: null },
      ],
      installments: [],
    });
    if (!plan.ok) throw new Error(plan.message);
    await q(`UPDATE treatment_plans SET consent_at = NOW() WHERE id = $1`, [plan.planId]);
    const [endoItem, crownItem] = (await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1 ORDER BY id`, [plan.planId])).map((row) => row.id);
    await q(`UPDATE plan_items SET doctor_id = $2, case_id = $3 WHERE id = $1`, [endoItem, endodontist, endoCaseId]);
    const dependency = await addPlanItemDependency({ itemId: crownItem, requiresItemId: endoItem, requirement: "completed", note: null, actor: "admin" });
    if (!dependency.ok) throw new Error(dependency.reason);

    // 2) Dr Aqlan refers to Dr Mohammed; the ortho case waits on it.
    const id = await referral(p, { caseId: endoCaseId, blocksCaseId: orthoCaseId, planItemId: endoItem });
    const summaryBefore = await patientWorkflow(p, "2026-09-30");
    expect(summaryBefore?.alerts.filter((alert) => alert.kind === "referral_blocker").map((alert) => alert.text))
      .toEqual([`حالة «تقويم ثابت» بانتظار: علاج الجذور (العصب) — الأسنان 21 (إحالة #${id} إلى د. محمد)`]);
    expect((await listPatientCases(p)).find((one) => one.id === orthoCaseId)?.waitingOn).toEqual([`علاج الجذور (العصب) — الأسنان 21 (إحالة #${id} إلى د. محمد)`]);

    // illegal before acceptance
    expect(await step(id, "complete", { procedurePerformed: "x" })).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await step(id, "accept")).toMatchObject({ ok: true });

    // 3) reception «حجز الإحالة»
    const appointment = await appointmentToday(p, "12:00");
    expect(await step(id, "schedule", { appointmentId: appointment }, "reception")).toMatchObject({ ok: true, referral: { workflowState: "scheduled" } });
    const work = await myClinicalWork(endodontist);
    expect(work.toMe.map((one) => one.id)).toContain(id);
    expect(work.today.find((one) => one.appointmentId === appointment)).toMatchObject({ referralId: id, referredBy: "د. عقلان" });

    // 4) arrival → the visit opens in the endodontic context
    expect(await arriveAppointment(appointment, { actor: "reception", actorRole: "reception" })).toBe(true);
    const [visit] = await q<{ id: number; case_id: number }>(`SELECT id, case_id FROM visits WHERE appointment_id = $1`, [appointment]);
    expect(visit.case_id).toBe(endoCaseId);
    expect(await getReferral(id)).toMatchObject({ workflowState: "arrived" });

    // no invoice, no payment from the referral itself
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [p])).toEqual([]);

    // 5) Dr Mohammed signs the root canal on the referred plan item → in_progress
    await q(`UPDATE visits SET diagnosis = 'التهاب لب 21' WHERE id = $1`, [visit.id]);
    await setVisitProcedures({
      visitId: visit.id,
      procedures: [{ serviceId: endoServiceId, toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 50000, priceReason: null, doctorId: endodontist, note: null, planItemId: endoItem }],
    });
    const signed = await signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "dr-mohammed", signerDoctorPartyId: endodontist });
    expect(signed.reason).toBeNull();
    expect(await getReferral(id)).toMatchObject({ workflowState: "in_progress" });
    expect(await step(id, "accept")).toEqual({ ok: false, reason: "invalid_transition" });

    // 6) complete with an outcome; 7) Dr Aqlan acknowledges
    expect(await step(id, "complete", { procedurePerformed: "حشو قنوات 21", note: "جاهز للحاصرة" })).toMatchObject({
      ok: true, referral: { workflowState: "completed", status: "completed" },
    });
    expect((await myClinicalWork(orthodontist)).returnedToMe.map((one) => one.id)).toEqual([id]);
    expect(await step(id, "acknowledge", {}, "dr-aqlan")).toMatchObject({ ok: true, referral: { workflowState: "returned_to_referrer" } });
    expect(await step(id, "cancel", { note: "متأخر" }, "dr-aqlan")).toEqual({ ok: false, reason: "invalid_transition" });

    // 8) the ortho case is unblocked and the crown is ready (its requirement is met)
    const summaryAfter = await patientWorkflow(p, "2026-09-30");
    expect(summaryAfter?.alerts.filter((alert) => alert.kind === "referral_blocker" || alert.kind === "plan_blocked")).toEqual([]);
    expect((await listPatientCases(p)).find((one) => one.id === orthoCaseId)?.waitingOn).toBeUndefined();

    // money: one ledger — a single invoice for the patient, its work line on the endodontist only
    const invoices = await q<{ id: number; patient_id: number }>(`SELECT id, patient_id FROM invoices WHERE patient_id = $1`, [p]);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].id).toBe(signed.invoiceId);
    expect(await q(`SELECT doctor_id, service_id, total_minor::text FROM invoice_items WHERE invoice_id = $1`, [signed.invoiceId]))
      .toEqual([{ doctor_id: endodontist, service_id: endoServiceId, total_minor: "50000" }]);
    const report = await commissionReport("2000-01-01", "2099-12-31");
    const accrued = (doctorId: number) => report.filter((row) => row.doctorId === doctorId)
      .reduce((sum, row) => sum + row.accruedMinor, 0);
    expect(accrued(endodontist)).toBeGreaterThan(0);
    const orthoOnThisPatient = await q(
      `SELECT ii.id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.patient_id = $1 AND ii.doctor_id = $2`,
      [p, orthodontist]);
    expect(orthoOnThisPatient).toEqual([]);

    // every transition audited, in order
    expect(await auditOf(p)).toEqual([
      "referral.create", "referral.accept", "referral.schedule", "referral.arrive", "referral.progress",
      "referral.complete", "referral.return",
    ]);

    // the patient timeline tells the referral's story
    const timeline = await patientTimeline(p);
    const referralTitles = timeline.filter((event) => event.kind === "referral").map((event) => event.title);
    expect(referralTitles).toHaveLength(7);
    expect(referralTitles).toContain(`إحالة #${id} إلى د. محمد: اكتملت وعادت إلى المحيل`);
    expect(timeline.find((event) => event.title === `إحالة #${id} إلى د. محمد: طُلبت`)?.detail).toBe("علاج عصب 21 قبل تركيب الحاصرة");
  });
});
