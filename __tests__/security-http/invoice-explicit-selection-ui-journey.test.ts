import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

/** Built application + actual authenticated preview/save/plan APIs + isolated PostgreSQL.
 * SQL creates only synthetic patient/catalog prerequisites and reads retained records.
 * Plans, invoices, idempotency and financial identity are produced by real writers. */
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let db: Client;
let serviceId = 0, doctorId = 0;
const stamp = Date.now();
const contexts = new Set<BrowserContext>();
beforeAll(async () => {
  await mkdir("artifacts/invoice-explicit-selection", { recursive: true });
  await writeFile("artifacts/invoice-explicit-selection/started.txt", "synthetic-suite-started\n");
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  doctorId = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username = 'secdoctora'")).rows[0].party_id;
  serviceId = (await db.query<{ id: number }>(`INSERT INTO services
    (name,category,price_minor,is_active,price_configured) VALUES($1,'filling',10000,true,true) RETURNING id`,
  [`Synthetic explicit selection ${stamp}`])).rows[0].id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240000);
afterAll(async () => {
  await Promise.all([...contexts].map((context) => context.close())); await browser?.close(); await db?.end();
});
async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await db.query<T & Record<string, unknown>>(sql, params)).rows;
}
async function newPatient(tag: string) {
  return (await q<{ id: number }>("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id",
    [`EIS-${stamp}-${tag}`, `Synthetic explicit invoice ${tag}`, doctorId]))[0].id;
}
async function plan(patientId: number, toothCode: number) {
  const response = await authedMutation("/api/plans", h.sessions.reception, "POST", JSON.stringify({
    mode: "v2", patientId, title: `Synthetic plan ${patientId} ${toothCode}`, currency: "YER", billingMode: "per_procedure",
    primaryDoctorId: doctorId, items: [{ serviceId, toothCode, quantity: 1, unitPriceMinor: 10000,
      billingRule: "on_completion", sessionCount: 1 }],
  }));
  const text = await response.text(); expect(response.status, text).toBe(201);
  const { id } = JSON.parse(text) as { id: number };
  const item = (await q<{ id: number }>("SELECT id FROM plan_items WHERE plan_id=$1 ORDER BY id", [id]))[0];
  return { id, itemId: item.id };
}
async function open(patientId: number, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 980 }, locale: "ar-YE" });
  contexts.add(context);
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "فاتورة يدوية", exact: true }).click();
  await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(serviceId));
  await page.getByTestId("invoice-provider-0").selectOption(String(doctorId));
  return { context, page };
}
async function tooth(page: Page, code: number) {
  await page.getByTestId("invoice-tooth-button-0").click();
  const dialog = page.getByTestId("tooth-dialog");
  await dialog.getByTestId(`odontogram-tooth-${code}`).click();
  await dialog.getByTestId("tooth-dialog-confirm").click();
  await dialog.waitFor({ state: "detached" });
  expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe(String(code));
}
const ready = (page: Page) => page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="ready"]').waitFor();
const refused = (page: Page) => page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="refused"]').waitFor();
async function selectPlan(page: Page, planId: number, keyboard: boolean) {
  const select = page.getByTestId("invoice-existing-plan");
  await expect.poll(() => select.isEnabled()).toBe(true);
  if (keyboard) { await select.focus(); await select.press("End"); await select.press("Enter"); }
  else await select.selectOption(String(planId));
  expect(await select.inputValue()).toBe(String(planId));
}
async function selectItem(page: Page, itemId: number, keyboard: boolean) {
  const select = page.getByTestId("invoice-plan-item-0");
  await expect.poll(() => select.isEnabled()).toBe(true);
  if (keyboard) { await select.focus(); await select.press("End"); await select.press("Enter"); }
  else await select.selectOption(String(itemId));
  expect(await select.inputValue()).toBe(String(itemId));
  await ready(page);
}
async function noOverflow(page: Page, name: string) {
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `artifacts/invoice-explicit-selection/${name}.png`, fullPage: true });
}

describe("explicit invoice treatment selection in the built RTL application", () => {
  it.each([390, 1280])("adds new work only to the chosen compatible plan at %ipx", async (width) => {
    const patientId = await newPatient(`fresh-${width}`);
    const first = await plan(patientId, 11), chosen = await plan(patientId, 12);
    const { context, page } = await open(patientId, width);
    try {
      await tooth(page, 21); await refused(page);
      const save = page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
      expect(await save.isDisabled()).toBe(true);
      expect(await page.getByTestId("invoice-existing-plan").inputValue()).toBe("");
      await selectPlan(page, chosen.id, width === 1280); await ready(page);
      await noOverflow(page, `fresh-plan-${width}`);
      const written = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/invoices" && response.request().method() === "POST");
      await save.click();
      const response = await written; expect(response.status()).toBe(201);
      const request = response.request().postDataJSON() as { existingPlanId: number; items: { planItemId: number | null }[] };
      expect(request.existingPlanId).toBe(chosen.id); expect(request.items[0].planItemId).toBeNull();
      const invoice = await response.json() as { id: number; clinical: { links: { planItemId: number }[] } };
      expect((await q<{ plan_id: number }>("SELECT plan_id FROM plan_items WHERE id=$1", [invoice.clinical.links[0].planItemId]))[0].plan_id).toBe(chosen.id);
      expect(await q("SELECT id FROM treatment_plans WHERE patient_id=$1", [patientId])).toHaveLength(2);
      expect(await q("SELECT id FROM plan_items WHERE plan_id=$1", [first.id])).toHaveLength(1);
      expect(await q("SELECT id FROM invoices WHERE patient_id=$1", [patientId])).toHaveLength(1);
    } finally { await context.close(); contexts.delete(context); }
  }, 120000);

  it.each([390, 1280])("retains draft, clears identity after FDI changes, then retries a committed response loss at %ipx", async (width) => {
    const patientId = await newPatient(`item-${width}`);
    await plan(patientId, 36); const chosen = await plan(patientId, 36);
    const { context, page } = await open(patientId, width);
    try {
      await tooth(page, 36); await refused(page);
      await selectPlan(page, chosen.id, width === 1280); await refused(page);
      await selectItem(page, chosen.itemId, width === 1280);
      const price = await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).inputValue();
      await tooth(page, 46); await refused(page);
      expect(await page.getByTestId("invoice-existing-plan").inputValue()).toBe("");
      expect(await page.getByTestId("invoice-plan-item-0").count()).toBe(0);
      expect(await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).inputValue()).toBe(price);
      expect(await page.getByTestId("invoice-provider-0").inputValue()).toBe(String(doctorId));
      await tooth(page, 36); await refused(page);
      expect(await page.getByTestId("invoice-existing-plan").inputValue()).toBe("");
      expect(await page.getByTestId("invoice-plan-item-0").inputValue()).toBe("");
      await selectPlan(page, chosen.id, width === 1280); await refused(page);
      await selectItem(page, chosen.itemId, width === 1280);
      await noOverflow(page, `exact-item-${width}`);
      const bodies: unknown[] = [];
      let lost = false;
      await page.route("**/api/invoices", async (route) => {
        if (route.request().method() !== "POST") { await route.continue(); return; }
        bodies.push(route.request().postDataJSON());
        if (!lost) {
          lost = true; const response = await route.fetch(); expect(response.status()).toBe(201);
          await route.abort("failed");
        } else await route.continue();
      });
      const save = page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
      await save.click();
      await page.getByRole("alert", { name: "خطأ حساب المريض" }).waitFor();
      expect(await page.getByTestId("invoice-existing-plan").inputValue()).toBe(String(chosen.id));
      expect(await page.getByTestId("invoice-plan-item-0").inputValue()).toBe(String(chosen.itemId));
      expect(await q("SELECT id FROM invoices WHERE patient_id=$1", [patientId])).toHaveLength(1);
      const replay = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/invoices" && response.request().method() === "POST");
      await save.click();
      const response = await replay; expect(response.status()).toBe(200);
      expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[0]).toMatchObject({ existingPlanId: chosen.id, items: [{ planItemId: chosen.itemId }] });
      expect(await q("SELECT id FROM invoices WHERE patient_id=$1", [patientId])).toHaveLength(1);
      expect(await q("SELECT i.id FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id WHERE t.patient_id=$1", [patientId])).toHaveLength(2);
      const financial = await authedGet(`/api/patients/${patientId}/treatment-financial-context`, h.sessions.reception);
      expect(financial.status).toBe(200);
      const data = await financial.json() as { references: { planItemId: number; invoiceIds: number[] }[] };
      expect(data.references.find((reference) => reference.planItemId === chosen.itemId)?.invoiceIds).toHaveLength(1);
    } finally { await context.close(); contexts.delete(context); }
  }, 120000);

  it("keeps direct API owner and financial role boundaries despite a valid-looking selector payload", async () => {
    const owner = await newPatient("owner-boundary"), foreign = await newPatient("foreign-boundary");
    const wrongPlan = await plan(foreign, 36);
    const body = { patientId: owner, existingPlanId: wrongPlan.id, currency: "YER",
      items: [{ serviceId, doctorId, toothCode: 36, quantity: 1, price: "10000", planItemId: wrongPlan.itemId }] };
    const denied = await authedMutation("/api/invoices", h.sessions.reception, "POST", JSON.stringify(body));
    expect(denied.status).toBe(409);
    expect(await q("SELECT id FROM invoices WHERE patient_id=$1", [owner])).toHaveLength(0);
    expect((await authedMutation("/api/invoices/clinical-preview", h.sessions.doctorA, "POST", JSON.stringify(body))).status).toBe(403);
    expect((await authedGet(`/api/patients/${foreign}/treatment-financial-context`, h.sessions.doctorA)).status).toBe(403);
  });

  it("ignores a delayed real preview for the previous tooth without erasing the current draft", async () => {
    const patientId = await newPatient("late-real-preview");
    await plan(patientId, 36); const chosen = await plan(patientId, 36);
    const { context, page } = await open(patientId, 1280);
    let release!: () => void, finish!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    let held = false, holdNext = true, cancelled = false, deliveryError: string | null = null;
    try {
      await tooth(page, 36); await refused(page);
      await selectPlan(page, chosen.id, false); await refused(page);
      await selectItem(page, chosen.itemId, false);
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).pathname !== "/api/invoices/clinical-preview") return;
        const body = request.postDataJSON() as { items?: { toothCode?: number }[] };
        if (body.items?.[0]?.toothCode === 36) cancelled = true;
      });
      await page.route("**/api/invoices/clinical-preview", async (route) => {
        if (!holdNext) { await route.continue(); return; }
        holdNext = false;
        try {
          const realResponse = await route.fetch();
          expect(realResponse.status()).toBe(200);
          held = true;
          await released;
          // Return the actual server body after a newer tooth request has completed.
          try { await route.fulfill({ response: realResponse }); }
          catch (error) { deliveryError = String(error); }
        } finally { finish(); }
      });
      await page.getByRole("button", { name: "مسح اختيار الخطة والبنود", exact: true }).click();
      await expect.poll(() => held).toBe(true);
      await tooth(page, 46); await refused(page);
      expect(await page.getByTestId("invoice-plan-item-0").count()).toBe(0);
      release(); await completed;
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      if (deliveryError !== null) expect(cancelled).toBe(true);
      expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe("46");
      expect(await page.getByTestId("invoice-plan-item-0").count()).toBe(0);
      expect(await page.getByTestId("invoice-provider-0").inputValue()).toBe(String(doctorId));
      expect(await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).isDisabled()).toBe(true);
      expect(await q("SELECT id FROM invoices WHERE patient_id=$1", [patientId])).toHaveLength(0);
    } finally {
      release(); await context.close(); contexts.delete(context);
      if (held) await completed;
    }
  }, 120000);
});
