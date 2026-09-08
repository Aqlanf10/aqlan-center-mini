import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات تاريخ أسعار الخدمات (P1.11).
 *
 * المبدأ: الأسعار التاريخية في treatment/payment/invoice لا تتغير لأن مدير
 * المركز عدّل سعر الخدمة لاحقًا — snapshot عند الحدث. والسعر التخميني
 * (provisional) يبقى موسومًا حتى يُعتمد صراحةً، ولا يتحول إلى نهائي بصمت.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  getPool, resetPoolForTesting, ensureSchema,
  createService, updateService, listServices,
  fillProvisionalServicePrices, priceServiceBatch,
  createInvoice, listPatientInvoices,
} = await import("../lib/db");
const { provisionalFills } = await import("../lib/provisionalPrices");

let patientId: number;

async function serviceIdByName(name: string): Promise<number> {
  const { rows: [row] } = await getPool().query(`SELECT id FROM services WHERE name = $1`, [name]);
  return row.id;
}

beforeAll(async () => {
  await ensureSchema();
  const { rows: [patient] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('PRICE-P1', 'مريض الأسعار') RETURNING id`,
  );
  patientId = patient.id;
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("snapshot الأسعار عند الحدث", () => {
  it("عناصر الفاتورة تحفظ سعرها لحظة الإنشاء — تعديل الخدمة لاحقًا لا يمسها", async () => {
    const created = await createService({ name: "تنظيف PRICE", category: "general", priceMinor: 15000 });
    expect(created).not.toBeNull();
    const serviceId = await serviceIdByName("تنظيف PRICE");

    const invoice = await createInvoice({
      patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "test",
      items: [{ serviceId, doctorId: null, description: "تنظيف", quantity: 2, unitPriceMinor: 15000 }],
    });
    expect(invoice).not.toBeNull();
    expect(invoice!.totalMinor).toBe(30000);

    // المدير يعدّل سعر الخدمة بعد الفاتورة
    await updateService(serviceId, { priceMinor: 99999 });

    const invoices = await listPatientInvoices(patientId);
    const sameInvoice = invoices.find((row) => row.id === invoice!.id);
    expect(sameInvoice).toBeDefined();
    expect(sameInvoice!.totalMinor).toBe(30000); // رقم الفاتورة التاريخي ثابت

    const { rows: [item] } = await getPool().query(
      `SELECT unit_price_minor, total_minor FROM invoice_items WHERE invoice_id = $1`, [invoice!.id],
    );
    expect(Number(item.unit_price_minor)).toBe(15000);
    expect(Number(item.total_minor)).toBe(30000);
  });

  it("عناصر خطة العلاج تحفظ الاسم والسعر لحظة الاتفاق — تعديل الخدمة لا يمسها", async () => {
    const pool = getPool();
    const serviceId = await serviceIdByName("تنظيف PRICE");
    // الخطة تُنشأ عادة عبر واجهة علاج كاملة؛ هنا نثبت العقد: الاسم والسعر منسوخان
    const { rows: [plan] } = await pool.query(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, status, base_currency, created_by)
       VALUES ($1, 'خطة الأسعار', 15000, 'active', 'YER', 'test') RETURNING id`, [patientId],
    );
    await pool.query(
      `INSERT INTO plan_items (plan_id, service_id, service_name, unit_price_minor, quantity)
       VALUES ($1, $2, 'تنظيف PRICE', 15000, 1)`, [plan.id, serviceId],
    );

    await updateService(serviceId, { priceMinor: 123, name: "تنظيف PRICE المعدّل" });

    const { rows: [item] } = await pool.query(
      `SELECT service_name, unit_price_minor FROM plan_items WHERE plan_id = $1`, [plan.id],
    );
    expect(item.service_name).toBe("تنظيف PRICE"); // الاسم نسخة، لا مرجع حيّ
    expect(Number(item.unit_price_minor)).toBe(15000);
  });

  it("السعر التخميني يبقى موسومًا provisional حتى اعتماد صريح — لا يتحول نهائيًّا بصمت", async () => {
    const pool = getPool();
    // خدمة بلا سعر
    await createService({ name: "خدمة تخمينية PRICE", category: "cleaning", priceMinor: 0 });
    const serviceId = await serviceIdByName("خدمة تخمينية PRICE");

    // ملء تخميني: يوسم provisional=TRUE وconfigured=FALSE
    const fills = provisionalFills(await listServices());
    const filled = await fillProvisionalServicePrices(fills, "test");
    expect(filled.ok).toBe(true);
    expect(fills.some((fill) => fill.id === serviceId)).toBe(true); // خدمتنا بلا سعر فتُملأ
    const { rows: [row] } = await pool.query(
      `SELECT price_provisional, price_configured FROM services WHERE id = $1`, [serviceId],
    );
    expect(row.price_provisional).toBe(true);
    expect(row.price_configured).toBe(false);

    // تحديث اسم الخدمة فقط (بلا سعر) ⇒ لا يلمس الوسم
    await updateService(serviceId, { name: "خدمة تخمينية PRICE ٢" });
    const { rows: [row2] } = await pool.query(
      `SELECT price_provisional, price_configured FROM services WHERE id = $1`, [serviceId],
    );
    expect(row2.price_provisional).toBe(true);

    // اعتماد صريح للسعر ⇒ provisional يُرفع صراحةً
    await updateService(serviceId, { priceMinor: 25000 });
    const { rows: [row3] } = await pool.query(
      `SELECT price_provisional, price_configured FROM services WHERE id = $1`, [serviceId],
    );
    expect(row3.price_provisional).toBe(false);
    expect(row3.price_configured).toBe(true);
  });

  it("priceServiceBatch: اعتماد دفعة أسعار صريح يرفع الوسم التخميني ويثبّت السعر", async () => {
    const serviceId = await serviceIdByName("خدمة تخمينية PRICE ٢");
    const result = await priceServiceBatch([{ id: serviceId, priceMinor: 20000 }], "test");
    expect(result.ok).toBe(true);
    const { rows: [row] } = await getPool().query(
      `SELECT price_provisional, price_configured, price_minor FROM services WHERE id = $1`, [serviceId],
    );
    expect(row.price_provisional).toBe(false);
    expect(row.price_configured).toBe(true);
    expect(Number(row.price_minor)).toBe(20000);
  });

  it("قائمة الخدمات تعلن الوسمين — الواجهة تستطيع تمييز التخميني", async () => {
    // خدمة تخمينية جديدة (لم تُعتمد بعد)
    await createService({ name: "خدمة تخمينية إضافية PRICE", category: "rct", priceMinor: 0 });
    const fills = provisionalFills(await listServices());
    const extraId = await serviceIdByName("خدمة تخمينية إضافية PRICE");
    await fillProvisionalServicePrices(fills.filter((fill) => fill.id === extraId), "test");

    const services = await listServices();
    const provisional = services.find((row) => row.name === "خدمة تخمينية إضافية PRICE");
    const configured = services.find((row) => row.name === "تنظيف PRICE المعدّل");
    expect(provisional?.priceProvisional).toBe(true);
    expect(provisional?.priceConfigured).toBe(false);
    expect(configured?.priceConfigured).toBe(true);
  });
});
