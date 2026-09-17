import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات التصحيحات النهائية للمالك TD-05 (PR #44) — «الحافة الأخيرة».
 *
 *  **الاستنتاج ب (النهائي): العملة ملك البند لا الزيارة.**
 *  الحمولة السريرية كان تستنتج عملة كل السطور من عملةٍ واحدة على مستوى الزيارة
 *  (`visit.planCurrency`)، فزيارةٌ فارغة (بلا إجراءات مرتبطة) لا تعرف عملة بند
 *  الخطة الدولاري الذي يختاره الطبيب من «مخطَّط لليوم» — فيُنسَّق ١٥٠٠٠٠ وحدة
 *  صغرى دولارية على أنه ريال يمني «150,000». الآن كل بندٍ يحمل عملة خطته معه:
 *
 *   * `outstanding[].planCurrency` — عملة خطة ذلك البند بعينه (لا عملة الزيارة).
 *   * `procedures[].planCurrency` — عملة بند الخطة المرتبط بكل سطر إجراء؛
 *     `null` للسطر الحر (أساس المركز).
 *
 *  هذه الاختبارات تُثبت عقد الحمولة في طبقة الخدمة (lib/db.ts) — قبل الواجهة،
 *  وقبل أي رحلة متصفح: الصفحة لا تستطيع عرض عملةٍ لا تصلهاب أصلًا.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const sessionMock = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: sessionMock.requireSession }));

const {
  getPool, resetPoolForTesting, ensureSchema, createPlanV2, getClinicalVisit,
} = await import("../lib/db");

let patientId: number;
let serviceId: number;
/** خطة لكل عملة — كلٌّ ببندٍ واحد سعره ١٥٠٠٠٠ وحدة صغرى بعملتها. */
const planItemIds = new Map<string, number>();
let emptyVisitId: number;
let mixedVisitId: number;

beforeAll(async () => {
  await ensureSchema();
  const pool = getPool();
  const { rows: [patient] } = await pool.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('FINALRV-1', 'مريض التصحيحات النهائية') RETURNING id`,
  );
  patientId = patient.id;
  const { rows: [service] } = await pool.query(
    `INSERT INTO services (name, price_minor, is_active) VALUES ('تنظيف التصحيحات النهائية', 15000, TRUE) RETURNING id`,
  );
  serviceId = service.id;

  /* ثلاث خطط فعّالة بثلاث عملات — بندٌ واحد لكلٍّ منها. الملكية للبند. */
  for (const [title, currency] of [
    ["اتفاق دولاري — نهائية", "USD"],
    ["اتفاق سعودي — نهائية", "SAR"],
    ["خطة أساسية — نهائية", "YER"],
  ] as [string, "USD" | "SAR" | "YER"][]) {
    const plan = await createPlanV2({
      patientId, title, specialty: null, primaryDoctorId: null,
      billingMode: "per_procedure", baseCurrency: currency, startDate: "2026-01-01", note: null,
      items: [{
        serviceId, serviceName: "تنظيف التصحيحات النهائية", category: "cleaning",
        toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 150000,
        billingRule: "on_completion", sessionCount: 1, note: null,
      }],
      installments: [], createdBy: "finalrv",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(`تعذّر إنشاء الخطة «${title}»`);
    const { rows: [item] } = await pool.query<{ id: number }>(
      `SELECT id FROM plan_items WHERE plan_id = $1 ORDER BY id LIMIT 1`, [plan.planId],
    );
    planItemIds.set(currency, item.id);
  }

  /* زيارة فارغة — لا إجراءات فيها بعد: أقصى حالات «العملة المجهولة». */
  const { rows: [emptyVisit] } = await pool.query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, status) VALUES ($1, $2, 'seated') RETURNING id`,
    ["مريض التصحيحات النهائية", patientId],
  );
  emptyVisitId = emptyVisit.id;

  /* زيارة بسطورٍ مرتبطة من عملات اتفاق مختلفة + سطرٍ حر — كل سطر بعملته. */
  const { rows: [mixedVisit] } = await pool.query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, status) VALUES ($1, $2, 'seated') RETURNING id`,
    ["مريض التصحيحات النهائية", patientId],
  );
  mixedVisitId = mixedVisit.id;
  for (const currency of ["USD", "SAR"] as const) {
    await pool.query(
      `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
       VALUES ($1, $2, $3, 1, 150000)`,
      [mixedVisitId, serviceId, planItemIds.get(currency)],
    );
  }
  await pool.query(
    `INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, quantity, unit_price_minor)
     VALUES ($1, $2, NULL, 1, 15000)`,
    [mixedVisitId, serviceId],
  );
}, 60_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("التصحيحات النهائية: عملة كل بندٍ من الخطط في العلاج المتبقّي", () => {
  it("outstanding[].planCurrency — كل بند يحمل عملة خطته هو، لا عملة الزيارة", async () => {
    const visit = await getClinicalVisit(emptyVisitId);
    expect(visit).not.toBeNull();
    expect(visit?.outstanding.length).toBe(3);

    for (const currency of ["USD", "SAR", "YER"]) {
      const item = visit?.outstanding.find((row) => row.planItemId === planItemIds.get(currency));
      expect(item, `بند العملة ${currency} في العلاج المتبقّي`).toBeTruthy();
      expect(item?.planCurrency, `عملة بند ${currency}`).toBe(currency);
    }
  });

  it("زيارة فارغة تبقى بلا عملة مستنتَجة على مستوى الزيارة — والبنود تعرف عملاتها", async () => {
    /* لا إجراءات مرتبطة ⇒ لا عملة زيارة، وأول إجراءٍ يُضاف سيعرف عملته من بنده. */
    const visit = await getClinicalVisit(emptyVisitId);
    expect(visit?.planCurrency ?? null).toBeNull();
    expect(visit?.procedures.length).toBe(0);
  });
});

describe("التصحيحات النهائية: عملة كل سطر إجراء من بند خطته هو", () => {
  it("procedures[].planCurrency — المرتبط بعملة خطته، والحرّ null (أساس)", async () => {
    const visit = await getClinicalVisit(mixedVisitId);
    expect(visit).not.toBeNull();
    expect(visit?.procedures.length).toBe(3);

    const usdLine = visit?.procedures.find((line) => line.planItemId === planItemIds.get("USD"));
    const sarLine = visit?.procedures.find((line) => line.planItemId === planItemIds.get("SAR"));
    const freeLine = visit?.procedures.find((line) => line.planItemId === null);
    expect(usdLine?.planCurrency).toBe("USD");
    expect(sarLine?.planCurrency).toBe("SAR");
    expect(freeLine?.planCurrency ?? null).toBeNull();
  });

  it("السطور المرتبطة بعملاتٍ مختلفة لا تُختزل في عملة زيارةٍ واحدة", async () => {
    /* خطتا اتفاقٍ مختلفتان في زيارةٍ واحدة ⇒ عملة الزيارة ملغاة (تُرفض عند
       التوقيع)، لكن كل سطرٍ يظل يعملة خطته — لا يُنسَّب أيٌّ منها للأساس. */
    const visit = await getClinicalVisit(mixedVisitId);
    expect(visit?.planCurrency ?? null).toBeNull();
    const linked = visit?.procedures.filter((line) => line.planItemId !== null) ?? [];
    expect(linked.length).toBe(2);
    expect(new Set(linked.map((line) => line.planCurrency)).size).toBe(2);
  });
});
