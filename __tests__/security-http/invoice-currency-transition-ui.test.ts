import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { formatMoney, type Currency } from "../../lib/money";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

// Exact reported sequence: choose the 250,000-YER orthodontic service first,
// then switch currency. All prices come from the actual isolated server catalogue.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser, doctorId: number;
const ids = { native: 0, missing: 0, partial: 0 };
const evidence = process.env.INVOICE_CURRENCY_OUTPUT ?? ".settings-ui-artifacts/invoice-currency-transitions";
const witnesses: unknown[] = [];
let serial = 0;
const native = { YER: { text: "250000", minor: 250000 }, SAR: { text: "1800.00", minor: 180000 }, USD: { text: "625.00", minor: 62500 } };
beforeAll(async () => {
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  h = await harness(); db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  doctorId = (await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id as number;
  for (const [key, sar, usd] of [["native", 180000, 62500], ["missing", null, null], ["partial", 180000, null]] as const) {
    ids[key] = (await db.query(`INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active)
      VALUES($1,'ortho',250000,$2,$3,TRUE,TRUE) RETURNING id`, [`تركيب تقويم ثابت (فكّان) — اصطناعي ${key}`, sar, usd])).rows[0].id as number;
  }
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => {
  await writeFile(`${evidence}/currency-witnesses.json`, JSON.stringify(witnesses, null, 2) + "\n");
  await browser?.close(); await db?.end();
});
async function patient() {
  return (await db.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'اختبار عملة الفاتورة — اصطناعي',$2) RETURNING id", [`CURR-${Date.now()}-${++serial}`, doctorId])).rows[0].id as number;
}
async function open(width = 390, historical = false) {
  const patientId = await patient();
  const context = await browser.newContext({ viewport: { width, height: 1040 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("treatment-entry-open").click();
  await page.getByRole("button", { name: historical ? "علاج بدأ قبل النظام" : "علاج جديد", exact: true }).click();
  if (historical) {
    await page.getByLabel("تاريخ المعلومات التاريخية", { exact: true }).fill("2026-10-01");
    await page.getByLabel("المدفوع قبل النظام", { exact: true }).fill("0");
  }
  return { context, page, patientId };
}
async function service(page: Page, id: number) {
  const row = page.getByTestId("invoice-row-0");
  await row.getByLabel("الخدمة", { exact: true }).selectOption(String(id));
  await row.getByLabel("نطاق العلاج", { exact: true }).selectOption("both");
  await page.getByTestId("invoice-provider-0").selectOption(String(doctorId));
}
const price = (page: Page) => page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true });
const moneyCurrency = (page: Page, historical = false) => page.getByLabel(historical ? "عملة الاتفاق" : "عملة الفاتورة", { exact: true });
const save = (page: Page, historical = false) => page.getByRole("button", { name: historical ? "احفظ الاتفاق التاريخي" : "احفظ الفاتورة", exact: true });
async function assertNative(page: Page, currency: Currency, scene: string) {
  try {
    await expect.poll(async () => (await price(page).inputValue()).replaceAll(",", "")).toBe(native[currency].text);
    const label = await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).locator("option:checked").innerText();
    expect(label).toContain(formatMoney(native[currency].minor, currency));
    expect(await page.getByTestId("invoice-row-0").getByLabel("سبب تغيير السعر", { exact: true }).count()).toBe(0);
    if (currency !== "YER") expect(label).not.toContain(formatMoney(250000, "YER"));
    witnesses.push({ scene, currency, expectedMinor: native[currency].minor, price: await price(page).inputValue(), label });
    await page.screenshot({ path: `${evidence}/${scene}-${currency}.png`, fullPage: true });
  } catch (error) {
    await page.screenshot({ path: `${evidence}/${scene}-${currency}-failed.png`, fullPage: true });
    throw error;
  }
}
async function noMoney(patientId: number) {
  for (const table of ["invoices", "payments"]) expect((await db.query(`SELECT id FROM ${table} WHERE patient_id=$1`, [patientId])).rows).toHaveLength(0);
}

describe("invoice selected-service currency transitions", () => {
  it.each([390, 1280].flatMap(width => ["normal", "historical"].map(origin => ({ width, origin }))))("$origin at $width replaces native prices after selecting 250000 YER orthodontics", async ({ width, origin }) => {
    const historical = origin === "historical";
    const { context, page, patientId } = await open(width, historical);
    try {
      expect(await moneyCurrency(page, historical).inputValue()).toBe("YER");
      expect(await price(page).inputValue()).toBe("");
      await service(page, ids.native);
      let previous: Currency = "YER";
      for (const currency of ["YER", "SAR", "USD", "YER"] as const) {
        await moneyCurrency(page, historical).selectOption(currency);
        await assertNative(page, currency, `${origin}-${width}`);
        if (historical && currency !== previous) {
          expect(await page.getByLabel("المدفوع قبل النظام", { exact: true }).inputValue()).toBe("");
          expect(await save(page, historical).isDisabled()).toBe(true);
          await page.getByLabel("المدفوع قبل النظام", { exact: true }).fill("0");
        }
        await expect.poll(() => save(page, historical).isEnabled()).toBe(true);
        previous = currency;
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await noMoney(patientId);
    } finally { await context.close(); }
  });

  it.each([false, true].flatMap(historical => (["SAR", "USD"] as const).map(currency => ({ historical, currency }))))("clears and blocks a missing $currency quote after YER selection, historical=$historical", async ({ historical, currency }) => {
    const { context, page, patientId } = await open(390, historical);
    try {
      const catalogue = await authedGet("/api/services", h.sessions.reception); expect(catalogue.status).toBe(200);
      const quoted = (await catalogue.json()).find((one: { id: number }) => one.id === ids.missing);
      expect(quoted[currency === "SAR" ? "priceSarMinor" : "priceUsdMinor"]).toBeNull();
      // The shared service DTO may offer an FX suggestion for other workflows;
      // this agreement must never adopt that converted amount as its native price.
      expect(quoted.priceIn[currency].source).not.toBe("catalog");
      await service(page, ids.missing);
      expect((await price(page).inputValue()).replaceAll(",", "")).toBe("250000");
      await moneyCurrency(page, historical).selectOption(currency);
      expect(await price(page).inputValue()).toBe("");
      expect(await page.getByTestId("invoice-row-0").innerText()).toContain("لا يوجد سعر مقرر بهذه العملة");
      expect(await save(page, historical).isDisabled()).toBe(true);
      await page.screenshot({ path: `${evidence}/missing-${historical}-${currency}-390.png`, fullPage: true });
      await price(page).fill("2000");
      await page.getByTestId("invoice-row-0").getByLabel("سبب تغيير السعر", { exact: true }).fill("قيمة متفق عليها صراحة بهذه العملة");
      if (historical) {
        expect(await page.getByLabel("المدفوع قبل النظام", { exact: true }).inputValue()).toBe("");
        await page.getByLabel("المدفوع قبل النظام", { exact: true }).fill("0");
      }
      await expect.poll(() => save(page, historical).isEnabled()).toBe(true);
      // Returning to YER resets the explicit foreign amount and its reason.
      await moneyCurrency(page, historical).selectOption("YER");
      await assertNative(page, "YER", `missing-reset-${historical}-${currency}`);
      await noMoney(patientId);
      witnesses.push({ missingCurrency: currency, historical, serverQuote: quoted.priceIn[currency], explicitNativePrice: null, emptyAndBlocked: true });
    } finally { await context.close(); }
  });

  it("keeps missing USD blocked through rapid changes and a late real SAR preview", async () => {
    const { context, page, patientId } = await open();
    let release!: () => void, sawHeld!: () => void, finished!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { sawHeld = resolve; });
    const done = new Promise<void>(resolve => { finished = resolve; });
    let captured = false, previewStatus: number | null = null;
    try {
      await service(page, ids.partial);
      await expect.poll(() => save(page).isEnabled()).toBe(true);
      await page.route("**/api/invoices/clinical-preview", async route => {
        const body = route.request().postDataJSON();
        if (body.currency !== "SAR" || captured) return route.continue();
        captured = true;
        try {
          const response = await route.fetch(); previewStatus = response.status(); sawHeld();
          await released; await route.fulfill({ response }).catch(() => {});
        } finally { sawHeld(); finished(); }
      });
      await moneyCurrency(page).selectOption("SAR"); await held; expect(previewStatus).toBe(200);
      for (const currency of ["USD", "YER", "USD"] as const) await moneyCurrency(page).selectOption(currency);
      expect(await price(page).inputValue()).toBe("");
      release(); await done;
      await page.waitForLoadState("networkidle");
      expect(await moneyCurrency(page).inputValue()).toBe("USD");
      expect(await price(page).inputValue()).toBe(""); expect(await save(page).isDisabled()).toBe(true);
      await noMoney(patientId);
      await page.screenshot({ path: `${evidence}/rapid-late-SAR-final-missing-USD-390.png`, fullPage: true });
    } finally { release(); await context.close(); }
  });

  it.each([false, true])("clears typed overrides and manual-row amounts instead of relabelling, historical=%s", async historical => {
    const { context, page, patientId } = await open(390, historical);
    try {
      await service(page, ids.native); await price(page).fill("240000");
      await page.getByLabel("سبب تغيير السعر", { exact: true }).fill("تعديل يمني صريح");
      await moneyCurrency(page, historical).selectOption("SAR");
      await assertNative(page, "SAR", `override-reset-${historical}`);
      await page.getByRole("button", { name: "+ بند آخر", exact: true }).click();
      const manual = page.getByTestId("invoice-row-1");
      await manual.getByLabel("وصف البند", { exact: true }).fill("بند مالي يدوي اصطناعي");
      await manual.getByLabel("السعر", { exact: true }).fill("75");
      await moneyCurrency(page, historical).selectOption("USD");
      await assertNative(page, "USD", `manual-reset-${historical}`);
      expect(await manual.getByLabel("السعر", { exact: true }).inputValue()).toBe("");
      expect(await manual.getByLabel("وصف البند", { exact: true }).inputValue()).toBe("بند مالي يدوي اصطناعي");
      expect(await save(page, historical).isDisabled()).toBe(true);
      await noMoney(patientId);
    } finally { await context.close(); }
  });

  it.each(["YER", "SAR", "USD"] as const)("persists the final explicit %s currency and its own server catalogue amount", async currency => {
    const { context, page, patientId } = await open(390);
    try {
      await service(page, ids.native);
      await moneyCurrency(page).selectOption(currency);
      await assertNative(page, currency, `persist-${currency}`);
      await expect.poll(() => save(page).isEnabled()).toBe(true);
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/api/invoices" && response.request().method() === "POST");
      await save(page).click(); const response = await responsePromise;
      expect(response.status(), await response.text()).toBe(201);
      const body = response.request().postDataJSON(), invoice = await response.json();
      expect(body.currency).toBe(currency); expect(body).not.toHaveProperty("visitId");
      expect(invoice).toMatchObject({ patientId, baseCurrency: currency, totalMinor: native[currency].minor });
      expect(invoice.items[0]).toMatchObject({ serviceId: ids.native, unitPriceMinor: native[currency].minor, quantity: 1 });
      expect((await db.query("SELECT base_currency,total_minor::text AS total_minor FROM invoices WHERE id=$1", [invoice.id])).rows[0])
        .toEqual({ base_currency: currency, total_minor: String(native[currency].minor) });
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1", [patientId])).rows).toHaveLength(0);
      expect((await db.query("SELECT id FROM visits WHERE patient_id=$1", [patientId])).rows).toHaveLength(0);
      witnesses.push({ persistedCurrency: currency, request: body, invoiceId: invoice.id, storedTotalMinor: native[currency].minor, paymentCount: 0, visitCount: 0 });
      await page.screenshot({ path: `${evidence}/persisted-${currency}-390.png`, fullPage: true });
    } finally { await context.close(); }
  });

  it("keeps server permissions and explicit reasons for configured native-price overrides", async () => {
    const patientId = await patient();
    const body = (price: string, priceReason?: string) => ({ patientId, currency: "SAR", items: [{ serviceId: ids.native, doctorId, scope: "both", quantity: 1, price, priceReason, catalogPriceMinor: 180000 }] });
    const send = (role: "admin" | "reception" | "doctorA", value: unknown) => authedMutation("/api/invoices", h.sessions[role], "POST", JSON.stringify(value));
    expect((await send("admin", body("1900"))).status).toBe(400);
    const forbiddenRaise = await send("reception", body("1900", "زيادة اصطناعية مرفوضة"));
    expect(forbiddenRaise.status).toBe(400); expect((await forbiddenRaise.json()).message).toContain("رفع السعر للمدير وحده");
    expect((await send("doctorA", body("1800"))).status).toBe(403);
    await noMoney(patientId);
    const accepted = await send("admin", body("1900", "زيادة صريحة معتمدة للاختبار"));
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    const invoice = await accepted.json(); expect(invoice).toMatchObject({ baseCurrency: "SAR", totalMinor: 190000 });
    const audit = await db.query("SELECT details FROM audit_log WHERE action='invoice.create' AND entity_id=$1", [invoice.id]);
    expect(JSON.stringify(audit.rows)).toContain("زيادة صريحة معتمدة للاختبار");
  });
});
