import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
let native: number, converted: number, doctor: number, serial = 0;
const settingKeys = ["finance.rate.SAR", "finance.rate.USD", "billing.max_discount_percent", "finance.reception_adds_opening_balance"];
let previousSettings: { key: string; value: string }[] = [];
beforeAll(async () => {
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  doctor = (await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  native = (await db.query("INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active) VALUES('Synthetic monthly orthodontics','ortho',2200,150000,50000,TRUE,TRUE) RETURNING id")).rows[0].id;
  converted = (await db.query("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic converted orthodontics','ortho',2200,TRUE,TRUE) RETURNING id")).rows[0].id;
  previousSettings = (await db.query("SELECT key,value FROM settings WHERE key=ANY($1::text[])", [settingKeys])).rows;
  await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','440'),('finance.rate.USD','2200'),('billing.max_discount_percent','10'),('finance.reception_adds_opening_balance','true') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  mkdirSync(".settings-ui-artifacts", { recursive: true });
}, 180000);
afterAll(async () => {
  await browser?.close();
  if (db) {
    await db.query("DELETE FROM settings WHERE key=ANY($1::text[])", [settingKeys]);
    for (const setting of previousSettings) await db.query("INSERT INTO settings(key,value) VALUES($1,$2)", [setting.key, setting.value]);
    await db.end();
  }
});
async function open(historical = false, width = 390) {
  const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic monthly agreement') RETURNING id", [`MONTHLY-${Date.now()}-${++serial}`])).rows[0].id;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]); const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("treatment-entry-open").click();
  await page.getByRole("button", { name: historical ? "علاج بدأ قبل النظام" : "علاج جديد", exact: true }).click();
  await page.getByLabel(historical ? "عملة الاتفاق" : "عملة الفاتورة", { exact: true }).selectOption("SAR");
  const row = page.getByTestId("invoice-row-0"); await row.getByLabel("الخدمة", { exact: true }).selectOption(String(native));
  await row.getByLabel("نطاق العلاج", { exact: true }).selectOption("both");
  await page.getByTestId("invoice-provider-0").selectOption(String(doctor));
  return { patientId, context, page, editor: page.getByTestId("debt-repayment-editor") };
}
async function stored(patientId: number) {
  return (await db.query("SELECT r.terms FROM debt_repayment_revisions r JOIN debt_repayment_arrangements a ON a.id=r.arrangement_id WHERE a.patient_id=$1 ORDER BY r.id DESC LIMIT 1", [patientId])).rows[0].terms;
}
describe("receptionist monthly proposed-payment workspace", () => {
  it.each([390, 1280])("generates editable exact schedules, regenerates after discount, persists once without cash at %s", async width => {
    const { patientId, context, page, editor } = await open(false, width);
    try {
      const save = page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
      await expect.poll(() => save.isEnabled()).toBe(true);
      await editor.getByRole("radio", { name: "جدول أقساط", exact: true }).check();
      await editor.getByLabel("مبلغ الدفعة المقدمة المقترحة", { exact: true }).fill("490");
      await editor.getByLabel("تاريخ الدفعة المقدمة المقترحة", { exact: true }).fill("2026-10-14");
      await editor.getByLabel("أول استحقاق شهري", { exact: true }).fill("2027-01-31");
      expect(await editor.getByTestId("monthly-schedule-remainder").innerText()).toContain("1,010");
      for (const months of [12, 15, 18]) {
        if(months!==12) await editor.locator("summary").click();
        await editor.getByRole("button", { name: `${months} شهرًا`, exact: true }).click();
        await editor.getByRole("button", { name: "توليد جدول الأقساط", exact: true }).click();
        expect(await editor.getByTestId("debt-repayment-row-fields").count()).toBe(months + 1);
        expect(await save.isEnabled()).toBe(true);
      }
      await editor.locator("summary").click();
      await editor.getByLabel("عدد الأشهر", { exact: true }).fill("0");
      expect(await editor.getByRole("button", { name: "توليد جدول الأقساط", exact: true }).isDisabled()).toBe(true);
      await editor.getByLabel("عدد الأشهر", { exact: true }).fill("2");
      await editor.getByRole("button", { name: "توليد جدول الأقساط", exact: true }).click();
      expect(await editor.getByLabel("مبلغ السداد 2", { exact: true }).inputValue()).toBe("505.00");
      expect(await editor.getByLabel("تاريخ السداد 3", { exact: true }).inputValue()).toBe("2027-02-28");
      await editor.getByLabel("مبلغ السداد 2", { exact: true }).fill("504"); expect(await save.isDisabled()).toBe(true);
      await editor.locator("summary").click();
      await editor.getByRole("button", { name: "توليد جدول الأقساط", exact: true }).click();
      await page.getByLabel("الخصم", { exact: true }).fill("100");
      await page.getByLabel("سبب الخصم", { exact: true }).fill("Synthetic allowed receptionist discount");
      expect(await save.isDisabled()).toBe(true);
      expect(await editor.getByRole("status").innerText()).toContain("تغيّر مبلغ الدين");
      await editor.locator("summary").click();
      await editor.getByLabel("عدد الأشهر", { exact: true }).fill("3");
      await editor.getByRole("button", { name: "توليد جدول الأقساط", exact: true }).click();
      expect(await editor.getByLabel("مبلغ السداد 2", { exact: true }).inputValue()).toBe("303.34");
      expect(await editor.getByLabel("تاريخ السداد 4", { exact: true }).inputValue()).toBe("2027-03-31");
      await expect.poll(() => save.isEnabled()).toBe(true);
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
      expect(geometry.width).toBeLessThanOrEqual(geometry.viewport + 1);
      await page.screenshot({ path: `.settings-ui-artifacts/monthly-reception-sar-${width}.png`, fullPage: true });
      await save.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await page.getByRole("region", { name: "فاتورة جديدة", exact: true }).waitFor({ state: "detached" });
      expect((await stored(patientId)).installments.map((row: { amountMinor: number }) => row.amountMinor)).toEqual([49000, 30334, 30333, 30333]);
      expect((await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments", [patientId])).rows[0]).toEqual({ invoices: 1, payments: 0 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => page.getByTestId("debt-repayment-panel").innerText()).toContain("جدول أقساط");
    } finally { await context.close(); }
  });
  it("distributes only historical opening debt and saves no invoice or receipt", async () => {
    const { patientId, context, page, editor } = await open(true);
    try {
      await page.getByLabel("المدفوع قبل النظام", { exact: true }).fill("500");
      await page.getByLabel("تاريخ المعلومات التاريخية", { exact: true }).fill("2026-10-01");
      await editor.getByRole("radio", { name: "جدول أقساط", exact: true }).check();
      await editor.getByLabel("مبلغ الدفعة المقدمة المقترحة", { exact: true }).fill("490");
      await editor.getByLabel("تاريخ الدفعة المقدمة المقترحة", { exact: true }).fill("2026-10-14");
      await editor.getByLabel("عدد الأشهر", { exact: true }).fill("2");
      await editor.getByLabel("أول استحقاق شهري", { exact: true }).fill("2028-01-31");
      await editor.getByRole("button", { name: "توليد جدول الأقساط", exact: true }).click();
      expect(await editor.getByLabel("مبلغ السداد 2", { exact: true }).inputValue()).toBe("255.00");
      expect(await editor.getByLabel("تاريخ السداد 3", { exact: true }).inputValue()).toBe("2028-02-29");
      const save = page.getByRole("button", { name: "احفظ الاتفاق التاريخي", exact: true }); await expect.poll(() => save.isEnabled()).toBe(true);
      await page.screenshot({ path: ".settings-ui-artifacts/monthly-reception-historical-sar-390.png", fullPage: true });
      await save.click(); await page.getByRole("region", { name: "اتفاق تاريخي متعدد البنود", exact: true }).waitFor({ state: "detached" });
      expect((await stored(patientId)).installments.map((row: { amountMinor: number }) => row.amountMinor)).toEqual([49000, 25500, 25500]);
      expect((await db.query("SELECT (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,(SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,(SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1) AS opening", [patientId])).rows[0]).toEqual({ invoices: 0, payments: 0, opening: "100000" });
    } finally { await context.close(); }
  });
  it("keeps converted quotes distinct from native prices for receptionist and denies doctor preview/create", async () => {
    const response = await authedGet("/api/services", h.sessions.reception); expect(response.status).toBe(200);
    const services = await response.json();
    expect(services.find((service: { id: number }) => service.id === native).priceIn.SAR).toEqual({ minor: 150000, source: "catalog" });
    const quote = services.find((service: { id: number }) => service.id === converted);
    expect(quote.priceSarMinor).toBeNull(); expect(quote.priceUsdMinor).toBeNull();
    expect(quote.priceIn.SAR).toEqual({ minor: 500, source: "converted" });
    expect(quote.priceIn.USD).toEqual({ minor: 100, source: "converted" });
    const { patientId, context, page } = await open();
    try {
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(converted));
      expect(await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).inputValue()).toBe("5.00");
      expect(await page.getByTestId("invoice-price-source-0").innerText()).toContain("محوّل مقترح");
      await page.screenshot({ path: ".settings-ui-artifacts/monthly-reception-converted-unpriced-sar-390.png", fullPage: true });
      const body = { patientId, currency: "SAR", items: [{ serviceId: native, doctorId: doctor, scope: "both", price: "1500", catalogPriceMinor: 150000 }] };
      expect((await authedMutation("/api/invoices/clinical-preview", h.sessions.reception, "POST", JSON.stringify(body))).status).toBe(200);
      for (const path of ["/api/invoices/clinical-preview", "/api/invoices"]) {
        for (const role of ["doctorA", "cashier", "accountant"] as const) expect((await authedMutation(path, h.sessions[role], "POST", JSON.stringify(body))).status).toBe(403);
        expect((await authedMutation(path, h.sessions.reception, "POST", JSON.stringify({ ...body, items: [{ ...body.items[0], price: "1600", priceReason: "Synthetic reason does not grant admin" }] }))).status).toBe(400);
        expect((await authedMutation(path, h.sessions.reception, "POST", JSON.stringify({ ...body, items: [{ ...body.items[0], price: "1490" }] }))).status).toBe(400);
      }
      const manual = { ...body, idempotencyKey: `monthly-manual-${patientId}`, items: [{ ...body.items[0], serviceId: converted, catalogPriceMinor: null, priceReason: "Synthetic explicit unpriced agreement" }] };
      const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions.reception, "POST", JSON.stringify(manual)); expect(preview.status).toBe(200);
      const saved = await authedMutation("/api/invoices", h.sessions.reception, "POST", JSON.stringify(manual)); expect(saved.status).toBe(201);
      const invoice = await saved.json();
      const audit = (await db.query("SELECT details FROM audit_log WHERE action='invoice.create' AND entity_id=$1", [String(invoice.id)])).rows[0].details;
      expect(JSON.stringify(audit)).toContain("Synthetic explicit unpriced agreement");
      // Invoice-specific manual reason is now enforced in preview and save.
      const noReason = await authedMutation("/api/invoices/clinical-preview", h.sessions.reception, "POST", JSON.stringify({ ...manual, items: [{ ...manual.items[0], priceReason: "" }] }));
      expect(noReason.status).toBe(400);
      writeFileSync(".settings-ui-artifacts/monthly-reception-pricing-audit.json", JSON.stringify({ synthetic: true, role: "reception", nativeSarMinor: 150000, convertedSar: quote.priceIn.SAR, convertedUsd: quote.priceIn.USD, nativeForeignFields: [quote.priceSarMinor, quote.priceUsdMinor], reasonedManualPreview: preview.status, reasonedManualSave: saved.status, unpricedNoReasonPreviewObserved: noReason.status, unpricedReasonRequirementImplemented: true, convertedOfferImplemented: true }, null, 2));
    } finally { await context.close(); }
  });
});
