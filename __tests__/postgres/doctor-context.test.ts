import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P0-E) زيارة اليوم لا تُفتح بسياقٍ فارغ: آخر تشخيصٍ موثَّق، والحالات الجارية بخطوتها التالية،
 * وتاريخ الزيارة السابقة بيوم العيادة (لا يوم UTC) — على PostgreSQL 18.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, addVisit, getClinicalVisit, createClinicalCase, createPlanV2, setPlanItemCase,
} = db;
const { SPECIALTIES } = await import("../../lib/appointment-services");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctorId = 0;
let rctId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctorId = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. العصب') RETURNING id`))[0].id;
  rctId = (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('علاج عصب', 60000, TRUE, TRUE, 'rct') RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(P0-E) the doctor opens today's visit with context", () => {
  it("shows the latest diagnosis, the active case's progress and next step, and the clinic-day date", async () => {
    const patientId = (await q<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('CTX-1', 'مريض سياق') RETURNING id`))[0].id;

    /* زيارة سابقة موقّعة وصلت ٠٠:٣٠ بتوقيت العيادة (٢١:٣٠ UTC من اليوم السابق). */
    const previous = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId, doctorId });
    await q(`UPDATE visits SET diagnosis = 'التهاب لب غير عكوس 36', treatment_done = 'فتح وتنظيف',
               arrived_at = '2026-09-14 21:30:00+00', signed_at = '2026-09-14 22:00:00+00', status = 'done' WHERE id = $1`, [previous.id]);

    const specialty = SPECIALTIES.includes("endodontics") ? "endodontics" : SPECIALTIES[0];
    const created = await createClinicalCase({
      patientId, specialty, title: "علاج عصب 36", site: "36", problem: "ألم ليلي", responsiblePartyId: doctorId,
      orthoCaseId: null, actor: "doctor",
    });
    if (!created.ok) throw new Error(created.reason);
    const plan = await createPlanV2({
      patientId, title: "خطة العصب", specialty: null, primaryDoctorId: doctorId, billingMode: "per_procedure",
      baseCurrency: "YER", startDate: "2026-09-15", note: null, createdBy: "doctor",
      items: [
        { serviceId: rctId, serviceName: "علاج عصب", category: "rct", toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: 60000, billingRule: "per_session", sessionCount: 3, note: null },
        { serviceId: rctId, serviceName: "علاج عصب", category: "rct", toothCode: 37, surfaces: null, quantity: 1, unitPriceMinor: 60000, billingRule: "per_session", sessionCount: 3, note: null },
      ],
      installments: [],
    });
    if (!plan.ok) throw new Error(plan.message);
    const items = await q<{ id: number; tooth_code: number }>(`SELECT id, tooth_code FROM plan_items WHERE plan_id = $1 ORDER BY id`, [plan.planId]);
    for (const item of items) {
      expect((await setPlanItemCase({ itemId: item.id, caseId: created.case.id, priority: null, actor: "doctor" })).ok).toBe(true);
    }
    await q(`UPDATE plan_items SET status = 'done' WHERE id = $1`, [items[1].id]);

    const today = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId, doctorId });
    const visit = await getClinicalVisit(today.id);
    expect(visit?.previousVisit).toMatchObject({ id: previous.id, date: "2026-09-15", diagnosis: "التهاب لب غير عكوس 36" });
    expect(visit?.latestDiagnosis).toEqual({ text: "التهاب لب غير عكوس 36", date: "2026-09-15" });
    expect(visit?.activeCases).toEqual([expect.objectContaining({
      title: "علاج عصب 36", status: "active", doneSteps: 1, totalSteps: 2, nextStep: "علاج عصب — سن 36",
    })]);
  });

  it("a new patient has an empty context, not an error", async () => {
    const patientId = (await q<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('CTX-2', 'مريض جديد') RETURNING id`))[0].id;
    const visit = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId, doctorId });
    const loaded = await getClinicalVisit(visit.id);
    expect(loaded).toMatchObject({ previousVisit: null, latestDiagnosis: null, activeCases: [] });
  });
});
