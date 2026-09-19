import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/**
 * اختبارات P-01 على HTTP حقيقي — شكل عقد الـ API للعملات المختلطة.
 *
 * البذرة: مريضٌ خاص بهذا الملف له ثلاث فواتير (100,000 ر.ي و100,000 ر.س
 * و10,000 $) ببندٍ واحدٍ لكلٍّ منها. ثم يُقرأ العقد كما يقرأه المتصفح:
 *  * /api/finance/report — المفوتر بكل عملة على حدة (invoicedByCurrency)،
 *    والعدد المختلط invoicedMinor حُذف، والخدمات الأكثر موسومةٌ بعملتها.
 *  * /api/finance/debts — صفٌّ لكل (مريض × عملة)، كلٌّ بعملته ورصيد دلوها.
 *
 * المطابقة بالفرق (قبل البذر وبعده): جولة الاختبارات قاعدةٌ مشتركة، فقد يخلّف
 * ملفٌّ سابقٌ بذره؛ الفرق عن خط الأساس يُثبت إسهام بذرتنا وحده بدل الرقم
 * المطلق الذي قد يمازجه إسهام غيرنا.
 */

let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patientId = 0;

const SERVICE_DESCRIPTION = "تنظيف P-01";

interface FinanceReportPayload {
  invoicedByCurrency?: Record<string, number>;
  invoicedMinor?: number;
  invoiceCount?: number;
  patientCount?: number;
  topServices?: { name: string; count: number; totalMinor: number; currency: string }[];
}

interface DebtsPayload {
  rows?: {
    patientId: number; patientName: string; currency: string;
    billedMinor: number; dueMinor: number;
  }[];
  baseCurrency?: string;
}

function reportSnapshot(): Promise<Response> {
  return fetch(`${baseUrl}/api/finance/report`, {
    headers: { Cookie: h.sessions.admin.cookie },
    redirect: "manual",
  });
}

function debtsSnapshot(): Promise<Response> {
  return fetch(`${baseUrl}/api/finance/debts`, {
    headers: { Cookie: h.sessions.admin.cookie },
    redirect: "manual",
  });
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 240_000);

afterAll(async () => {
  if (db) {
    await db.query(`DELETE FROM invoices WHERE patient_id = $1`, [patientId]).catch(() => {});
    await db.query(`DELETE FROM patients WHERE id = $1`, [patientId]).catch(() => {});
    await db.end();
  }
});

describe("P-01 على HTTP: /api/finance/report بكل عملة على حدة", () => {
  let baseline: FinanceReportPayload;
  let after: FinanceReportPayload;

  beforeAll(async () => {
    const before = await reportSnapshot();
    expect(before.status).toBe(200);
    baseline = await before.json();

    const { rows: [patient] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('P01-HTTP-1', 'مريض P-01 HTTP') RETURNING id`,
    );
    patientId = patient.id;

    const seeds: { number: string; currency: string; totalMinor: number }[] = [
      { number: "P01-HTTP-INV-YER", currency: "YER", totalMinor: 100000 },
      { number: "P01-HTTP-INV-SAR", currency: "SAR", totalMinor: 100000 },
      { number: "P01-HTTP-INV-USD", currency: "USD", totalMinor: 10000 },
    ];
    for (const seed of seeds) {
      const { rows: [invoice] } = await db.query<{ id: number }>(
        `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at)
         VALUES ($1, $2, 'open', $3, 0, $4, NOW()) RETURNING id`,
        [seed.number, patientId, seed.totalMinor, seed.currency],
      );
      await db.query(
        `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor)
         VALUES ($1, NULL, $2, 1, $3, $3)`,
        [invoice.id, SERVICE_DESCRIPTION, seed.totalMinor],
      );
    }

    const afterResponse = await reportSnapshot();
    expect(afterResponse.status).toBe(200);
    after = await afterResponse.json();
  }, 120_000);

  it("المفوتر ثلاثة دلاب — فرق البذر يطابق بذرتنا بكل عملة", async () => {
    expect(after.invoicedByCurrency).toBeDefined();
    expect(after.invoicedByCurrency!.YER - (baseline.invoicedByCurrency?.YER ?? 0)).toBe(100000);
    expect(after.invoicedByCurrency!.SAR - (baseline.invoicedByCurrency?.SAR ?? 0)).toBe(100000);
    expect(after.invoicedByCurrency!.USD - (baseline.invoicedByCurrency?.USD ?? 0)).toBe(10000);
  });

  it("العدد المختلط invoicedMinor غير موجود في العقد — وحذفه ليس فرقًا بل بنية", async () => {
    expect("invoicedMinor" in after).toBe(false);
    expect("invoicedMinor" in baseline).toBe(false);
  });

  it("الخدمات الأكثر موسومةٌ بعملتها — ثلاثة صفوف لبذرتنا، بلا ترتيبٍ عبر العملات", async () => {
    const mine = (after.topServices ?? []).filter((service) => service.name === SERVICE_DESCRIPTION);
    expect(mine).toHaveLength(3);
    expect(new Set(mine.map((service) => service.currency))).toEqual(new Set(["YER", "SAR", "USD"]));
    for (const service of mine) {
      expect(service.count).toBe(1);
      expect(service.totalMinor).not.toBe(210000);
      if (service.currency === "YER") expect(service.totalMinor).toBe(100000);
      if (service.currency === "SAR") expect(service.totalMinor).toBe(100000);
      if (service.currency === "USD") expect(service.totalMinor).toBe(10000);
    }
  });

  it("عدد الفواتير زاد بثلاث، والمريض واحد لا ثلاثة", async () => {
    expect((after.invoiceCount ?? 0) - (baseline.invoiceCount ?? 0)).toBe(3);
    expect((after.patientCount ?? 0) - (baseline.patientCount ?? 0)).toBe(1);
  });
});

describe("P-01 على HTTP: /api/finance/debts صفٌّ لكل (مريض × عملة)", () => {
  it("مريض الثلاث عملات ثلاثة صفوف — كلٌّ بعملته ورصيد دلوه", async () => {
    const response = await debtsSnapshot();
    expect(response.status).toBe(200);
    const payload: DebtsPayload = await response.json();
    expect(payload.baseCurrency).toBe("YER");

    const mine = (payload.rows ?? []).filter((row) => row.patientId === patientId);
    expect(mine).toHaveLength(3);
    expect(new Set(mine.map((row) => row.currency))).toEqual(new Set(["YER", "SAR", "USD"]));
    for (const row of mine) {
      expect(row.dueMinor).not.toBe(210000);
      if (row.currency === "YER") expect(row.dueMinor).toBe(100000);
      if (row.currency === "SAR") expect(row.dueMinor).toBe(100000);
      if (row.currency === "USD") expect(row.dueMinor).toBe(10000);
    }
  });

  it("الطبيب بلا صلاحية المالية المخفية محجوب من التقرير المالي (403)", async () => {
    const report = await fetch(`${baseUrl}/api/finance/report`, {
      headers: { Cookie: h.sessions.doctorA.cookie },
      redirect: "manual",
    });
    expect(report.status).toBe(403);
  });

  it("والاستقبال — من يقبض المال — يقرأ المديونية (200)", async () => {
    const response = await fetch(`${baseUrl}/api/finance/debts`, {
      headers: { Cookie: h.sessions.reception.cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
  });
});
