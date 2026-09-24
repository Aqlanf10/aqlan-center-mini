import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * P0-1 — محرّك عمولات الأطباء على PostgreSQL 18 الحقيقي.
 *
 * كل حالة تبني عيادةً صغيرة من الصفر (أطباء، مرضى، زيارات، فواتير، دفعات، أعمال
 * مختبر) ثم تسأل التقرير نفسه الذي تقرؤه شاشة العمولات: `commissionReport`.
 * والتغييرات على النسب تُجرى عبر دوال التطبيق نفسها (`updateParty`/`updateUser`)
 * لا عبر SQL — لأنها الطريق الذي يسلكه المالك، وهي التي يجب أن تحفظ التاريخ.
 *
 * الحالات الثلاث الأولى هي إعادة إنتاجٍ حرفية لما أثبته تدقيق الجاهزية:
 *   ١٨٬٠٠٠ بدل ١٢٬٠٠٠ · اختفاء ٢٬٧٦٠ · تحوّل ٢٬٧٦٠ إلى ٣٬٤٥٠.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { commissionReport, createParty, createStaffUser, ensureSchema, getPool, resetPoolForTesting, updateParty, updateUser } = db;

type Currency = "YER" | "SAR" | "USD";
const PAST = "2024-03-10";
const FAR_PAST = "1970-01-01";
let seq = 0;
let shiftId = 0;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

/** طبيبٌ عبر دالة التطبيق — كما تنشئه شاشة الجهات. */
async function doctor(name: string, percent: number): Promise<number> {
  const party = await createParty({ name, kind: "doctor", phone: null, commissionPercent: percent, note: null });
  return party.id;
}

async function patient(): Promise<number> {
  seq += 1;
  const [row] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`,
    [`P01-${seq}`, `مريض عمولة ${seq}`],
  );
  return row.id;
}

/**
 * زيارةٌ موقّعة وفاتورتها: بنود بأطباء، بعملة الاتفاق، في لحظةٍ معيّنة.
 * تعيد رقم الفاتورة ورقم الزيارة (لربط المختبر بها).
 */
async function visitInvoice(input: {
  patientId: number;
  currency: Currency;
  at: string;
  items: Array<{ doctorId: number; amount: number }>;
  visitDoctorId?: number;
}): Promise<{ invoiceId: number; visitId: number }> {
  seq += 1;
  const total = input.items.reduce((sum, item) => sum + item.amount, 0);
  const [invoice] = await q<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, $3, 0, $4, 'test', $5::timestamptz) RETURNING id`,
    [`P01-INV-${seq}`, input.patientId, total, input.currency, input.at],
  );
  for (const item of input.items) {
    await q(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor, doctor_id)
       VALUES ($1, 'بند', 1, $2, $2, $3)`,
      [invoice.id, item.amount, item.doctorId],
    );
  }
  const [visit] = await q<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, doctor_id, status, invoice_id, arrived_at, signed_at, signed_by)
     VALUES ('مريض', $1, $2, 'done', $3, $4::timestamptz, $4::timestamptz, 'test') RETURNING id`,
    [input.patientId, input.visitDoctorId ?? input.items[0].doctorId, invoice.id, input.at],
  );
  return { invoiceId: invoice.id, visitId: visit.id };
}

async function pay(input: {
  patientId: number; invoiceId: number; amount: number; currency: Currency; at?: string;
}): Promise<number> {
  seq += 1;
  const [row] = await q<{ id: number }>(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
       exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
     VALUES ($1, $2, $3, $4, 'payment', $5, $6, 1, $5, $6, 'cash', 'test', COALESCE($7::timestamptz, NOW()))
     RETURNING id`,
    [`P01-R-${seq}`, input.patientId, input.invoiceId, shiftId, input.amount, input.currency, input.at ?? null],
  );
  return row.id;
}

async function refund(input: {
  patientId: number; originId: number; amount: number; currency: Currency; at?: string;
}): Promise<void> {
  seq += 1;
  await q(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
       exchange_rate, base_amount_minor, base_currency, method, created_by, created_at, reversal_of_id)
     SELECT $1, patient_id, invoice_id, shift_id, 'refund', $2, currency, 1, $2, currency, 'cash', 'test',
            COALESCE($3::timestamptz, NOW()), id
       FROM payments WHERE id = $4`,
    [`P01-RF-${seq}`, input.amount, input.at ?? null, input.originId],
  );
}

async function lab(input: {
  patientId: number; visitId: number; doctorId: number | null; cost: number;
  currency: Currency | null; status?: string; toothCode?: number;
}): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO lab_orders (patient_id, lab_name, work_type, sent_date, due_date, status, visit_id,
       doctor_id, cost_minor, cost_currency, tooth_code)
     VALUES ($1, 'مختبر', 'تاج', DATE '2024-03-01', DATE '2024-03-20', $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.patientId, input.status ?? "delivered", input.visitId, input.doctorId, input.cost, input.currency,
      input.toothCode ?? null],
  );
  return row.id;
}

/** مستخدم طبيب مربوط بجهته — بابُ الإعداد المتقدّم كما تفتحه شاشة المستخدمين. */
async function doctorUser(partyId: number, username: string): Promise<number> {
  const user = await createStaffUser({
    username, displayName: username, passwordHash: "x", role: "doctor", partyId,
  });
  return user.id;
}

async function report(from = FAR_PAST, to = "2999-12-31") {
  return commissionReport(from, to);
}
function row(rows: Awaited<ReturnType<typeof report>>, doctorId: number, currency: Currency = "YER") {
  return rows.find((r) => r.doctorId === doctorId && r.currency === currency);
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

beforeEach(async () => {
  // كل حالة في عيادة نظيفة: لا يتسرّب طبيبٌ أو دفعة من حالةٍ إلى أخرى.
  // TRUNCATE لا يطلق حرّاس الصفوف (append-only) — تنظيف قاعدة اختبارٍ معزولة فقط.
  await q(`TRUNCATE doctor_commission_history, payments, expenses, invoice_items, lab_orders, visits,
                    invoices, patients, cashier_shifts, users, parties RESTART IDENTITY CASCADE`);
  const [shift] = await q<{ id: number }>(
    `INSERT INTO cashier_shifts (opened_by) VALUES ('p01') RETURNING id`,
  );
  shiftId = shift.id;
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("إعادة إنتاج عيوب تدقيق الجاهزية (يجب ألا تعود أبدًا)", () => {
  it("AUDIT-1: تكلفة المختبر تُخصم — ١٢٬٠٠٠ لا ١٨٬٠٠٠", async () => {
    const a = await doctor("د. أ", 30);
    const p = await patient();
    const { invoiceId, visitId } = await visitInvoice({
      patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: a, amount: 60000 }],
    });
    await lab({ patientId: p, visitId, doctorId: a, cost: 20000, currency: "YER" });
    await pay({ patientId: p, invoiceId, amount: 60000, currency: "YER", at: `${PAST} 10:00+03` });

    const r = row(await report(), a);
    expect(r?.earnedMinor).toBe(12000);
    expect(r?.earnedMinor).not.toBe(18000);
  });

  it("AUDIT-2: إعدادٌ متقدّم للطبيب أ لا يُخفي عمولة الطبيب ب (٢٬٧٦٠)", async () => {
    const a = await doctor("د. أ", 30);
    const b = await doctor("د. ب", 40);
    const p = await patient();
    const inv = await visitInvoice({
      patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: b, amount: 15000 }],
    });
    await pay({ patientId: p, invoiceId: inv.invoiceId, amount: 6900, currency: "YER", at: `${PAST} 10:00+03` });
    expect(row(await report(), b)?.earnedMinor).toBe(2760);

    const userA = await doctorUser(a, "docA");
    await updateUser(userA, {
      commissionConfig: {
        calculationMode: "percentage", defaultPercent: 35, categoryRates: {}, fixedAmountPerVisitMinor: 0,
        deductLabCost: true, deductMaterialCost: false, basis: "collected_cash", effectiveDate: "", rateHistory: [],
      },
    }, { actor: "owner" });

    const after = row(await report(), b);
    expect(after, "الطبيب ب اختفى من التقرير").toBeDefined();
    expect(after?.earnedMinor).toBe(2760);
  });

  it("AUDIT-3: تغيير النسبة لا يعيد حساب ما قُبض سابقًا — ٢٬٧٦٠ لا ٣٬٤٥٠", async () => {
    const b = await doctor("د. ب", 40);
    const p = await patient();
    const inv = await visitInvoice({
      patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: b, amount: 15000 }],
    });
    await pay({ patientId: p, invoiceId: inv.invoiceId, amount: 6900, currency: "YER", at: `${PAST} 10:00+03` });
    expect(row(await report(), b)?.earnedMinor).toBe(2760);

    await updateParty(b, { commissionPercent: 50 }, { actor: "owner" });

    const after = row(await report(), b);
    expect(after?.earnedMinor).toBe(2760);
    expect(after?.earnedMinor).not.toBe(3450);
  });
});

const NOW_ISO = () => new Date().toISOString();

describe("الحالات ١–١٨: صحة المحرّك", () => {
  it("CASE 1: نسبة عادية بلا مختبر — ٤٠٪ من ١٠٬٠٠٠ مقبوضة = ٤٬٠٠٠", async () => {
    const d = await doctor("د. عادي", 40);
    const p = await patient();
    const { invoiceId } = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: d, amount: 10000 }] });
    await pay({ patientId: p, invoiceId, amount: 10000, currency: "YER", at: `${PAST} 10:00+03` });
    const r = row(await report(), d);
    expect(r).toMatchObject({ accruedMinor: 4000, earnedMinor: 4000, labCostMinor: 0, labCostNotDeductedCount: 0 });
  });

  it("CASE 2: نسبة عادية مع مختبر — الأساس بعد المختبر، والتكلفة ظاهرة على الصف", async () => {
    const d = await doctor("د. تركيبات", 30);
    const p = await patient();
    const { invoiceId, visitId } = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: d, amount: 60000 }] });
    await lab({ patientId: p, visitId, doctorId: d, cost: 20000, currency: "YER" });
    await pay({ patientId: p, invoiceId, amount: 30000, currency: "YER", at: `${PAST} 10:00+03` });
    const r = row(await report(), d);
    // accrued = (60,000 − 20,000) × 30% = 12,000 ؛ المقبوض نصف الفاتورة ⇒ 6,000.
    expect(r).toMatchObject({ accruedMinor: 12000, earnedMinor: 6000, labCostMinor: 20000 });
  });

  it("CASE 3: إعدادٌ متقدّم للطبيب أ والطبيب ب على نسبته العادية — كلٌّ بقاعدته", async () => {
    const a = await doctor("د. أ", 30);
    const b = await doctor("د. ب", 40);
    const userA = await doctorUser(a, "docA3");
    await updateUser(userA, {
      commissionConfig: {
        calculationMode: "percentage", defaultPercent: 50, categoryRates: {}, fixedAmountPerVisitMinor: 0,
        deductLabCost: true, deductMaterialCost: false, basis: "collected_cash", effectiveDate: "", rateHistory: [],
      },
    }, { actor: "owner" });
    const p = await patient();
    const at = NOW_ISO();
    const { invoiceId } = await visitInvoice({ patientId: p, currency: "YER", at, items: [{ doctorId: a, amount: 10000 }, { doctorId: b, amount: 10000 }] });
    await pay({ patientId: p, invoiceId, amount: 20000, currency: "YER" });
    const rows = await report();
    expect(row(rows, a)?.earnedMinor).toBe(5000);
    expect(row(rows, b)?.earnedMinor).toBe(4000);
  });

  it("CASE 4: تعديل إعداد الطبيب أ لا يغيّر الطبيب ب بشيء", async () => {
    const a = await doctor("د. أ", 30);
    const b = await doctor("د. ب", 40);
    const p = await patient();
    const inv = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: a, amount: 10000 }, { doctorId: b, amount: 10000 }] });
    await pay({ patientId: p, invoiceId: inv.invoiceId, amount: 20000, currency: "YER", at: `${PAST} 10:00+03` });
    const before = row(await report(), b);
    const userA = await doctorUser(a, "docA4");
    for (const percent of [10, 60, 25]) {
      await updateUser(userA, {
        commissionConfig: {
          calculationMode: "percentage", defaultPercent: percent, categoryRates: {}, fixedAmountPerVisitMinor: 0,
          deductLabCost: false, deductMaterialCost: false, basis: "invoiced", effectiveDate: "", rateHistory: [],
        },
      }, { actor: "owner" });
      expect(row(await report(), b)).toEqual(before);
    }
    await updateUser(userA, { clearCommissionConfig: true }, { actor: "owner" });
    expect(row(await report(), b)).toEqual(before);
  });

  it("CASE 5: دفعةٌ قبل تغيير النسبة تبقى على نسبتها القديمة", async () => {
    const d = await doctor("د. تاريخي", 40);
    const p = await patient();
    const { invoiceId } = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: d, amount: 10000 }] });
    await pay({ patientId: p, invoiceId, amount: 10000, currency: "YER", at: `${PAST} 10:00+03` });
    await updateParty(d, { commissionPercent: 10 }, { actor: "owner" });
    await updateParty(d, { commissionPercent: 90 }, { actor: "owner" });
    expect(row(await report(), d)).toMatchObject({ accruedMinor: 4000, earnedMinor: 4000 });
  });

  it("CASE 6: تحصيلٌ بعد تغيير النسبة يأخذ الجديدة — والقديم بقديمته", async () => {
    const d = await doctor("د. متدرّج", 40);
    const p = await patient();
    const { invoiceId } = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: d, amount: 20000 }] });
    await pay({ patientId: p, invoiceId, amount: 10000, currency: "YER", at: `${PAST} 10:00+03` });
    await updateParty(d, { commissionPercent: 50 }, { actor: "owner" });
    await pay({ patientId: p, invoiceId, amount: 10000, currency: "YER" }); // الآن
    // النصف الأول بـ٤٠٪ (4,000) والثاني بـ٥٠٪ (5,000). والمستحق على الفاتورة بنسبة يومها (8,000).
    expect(row(await report(), d)).toMatchObject({ accruedMinor: 8000, earnedMinor: 9000 });
  });

  it("CASE 7: دفعة جزئية — نصيبها وحده", async () => {
    const d = await doctor("د. جزئي", 40);
    const p = await patient();
    const { invoiceId } = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: d, amount: 10000 }] });
    await pay({ patientId: p, invoiceId, amount: 2500, currency: "YER", at: `${PAST} 10:00+03` });
    expect(row(await report(), d)).toMatchObject({ accruedMinor: 4000, earnedMinor: 1000 });
  });

  it("CASE 8: دفعات متعددة — مجموعها، ولا يتجاوز الفاتورة ما فاض", async () => {
    const d = await doctor("د. أقساط", 40);
    const p = await patient();
    const { invoiceId } = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: d, amount: 10000 }] });
    for (const [amount, hour] of [[2000, 10], [3000, 11], [5000, 12], [7000, 13]] as const) {
      await pay({ patientId: p, invoiceId, amount, currency: "YER", at: `${PAST} ${hour}:00+03` });
    }
    // المقبوض 17,000 على فاتورة 10,000: الفائض رصيدٌ للمريض لا عمولة عليه.
    expect(row(await report(), d)).toMatchObject({ accruedMinor: 4000, earnedMinor: 4000 });
  });

  it("CASE 9: الردّ الجزئي والكامل ينقصان العمولة من أصلهما", async () => {
    const d = await doctor("د. ردود", 40);
    const p = await patient();
    const { invoiceId } = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: d, amount: 10000 }] });
    const origin = await pay({ patientId: p, invoiceId, amount: 10000, currency: "YER", at: `${PAST} 10:00+03` });
    await refund({ patientId: p, originId: origin, amount: 4000, currency: "YER", at: `${PAST} 11:00+03` });
    expect(row(await report(), d)?.earnedMinor).toBe(2400);
    await refund({ patientId: p, originId: origin, amount: 6000, currency: "YER", at: `${PAST} 12:00+03` });
    expect(row(await report(), d)?.earnedMinor ?? 0).toBe(0);
    // والمستحق على الفاتورة يبقى أثرًا للعمل المنجز.
    expect(row(await report(), d)?.accruedMinor).toBe(4000);
  });

  it("CASE 10: المختبر يُخصم مرّةً واحدة — مهما تعدّدت بنود الطبيب أو التقارير، ولا الملغى ولا مختبر زميله", async () => {
    const a = await doctor("د. أ", 30);
    const b = await doctor("د. ب", 30);
    const p = await patient();
    const { invoiceId, visitId } = await visitInvoice({
      patientId: p, currency: "YER", at: `${PAST} 09:00+03`,
      items: [{ doctorId: a, amount: 30000 }, { doctorId: a, amount: 30000 }, { doctorId: b, amount: 10000 }],
    });
    await lab({ patientId: p, visitId, doctorId: a, cost: 20000, currency: "YER", toothCode: 11 });
    await lab({ patientId: p, visitId, doctorId: a, cost: 99999, currency: "YER", toothCode: 12, status: "cancelled" });
    await lab({ patientId: p, visitId, doctorId: b, cost: 4000, currency: "YER", toothCode: 21 });
    await pay({ patientId: p, invoiceId, amount: 70000, currency: "YER", at: `${PAST} 10:00+03` });
    const first = await report();
    expect(row(first, a)).toMatchObject({ earnedMinor: 12000, labCostMinor: 20000 }); // (60,000 − 20,000) × 30%
    expect(row(first, b)).toMatchObject({ earnedMinor: 1800, labCostMinor: 4000 }); // (10,000 − 4,000) × 30%
    expect(await report()).toEqual(first);
  });

  it("CASE 11: طبيبان بإجراءين منفصلين — لكلٍّ حصته ومختبره", async () => {
    const a = await doctor("د. أ", 30);
    const b = await doctor("د. ب", 40);
    const p = await patient();
    const { invoiceId, visitId } = await visitInvoice({
      patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: a, amount: 10000 }, { doctorId: b, amount: 20000 }],
    });
    await lab({ patientId: p, visitId, doctorId: b, cost: 5000, currency: "YER" });
    await pay({ patientId: p, invoiceId, amount: 30000, currency: "YER", at: `${PAST} 10:00+03` });
    const rows = await report();
    expect(row(rows, a)?.earnedMinor).toBe(3000);
    expect(row(rows, b)?.earnedMinor).toBe(6000);
  });

  it("CASE 12–14: يمني وسعودي ودولار — ثلاثة أرصدة مستقلة بلا تحويل", async () => {
    const d = await doctor("د. عملات", 30);
    const p = await patient();
    const yer = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: d, amount: 500000 }] });
    const sar = await visitInvoice({ patientId: p, currency: "SAR", at: `${PAST} 09:10+03`, items: [{ doctorId: d, amount: 110000 }] });
    const usd = await visitInvoice({ patientId: p, currency: "USD", at: `${PAST} 09:20+03`, items: [{ doctorId: d, amount: 16667 }] });
    await lab({ patientId: p, visitId: sar.visitId, doctorId: d, cost: 10000, currency: "SAR" });
    // مختبرٌ باليمني على فاتورةٍ بالدولار: لا يُحوَّل بسعرٍ مخترع — لا يُخصم ويُعدّ.
    await lab({ patientId: p, visitId: usd.visitId, doctorId: d, cost: 3000, currency: "YER" });
    await pay({ patientId: p, invoiceId: yer.invoiceId, amount: 500000, currency: "YER", at: `${PAST} 10:00+03` });
    await pay({ patientId: p, invoiceId: sar.invoiceId, amount: 110000, currency: "SAR", at: `${PAST} 10:10+03` });
    await pay({ patientId: p, invoiceId: usd.invoiceId, amount: 16667, currency: "USD", at: `${PAST} 10:20+03` });
    const rows = await report();
    expect(row(rows, d, "YER")).toMatchObject({ earnedMinor: 150000, labCostNotDeductedCount: 0 });
    expect(row(rows, d, "SAR")).toMatchObject({ earnedMinor: 30000, labCostMinor: 10000 }); // 300.00 SAR
    expect(row(rows, d, "USD")).toMatchObject({ earnedMinor: 5000, labCostMinor: 0, labCostNotDeductedCount: 1 }); // 50.00 USD
    expect(rows.filter((r) => r.doctorId === d)).toHaveLength(3);
  });

  it("CASE 15: طبيبٌ بلا نسبة لا عمولة له ولا يُسقط غيره — وطبيبٌ أُدرج خارج التطبيق يُقرأ بقيمته الحيّة", async () => {
    const zero = await doctor("د. بلا نسبة", 0);
    const [legacy] = await q<{ id: number }>(
      `INSERT INTO parties (name, kind, commission_percent) VALUES ('د. قديم', 'doctor', 25) RETURNING id`,
    );
    const p = await patient();
    const { invoiceId } = await visitInvoice({
      patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: zero, amount: 10000 }, { doctorId: legacy.id, amount: 10000 }],
    });
    await pay({ patientId: p, invoiceId, amount: 20000, currency: "YER", at: `${PAST} 10:00+03` });
    const rows = await report();
    expect(row(rows, zero)).toBeUndefined();
    expect(row(rows, legacy.id)?.earnedMinor).toBe(2500);
    // وأول تغييرٍ عليه يلتقط شروطه القديمة أولًا — فلا يُعاد كتابة ماضيه.
    await updateParty(legacy.id, { commissionPercent: 80 }, { actor: "owner" });
    expect(row(await report(), legacy.id)?.earnedMinor).toBe(2500);
  });

  it("CASE 16: الفاتورة الملغاة لا عمولة عليها، والمختبر الملغى لا يُخصم", async () => {
    const d = await doctor("د. إلغاء", 40);
    const p = await patient();
    const cancelled = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: d, amount: 10000 }] });
    await pay({ patientId: p, invoiceId: cancelled.invoiceId, amount: 10000, currency: "YER", at: `${PAST} 10:00+03` });
    await q(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [cancelled.invoiceId]);
    const kept = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 11:00+03`, items: [{ doctorId: d, amount: 5000 }] });
    await lab({ patientId: p, visitId: kept.visitId, doctorId: d, cost: 5000, currency: "YER", status: "cancelled" });
    const rows = await report();
    // الدفعة على الملغاة تبقى رصيدًا للمريض — تغطّي الفاتورة القائمة (5,000) وحدها.
    expect(row(rows, d)).toMatchObject({ accruedMinor: 2000, earnedMinor: 2000, labCostMinor: 0 });
  });

  it("CASE 17: تغيير الإعداد المتقدّم والنسبة يُدوَّن بالقيمة قبل وبعد والسريان والفاعل", async () => {
    const d = await doctor("د. تدقيق", 30);
    await updateParty(d, { commissionPercent: 45 }, { actor: "owner", actorRole: "admin", reason: "عقد جديد" });
    const user = await doctorUser(d, "docAudit");
    await updateUser(user, {
      commissionConfig: {
        calculationMode: "by_category", defaultPercent: 33, categoryRates: { ortho: 40 }, fixedAmountPerVisitMinor: 0,
        deductLabCost: true, deductMaterialCost: false, basis: "collected_cash", effectiveDate: "", rateHistory: [],
      },
    }, { actor: "owner", actorRole: "admin", reason: "نسب التخصص" });
    const audits = await q<{ actor: string; actor_role: string; details: Record<string, unknown> }>(
      `SELECT actor, actor_role, details FROM audit_log
        WHERE action = 'doctor.commission.update' AND entity = 'party' AND entity_id = $1 ORDER BY id`,
      [String(d)],
    );
    const party = audits.find((a) => a.details["السبب"] === "عقد جديد");
    expect(party?.actor).toBe("owner");
    expect(party?.details["قبل_القيمة"]).toMatchObject({ percent: 30, config: null });
    expect(party?.details["بعد_القيمة"]).toMatchObject({ percent: 45, config: null });
    expect(typeof party?.details["نافذ_من"]).toBe("string");
    const advanced = audits.find((a) => a.details["السبب"] === "نسب التخصص");
    expect(advanced?.details["قبل_القيمة"]).toMatchObject({ percent: 45, config: null });
    expect((advanced?.details["بعد_القيمة"] as { config: { defaultPercent: number } }).config.defaultPercent).toBe(33);
    expect(advanced?.details["سجل_العمولة"]).toBeTypeOf("number");
  });

  it("CASE 18: تقارير متكرّرة ومتزامنة تعطي النتيجة نفسها حرفيًّا", async () => {
    const a = await doctor("د. أ", 30);
    const b = await doctor("د. ب", 40);
    const p = await patient();
    const { invoiceId, visitId } = await visitInvoice({
      patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: a, amount: 33333 }, { doctorId: b, amount: 22222 }],
    });
    await lab({ patientId: p, visitId, doctorId: a, cost: 7777, currency: "YER" });
    await pay({ patientId: p, invoiceId, amount: 12345, currency: "YER", at: `${PAST} 10:00+03` });
    await updateParty(b, { commissionPercent: 55 }, { actor: "owner" });
    await pay({ patientId: p, invoiceId, amount: 23456, currency: "YER" });
    const results = await Promise.all(Array.from({ length: 6 }, () => report()));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await report()).toEqual(results[0]);
  });
});

describe("سلامة السجل الزمني", () => {
  it("السجل append-only: لا تعديل ولا حذف حتى من SQL مباشر", async () => {
    const d = await doctor("د. سجل", 30);
    await expect(q(`UPDATE doctor_commission_history SET percent = 99 WHERE party_id = $1`, [d]))
      .rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM doctor_commission_history WHERE party_id = $1`, [d]))
      .rejects.toThrow(/append-only/);
    await expect(q(`UPDATE parties SET commission_percent = 150 WHERE id = $1`, [d]))
      .rejects.toThrow(/parties_commission_percent_range/);
  });

  it("إزالة الإعداد المتقدّم مستقبلية: ما قُبض أثناءه يبقى بنسبته", async () => {
    const d = await doctor("د. إزالة", 20);
    const user = await doctorUser(d, "docClear");
    await updateUser(user, {
      commissionConfig: {
        calculationMode: "percentage", defaultPercent: 60, categoryRates: {}, fixedAmountPerVisitMinor: 0,
        deductLabCost: true, deductMaterialCost: false, basis: "collected_cash", effectiveDate: "", rateHistory: [],
      },
    }, { actor: "owner" });
    const p = await patient();
    const { invoiceId } = await visitInvoice({ patientId: p, currency: "YER", at: NOW_ISO(), items: [{ doctorId: d, amount: 10000 }] });
    await pay({ patientId: p, invoiceId, amount: 5000, currency: "YER" });
    await updateUser(user, { clearCommissionConfig: true }, { actor: "owner" });
    await pay({ patientId: p, invoiceId, amount: 5000, currency: "YER" });
    // النصف الأول بـ٦٠٪ (3,000) والثاني بعد الإزالة بنسبة الجهة ٢٠٪ (1,000).
    expect(row(await report(), d)?.earnedMinor).toBe(4000);
  });

  it("ربط حسابٍ بإعدادٍ متقدّم بجهةٍ يسري من لحظة الربط لا قبلها", async () => {
    const d = await doctor("د. ربط", 25);
    const p = await patient();
    const { invoiceId } = await visitInvoice({ patientId: p, currency: "YER", at: `${PAST} 09:00+03`, items: [{ doctorId: d, amount: 10000 }] });
    await pay({ patientId: p, invoiceId, amount: 10000, currency: "YER", at: `${PAST} 10:00+03` });
    const user = await createStaffUser({
      username: "unlinked", displayName: "حساب بلا جهة", passwordHash: "x", role: "reception",
      commissionConfig: {
        calculationMode: "percentage", defaultPercent: 90, categoryRates: {}, fixedAmountPerVisitMinor: 0,
        deductLabCost: true, deductMaterialCost: false, basis: "collected_cash", effectiveDate: "", rateHistory: [],
      },
    });
    await db.linkUserDoctor(user.id, d, { actor: "owner" });
    expect(row(await report(), d)?.earnedMinor).toBe(2500);
  });

  it("بذر الهجرة حتمي ولا يتكرّر: خطّ أساس بقيمة اللحظة وإعداد أحدث مستخدم", async () => {
    const { DOCTOR_COMMISSION_HISTORY_SQL } = await import("../../lib/commission-history-schema");
    const [legacy] = await q<{ id: number }>(
      `INSERT INTO parties (name, kind, commission_percent) VALUES ('د. قبل السجل', 'doctor', 35) RETURNING id`,
    );
    await q(`INSERT INTO users (username, display_name, password_hash, role, party_id, commission_config)
             VALUES ('old1', 'قديم ١', 'x', 'doctor', $1, '{"defaultPercent": 10}'),
                    ('old2', 'قديم ٢', 'x', 'doctor', $1, '{"defaultPercent": 20}'),
                    ('old3', 'قديم ٣', 'x', 'doctor', $1, 'ليس JSON')`, [legacy.id]);
    await q(DOCTOR_COMMISSION_HISTORY_SQL);
    await q(DOCTOR_COMMISSION_HISTORY_SQL);
    const rows = await q<{ percent: string; config: { defaultPercent?: number } | null; effective_from: Date; source: string }>(
      `SELECT percent, config, effective_from, source FROM doctor_commission_history WHERE party_id = $1`, [legacy.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("baseline");
    expect(Number(rows[0].percent)).toBe(35);
    expect(new Date(rows[0].effective_from).toISOString()).toBe("1970-01-01T00:00:00.000Z");
    // أحدث مستخدم (old3) نصّه ليس JSON ⇒ لا إعداد؛ القاعدة الحتمية «أكبر id» لا تقفز إلى غيره.
    expect(rows[0].config).toBeNull();
  });
});
