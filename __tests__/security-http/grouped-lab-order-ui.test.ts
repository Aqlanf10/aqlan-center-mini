/** 0136 acceptance by clicks on the built application (owner #483 6930647956, 6931868779, 6932010630), synthetic
 * database only: teeth from BOTH jaws on one invoice, ONE short entry (lab, shade, instructions) → ONE lab order with
 * one member per tooth, priced from the settings mapping and the lab's price; a lab without a price saves the invoice
 * with a visible Arabic warning and a pending cost; the services settings screen sets the mapping. */
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
const stamp = Date.now();
const ids = { doctor: 0, pricedLab: 0, unpricedLab: 0, service: 0, unmapped: 0, labService: 0 };
const evidence = ".settings-ui-artifacts/grouped-lab-order";
const one = async (sql: string, values: unknown[]) => (await db.query<{ id: number }>(sql, values)).rows[0].id;
const TEETH = [16, 26, 36];

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ids.doctor = await one("INSERT INTO parties(name,kind,commission_percent) VALUES($1,'doctor',30) RETURNING id", [`طبيب تجميع اصطناعي ${stamp}`]);
  ids.pricedLab = await one("INSERT INTO parties(name,kind,currency) VALUES($1,'lab','YER') RETURNING id", [`مختبر مسعّر اصطناعي ${stamp}`]);
  ids.unpricedLab = await one("INSERT INTO parties(name,kind,currency) VALUES($1,'lab','YER') RETURNING id", [`مختبر بلا سعر اصطناعي ${stamp}`]);
  ids.labService = await one("INSERT INTO lab_services(name,code,category,tooth_scope,requires_shade) VALUES($1,$2,'prostho','single_tooth',TRUE) RETURNING id", [`زيركون اصطناعي ${stamp}`, `SYN-GLO-${stamp}`]);
  ids.service = await one("INSERT INTO services(name,category,price_minor,price_configured,is_active,lab_service_id) VALUES($1,'crown',1000,TRUE,TRUE,$2) RETURNING id", [`تاج تجميع اصطناعي ${stamp}`, ids.labService]);
  ids.unmapped = await one("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES($1,'crown',1000,TRUE,TRUE) RETURNING id", [`تاج بلا ربط اصطناعي ${stamp}`]);
  await db.query("INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by) VALUES($1,$2,200,'YER','2020-01-01','synthetic')", [ids.pricedLab, ids.labService]);
  mkdirSync(evidence, { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function adminPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1040 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  return { context, page, errors };
}

/** A direct invoice with one crown line on the given teeth, grouped through the single short entry. */
async function invoiceWithGroupedLab(page: Page, patientId: number, labId: number, instructions: string) {
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("treatment-entry-open").click();
  await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
  await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(ids.service));
  await page.getByTestId("invoice-tooth-button-0").click();
  const dialog = page.getByTestId("tooth-dialog"); await dialog.waitFor();
  for (const tooth of TEETH) await dialog.getByTestId(`odontogram-tooth-${tooth}`).click();
  await page.getByTestId("tooth-dialog-confirm").click(); await dialog.waitFor({ state: "detached" });
  await page.getByTestId("invoice-provider-0").selectOption(String(ids.doctor));
  const start = page.getByTestId("grouped-lab-start");
  await expect.poll(() => start.textContent(), { timeout: 30_000 }).toContain(`(${TEETH.length})`);
  await start.click();
  const entry = page.getByTestId("grouped-lab-entry"); await entry.waitFor();
  expect(await entry.getByTestId("grouped-lab-teeth").textContent()).toContain(TEETH.join("، "));
  await entry.getByTestId("grouped-lab-party").selectOption(String(labId));
  await entry.getByTestId("grouped-lab-shade").selectOption("A2");
  await entry.getByTestId("grouped-lab-instructions").fill(instructions);
  // The per-tooth lab form is not opened for the grouped teeth: one entry only.
  expect(await page.locator("legend", { hasText: /^مواصفات المختبر — / }).count()).toBe(0);
  await expect.poll(() => page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).isEnabled(), { timeout: 30_000 }).toBe(true);
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/invoices" && response.request().method() === "POST");
  await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).click();
  expect((await saved).status()).toBe(201);
}

const ordersOf = async (patientId: number) => (await db.query<{ id: number; cost: number | null; pricing_state: string | null; members: number; payables: number }>(
  `SELECT o.id, o.cost_minor::int AS cost, o.pricing_state,
          (SELECT count(*)::int FROM lab_work_members m WHERE m.intent_id=o.lab_work_intent_id AND m.retired_revision IS NULL) AS members,
          (SELECT count(*)::int FROM payables p WHERE p.lab_order_id=o.id) AS payables
     FROM lab_orders o WHERE o.patient_id=$1`, [patientId])).rows;

it("teeth from both jaws, one short entry → one priced lab order with one member per tooth and one payable", async () => {
  const patient = await one("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [`SYN-GLO-A-${stamp}`, `مريض تجميع اصطناعي أ ${stamp}`]);
  const { context, page, errors } = await adminPage();
  try {
    await invoiceWithGroupedLab(page, patient, ids.pricedLab, "حواف رفيعة");
    await page.screenshot({ path: `${evidence}/1-grouped-priced-1280.png`, fullPage: true });
    expect(await ordersOf(patient)).toEqual([expect.objectContaining({ cost: 600, pricing_state: "rule", members: 3, payables: 1 })]);
    expect(await page.getByTestId("grouped-lab-pricing-warning").count()).toBe(0);
    await page.goto(`${baseUrl}/lab`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "لم تُرسل بعد", exact: true }).click();
    const details = page.getByRole("table", { name: "أنواع وأسعار أسنان طلب المختبر" }).filter({ hasText: `تاج تجميع اصطناعي ${stamp}` });
    await details.waitFor({ timeout: 30_000 });
    for (const tooth of TEETH) expect(await details.textContent()).toContain(String(tooth));
    expect(await details.textContent()).toContain("YER");
    expect(await details.textContent()).toContain(`زيركون اصطناعي ${stamp}`);
    const hidden = await fetch(`${baseUrl}/api/lab?patientId=${patient}`, { headers: { Cookie: h.sessions.doctorA.cookie } });
    expect(hidden.status).toBe(200);
    const payload = await hidden.json();
    expect(payload.orders[0].members).toHaveLength(3);
    expect(payload.orders[0]).not.toHaveProperty("memberPrices");
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 180_000);

it("a lab without a price still saves the invoice, warns in Arabic and leaves the lab cost pending", async () => {
  const patient = await one("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [`SYN-GLO-B-${stamp}`, `مريض تجميع اصطناعي ب ${stamp}`]);
  const { context, page, errors } = await adminPage();
  try {
    await invoiceWithGroupedLab(page, patient, ids.unpricedLab, "");
    const warning = page.getByTestId("grouped-lab-pricing-warning");
    await warning.waitFor({ timeout: 30_000 });
    expect(await warning.textContent()).toContain("معلّقة");
    await page.screenshot({ path: `${evidence}/2-missing-price-warning-1280.png`, fullPage: true });
    expect(await ordersOf(patient)).toEqual([expect.objectContaining({ cost: null, pricing_state: "missing_rule", members: 3, payables: 0 })]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 180_000);

it("the services settings screen maps a clinic crown to a lab service", async () => {
  const { context, page, errors } = await adminPage();
  try {
    await page.goto(`${baseUrl}/finance/services`, { waitUntil: "domcontentloaded" });
    const select = page.getByTestId(`service-lab-mapping-${ids.unmapped}`);
    await select.waitFor({ timeout: 30_000 });
    const patched = page.waitForResponse(response => new URL(response.url()).pathname === `/api/services/${ids.unmapped}` && response.request().method() === "PATCH");
    await select.selectOption(String(ids.labService));
    expect((await patched).status()).toBe(200);
    expect((await db.query("SELECT lab_service_id FROM services WHERE id=$1", [ids.unmapped])).rows).toEqual([{ lab_service_id: ids.labService }]);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='service.lab_mapping' AND entity_id=$1", [String(ids.unmapped)])).rows).toEqual([{ n: 1 }]);
    await page.screenshot({ path: `${evidence}/3-service-mapping-1280.png`, fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
}, 180_000);
