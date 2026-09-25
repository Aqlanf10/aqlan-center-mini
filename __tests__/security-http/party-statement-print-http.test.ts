import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/**
 * كشف حساب جهة المطبوع (/print/party/[id]) وواجهته على التطبيق المبني.
 *
 * الورقة مالية: للإدارة والاستقبال فقط، والطبيب يرى 404 لا ورقة. والاسم يظهر
 * حتى لجهةٍ لا التزامات لها (كان العنوان يُقرأ من أول التزام فيبقى فارغًا).
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let emptyLabId = 0;
let supplierId = 0;
const get = (path: string, cookie: string) => fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: "manual" });

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: emptyLabId }] } = await db.query<{ id: number }>(
    `INSERT INTO parties (name, kind) VALUES ('مختبر بلا حركات', 'lab') RETURNING id`,
  ));
  ({ rows: [{ id: supplierId }] } = await db.query<{ id: number }>(
    `INSERT INTO parties (name, kind, phone) VALUES ('مورد الكشف المطبوع', 'supplier', '777000111') RETURNING id`,
  ));
  await db.query(
    `INSERT INTO payables (party_id, category, description, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, created_by)
     VALUES ($1, 'supplier', 'فاتورة مواد سبتمبر', 25000, 'SAR', 140, 3500000, 'YER', 'test'),
            ($1, 'supplier', 'فاتورة قفازات', 80000, 'YER', 1, 80000, 'YER', 'test')`,
    [supplierId],
  );
}, 240_000);

afterAll(async () => {
  await db?.end();
});

describe("كشف حساب جهة — الطباعة", () => {
  it("الإدارة والاستقبال يطبعان الكشف بالاسم والتوقيع ولكل عملة سطرها", async () => {
    for (const session of [h.sessions.admin, h.sessions.reception]) {
      const response = await get(`/print/party/${supplierId}`, session.cookie);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("كشف حساب جهة");
      expect(html).toContain("مورد الكشف المطبوع");
      expect(html).toContain("فاتورة مواد سبتمبر");
      expect(html).toContain("المتبقي علينا");
      expect(html).toContain("عن العيادة");
      expect(html).toContain("ريال سعودي");
    }
  });

  it("الطبيب والمحاسب بلا صلاحية مال لا يريان الورقة", async () => {
    expect((await get(`/print/party/${supplierId}`, h.sessions.doctorA.cookie)).status).toBe(404);
    expect((await get(`/print/party/${supplierId}`, h.sessions.accountant.cookie)).status).toBe(404);
  });

  it("جهة غير موجودة أو رقم غير صالح ⇒ 404", async () => {
    expect((await get(`/print/party/999999`, h.sessions.admin.cookie)).status).toBe(404);
    expect((await get(`/print/party/abc`, h.sessions.admin.cookie)).status).toBe(404);
  });
});

describe("كشف حساب جهة — الواجهة البرمجية", () => {
  it("جهة بلا التزامات يعود اسمها والإجمالي فارغ", async () => {
    const response = await get(`/api/payables?partyId=${emptyLabId}`, h.sessions.admin.cookie);
    expect(response.status).toBe(200);
    const payload = await response.json() as { party: { name: string }; totals: unknown[]; payables: unknown[] };
    expect(payload.party.name).toBe("مختبر بلا حركات");
    expect(payload.payables).toEqual([]);
    expect(payload.totals).toEqual([]);
  });

  it("الإجمالي لكل عملة بعملتها", async () => {
    const response = await get(`/api/payables?partyId=${supplierId}`, h.sessions.reception.cookie);
    const payload = await response.json() as { totals: { currency: string; owedMinor: number; remainingMinor: number }[] };
    expect(payload.totals.map((row) => [row.currency, row.owedMinor, row.remainingMinor])).toEqual([
      ["YER", 80_000, 80_000],
      ["SAR", 25_000, 25_000],
    ]);
  });

  it("جهة غير موجودة ⇒ 404 برسالة عربية", async () => {
    const response = await get(`/api/payables?partyId=999999`, h.sessions.admin.cookie);
    expect(response.status).toBe(404);
    expect((await response.json() as { message: string }).message).toBe("الجهة غير موجودة.");
  });
});

describe("(P2-14) كشف عمولة الطبيب المطبوع مخالصةٌ موقّعة", () => {
  it("يحمل سطور توقيع الطبيب والمحاسب والمدير", async () => {
    const response = await get(`/print/report?report=doctor-commission&preset=this_month`, h.sessions.admin.cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("توقيع الطبيب");
    expect(html).toContain("المحاسب");
  });

  it("تقريرٌ غير تسوية لا يحمل سطور التوقيع", async () => {
    const response = await get(`/print/report?report=appointment-performance&preset=this_month`, h.sessions.admin.cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("توقيع الطبيب");
  });
});
