import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * مركز التقارير — المرحلة 2 (إسناد الأطباء والتخصصات) على PostgreSQL 18 الحقيقي.
 *
 * RPT-08…14 إعادة إنتاجٍ حرفية أُثبت فشلها قبل الإصلاح: الطبيب والتخصص كانا يأخذان
 * المريض كله — كل تحصيله في الفترة ورصيده كله وصافي الفاتورة كاملًا — لمجرد علاقةٍ
 * تاريخية به. الصحيح: من بنود الفاتورة نفسها (البند → الطبيب/التخصص)، والتحصيل
 * والمتبقي يُوزَّعان على البنود.
 *
 * السيناريو (سبتمبر ٢٠٢٥ هو الفترة):
 *  - مريض ١: تقويم عند د. التقويم في مايو (١٠٠٬٠٠٠، سُدّد في مايو)، ثم علاج جذور عند
 *    د. العصب في سبتمبر (٦٠٬٠٠٠) دفع منه ٤٠٬٠٠٠ في سبتمبر.
 *  - مريض ٢: فاتورة سبتمبر بطبيبين: تقويم ٣٠٬٠٠٠ (د. التقويم) + جذور ١٠٬٠٠٠ (د. العصب)،
 *    خصم ٤٬٠٠٠ ⇒ صافي ٣٦٬٠٠٠، دُفع كاملًا في سبتمبر.
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
const at = (date: string, time = "10:00") => `${date} ${time}+03`;
function filters(report: string, extra: Record<string, string> = {}) {
  return parseFilters(
    new URLSearchParams({ report, preset: "custom", from: "2025-09-01", to: "2025-09-30", ...extra }),
    "2025-09-30",
  );
}
type Row = Record<string, unknown>;
const moneyKpi = (result: Awaited<ReturnType<typeof buildReport>>, key: string) =>
  result.kpis.find((item) => item.key === key)?.minor;

let ortho = 0;
let endo = 0;
let p1 = 0;
let p2 = 0;
let shift = 0;
let receipt = 0;

async function invoice(patientId: number, day: string, discount: number,
  lines: Array<{ serviceId: number; description: string; total: number; doctorId: number }>): Promise<number> {
  const total = lines.reduce((sum, line) => sum + line.total, 0);
  const [inv] = await q<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, $3, $4, 'YER', 't', $5::timestamptz) RETURNING id`,
    [`R2-INV-${patientId}-${day}`, patientId, total, discount, at(day)],
  );
  for (const line of lines) {
    await q(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
             VALUES ($1, $2, $3, 1, $4, $4, $5)`, [inv.id, line.serviceId, line.description, line.total, line.doctorId]);
  }
  return inv.id;
}
async function pay(patientId: number, day: string, amount: number, kind: "payment" | "refund" = "payment") {
  receipt += 1;
  await q(
    `INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency, exchange_rate,
                           base_amount_minor, base_currency, method, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, 'YER', 1, $5, 'YER', 'cash', 't', $6::timestamptz)`,
    [`R2-REC-${receipt}`, patientId, shift, kind, amount, at(day, "11:00")],
  );
}
async function visit(patientId: number, doctorId: number, day: string) {
  await q(`INSERT INTO visits (patient_name, patient_id, doctor_id, status, arrived_at) VALUES ('م', $1, $2, 'done', $3::timestamptz)`,
    [patientId, doctorId, at(day, "09:00")]);
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await q(`TRUNCATE payments, invoice_items, invoices, visits, appointments, treatment_plans, patients, parties RESTART IDENTITY CASCADE`);
  [{ id: ortho }] = await q<{ id: number }>(`INSERT INTO parties (name, kind) VALUES ('د. التقويم', 'doctor') RETURNING id`);
  [{ id: endo }] = await q<{ id: number }>(`INSERT INTO parties (name, kind) VALUES ('د. العصب', 'doctor') RETURNING id`);
  const [{ id: orthoSvc }] = await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, category) VALUES ('تقويم R2', 100000, TRUE, 'ortho') RETURNING id`);
  const [{ id: rctSvc }] = await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, category) VALUES ('جذور R2', 60000, TRUE, 'rct') RETURNING id`);
  [{ id: shift }] = await q<{ id: number }>(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd) VALUES ('r2', 0, 0, 0) RETURNING id`);

  [{ id: p1 }] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, created_at) VALUES ('R2-1', 'مريض متعدد الأطباء', $1::timestamptz) RETURNING id`,
    [at("2024-01-01")]);
  await invoice(p1, "2025-05-10", 0, [{ serviceId: orthoSvc, description: "تقويم", total: 100000, doctorId: ortho }]);
  await visit(p1, ortho, "2025-05-10");
  await pay(p1, "2025-05-10", 100000);
  await invoice(p1, "2025-09-10", 0, [{ serviceId: rctSvc, description: "علاج جذور", total: 60000, doctorId: endo }]);
  await visit(p1, endo, "2025-09-10");
  await pay(p1, "2025-09-12", 40000);

  [{ id: p2 }] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, created_at) VALUES ('R2-2', 'مريض بطبيبين', $1::timestamptz) RETURNING id`,
    [at("2024-02-01")]);
  await invoice(p2, "2025-09-15", 4000, [
    { serviceId: orthoSvc, description: "تقويم", total: 30000, doctorId: ortho },
    { serviceId: rctSvc, description: "علاج جذور", total: 10000, doctorId: endo },
  ]);
  await visit(p2, ortho, "2025-09-15");
  await pay(p2, "2025-09-15", 36000);
});
afterAll(async () => { await resetPoolForTesting(); });

function doctorRow(rows: Row[] | undefined, doctorId: number): Row | undefined {
  return (rows ?? []).find((row) => row.doctorId === doctorId && row.currency === "YER");
}
function specialtyRow(rows: Row[] | undefined, code: string): Row | undefined {
  return (rows ?? []).find((row) => row.specialtyCode === code && row.currency === "YER");
}

describe("تقرير الطبيب — من بنوده لا من علاقته التاريخية بالمريض", () => {
  it("RPT-08: مرضى الطبيب = من عمل لهم أو زاروه في الفترة — لا مريض مايو في تقرير سبتمبر", async () => {
    const result = await buildReport("doctor", filters("doctor"));
    expect(doctorRow(result.rows, ortho)?.patients).toBe(1); // مريض ٢ وحده
    expect(doctorRow(result.rows, endo)?.patients).toBe(2);
  });

  it("RPT-09: تحصيل المريض لا يُنسب لطبيبٍ لم يُسدَّد عمله منه", async () => {
    const result = await buildReport("doctor", filters("doctor"));
    // مريض ١ دفع ٤٠٬٠٠٠ عن الجذور — لا شيء منه للتقويم.
    expect(doctorRow(result.rows, ortho)?.collectedMinor).toBe(27000);
    expect(doctorRow(result.rows, endo)?.collectedMinor).toBe(49000);
  });

  it("RPT-10: المتبقي يُنسب لصاحب البند غير المسدَّد وحده — لا يتكرر", async () => {
    const result = await buildReport("doctor", filters("doctor"));
    expect(doctorRow(result.rows, ortho)?.debtMinor ?? 0).toBe(0);
    expect(doctorRow(result.rows, endo)?.debtMinor).toBe(20000);
  });

  it("RPT-11: فاتورة بطبيبين — لكلٍّ نصيب بنوده من الصافي بعد الخصم، والإجراءات بنوده", async () => {
    const result = await buildReport("doctor", filters("doctor"));
    expect(doctorRow(result.rows, ortho)?.workMinor).toBe(27000);
    expect(doctorRow(result.rows, endo)?.workMinor).toBe(69000);
    expect(doctorRow(result.rows, ortho)?.procedures).toBe(1);
    expect(doctorRow(result.rows, endo)?.procedures).toBe(2);
  });

  it("المجموع يطابق: تحصيل الأطباء = تحصيل الفترة، بلا تكرار", async () => {
    const doctor = await buildReport("doctor", filters("doctor"));
    const collections = await buildReport("collections", filters("collections"));
    const sum = (doctor.rows ?? []).filter((row) => row.currency === "YER")
      .reduce((total, row) => total + Number(row.collectedMinor ?? 0), 0);
    expect(sum).toBe(76000);
    expect(moneyKpi(collections, "total")).toBe(76000);
  });
});

describe("تقرير التخصص — من بنود الخدمات لا من «المريض لديه هذا التخصص»", () => {
  it("RPT-12: مرضى التخصص في الفترة لا تاريخيًّا", async () => {
    const result = await buildReport("specialty", filters("specialty"));
    expect(specialtyRow(result.rows, "ortho")?.patients).toBe(1);
    expect(specialtyRow(result.rows, "rct")?.patients).toBe(2);
  });

  it("RPT-13: التحصيل يُنسب لتخصص البند المسدَّد", async () => {
    const result = await buildReport("specialty", filters("specialty"));
    expect(specialtyRow(result.rows, "ortho")?.collectedMinor).toBe(27000);
    expect(specialtyRow(result.rows, "rct")?.collectedMinor).toBe(49000);
  });

  it("RPT-14: المديونية لتخصص البند غير المسدَّد وحده", async () => {
    const result = await buildReport("specialty", filters("specialty"));
    expect(specialtyRow(result.rows, "ortho")?.debtMinor ?? 0).toBe(0);
    expect(specialtyRow(result.rows, "rct")?.debtMinor).toBe(20000);
  });

  it("تخصص واحد: مرضاه برصيد التخصص نفسه لا رصيدهم كله", async () => {
    const result = await buildReport("specialty", filters("specialty", { specialty: "ortho" }));
    expect((result.rows ?? []).filter((row) => Number(row.balanceMinor) > 0)).toEqual([]);
    const rct = await buildReport("specialty", filters("specialty", { specialty: "rct" }));
    const row = (rct.rows ?? []).find((item) => item.patientId === p1);
    expect(row?.balanceMinor).toBe(20000);
    expect((rct.rows ?? []).some((item) => item.patientId === p2)).toBe(false);
  });
});

describe("(RPT-SPEC) التخصص: الإجراءات والزيارات، المفوتر، الأطباء، المختبر والمواد والصافي", () => {
  beforeAll(async () => {
    const [{ id: rctSvc }] = await q<{ id: number }>(`SELECT id FROM services WHERE category = 'rct' LIMIT 1`);
    const [{ id: orthoSvc }] = await q<{ id: number }>(`SELECT id FROM services WHERE category = 'ortho' LIMIT 1`);
    const visits = await q<{ id: number; patient_id: number; doctor_id: number }>(
      `SELECT id, patient_id, doctor_id FROM visits WHERE arrived_at >= '2025-09-01' ORDER BY id`);
    const p1Visit = visits.find((v) => v.patient_id === p1)!;
    const p2Visit = visits.find((v) => v.patient_id === p2)!;
    await q(`INSERT INTO visit_procedures (visit_id, service_id, doctor_id, quantity, unit_price_minor) VALUES ($1, $2, $3, 1, 60000)`,
      [p1Visit.id, rctSvc, endo]);
    await q(`INSERT INTO visit_procedures (visit_id, service_id, doctor_id, quantity, unit_price_minor)
             VALUES ($1, $2, $3, 1, 30000), ($1, $4, $5, 2, 5000)`, [p2Visit.id, orthoSvc, ortho, rctSvc, endo]);
    // أمر مختبر بالريال السعودي على زيارة العصب — يبقى سعوديًّا في دلوه.
    await q(`INSERT INTO lab_orders (patient_id, lab_name, work_type, sent_date, due_date, cost_minor, cost_currency, visit_id, created_at)
             VALUES ($1, 'مختبر', 'تاج بعد العصب', '2025-09-10', '2025-09-20', 5000, 'SAR', $2, $3::timestamptz)`,
      [p1, p1Visit.id, at("2025-09-10")]);
    await q(`INSERT INTO material_rate_history (category, rate_bp, effective_from) VALUES ('rct', 1000, '2025-01-01')`);
  });

  it("السطر المالي: المفوتر والمختبر (بعملته) والمواد والصافي لكل تخصص", async () => {
    const result = await buildReport("specialty", filters("specialty"));
    const rct = specialtyRow(result.rows, "rct")!;
    expect(rct.invoicedMinor).toBe(60000 + 9000);
    expect(rct.collectedMinor).toBe(49000);
    expect(rct.materialCostMinor).toBe(4900);
    expect(rct.labCostMinor).toBe(0);
    expect(rct.netMinor).toBe(49000 - 4900);
    const rctSar = (result.rows ?? []).find((row) => row.specialtyCode === "rct" && row.currency === "SAR")!;
    expect(rctSar.labCostMinor).toBe(5000);
    expect(rctSar.netMinor).toBe(-5000);
  });

  it("النشاط: الإجراءات بالكمية، والزيارات والمرضى والأطباء لكل تخصص", async () => {
    const result = await buildReport("specialty", filters("specialty"));
    const activity = result.sections?.find((section) => section.title.startsWith("النشاط"))!;
    const rct = activity.rows.find((row) => row.specialtyLabel === "علاج جذور")!;
    expect(rct).toMatchObject({ procedures: 3, visits: 2, patients: 2, doctors: 1 });
    const ortho = activity.rows.find((row) => row.specialtyLabel === "تقويم")!;
    expect(ortho).toMatchObject({ procedures: 1, visits: 1, patients: 1 });
  });

  it("الأطباء داخل التخصص: إجراءات كل طبيب ومفوتره وتحصيله", async () => {
    const result = await buildReport("specialty", filters("specialty", { specialty: "rct" }));
    const doctors = result.sections?.[0];
    expect(doctors?.rows).toEqual([
      expect.objectContaining({ doctorName: "د. العصب", currency: "YER", procedures: 3, invoicedMinor: 69000, collectedMinor: 49000 }),
    ]);
    expect(moneyKpi(result, "net-YER") ?? moneyKpi(result, "net")).toBeDefined();
    expect(result.kpis.find((item) => item.key === "procedures")?.value ?? result.kpis.find((item) => item.key === "procedures")?.count).toBe(3);
  });
});
