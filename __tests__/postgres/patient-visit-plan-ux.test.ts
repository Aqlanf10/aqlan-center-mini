import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P1–P6) رحلة المريض → الخطة → الزيارة على PostgreSQL 18:
 * سجل الاستمارات الإضافي، ومعاينة الاستحقاق بقرار التوقيع نفسه (صفرٌ من القواعد لا من زر)،
 * والمواد التلقائية واليدوية من سجل حركات المخزون نفسه.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, createPlanV2, recordPlanConsent,
  addVisit, setVisitProcedures, signClinicalVisit, previewVisitBilling, recordAdjustment, recordPayment,
  createIntakeForm, listIntakeForms, createInventoryMovement, visitMaterialMovements, AUTO_MATERIAL_REASON_PREFIX,
} = db;
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctorId = 0;
let orthoServiceId = 0;
let fillingId = 0;
let seq = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  doctorId = (await q<{ id: number }>(
    `INSERT INTO parties (kind, name, commission_percent) VALUES ('doctor', 'د. الرحلة', 30) RETURNING id`))[0].id;
  orthoServiceId = (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category)
     VALUES ('تقويم ثابت', 300000, TRUE, TRUE, 'ortho') RETURNING id`))[0].id;
  fillingId = (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category)
     VALUES ('حشوة', 25000, TRUE, TRUE, 'filling') RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function patient(name: string): Promise<number> {
  seq += 1;
  return (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`UX-${seq}`, name]))[0].id;
}

async function visitWith(patientId: number, lines: { serviceId: number; planItemId: number | null; priceMinor: number }[]) {
  const visit = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId, doctorId });
  await q(`UPDATE visits SET diagnosis = 'متابعة' WHERE id = $1`, [visit.id]);
  if (lines.length > 0) {
    await setVisitProcedures({
      visitId: visit.id,
      procedures: lines.map((line) => ({
        serviceId: line.serviceId, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: line.priceMinor,
        priceReason: null, doctorId, note: null, planItemId: line.planItemId,
      })),
    });
  }
  return visit.id;
}

async function agreementPlan(patientId: number) {
  const created = await createPlanV2({
    patientId, title: "عقد تقويم سريع", specialty: "تقويم", primaryDoctorId: doctorId, billingMode: "installments",
    baseCurrency: "YER", startDate: today, note: null, createdBy: "reception",
    items: [{ serviceId: orthoServiceId, serviceName: "تقويم ثابت", category: "ortho", toothCode: null, surfaces: null,
      quantity: 1, unitPriceMinor: 300000, billingRule: "per_session", sessionCount: 3, note: null }],
    installments: [{ dueDate: today, amountMinor: 150000 }, { dueDate: today, amountMinor: 150000 }],
  });
  if (!created.ok) throw new Error(created.message);
  const consent = await recordPlanConsent({ planId: created.planId, actor: "admin", note: null });
  if (!consent.ok) throw new Error(consent.message);
  const [item] = await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [created.planId]);
  return { planId: created.planId, itemId: item.id };
}

describe("(P1) intake history is append-only", () => {
  it("lists newest first; a staff update is a NEW row and the earlier form is untouched", async () => {
    const p = await patient("استمارة");
    const first = await createIntakeForm(p, {
      conditions: ["diabetes"], allergies: "بنسلين", medications: null, emergencyName: null, emergencyPhone: null, note: null,
    });
    const [before] = await q<{ answers: unknown; created_at: Date }>(`SELECT answers, created_at FROM patient_intake_forms WHERE id = $1`, [first.id]);
    const second = await createIntakeForm(p, {
      conditions: [], allergies: "بنسلين", medications: "ميتفورمين", emergencyName: "أخوه", emergencyPhone: "777123456", note: "تحديث",
    }, { actor: "reception1", actorRole: "reception" });

    const history = await listIntakeForms(p);
    expect(history.map((form) => form.id)).toEqual([second.id, first.id]);
    expect(history[0]).toMatchObject({ recordedBy: "reception1", answers: { medications: "ميتفورمين" } });
    expect(history[1]).toMatchObject({ recordedBy: null, answers: { conditions: ["diabetes"], medications: null } });
    const [after] = await q<{ answers: unknown; created_at: Date }>(`SELECT answers, created_at FROM patient_intake_forms WHERE id = $1`, [first.id]);
    expect(after).toEqual(before);
    expect(await q(`SELECT action, actor FROM audit_log WHERE action = 'intake.staff' AND entity_id = $1`, [String(p)]))
      .toEqual([{ action: "intake.staff", actor: "reception1" }]);
  });
});

describe("(P6) billing preview = the sign decision", () => {
  it("an installment-funded session previews 0 with the agreement reason, and signs with 0 and no invoice", async () => {
    const p = await patient("اتفاق");
    const { itemId } = await agreementPlan(p);
    const visitId = await visitWith(p, [{ serviceId: orthoServiceId, planItemId: itemId, priceMinor: 100000 }]);

    const preview = await previewVisitBilling(visitId);
    expect(preview?.lines.map((line) => line.classification)).toEqual(["INCLUDED"]);
    expect(preview?.duesByCurrency).toEqual({});
    expect(preview?.zeroReason).toBe("مشمولة ضمن اتفاق الأقساط");

    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0 });
  });

  it("a free billable procedure previews exactly what the sign invoices", async () => {
    const p = await patient("حشوة");
    const visitId = await visitWith(p, [{ serviceId: fillingId, planItemId: null, priceMinor: 25000 }]);
    const preview = await previewVisitBilling(visitId);
    expect(preview).toMatchObject({ duesByCurrency: { YER: 25000 }, mixedCurrencies: false, zeroReason: null });
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed.duesMinor).toBe(preview?.duesByCurrency.YER);
    expect(signed.invoiceId).not.toBeNull();
  });

  it("a per-session plan without installments stays billable (the agreement rule does not leak)", async () => {
    const p = await patient("بلا أقساط");
    const created = await createPlanV2({
      patientId: p, title: "خطة جلسات", specialty: null, primaryDoctorId: doctorId, billingMode: "per_procedure",
      baseCurrency: "YER", startDate: today, note: null, createdBy: "reception",
      items: [{ serviceId: orthoServiceId, serviceName: "تقويم ثابت", category: "ortho", toothCode: null, surfaces: null,
        quantity: 1, unitPriceMinor: 300000, billingRule: "per_session", sessionCount: 3, note: null }],
      installments: [],
    });
    if (!created.ok) throw new Error(created.message);
    await recordPlanConsent({ planId: created.planId, actor: "admin", note: null });
    const [item] = await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [created.planId]);
    const visitId = await visitWith(p, [{ serviceId: orthoServiceId, planItemId: item.id, priceMinor: 0 }]);
    const preview = await previewVisitBilling(visitId);
    expect(preview?.lines[0]).toMatchObject({ classification: "NEW_BILLABLE", amountMinor: 100000, planLinked: true });
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed.duesMinor).toBe(100000);
  });

  it("a legacy orthodontic adjustment covered by the opening balance previews 0 with the legacy reason", async () => {
    const p = await patient("تقويم سابق");
    const caseId = (await q<{ id: number }>(
      `INSERT INTO ortho_cases (patient_id, created_by, baseline_kind, baseline_recorded_at, legacy_financial_mode,
                                responsible_doctor_id, upper_wire, lower_wire)
       VALUES ($1, 'migration', 'legacy', NOW(), 'opening_balance', $2, '016 NiTi', '016 NiTi') RETURNING id`,
      [p, doctorId]))[0].id;
    await q(`INSERT INTO patient_opening_balances (patient_id, currency, amount_minor, as_of_date, created_by)
             VALUES ($1, 'YER', 350000, $2::date, 'migration')`, [p, today]);
    const paid = await recordPayment({
      patientId: p, invoiceId: null, openingCurrency: "YER", kind: "payment", amountMinor: 30000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
    });
    expect(paid.reason).toBeNull();
    const visitId = await visitWith(p, []);
    const saved = await recordAdjustment({
      caseId, visitId: null, doneOn: today, phase: null, upperWire: "017×025 NiTi", lowerWire: null,
      elastics: "none", elasticNote: null, done: "شدّة دورية", nextWeeks: 4, note: null,
      recordedBy: "doctor", actorRole: "doctor",
    });
    if (!saved.ok) throw new Error(saved.message);
    const preview = await previewVisitBilling(visitId);
    expect(preview).toMatchObject({ orthoAdjustment: "LEGACY_INCLUDED", duesByCurrency: {}, zeroReason: "شدّة تقويم مشمولة بالعلاج السابق" });
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0 });
  });

  it("the preview writes nothing", async () => {
    const p = await patient("قراءة فقط");
    const visitId = await visitWith(p, [{ serviceId: fillingId, planItemId: null, priceMinor: 25000 }]);
    const snapshot = async () => q(`SELECT
      (SELECT count(*) FROM invoices)::int AS invoices, (SELECT count(*) FROM treatment_sessions)::int AS sessions,
      (SELECT count(*) FROM audit_log)::int AS audit, (SELECT signed_at FROM visits WHERE id = $1) AS signed`, [visitId]);
    const before = await snapshot();
    await previewVisitBilling(visitId);
    expect(await snapshot()).toEqual(before);
  });
});

describe("(P4) visit materials: automatic vs manual from the same movement log", () => {
  it("a manual out-movement on the visit is listed as manual; the sign's automatic deduction as auto", async () => {
    const p = await patient("مواد");
    const itemId = (await q<{ id: number }>(
      `INSERT INTO inventory_items (name, category, unit, min_level, created_by) VALUES ('كمبوزيت', 'filling', 'سرنجة', 0, 't') RETURNING id`))[0].id;
    expect((await createInventoryMovement({ itemId, kind: "in", qty: 5, createdBy: "admin" })).ok).toBe(true);
    await q(`INSERT INTO service_materials (service_id, item_id, qty_per_unit, created_by) VALUES ($1, $2, 1, 'admin')`, [fillingId, itemId]);
    const visitId = await visitWith(p, [{ serviceId: fillingId, planItemId: null, priceMinor: 25000 }]);

    const manual = await createInventoryMovement({
      itemId, kind: "out", qty: 2, reason: "استهلاك إضافي في الزيارة", visitId, patientId: p, createdBy: "doctor",
    });
    expect(manual.ok).toBe(true);
    const short = await createInventoryMovement({ itemId, kind: "out", qty: 10, reason: "x", visitId, patientId: p, createdBy: "doctor" });
    expect(short.ok).toBe(false);

    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed.reason).toBeNull();
    expect(signed.materialsDeducted).toBe(1);

    const lines = await visitMaterialMovements(visitId);
    expect(lines.map((line) => [line.source, line.qty])).toEqual([["manual", 2], ["auto", 1]]);
    expect(lines[1].reason?.startsWith(AUTO_MATERIAL_REASON_PREFIX)).toBe(true);
    const [{ balance }] = await q<{ balance: string }>(
      `SELECT SUM(CASE kind WHEN 'in' THEN qty WHEN 'out' THEN -qty ELSE qty END)::text AS balance
         FROM inventory_movements WHERE item_id = $1`, [itemId]);
    expect(Number(balance)).toBe(2);
  });
});
