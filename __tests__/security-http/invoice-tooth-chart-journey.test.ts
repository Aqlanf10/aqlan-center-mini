import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/**
 * (INV-LINK TOOTH) أسنان بند الفاتورة العلاجية تُختار بالنقر على **مخطط الأسنان نفسه** (Odontogram المشترك مع
 * المخطط السريري) — لا بكتابة الأرقام. على التطبيق المبني وقاعدة معزولة:
 * عصب 36+46 ⇒ سطران وحالتان · جسر 14-16 ⇒ ثلاثة أسطر وحالة واحدة · حشوة 26 MO · تقويم فك علوي بلا مخطط ·
 * كشف بلا زر أسنان · عصب بلا سن ⇒ الحفظ ممنوع · جوال 390px بلا تمرير أفقي للصفحة.
 */

let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorPartyId = 0;
const stamp = Date.now();
const services: Record<"rct" | "bridge" | "filling" | "ortho" | "consultation", number> = {
  rct: 0, bridge: 0, filling: 0, ortho: 0, consultation: 0,
};
const SHOTS = "/tmp/claude-0/shots";

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ({ rows: [{ party_id: doctorPartyId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  const prices = { rct: 6000000, bridge: 9000000, filling: 1500000, ortho: 30000000, consultation: 300000 };
  for (const category of Object.keys(services) as (keyof typeof services)[]) {
    ({ rows: [{ id: services[category] }] } = await db.query<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, $2, TRUE, TRUE, $3) RETURNING id`,
      [`سن مخطط ${category} ${stamp}`, prices[category], category]));
  }
  try { mkdirSync(SHOTS, { recursive: true }); } catch { /* لقطات اختيارية */ }
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function newPatient(label: string): Promise<number> {
  const { rows: [{ id }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`ITC-${label}-${stamp}`, `مريض مخطط الفاتورة ${label}`, doctorPartyId]);
  return id;
}

async function openInvoice(patientId: number, viewport = { width: 1280, height: 1100 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: "ar-YE" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "فاتورة يدوية" }).click();
  return { context, page };
}

async function chooseService(page: Page, serviceId: number, line = 0) {
  await page.getByTestId(`invoice-row-${line}`).getByLabel("الخدمة", { exact: true }).selectOption(String(serviceId));
}

/** يفتح المخطط من زر السطر وينقر الأسنان في المخطط المشترك (لا كتابة أرقام). */
async function pickTeeth(page: Page, line: number, teeth: number[], surfaces: string[] = []): Promise<Locator> {
  await page.getByTestId(`invoice-tooth-button-${line}`).click();
  const dialog = page.getByTestId("tooth-dialog");
  await dialog.waitFor();
  for (const tooth of teeth) await dialog.getByTestId(`odontogram-tooth-${tooth}`).click();
  for (const surface of surfaces) await dialog.getByTestId(`surface-${surface}`).click();
  return dialog;
}

async function confirm(page: Page) {
  await page.getByTestId("tooth-dialog-confirm").click();
  await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
}

async function save(page: Page) {
  await page.getByRole("button", { name: "احفظ الفاتورة" }).click();
  await page.getByTestId("invoice-clinical-notice").waitFor();
}

const planItems = async (patientId: number) => (await db.query<{ tooth_code: number | null; surfaces: string | null }>(
  `SELECT pi.tooth_code, pi.surfaces FROM plan_items pi JOIN treatment_plans tp ON tp.id = pi.plan_id
    WHERE tp.patient_id = $1 ORDER BY pi.tooth_code NULLS FIRST, pi.id`, [patientId])).rows;
const cases = async (patientId: number) => (await db.query<{ specialty: string; site: string | null }>(
  `SELECT specialty, site FROM clinical_cases WHERE patient_id = $1 ORDER BY site NULLS FIRST, id`, [patientId])).rows;

describe("INV-LINK TOOTH — invoice tooth selection through the shared dental chart", () => {
  it("RCT: clicking 36 and 46 on the chart splits into two lines, each previewing its own case; saved as two items and two cases", async () => {
    const patientId = await newPatient("rct");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.rct);
    const dialog = await pickTeeth(page, 0, [36, 46]);
    expect(await dialog.getAttribute("role")).toBe("dialog");
    expect(await dialog.getAttribute("aria-modal")).toBe("true");
    expect(await dialog.getByTestId("odontogram-tooth-36").getAttribute("aria-pressed")).toBe("true");
    expect(await dialog.getByTestId("tooth-dialog-split-notice").innerText()).toContain("سيُنشأ سطر وحالة مستقلة لكل سن");
    await confirm(page);

    expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe("36");
    expect(await page.getByTestId("invoice-row-1").getAttribute("data-tooth")).toBe("46");
    expect(await page.getByTestId("invoice-split-notice").innerText()).toContain("سيُنشأ سطر وحالة مستقلة لكل سن");
    expect(await page.getByTestId("invoice-tooth-chip-1").innerText()).toContain("سن 46");
    for (const line of [0, 1]) {
      const preview = page.getByTestId(`invoice-clinical-preview-${line}`);
      await preview.filter({ hasText: "سيتم إنشاء حالة أولية تحتاج تقييم الطبيب" }).waitFor();
      expect(await preview.innerText()).toContain("بند خطة جديد");
    }

    // Escape يغلق النافذة دون تغيير السطر
    await page.getByTestId("invoice-tooth-button-0").click();
    await page.getByTestId("tooth-dialog").getByTestId("odontogram-tooth-11").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
    expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe("36");
    expect(await page.getByTestId("invoice-row-2").count()).toBe(0);

    await page.screenshot({ path: `${SHOTS}/invoice-tooth-rct-desktop.png`, fullPage: true }).catch(() => undefined);
    await save(page);
    expect((await db.query(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(1);
    expect((await planItems(patientId)).map((row) => row.tooth_code)).toEqual([36, 46]);
    expect(await cases(patientId)).toEqual([{ specialty: "endodontics", site: "36" }, { specialty: "endodontics", site: "46" }]);
    await context.close();
  });

  it("bridge: 14, 15, 16 on the chart ⇒ three grouped lines carrying the episode, one case", async () => {
    const patientId = await newPatient("bridge");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.bridge);
    const dialog = await pickTeeth(page, 0, [16, 14, 15]);
    expect(await dialog.getByTestId("tooth-dialog-summary").innerText()).toContain("14، 15، 16");
    await confirm(page);
    for (const [line, tooth] of [[0, 14], [1, 15], [2, 16]] as const) {
      expect(await page.getByTestId(`invoice-row-${line}`).getAttribute("data-tooth")).toBe(String(tooth));
      expect(await page.getByTestId(`invoice-tooth-chip-${line}`).innerText()).toContain("جسر/حلقة: 14، 15، 16");
    }
    await page.getByTestId("invoice-clinical-preview-2").waitFor();
    await save(page);
    expect((await planItems(patientId)).map((row) => row.tooth_code)).toEqual([14, 15, 16]);
    const opened = await cases(patientId);
    expect(opened).toHaveLength(1);
    expect(opened[0].specialty).toBe("prosthodontics");
    await context.close();
  });

  it("filling: tooth 26 + surfaces M, O ⇒ plan item surfaces MO", async () => {
    const patientId = await newPatient("filling");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.filling);
    await pickTeeth(page, 0, [26], ["M", "O"]);
    await confirm(page);
    expect(await page.getByTestId("invoice-tooth-chip-0").innerText()).toContain("سن 26 — أسطح MO");
    await page.getByTestId("invoice-clinical-preview-0").waitFor();
    await save(page);
    expect(await planItems(patientId)).toEqual([{ tooth_code: 26, surfaces: "MO" }]);
    await context.close();
  });

  it("ortho: upper arch scope, no tooth chart needed ⇒ case site «الفك العلوي»", async () => {
    const patientId = await newPatient("ortho");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.ortho);
    const row = page.getByTestId("invoice-row-0");
    await row.getByTestId("scope-upper").click();
    expect(await row.getByTestId("scope-upper").getAttribute("aria-pressed")).toBe("true");
    expect(await page.getByTestId("invoice-tooth-button-0").count()).toBe(0);
    expect(await page.getByRole("button", { name: "احفظ الفاتورة" }).isEnabled()).toBe(true);
    await page.getByTestId("invoice-clinical-preview-0").waitFor();
    await save(page);
    expect(await cases(patientId)).toEqual([{ specialty: "orthodontics", site: "الفك العلوي" }]);
    await context.close();
  });

  it("consultation: no tooth button at all", async () => {
    const patientId = await newPatient("consult");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.consultation);
    await expect.poll(() => page.getByRole("button", { name: "احفظ الفاتورة" }).isEnabled()).toBe(true);
    expect(await page.getByTestId("invoice-tooth-button-0").count()).toBe(0);
    expect(await page.getByTestId("invoice-tooth-control-0").count()).toBe(0);
    await context.close();
  });

  it("RCT without a tooth: save is blocked with an Arabic message and nothing is written", async () => {
    const patientId = await newPatient("blocked");
    const { context, page } = await openInvoice(patientId);
    await chooseService(page, services.rct);
    const blocked = page.getByTestId("invoice-save-blocked");
    await blocked.waitFor();
    expect(await blocked.innerText()).toContain("لا يمكن حفظ الفاتورة قبل تحديد السن");
    expect(await page.getByTestId("invoice-tooth-problem-0").innerText()).toContain("حدّد السن من مخطط الأسنان");
    expect(await page.getByRole("button", { name: "احفظ الفاتورة" }).isDisabled()).toBe(true);
    // ولا يفتح الحفظ بنافذةٍ أُلغيت بلا اختيار
    await page.getByTestId("invoice-tooth-button-0").click();
    expect(await page.getByTestId("tooth-dialog-confirm").isDisabled()).toBe(true);
    await page.getByRole("button", { name: "إلغاء", exact: true }).click();
    expect(await page.getByRole("button", { name: "احفظ الفاتورة" }).isDisabled()).toBe(true);
    expect((await db.query(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    await context.close();
  });

  it("mobile 390×844: the dialog is a full-width sheet, the page never scrolls sideways, confirm works", async () => {
    const patientId = await newPatient("mobile");
    const { context, page } = await openInvoice(patientId, { width: 390, height: 844 });
    await chooseService(page, services.rct);
    await page.getByTestId("invoice-tooth-button-0").click();
    const dialog = page.getByTestId("tooth-dialog");
    await dialog.waitFor();
    const box = await dialog.boundingBox();
    expect(box && box.width <= 390 && box.x >= 0).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const tooth = dialog.getByTestId("odontogram-tooth-36");
    const toothBox = await tooth.boundingBox();
    expect(toothBox && toothBox.width >= 44 && toothBox.height >= 44).toBe(true);
    await tooth.click();
    const confirmBox = await page.getByTestId("tooth-dialog-confirm").boundingBox();
    expect(confirmBox && confirmBox.height >= 44).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/invoice-tooth-dialog-mobile.png` }).catch(() => undefined);
    await confirm(page);
    expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe("36");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/invoice-tooth-row-mobile.png`, fullPage: true }).catch(() => undefined);
    await context.close();
  });
});
