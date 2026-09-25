import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (Reports R4) ذكاء العيادة على PostgreSQL 18 — شهر عيادةٍ صغير محسوبٌ باليد.
 *
 * الدوام ٠٩:٠٠–١٧:٠٠ (٤٨٠ دقيقة)، كرسيان. سبتمبر ٢٠٢٥:
 *  A1 د.س كرسي١ تمّت ٣٠د (٠١) · A2 د.س كرسي١ لم يحضر ٣٠د (٠٢، للمريض ن٢)
 *  A3 د.ي كرسي٢ ملغى (٠٢) · A4 د.ي كرسي٢ وصل ٦٠د (٠٣)
 *  A5 د.س كرسي١ محجوز ٣٠د (٠٤) — أُنشئ في ٠٣ للمريض ن٢ (إعادة حجز بعد عدم الحضور)
 *  V1 د.س كرسي١ ١٠:٠٠→١٠:٤٠ (٠١) · V2 د.ي كرسي٢ ١٤:٠٥→١٥:٠٥ (٠٣) · V3 د.س بلا كرسي ولا أوقات (٠٣)
 *  أيام التشغيل = ٠١، ٠٢، ٠٣، ٠٤ ⇒ المتاح لكل كرسي ٤٨٠ × ٤ = ١٩٢٠ دقيقة.
 */
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const reports = await import("../../lib/reports");
const { ensureSchema, getPool, resetPoolForTesting } = db;
const { buildReport, parseFilters } = reports;

type Result = Awaited<ReturnType<typeof buildReport>>;
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
const at = (date: string, time = "10:00") => `${date} ${time}+03`;
function filters(report: string, extra: Record<string, string> = {}) {
  return parseFilters(
    new URLSearchParams({ report, preset: "custom", from: "2025-09-01", to: "2025-09-30", ...extra }),
    "2025-09-30",
  );
}
const kpi = (result: Result, key: string) => result.kpis.find((item) => item.key === key);
const rows = (result: Result) => result.rows ?? [];

let salem = 0;
let yahya = 0;
let n1 = 0;
let n2 = 0;
let regular = 0;
let l1 = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await q(`TRUNCATE payments, invoice_items, invoices, visits, appointments, lab_orders, plan_items, treatment_plans,
           patients, parties RESTART IDENTITY CASCADE`);
  for (const [key, value] of [["clinic.day_start", "09:00"], ["clinic.day_end", "17:00"], ["clinic.shift2_start", ""],
    ["clinic.shift2_end", ""], ["clinic.chairs", "2"]]) {
    await q(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
  }
  [{ id: salem }] = await q<{ id: number }>(`INSERT INTO parties (name, kind) VALUES ('د. سالم', 'doctor') RETURNING id`);
  [{ id: yahya }] = await q<{ id: number }>(`INSERT INTO parties (name, kind) VALUES ('د. يحيى', 'doctor') RETURNING id`);
  [{ id: n1 }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name, created_at) VALUES ('R4-1', 'جديد ١', $1::timestamptz) RETURNING id`, [at("2025-09-01", "09:00")]);
  [{ id: n2 }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name, created_at) VALUES ('R4-2', 'جديد ٢', $1::timestamptz) RETURNING id`, [at("2025-09-02", "09:00")]);
  [{ id: regular }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name, created_at) VALUES ('R4-3', 'قديم', $1::timestamptz) RETURNING id`, [at("2024-01-01")]);

  const appointment = async (patient: number, doctor: number, chair: number | null, day: string, time: string, minutes: number, status: string, created = day) => {
    await q(`INSERT INTO appointments (patient_id, doctor_id, chair_no, scheduled_date, scheduled_time, duration_minutes, status, created_at)
             VALUES ($1, $2, $3, $4::date, $5::time, $6, $7, $8::timestamptz)`,
      [patient, doctor, chair, day, time, minutes, status, at(created, "08:00")]);
  };
  await appointment(n1, salem, 1, "2025-09-01", "10:00", 30, "done");
  await appointment(n2, salem, 1, "2025-09-02", "10:00", 30, "no_show");
  await appointment(regular, yahya, 2, "2025-09-02", "12:00", 30, "cancelled");
  await appointment(regular, yahya, 2, "2025-09-03", "14:00", 60, "arrived");
  await appointment(n2, salem, 1, "2025-09-04", "09:00", 30, "booked", "2025-09-03");

  const visit = async (patient: number, doctor: number, chair: number | null, day: string, seated: string | null, finished: string | null) => {
    await q(`INSERT INTO visits (patient_name, patient_id, doctor_id, chair, status, arrived_at, seated_at, finished_at)
             VALUES ('م', $1, $2, $3, 'done', $4::timestamptz, $5::timestamptz, $6::timestamptz)`,
      [patient, doctor, chair, at(day, "09:30"), seated ? at(day, seated) : null, finished ? at(day, finished) : null]);
  };
  await visit(n1, salem, 1, "2025-09-01", "10:00", "10:40");
  await visit(regular, yahya, 2, "2025-09-03", "14:05", "15:05");
  await visit(n1, salem, null, "2025-09-03", null, null);

  // فاتورة ن١ بـ٢٠٬٠٠٠ عند د. سالم، دُفع منها ١٥٬٠٠٠.
  const [shift] = await q<{ id: number }>(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd) VALUES ('r4', 0, 0, 0) RETURNING id`);
  const [invoice] = await q<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ('R4-INV', $1, 20000, 0, 'YER', 't', $2::timestamptz) RETURNING id`, [n1, at("2025-09-01", "11:00")]);
  await q(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor, doctor_id)
           VALUES ($1, 'كشف وتنظيف', 1, 20000, 20000, $2)`, [invoice.id, salem]);
  await q(`INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency, exchange_rate,
             base_amount_minor, base_currency, method, created_by, created_at)
           VALUES ('R4-REC', $1, $2, 'payment', 15000, 'YER', 1, 15000, 'YER', 'cash', 't', $3::timestamptz)`,
    [n1, shift.id, at("2025-09-01", "11:05")]);

  // المختبر: L1 وصل في موعده (٣ أيام)، L2 إعادةٌ له ما زالت مفتوحة ومتأخرة.
  [{ id: l1 }] = await q<{ id: number }>(
    `INSERT INTO lab_orders (patient_id, lab_name, work_type, sent_date, due_date, status, received_at, doctor_id, cost_minor, cost_currency)
     VALUES ($1, 'مختبر النور', 'تاج', '2025-09-01', '2025-09-05', 'received', $2::timestamptz, $3, 10000, 'USD') RETURNING id`,
    [n1, at("2025-09-04", "12:00"), salem]);
  await q(`INSERT INTO lab_orders (patient_id, lab_name, work_type, sent_date, due_date, status, doctor_id, cost_minor, cost_currency, remake_original_id)
           VALUES ($1, 'مختبر النور', 'تاج', '2025-09-02', '2025-09-10', 'sent', $2, 5000, 'YER', $3)`, [n1, salem, l1]);

  // خطتان: P1 بموافقة، بندان ١٠٬٠٠٠ أحدهما تمّ، ولا موعد قادم ⇒ علاجٌ غير مجدول. P2 بلا موافقة ولا بنود.
  const [p1] = await q<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date, consent_at, primary_doctor_id, specialty)
     VALUES ($1, 'خطة ن١', 20000, 'YER', 'active', '2025-09-05', $2::timestamptz, $3, 'filling') RETURNING id`,
    [n1, at("2025-09-05"), salem]);
  await q(`INSERT INTO plan_items (plan_id, service_name, category, quantity, unit_price_minor, status)
           VALUES ($1, 'حشوة ١', 'filling', 1, 10000, 'done'), ($1, 'حشوة ٢', 'filling', 1, 10000, 'planned')`, [p1.id]);
  await q(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date, primary_doctor_id)
           VALUES ($1, 'خطة قديم', 30000, 'YER', 'active', '2025-09-06', $2)`, [regular, yahya]);
});
afterAll(async () => { await resetPoolForTesting(); });

describe("أداء المواعيد — قاعدةٌ واحدة للحضور", () => {
  it("يعدّ النتائج والنسب من الأحداث: حضر ٢ (تمّت + وصل)، لم يحضر ١، ملغى ١، مفتوح ١", async () => {
    const result = await buildReport("appointment-performance", filters("appointment-performance"));
    expect(kpi(result, "booked")?.count).toBe(5);
    expect(kpi(result, "attended")?.count).toBe(2);
    expect(kpi(result, "no-show")?.count).toBe(1);
    expect(kpi(result, "cancelled")?.count).toBe(1);
    expect(kpi(result, "open")?.count).toBe(1);
    expect(kpi(result, "attendance-rate")?.text).toBe("66.7٪");
    expect(kpi(result, "no-show-rate")?.text).toBe("33.3٪");
    expect(kpi(result, "cancellation-rate")?.text).toBe("20٪");
    const salemRow = rows(result).find((row) => row.dimension === "الطبيب" && row.value === "د. سالم");
    expect(salemRow).toMatchObject({ total: 3, attended: 1, noShow: 1, open: 1, attendanceRate: 50 });
    const tuesday = rows(result).find((row) => row.dimension === "يوم الأسبوع" && row.value === "الثلاثاء");
    expect(tuesday).toMatchObject({ total: 2, noShow: 1, cancelled: 1 });
  });

  it("تقرير المواعيد يستعمل القاعدة نفسها — لا نسبتان متناقضتان", async () => {
    const appointments = await buildReport("appointments", filters("appointments"));
    expect(kpi(appointments, "attended")?.count).toBe(2);
    expect(kpi(appointments, "attendance-rate")?.text).toBe("66.7٪");
  });
});

describe("استغلال الكراسي — مقامٌ حقيقي فقط", () => {
  it("المتاح = الدوام × أيام التشغيل الفعلية، والمشغول من الجلوس إلى الانتهاء", async () => {
    const result = await buildReport("chair-utilization", filters("chair-utilization"));
    expect(kpi(result, "operating-days")?.count).toBe(4);
    expect(kpi(result, "daily-minutes")?.count).toBe(480);
    const chair1 = rows(result).find((row) => row.chair === "كرسي 1");
    const chair2 = rows(result).find((row) => row.chair === "كرسي 2");
    expect(chair1).toMatchObject({ availableMinutes: 1920, bookedMinutes: 90, occupiedMinutes: 40, idleMinutes: 1880, utilization: 2.1 });
    expect(chair2).toMatchObject({ availableMinutes: 1920, bookedMinutes: 60, occupiedMinutes: 60, utilization: 3.1 });
    const unassigned = rows(result).find((row) => row.chair === "غير مسند لكرسي");
    expect(unassigned).toMatchObject({ availableMinutes: null, utilization: null, visits: 1 });
    expect(kpi(result, "untimed")?.count).toBe(1);
  });
});

describe("استغلال الأطباء", () => {
  it("مواعيد وزيارات ودقائق كرسي وإنتاج وتحصيل لكل طبيب — بلا نسبة مخترعة", async () => {
    const result = await buildReport("provider-utilization", filters("provider-utilization"));
    const salemRow = rows(result).find((row) => row.doctorName === "د. سالم");
    expect(salemRow).toMatchObject({
      appointments: 3, attended: 1, noShow: 1, noShowRate: 50, visits: 2,
      bookedMinutes: 90, chairMinutes: 40, avgVisitMinutes: 40, utilization: "—",
    });
    expect(String(salemRow?.productionText)).toContain("20");
    expect(String(salemRow?.collectedText)).toContain("15");
    const yahyaRow = rows(result).find((row) => row.doctorName === "د. يحيى");
    expect(yahyaRow).toMatchObject({ appointments: 2, attended: 1, noShow: 0, noShowRate: 0, chairMinutes: 60 });
  });
});

describe("ملخّص العيادة — كل بطاقة تساوي تقريرها التفصيلي", () => {
  it("المواعيد والزيارات والتحصيل والمستحقات والمختبر", async () => {
    const overview = await buildReport("practice-overview", filters("practice-overview"));
    const [appointments, visits, collections, debt, patients] = await Promise.all([
      buildReport("appointments", filters("appointments")),
      buildReport("visits", filters("visits")),
      buildReport("collections", filters("collections")),
      buildReport("debt", filters("debt", { debtMode: "outstanding" })),
      buildReport("patients", filters("patients")),
    ]);
    expect(kpi(overview, "appointments")?.count).toBe(kpi(appointments, "appointments")?.count);
    expect(kpi(overview, "visits")?.count).toBe(kpi(visits, "visits")?.count);
    expect(kpi(overview, "visits")?.count).toBe(3);
    expect(kpi(overview, "new")?.count).toBe(kpi(patients, "new")?.count);
    expect(kpi(overview, "collected")?.minor).toBe(kpi(collections, "total")?.minor);
    expect(kpi(overview, "collected")?.minor).toBe(15000);
    expect(kpi(overview, "outstanding")?.minor).toBe(kpi(debt, "total")?.minor);
    expect(kpi(overview, "outstanding")?.minor).toBe(5000);
    expect(kpi(overview, "production")?.minor).toBe(20000);
    expect(kpi(overview, "lab-overdue")?.count).toBe(1);
    expect(kpi(overview, "appointments")?.href).toContain("report=appointments");
    expect(kpi(overview, "appointments")?.href).toContain("from=2025-09-01");
    // الاتجاه اليومي من الأحداث.
    const first = rows(overview).find((row) => row.day === "2025-09-01");
    expect(first).toMatchObject({ newPatients: 1, visits: 1, appointments: 1, attended: 1 });
  });

  it("المقارنة بالفترة السابقة أعدادٌ لا مال للزيارات", async () => {
    const overview = await buildReport("practice-overview", filters("practice-overview", { compare: "prev_period" }));
    const visitsEntry = overview.comparison?.entries.find((entry) => entry.label === "الزيارات");
    expect(visitsEntry).toMatchObject({ currentMinor: 3, previousMinor: 0, count: true, changePercent: null });
  });
});

describe("ذكاء المختبر", () => {
  it("حالات، متأخرة، إعادات، مدة التسليم، الالتزام بالموعد، وتكلفة بكل عملة", async () => {
    const result = await buildReport("lab-intelligence", filters("lab-intelligence"));
    expect(kpi(result, "cases")?.count).toBe(2);
    expect(kpi(result, "open")?.count).toBe(1);
    expect(kpi(result, "overdue")?.count).toBe(1);
    expect(kpi(result, "remakes")?.count).toBe(1);
    expect(kpi(result, "turnaround")?.text).toBe("3");
    expect(kpi(result, "on-time")?.text).toBe("100٪");
    expect(kpi(result, "cost")?.minor).toBe(5000);
    expect(kpi(result, "cost-USD")?.minor).toBe(10000);
    const lab = rows(result).find((row) => row.dimension === "المختبر");
    expect(lab).toMatchObject({ name: "مختبر النور", total: 2, remakeRate: 50, onTimeRate: 100 });
    expect(rows(result).some((row) => row.dimension === "الطبيب × المختبر" && String(row.name).includes("د. سالم"))).toBe(true);
  });
});

describe("خطط العلاج والعلاج غير المجدول", () => {
  it("القبول والتنفيذ والمتبقي بعملة الخطة", async () => {
    const result = await buildReport("plan-intelligence", filters("plan-intelligence"));
    expect(kpi(result, "created")?.count).toBe(2);
    expect(kpi(result, "approved")?.count).toBe(1);
    expect(kpi(result, "acceptance")?.text).toBe("50٪");
    expect(kpi(result, "value")?.minor).toBe(50000);
    expect(kpi(result, "executed")?.minor).toBe(10000);
    expect(kpi(result, "remaining")?.minor).toBe(40000);
    expect(kpi(result, "unscheduled")?.count).toBe(1);
  });

  it("علاج غير مجدول: خطة جارية ببنود معلّقة ولا موعد قادم", async () => {
    const result = await buildReport("unscheduled-treatment", filters("unscheduled-treatment"));
    expect(rows(result)).toHaveLength(1);
    expect(rows(result)[0]).toMatchObject({ patientId: n1, pendingItems: 1, pendingMinor: 10000, currency: "YER" });
  });
});

describe("المرضى الجدد والمتابعة والاتجاهات", () => {
  it("تحويل المرضى الجدد: تسجيل ← زيارة ← خطة ← بدء", async () => {
    const result = await buildReport("new-patient-intelligence", filters("new-patient-intelligence"));
    expect(rows(result)).toHaveLength(1);
    expect(rows(result)[0]).toMatchObject({ patients: 2, visited: 1, planned: 1, consented: 1, started: 1, visitRate: 50, startRate: 50 });
  });

  it("من لم يحضر: أُعيد حجزه (مثبت بإنشاء موعدٍ بعده) ولم يعد بعد", async () => {
    const result = await buildReport("recall-intelligence", filters("recall-intelligence"));
    expect(kpi(result, "no-show")?.count).toBe(1);
    expect(kpi(result, "rebooked")?.text).toBe("1 · 100٪");
    expect(kpi(result, "returned")?.text).toBe("0 · 0٪");
    expect(rows(result)[0]).toMatchObject({ patientId: n2, rebookedOn: "2025-09-03", returnedOn: "", stage: "أُعيد حجزه" });
  });

  it("الاتجاهات الشهرية للمركز والطبيب والمختبر", async () => {
    const result = await buildReport("practice-trends", filters("practice-trends"));
    const center = rows(result).find((row) => row.dimension === "المركز" && row.monthKey === "2025-09");
    expect(center).toMatchObject({ visits: 3, newPatients: 2, appointments: 5, noShow: 1, labCases: 2, services: 1 });
    const lab = rows(result).find((row) => row.dimension === "المختبر");
    expect(lab).toMatchObject({ name: "مختبر النور", labCases: 2 });
    const doctor = rows(result).find((row) => row.dimension === "الطبيب" && row.name === "د. سالم");
    expect(doctor?.visits).toBe(2);
  });
});
