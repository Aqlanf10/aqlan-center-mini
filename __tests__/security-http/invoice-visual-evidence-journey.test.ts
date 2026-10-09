import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";
import { COLLECTOR_PATH, emitVisualEvidence, sha256, VIEWPORT_HEIGHT, VISUAL_TEST_PATH,
  type CapturedScene, type VisualScene } from "./_invoice-visual-evidence";

/** Required visual evidence from the built app, using only this suite's isolated fixtures.
 * No API interception, CSS replacement, cookies/storage/traces/HAR/HTML/environment export.
 * A first real invoice gives a genuine duplicate-linkage refusal on the same synthetic patient.
 * All six bounded PNGs must succeed before any evidence bytes are emitted through existing CI stdout. */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let doctorId = 0;
let serviceId = 0;
const syntheticPatients = new Map<number, string>();
const stamp = Date.now();

beforeAll(async () => {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("Visual evidence requires the isolated loopback harness");
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ({ rows: [{ party_id: doctorId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  ({ rows: [{ id: serviceId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category)
     VALUES ($1, 1500000, TRUE, TRUE, 'filling') RETURNING id`, [`حشوة الدليل البصري الاصطناعي ${stamp}`]));
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function selectInvoiceLine(page: Page) {
  await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(serviceId));
  await page.getByTestId("invoice-provider-0").selectOption(String(doctorId));
  await page.getByTestId("invoice-tooth-button-0").click();
  const dialog = page.getByTestId("tooth-dialog");
  await page.locator('[data-testid="tooth-dialog"][data-chart-state="ready"]').waitFor();
  await dialog.getByTestId("odontogram-tooth-26").click();
  await dialog.getByTestId("surface-M").click();
  await dialog.getByTestId("surface-O").click();
}

async function capture(page: Page, patientId: number, scene: VisualScene): Promise<CapturedScene> {
  const expectedName = syntheticPatients.get(patientId);
  const location = new URL(page.url());
  if (!expectedName || location.origin !== new URL(baseUrl).origin || location.pathname !== `/patients/${patientId}`
    || location.search !== "?tab=account" || location.hash) throw new Error("Screenshot target is outside the synthetic scene allowlist");
  expect(await page.getByText(expectedName, { exact: true }).first().isVisible()).toBe(true);
  const width = scene.endsWith("-390") ? 390 : 1280;
  expect(page.viewportSize()).toEqual({ width, height: VIEWPORT_HEIGHT });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.evaluate(async () => { await document.fonts.ready; });
  const targets = scene.includes("shared-chart")
    ? ["tooth-dialog", "odontogram-tooth-26", "surface-M", "surface-O", "tooth-dialog-confirm"]
    : ["invoice-provider-0", "invoice-tooth-chip-0", "invoice-clinical-preview-0"];
  for (const target of targets) {
    const bounds = await page.getByTestId(target).boundingBox();
    expect(bounds, `required visible target ${target}`).not.toBeNull();
    expect(bounds!.x >= -1 && bounds!.y >= -1 && bounds!.x + bounds!.width <= width + 1
      && bounds!.y + bounds!.height <= VIEWPORT_HEIGHT + 1, `target inside actual screenshot ${target}`).toBe(true);
  }
  if (!scene.includes("shared-chart")) {
    const bounds = await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).boundingBox();
    expect(bounds, "required Save control").not.toBeNull();
    expect(bounds!.x >= -1 && bounds!.y >= -1 && bounds!.x + bounds!.width <= width + 1
      && bounds!.y + bounds!.height <= VIEWPORT_HEIGHT + 1, "Save control inside actual screenshot").toBe(true);
  }
  const png = await page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide", scale: "css" });
  return { scene, png };
}

describe("required invoice visual evidence through retained CI stdout", () => {
  it("captures actual provider-ready, shared-chart and refusal scenes at 390 and 1280", async () => {
    const captures: CapturedScene[] = [];
    for (const width of [390, 1280] as const) {
      const patientName = `مريض الدليل البصري الاصطناعي ${width}`;
      const { rows: [{ id: patientId }] } = await db.query<{ id: number }>(
        `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
        [`IVIS-${stamp}-${width}`, patientName, doctorId]);
      syntheticPatients.set(patientId, patientName);
      const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT }, locale: "ar-YE", deviceScaleFactor: 1 });
      const [name, ...value] = h.sessions.reception.cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "فاتورة يدوية", exact: true }).click();
        await selectInvoiceLine(page);
        expect(await page.getByTestId("tooth-dialog").getByTestId("odontogram-tooth-26").getAttribute("aria-pressed")).toBe("true");
        expect(await page.getByTestId("surface-M").getAttribute("aria-pressed")).toBe("true");
        expect(await page.getByTestId("surface-O").getAttribute("aria-pressed")).toBe("true");
        captures.push(await capture(page, patientId, `invoice-shared-chart-${width}`));

        await page.getByTestId("tooth-dialog-confirm").click();
        await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
        await page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="ready"]').waitFor();
        expect(await page.getByTestId("invoice-provider-0").inputValue()).toBe(String(doctorId));
        expect(await page.getByTestId("invoice-provider-review-0").count()).toBe(0);
        expect(await page.getByTestId("invoice-tooth-chip-0").innerText()).toContain("MO");
        const save = page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
        expect(await save.isEnabled()).toBe(true);
        await page.getByRole("region", { name: "فاتورة جديدة", exact: true }).evaluate((element) => element.scrollIntoView({ block: "start" }));
        await page.evaluate(() => window.scrollBy(0, -96));
        captures.push(await capture(page, patientId, `invoice-provider-ready-${width}`));

        await save.click();
        await page.getByTestId("invoice-clinical-notice").waitFor();
        await page.getByRole("button", { name: "فاتورة يدوية", exact: true }).click();
        await selectInvoiceLine(page);
        const duplicatePreview = page.waitForResponse((response) => {
          if (new URL(response.url()).pathname !== "/api/invoices/clinical-preview" || response.request().method() !== "POST") return false;
          const body = response.request().postDataJSON() as { items?: { toothCode?: number; doctorId?: number; surfaces?: string }[] };
          return body.items?.[0]?.toothCode === 26 && body.items[0].doctorId === doctorId && body.items[0].surfaces === "MO";
        });
        await page.getByTestId("tooth-dialog-confirm").click();
        const duplicateResponse = await duplicatePreview;
        expect(duplicateResponse.status()).toBe(200);
        const duplicateBody = await duplicateResponse.json() as { lines: { line: number; refusal: string | null }[] };
        expect(duplicateBody.lines.find((line) => line.line === 0)?.refusal).toBe("already_billed");
        await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
        const refusal = page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="refused"]');
        await refusal.waitFor();
        expect(await refusal.innerText()).not.toContain("ستنشئ/تربط");
        expect(await save.isEnabled()).toBe(false);
        await page.getByRole("region", { name: "فاتورة جديدة", exact: true }).evaluate((element) => element.scrollIntoView({ block: "start" }));
        await page.evaluate(() => window.scrollBy(0, -96));
        captures.push(await capture(page, patientId, `invoice-refusal-${width}`));
        expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(1);
      } finally { await context.close(); }
    }
    await emitVisualEvidence(captures, {
      testSha256: sha256(readFileSync(join(process.cwd(), VISUAL_TEST_PATH))),
      collectorSha256: sha256(readFileSync(join(process.cwd(), COLLECTOR_PATH))),
    });
  }, 240_000);
});
