import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * مركز التقارير — المرحلة 1 على PostgreSQL 18 الحقيقي.
 *
 * RPT-01/02/05/06 إعادة إنتاجٍ حرفية أُثبت فشلها على main قبل الإصلاح:
 *   المريض الجديد بلا مال لا يظهر · زيارة ٥ مارس = ٠ · زيارات مارس = ٢ بدل ٤ ·
 *   «الخدمات» في السنوي = عدد الزيارات.
 */
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const reports = await import("../../lib/reports");
const { ensureSchema, getPool, resetPoolForTesting } = db;
const { buildReport, parseFilters } = reports;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
const TZ = "Asia/Aden";
const at = (date: string, time = "10:00") => `${date} ${time}+03`;
function filters(report: string, from: string, to: string) {
  return parseFilters(new URLSearchParams({ report, preset: "custom", from, to }), to);
}
const kpi = (result: Awaited<ReturnType<typeof buildReport>>, key: string) =>
  result.kpis.find((item) => item.key === key)?.count;

let consultOnly = 0;
let regular = 0;
let doctorA = 0;
let doctorB = 0;
let cleaning = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await q(`TRUNCATE payments, invoice_items, invoices, visits, appointments, patients, parties RESTART IDENTITY CASCADE`);
  const [doctor] = await q<{ id: number }>(`INSERT INTO parties (name, kind) VALUES ('د. التقرير', 'doctor') RETURNING id`);
  doctorA = doctor.id;
  const [other] = await q<{ id: number }>(`INSERT INTO parties (name, kind) VALUES ('د. آخر', 'doctor') RETURNING id`);
  doctorB = other.id;
  const [svc] = await q<{ id: number }>(`INSERT INTO services (name, price_minor, is_active, category) VALUES ('تنظيف R1', 10000, TRUE, 'general') RETURNING id`);
  cleaning = svc.id;
  // مريضٌ جديد حضر استشارةً فقط — بلا فاتورة ولا دفعة.
  const [c] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, created_at) VALUES ('R-1', 'مريض استشارة', $1::timestamptz) RETURNING id`,
    [at("2025-03-10")],
  );
  consultOnly = c.id;
  await q(`INSERT INTO visits (patient_name, patient_id, doctor_id, status, arrived_at, finished_at)
           VALUES ('مريض استشارة', $1, $2, 'done', $3::timestamptz, $3::timestamptz)`, [consultOnly, doctor.id, at("2025-03-10")]);
  // مريضٌ قديم زار ثلاث مرات في مارس، وفي كل زيارةٍ فاتورة ببندين.
  const [r] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, created_at) VALUES ('R-2', 'مريض منتظم', $1::timestamptz) RETURNING id`,
    [at("2024-01-01")],
  );
  regular = r.id;
  // زيارةٌ سابقة في ٢٠٢٤ — فزيارات مارس لمراجعٍ سابق لا جديد.
  await q(`INSERT INTO visits (patient_name, patient_id, doctor_id, status, arrived_at) VALUES ('مريض منتظم', $1, $2, 'done', $3::timestamptz)`,
    [regular, doctor.id, at("2024-06-01")]);
  for (const [i, day] of ["2025-03-05", "2025-03-15", "2025-03-25"].entries()) {
    const [inv] = await q<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
       VALUES ($1, $2, 20000, 0, 'YER', 't', $3::timestamptz) RETURNING id`,
      [`R-INV-${i}`, regular, at(day)],
    );
    await q(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
             VALUES ($1, $3, 'تنظيف', 1, 10000, 10000, $2), ($1, NULL, 'حشوة', 1, 10000, 10000, $2)`, [inv.id, doctor.id, cleaning]);
    await q(`INSERT INTO visits (patient_name, patient_id, doctor_id, status, invoice_id, arrived_at, seated_at, finished_at)
             VALUES ('مريض منتظم', $1, $2, 'done', $3, $4::timestamptz, $5::timestamptz, $6::timestamptz)`,
      [regular, doctor.id, inv.id, at(day, "10:00"), at(day, "10:20"), at(day, "10:50")]);
  }
  // زيارة بلا ملف (زائر عابر) عند طبيبٍ آخر في مارس.
  await q(`INSERT INTO visits (patient_name, doctor_id, status, arrived_at) VALUES ('زائر عابر', $1, 'waiting', $2::timestamptz)`,
    [doctorB, at("2025-03-15", "12:00")]);
});
afterAll(async () => { await resetPoolForTesting(); });

describe("مركز التقارير — عيوب التدقيق (يجب ألا تعود)", () => {
  it("RPT-01: المريض الجديد بلا فاتورة ولا دفعة يظهر في تقرير المرضى الجدد", async () => {
    const result = await buildReport("patients", filters("patients", "2025-03-01", "2025-03-31"));
    expect(result.rows!.some((row) => row.patientId === consultOnly)).toBe(true);
    expect(kpi(result, "new")).toBe(1);
  });

  it("RPT-02: زيارة ٥ مارس تُعدّ في تقرير يومها وإن عاد المريض بعدها", async () => {
    const result = await buildReport("daily", filters("daily", "2025-03-05", "2025-03-05"));
    expect(kpi(result, "visits")).toBe(1);
  });

  it("RPT-05: زيارات مارس = ٥ زيارات فعلية (٣ للمنتظم + استشارة + زائر عابر) لا «آخر زيارة»", async () => {
    const result = await buildReport("monthly", filters("monthly", "2025-03-01", "2025-03-31"));
    expect(kpi(result, "visits")).toBe(5);
  });

  it("RPT-06: عمود «الخدمات» في السنوي عدد الخدمات (٦ بنود) لا عدد الزيارات", async () => {
    const result = await buildReport("annual", filters("annual", "2025-01-01", "2025-12-31"));
    const march = result.monthly!.rows.filter((row) => row.monthLabel === result.monthly!.rows.find((r) => String(r.monthLabel).includes("مارس"))?.monthLabel);
    expect(march.length).toBeGreaterThan(0);
    expect(march[0].services).toBe(6);
  });
});

describe("سجل الزيارات والفلاتر (R1)", () => {
  it("RPT-03: سجل الزيارات يعرض كل زيارة — بفاتورة وبدونها، وبلا ملف — بأوقاتها ومددها", async () => {
    const result = await buildReport("visits", filters("visits", "2025-03-01", "2025-03-31"));
    expect(result.rows).toHaveLength(5);
    expect(kpi(result, "visits")).toBe(5);
    expect(kpi(result, "firstVisits")).toBe(1); // الاستشارة أول زيارةٍ لمريضها
    expect(kpi(result, "notInvoiced")).toBe(2);
    const consult = result.rows!.find((row) => row.patientId === consultOnly)!;
    expect(consult.kind).toBe("مراجع جديد");
    expect(consult.invoiceText).toBe("بلا فاتورة");
    const withTimes = result.rows!.find((row) => row.patientId === regular)!;
    expect(withTimes.waitMinutes).toBe(20);
    expect(withTimes.sessionMinutes).toBe(30);
    expect(withTimes.collection).toBe("غير محصّلة");
    expect(result.rows!.some((row) => row.kind === "بلا ملف")).toBe(true);
  });

  it("فلتر الطبيب في الزيارات = طبيب الزيارة نفسها", async () => {
    const params = new URLSearchParams({ report: "visits", preset: "custom", from: "2025-03-01", to: "2025-03-31", doctorId: String(doctorB) });
    const result = await buildReport("visits", parseFilters(params, "2025-03-31"));
    expect(result.rows).toHaveLength(1);
    expect(result.rows![0].patientName).toBe("زائر عابر");
  });

  it("RPT-12: فلتر الخدمة يعمل — تقرير الخدمات وسجل الزيارات", async () => {
    const params = new URLSearchParams({ preset: "custom", from: "2025-03-01", to: "2025-03-31", serviceId: String(cleaning) });
    const services = await buildReport("services", parseFilters(params, "2025-03-31"));
    expect(services.rows).toHaveLength(1);
    expect(services.rows![0].count).toBe(3);
    expect(services.rows![0].totalMinor).toBe(30_000);
    const visits = await buildReport("visits", parseFilters(params, "2025-03-31"));
    expect(visits.rows).toHaveLength(3);
  });

  it("تقرير الخدمات من البنود: الكمية تُعدّ، والقيمة نصيب البند من الصافي بعد الخصم", async () => {
    const [inv] = await q<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
       VALUES ('R-INV-Q', $1, 30000, 3000, 'YER', 't', $2::timestamptz) RETURNING id`,
      [regular, at("2025-04-02")],
    );
    await q(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
             VALUES ($1, $2, 'تنظيف', 2, 10000, 20000, $3), ($1, NULL, 'أشعة', 1, 10000, 10000, $3)`, [inv.id, cleaning, doctorA]);
    const result = await buildReport("services", filters("services", "2025-04-01", "2025-04-30"));
    const clean = result.rows!.find((row) => row.serviceName === "تنظيف")!;
    const xray = result.rows!.find((row) => row.serviceName === "أشعة")!;
    expect(clean.count).toBe(2);
    expect(clean.totalMinor).toBe(18_000);
    expect(xray.totalMinor).toBe(9_000);
  });

  it("التقرير اليومي لمدى أيام يُسمّى تقرير الفترة لا «اليومي»", async () => {
    const result = await buildReport("daily", filters("daily", "2025-03-01", "2025-03-31"));
    expect(result.title).toBe("التقرير التشغيلي للفترة");
    expect(kpi(result, "visits")).toBe(5);
  });
});
