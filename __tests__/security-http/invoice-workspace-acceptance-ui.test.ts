import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";

let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId: number;
let pricedId: number;
let missingId: number;
let disabledId: number;
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic invoice acceptance') RETURNING id", [`INV-ACCEPT-${Date.now()}`])).rows[0].id;
  const service = async (name: string, active: boolean, configured: boolean, yer: number, sar: number | null, usd: number | null) =>
    (await db.query("INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active) VALUES($1,'consultation',$2,$3,$4,$5,$6) RETURNING id", [name,yer,sar,usd,configured,active])).rows[0].id;
  pricedId = await service("Synthetic priced invoice service", true, true, 10000, 12345, 2345);
  missingId = await service("Synthetic unpriced invoice service", true, false, 0, null, null);
  disabledId = await service("Synthetic disabled invoice service", false, true, 10000, 12345, 2345);
}, 180_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

describe("owner acceptance: discoverable prices and repayment choice", () => {
  it.each(["admin", "reception"] as const)("%s sees authoritative currency prices and explicit missing-price state", async role => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-YE" });
    try {
      const [name, ...value] = h.sessions[role].cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const page = await context.newPage();
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("treatment-entry-open").click();
      await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
      const catalogue = await context.request.get(`${baseUrl}/api/services`);
      expect(catalogue.status()).toBe(200);
      const prices = (await catalogue.json()).find((s: { id: number }) => s.id === pricedId);
      expect(prices.priceIn.SAR).toEqual({ minor: 12345, source: "catalog" });
      await page.getByLabel("الخدمة", { exact: true }).selectOption(String(pricedId));
      const price = page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true });
      expect((await price.inputValue()).replaceAll(",", "")).toBe("10000");
      await page.getByLabel("عملة الفاتورة", { exact: true }).selectOption("SAR");
      const afterCurrency = await price.inputValue();
      expect.soft(afterCurrency).toBe("123.45");
      await page.getByLabel("عملة الفاتورة", { exact: true }).selectOption("USD");
      expect.soft(await price.inputValue()).toBe("23.45");
      await page.getByLabel("الخدمة", { exact: true }).selectOption(String(missingId));
      const missingValue = await price.inputValue();
      expect.soft(missingValue).toBe("");
      expect.soft(await page.getByTestId("invoice-row-0").innerText()).toMatch(/غير مسعّرة|غير مسعرة|لا يوجد سعر/);
      expect.soft(await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).isDisabled()).toBe(true);
      expect(await page.getByLabel("الخدمة", { exact: true }).locator(`option[value="${disabledId}"]`).count()).toBe(0);
      const repaymentChoices = await page.getByRole("radio", { name: /دفعة واحدة|جدول أقساط/ }).count();
      expect.soft(repaymentChoices).toBe(2);
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
      expect.soft(geometry.width).toBeLessThanOrEqual(geometry.viewport + 1);
      expect(errors).toEqual([]);
      console.info("INVOICE_WORKSPACE_ACCEPTANCE", JSON.stringify({ role, catalogueSarMinor: prices.priceIn.SAR.minor, afterCurrency, missingValue, repaymentChoices, geometry, pageErrors: errors }));
    } finally { await context.close(); }
  });
  it.each(["admin", "reception"] as const)("%s saves native prices and rejects stale, disabled and fabricated zero prices", async role => {
    const body = { patientId, currency: "SAR", items: [{ serviceId: pricedId, price: "123.45", catalogPriceMinor: 12345 }], idempotencyKey: `accept-native-${role}` };
    const first = await authedMutation("/api/invoices",h.sessions[role],"POST",JSON.stringify(body));
    expect(first.status).toBe(201);
    const saved = await first.json();expect(saved.totalMinor).toBe(12345);expect(saved.baseCurrency).toBe("SAR");
    const repeated = await authedMutation("/api/invoices",h.sessions[role],"POST",JSON.stringify(body));
    expect(repeated.status).toBe(200);expect((await repeated.json()).id).toBe(saved.id);
    const before = (await db.query('SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1',[patientId])).rows[0].n;
    try {
      await db.query('UPDATE services SET price_sar_minor=13000 WHERE id=$1',[pricedId]);
      const recovered = await authedMutation("/api/invoices",h.sessions[role],"POST",JSON.stringify(body));
      expect(recovered.status).toBe(200);expect((await recovered.json()).id).toBe(saved.id);
      const changed = await authedMutation("/api/invoices",h.sessions[role],"POST",JSON.stringify({...body,note:"Different submitted intent"}));
      expect(changed.status).toBe(409);
      const stale = await authedMutation("/api/invoices",h.sessions[role],"POST",JSON.stringify({...body,idempotencyKey:`accept-stale-${role}`}));
      expect(stale.status).toBe(400);
      const disabled = await authedMutation("/api/invoices",h.sessions[role],"POST",JSON.stringify({...body,items:[{serviceId:disabledId,price:"123.45"}],idempotencyKey:`accept-disabled-${role}`}));
      expect(disabled.status).toBe(400);
      const zero = await authedMutation("/api/invoices",h.sessions[role],"POST",JSON.stringify({patientId,currency:"YER",items:[{serviceId:missingId,price:"0"}],idempotencyKey:`accept-missing-${role}`}));
      expect(zero.status).toBe(400);
      expect((await db.query('SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1',[patientId])).rows[0].n).toBe(before);
    } finally { await db.query('UPDATE services SET price_sar_minor=12345 WHERE id=$1',[pricedId]); }
  });
});
