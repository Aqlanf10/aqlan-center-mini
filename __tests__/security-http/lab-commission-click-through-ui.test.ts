/** Release safety journey (owner #483 6902952517): invoice → lab → commission by clicks on the built application,
 * real routes and a synthetic PostgreSQL database. A crown is invoiced directly from the patient account with its
 * laboratory and shade; the lab board records the lab's cost; the commission screen shows the doctor's share
 * before and after that cost. Invoice 1000, lab 200, doctor 30%: 300 then 240. */
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
const stamp = Date.now();
const names = { patient: `مريض تركيبة اصطناعي ${stamp}`, doctor: `طبيب تركيبة اصطناعي ${stamp}`, lab: `مختبر قبول اصطناعي ${stamp}`, service: `تاج قبول اصطناعي ${stamp}` };
const ids = { patient: 0, doctor: 0, lab: 0, service: 0 };
const evidence = ".settings-ui-artifacts/lab-commission-click-through";
const id = async (sql: string, values: unknown[]) => (await db.query<{ id: number }>(sql, values)).rows[0].id;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ids.patient = await id("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [`SYN-LCC-${stamp}`, names.patient]);
  ids.doctor = await id("INSERT INTO parties(name,kind,commission_percent) VALUES($1,'doctor',30) RETURNING id", [names.doctor]);
  ids.lab = await id("INSERT INTO parties(name,kind,currency) VALUES($1,'lab','YER') RETURNING id", [names.lab]);
  ids.service = await id("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES($1,'crown',1000,TRUE,TRUE) RETURNING id", [names.service]);
  mkdirSync(evidence, { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

/** The doctor's accrued commission as the commission screen prints it. */
async function accruedOnScreen(page: Page) {
  await page.goto(`${baseUrl}/finance/commissions`, { waitUntil: "domcontentloaded" });
  const card = page.locator("li", { hasText: names.doctor }).first();
  await card.waitFor({ timeout: 30_000 });
  return (await card.locator("div.grid > div").first().locator("p").first().innerText()).replace(/[^\d٠-٩]/g, "");
}

it("invoice with laboratory and shade → cost on the lab board → commission 300 then 240", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1040 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    // 1) A direct treatment invoice from the patient account: no visit first.
    await page.goto(`${baseUrl}/patients/${ids.patient}?tab=account`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("treatment-entry-open").click();
    await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
    const row = page.getByTestId("invoice-row-0");
    await row.getByLabel("الخدمة", { exact: true }).selectOption(String(ids.service));
    await page.getByTestId("invoice-tooth-button-0").click();
    const dialog = page.getByTestId("tooth-dialog"); await dialog.waitFor();
    await dialog.getByTestId("odontogram-tooth-27").click();
    await page.getByTestId("tooth-dialog-confirm").click(); await dialog.waitFor({ state: "detached" });
    await page.getByTestId("invoice-provider-0").selectOption(String(ids.doctor));
    await page.getByRole("button", { name: "مواصفات المختبر — سن 27", exact: true }).click();
    await page.locator(`select:has(option[value="${ids.lab}"])`).filter({ hasNot: page.locator(`option[value="${ids.doctor}"]`) }).last().selectOption(String(ids.lab));
    await page.locator("label", { hasText: /^لون السن/ }).locator("select").selectOption({ index: 1 });
    await expect.poll(() => page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).isEnabled(), { timeout: 30_000 }).toBe(true);
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/invoices" && response.request().method() === "POST");
    await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).click();
    expect((await saved).status()).toBe(201);
    await page.screenshot({ path: `${evidence}/1-invoice-saved-1280.png`, fullPage: true });

    const orders = (await db.query<{ id: number; party_id: number; shade: string | null; visit_id: number | null; cost_minor: string | null }>(
      "SELECT id, party_id, shade, visit_id, cost_minor FROM lab_orders WHERE patient_id=$1", [ids.patient])).rows;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ party_id: ids.lab, visit_id: null, cost_minor: null });
    expect(orders[0].shade).toBeTruthy();

    // 2) Before the lab's cost is known the doctor's share is on the full 1000.
    expect(await accruedOnScreen(page)).toBe("300");

    // 3) The lab board: record the lab's cost on the same order.
    await page.goto(`${baseUrl}/lab`, { waitUntil: "domcontentloaded" });
    // The invoice opened the order as «لم تُرسل بعد»: it waits there until the lab work is sent.
    await page.getByRole("button", { name: "لم تُرسل بعد", exact: true }).click();
    await page.locator(`#lab-accounting-btn-${orders[0].id}`).click();
    await page.locator("#lab-accounting-cost-input").fill("200");
    await page.locator("#lab-accounting-currency-select").selectOption("YER");
    const patched = page.waitForResponse(response => new URL(response.url()).pathname === `/api/lab/${orders[0].id}` && response.request().method() === "PATCH");
    await page.locator("#lab-accounting-save-mapping-btn").click();
    expect((await patched).status()).toBe(200);
    expect((await db.query("SELECT amount_minor::int AS amount, currency FROM payables WHERE lab_order_id=$1", [orders[0].id])).rows).toEqual([{ amount: 200, currency: "YER" }]);

    // 4) The commission screen now takes the lab's cost first: (1000 − 200) × 30%.
    expect(await accruedOnScreen(page)).toBe("240");
    await page.screenshot({ path: `${evidence}/2-commission-after-lab-cost-1280.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 180_000);
