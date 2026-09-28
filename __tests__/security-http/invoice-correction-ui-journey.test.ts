import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * (FIN-2) المالك: «نخطئ بزيادة مبلغ على المريض وما عاد نقدر نعدّل».
 * في متصفحٍ حقيقي: المدير يفتح حساب المريض، «تصحيح» على الفاتورة، يخفّض السعر ويكتب
 * السبب — فتُلغى الفاتورة وتصدر المصحَّحة ويظهر ذلك في الحساب. والاستقبال لا يرى الزر.
 */

let browser: Browser;
let db: Client;
let patientId = 0;
let h: Awaited<ReturnType<typeof harness>>;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض فاتورة زائدة') RETURNING id`, [`FIN2U-${Date.now()}`]));
  const { rows: [invoice] } = await db.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
     VALUES ($1, $2, 80000, 0, 'YER', 'reception') RETURNING id`, [`FIN2U-INV-${Date.now()}`, patientId]);
  await db.query(
    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
     VALUES ($1, 'تنظيف وتلميع', 1, 80000, 80000)`, [invoice.id]);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await db?.end();
});

async function openAccount(cookie: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(cookie), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`);
  await page.getByRole("button", { name: /الحساب/ }).first().click();
  await page.getByRole("region", { name: "الفواتير" }).getByText("تنظيف وتلميع").first().waitFor();
  return { context, page };
}

describe("تصحيح فاتورةٍ بمبلغٍ زائد من حساب المريض", () => {
  it("the admin lowers the price with a reason; the ledger shows the cancelled original and the corrected invoice", async () => {
    const { context, page } = await openAccount(h.sessions.admin.cookie);
    try {
      const invoices = page.getByRole("region", { name: "الفواتير" });
      await invoices.getByRole("button", { name: "تصحيح" }).click();
      const editor = page.getByRole("group", { name: /^تصحيح / });
      await editor.getByLabel("سعر تنظيف وتلميع").fill("50000");
      await editor.getByLabel("سبب التصحيح").fill("السعر المعتمد ٥٠ ألفًا");
      await editor.getByText(/تخفيض/).waitFor();
      await editor.getByRole("button", { name: "صحّح الفاتورة" }).click();
      await page.getByRole("status").getByText(/وصدرت بدلها/).waitFor();

      const { rows } = await db.query<{ status: string; total_minor: string }>(
        `SELECT status, total_minor::text FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId]);
      expect(rows).toEqual([{ status: "cancelled", total_minor: "80000" }, { status: "open", total_minor: "50000" }]);
      await invoices.getByText(/^تصحيح للفاتورة/).waitFor();
    } finally {
      await context.close();
    }
  }, 120_000);

  it("reception sees no correction button", async () => {
    const { context, page } = await openAccount(h.sessions.reception.cookie);
    try {
      expect(await page.getByRole("region", { name: "الفواتير" }).getByRole("button", { name: "تصحيح" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 120_000);
});
