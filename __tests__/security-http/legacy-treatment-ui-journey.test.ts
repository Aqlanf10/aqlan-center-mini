import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/**
 * (INV-LINK LEGACY) Treatment started before the system, through the real built form and the shared Dental Chart.
 * 300,000 agreed and 120,000 paid before the system ⇒ only 180,000 enters as an opening balance: no invoice,
 * no receipt and no cash movement. Coverage is the immutable 14–16 snapshot, the case is marked
 * «حالة بدأت قبل النظام», and no clinical consent is invented. Synthetic isolated database only.
 */
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let bridge = 0;
const stamp = Date.now();
const SHOTS = ".settings-ui-artifacts";

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ({ rows: [{ id: bridge }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 300000, TRUE, TRUE, 'bridge') RETURNING id`,
    [`جسر قبل النظام ${stamp}`]));
  mkdirSync(SHOTS, { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function open(patientId: number, width: number, path: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${patientId}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}

/** Fills the real form through the shared Dental Chart and saves with a double click; returns the screenshot-ready page closed. */
async function registerThroughForm(patientId: number, width: number) {
  const page = await open(patientId, width, "?tab=account");
  const previews: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/legacy-treatments/preview")) previews.push(response.status());
    // The legacy form must never borrow the ordinary invoice preview again.
    if (response.url().includes("/api/invoices/clinical-preview")) previews.push(-1);
  });
  try {
    await page.getByRole("button", { name: "علاج بدأ قبل النظام" }).click();
    const form = page.getByTestId("legacy-treatment-form");
    await form.getByLabel("الخدمة العلاجية").selectOption(String(bridge));
    await form.getByTestId("legacy-tooth-button").click();
    const dialog = page.getByTestId("tooth-dialog");
    for (const tooth of [14, 15, 16]) await dialog.getByTestId(`odontogram-tooth-${tooth}`).click();
    await page.getByTestId("tooth-dialog-confirm").click();
    await dialog.waitFor({ state: "detached" });
    expect(await form.getByTestId("legacy-tooth-chip").innerText()).toMatch(/14[\s\S]*16/);
    // Incomplete draft: the save stays disabled and says why.
    expect(await form.getByTestId("legacy-preview-read-state").innerText()).toContain("أكمل");
    await form.getByLabel("المبلغ المتفق عليه أصلًا").fill("300000");
    await form.getByLabel("المدفوع قبل النظام").fill("120000");
    await form.getByLabel("تاريخ المعلومات التاريخية").fill("2026-01-15");
    await expect.poll(() => form.getByTestId("legacy-remaining").innerText()).toContain("180,000");
    // The case-link and opening evidence must be ready before saving; report its final message if it never becomes ready.
    const readState = form.getByTestId("legacy-preview-read-state");
    await expect.poll(async () => await readState.count() === 0 ? "ready" : await readState.innerText(), { timeout: 30_000 }).toBe("ready");
    expect(await form.getByTestId("legacy-opening-effect").innerText()).toContain("180,000");
    expect(await form.getByTestId("legacy-case-preview").innerText()).toContain("حالة بدأت قبل النظام");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/legacy-treatment-form-${width}.png`, fullPage: true });
    await form.getByRole("button", { name: "احفظ العلاج السابق" }).dblclick();
    await page.getByTestId("legacy-agreements").waitFor();
    await expect.poll(() => page.getByTestId("legacy-agreements").innerText()).toContain("14");
    await page.screenshot({ path: `${SHOTS}/legacy-treatment-saved-${width}.png`, fullPage: true });
    expect(previews.length).toBeGreaterThan(0);
    expect(previews.every((status) => status === 200)).toBe(true);
  } finally { await page.context().close(); }
}

describe("pre-system treatment through the built form", () => {
  it.each([1280, 390])("records 300000/120000 as a 180000 opening only at %s, with immutable 14–16 coverage, a marked case and no invented money or consent", async (width) => {
    const { rows: [{ id: patientId }] } = await db.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id", [`LGUI-${stamp}-${width}`, "مريض علاج سابق اصطناعي"]);
    await registerThroughForm(patientId, width);

    const { rows: agreements } = await db.query(`SELECT a.id, a.agreed_minor::int AS agreed, a.previously_paid_minor::int AS paid,
        a.remaining_minor::int AS remaining, a.currency, a.historical_as_of::text AS as_of, a.case_id, a.plan_item_id,
        s.snapshot_tooth_codes AS teeth, s.snapshot_mode AS mode
      FROM legacy_treatment_agreements a LEFT JOIN legacy_treatment_coverage_snapshots s ON s.agreement_id = a.id
      WHERE a.patient_id = $1`, [patientId]);
    expect(agreements).toEqual([expect.objectContaining({ agreed: 300000, paid: 120000, remaining: 180000, currency: "YER",
      as_of: "2026-01-15", teeth: [14, 15, 16], mode: "multi_tooth_episode" })]);
    expect((await db.query("SELECT amount_minor::int AS amount FROM patient_opening_balances WHERE patient_id = $1 AND currency = 'YER'", [patientId])).rows)
      .toEqual([{ amount: 180000 }]);
    expect((await db.query("SELECT 1 FROM invoices WHERE patient_id = $1", [patientId])).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM payments WHERE patient_id = $1", [patientId])).rows).toHaveLength(0);
    const { rows: [plan] } = await db.query<{ id: number; consent_at: string | null }>(`SELECT t.id, t.consent_at FROM treatment_plans t
      JOIN plan_items i ON i.plan_id = t.id WHERE i.id = $1`, [agreements[0].plan_item_id]);
    expect(plan.consent_at).toBeNull();
    expect(agreements[0].case_id).not.toBeNull();

    // A second tooth inside the recorded bridge cannot be billed again through the invoice preview.
    const preview = await fetch(`${baseUrl}/api/invoices/clinical-preview`, { method: "POST",
      headers: { "Content-Type": "application/json", Cookie: h.sessions.reception.cookie, Origin: baseUrl, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ patientId, currency: "YER", discount: "", discountReason: "", idempotencyKey: `lgui-${stamp}`,
        items: [{ serviceId: bridge, description: "", price: "", quantity: 1, toothCode: 15, episodeTeeth: [15] }] }) });
    const previewBody = await preview.json() as { lines?: { refusal: string | null }[]; message?: string };
    expect(previewBody.lines?.[0]?.refusal ?? previewBody.message).toBeTruthy();
    expect(previewBody.lines?.[0]?.refusal ?? null).not.toBeNull();

    {
      const lab = await open(patientId, width, "?tab=treatment&sub=lab");
      try {
        const banner = lab.getByTestId("legacy-case-banner-prosthodontics");
        await banner.waitFor();
        expect(await banner.innerText()).toContain("قبل النظام");
        expect(await lab.evaluate(() => document.documentElement.dir)).toBe("rtl");
        expect(await lab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await lab.screenshot({ path: `${SHOTS}/legacy-treatment-case-${width}.png`, fullPage: true });
      } finally { await lab.context().close(); }
      const account = await open(patientId, width, "?tab=account");
      try {
        await account.getByTestId("legacy-agreements").waitFor();
        expect(await account.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await account.screenshot({ path: `${SHOTS}/legacy-treatment-account-${width}.png`, fullPage: true });
      } finally { await account.context().close(); }
    }

    if (width !== 1280) return;
    const print = await open(patientId, 1280, "");
    try {
      const pdf = async (url: string, name: string) => {
        await print.goto(`${baseUrl}${url}`, { waitUntil: "networkidle" });
        const path = `${SHOTS}/${name}.pdf`;
        await print.pdf({ path, format: "A4", printBackground: true, preferCSSPageSize: true });
        expect(execFileSync("pdfinfo", [path], { encoding: "utf8" })).toMatch(/Page size:\s+59\d\.\d+ x 84\d\.\d+/);
        // pdftotext wraps RTL runs in embedding marks; strip them so amounts read as printed.
        return execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" }).replace(/[\u202a-\u202e]/g, "");
      };
      // The plan print shows the historical agreement as history, never as a new debt or consent.
      const planText = await pdf(`/print/plan/${plan.id}`, "legacy-treatment-plan-print");
      expect(planText).toMatch(/300,000/);
      expect(planText).toContain("ليست");
      expect(planText).toMatch(/16 ،15 ،14|14، 15، 16/);
      expect(planText).toContain("الموافقة الحالية غير متحققة");
      // The account statement carries the 180,000 opening as the only amount due; no receipt for the 120,000 paid before.
      const statementText = await pdf(`/print/statement/${patientId}`, "legacy-treatment-statement-print");
      expect(statementText).toMatch(/180,000/);
    } finally { await print.context().close(); }
  });
});

describe("legacy preview failure, staleness and form ownership", () => {
  it("blocks save on a failed preview, ignores a stale response, follows A→B→A, and starts clean after close/reopen", async () => {
    const { rows: [{ id: patientId }] } = await db.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id", [`LGST-${stamp}`, "مريض معاينة اصطناعي"]);
    const page = await open(patientId, 1280, "?tab=account");
    let mode: "fail" | "hold" | "pass" = "fail";
    let held: Route | null = null;
    const seen: { agreed: unknown; status: number }[] = [];
    await page.route("**/legacy-treatments/preview", async (route) => {
      const agreed = (JSON.parse(route.request().postData() ?? "{}") as { agreedAmount?: unknown }).agreedAmount;
      if (mode === "fail") { seen.push({ agreed, status: 503 }); return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "تعذّرت المعاينة (اختبار)." }) }); }
      if (mode === "hold" && agreed === "300000" && held === null) { held = route; return; }
      seen.push({ agreed, status: 200 });
      return route.continue();
    });
    try {
      await page.getByRole("button", { name: "علاج بدأ قبل النظام" }).click();
      const form = page.getByTestId("legacy-treatment-form");
      const save = form.getByRole("button", { name: "احفظ العلاج السابق" });
      const readState = form.getByTestId("legacy-preview-read-state");
      await form.getByLabel("الخدمة العلاجية").selectOption(String(bridge));
      await form.getByTestId("legacy-tooth-button").click();
      const dialog = page.getByTestId("tooth-dialog");
      for (const tooth of [24, 25]) await dialog.getByTestId(`odontogram-tooth-${tooth}`).click();
      await page.getByTestId("tooth-dialog-confirm").click();
      await form.getByLabel("المدفوع قبل النظام").fill("100000");
      await form.getByLabel("تاريخ المعلومات التاريخية").fill("2026-02-01");

      // A failed preview keeps save disabled and says so.
      await form.getByLabel("المبلغ المتفق عليه أصلًا").fill("250000");
      await expect.poll(() => readState.innerText(), { timeout: 30_000 }).toContain("تعذّرت المعاينة (اختبار).");
      expect(await readState.isVisible()).toBe(true);
      expect(await save.isEnabled()).toBe(false);

      // A (300000) is held; B (400000) answers first; releasing A must not overwrite B's evidence.
      mode = "hold";
      await form.getByLabel("المبلغ المتفق عليه أصلًا").fill("300000");
      await expect.poll(() => held !== null, { timeout: 30_000 }).toBe(true);
      await form.getByLabel("المبلغ المتفق عليه أصلًا").fill("400000");
      await expect.poll(() => form.getByTestId("legacy-opening-effect").count(), { timeout: 30_000 }).toBe(1);
      expect(await form.getByTestId("legacy-opening-effect").innerText()).toContain("300,000");
      await (held as Route | null)?.continue();
      await page.waitForTimeout(500);
      expect(await form.getByTestId("legacy-opening-effect").innerText()).toContain("300,000");
      expect(await save.isEnabled()).toBe(true);

      // A→B→A: back to 300000 shows A's own (fresh) evidence, not B's.
      mode = "pass";
      await form.getByLabel("المبلغ المتفق عليه أصلًا").fill("300000");
      await expect.poll(async () => await form.getByTestId("legacy-opening-effect").count() === 0 ? "" : form.getByTestId("legacy-opening-effect").innerText(),
        { timeout: 30_000 }).toContain("200,000");
      expect(seen.some((one) => one.agreed === "400000" && one.status === 200)).toBe(true);

      // Close and reopen: a fresh, empty form with save disabled; nothing was written by any preview.
      await form.getByRole("button", { name: "إلغاء" }).click();
      await page.getByRole("button", { name: "علاج بدأ قبل النظام" }).click();
      const reopened = page.getByTestId("legacy-treatment-form");
      expect(await reopened.getByLabel("المبلغ المتفق عليه أصلًا").inputValue()).toBe("");
      expect(await reopened.getByRole("button", { name: "احفظ العلاج السابق" }).isEnabled()).toBe(false);
      expect((await db.query(`SELECT 1 FROM legacy_treatment_agreements WHERE patient_id = $1
        UNION ALL SELECT 1 FROM treatment_plans WHERE patient_id = $1 UNION ALL SELECT 1 FROM patient_opening_balances WHERE patient_id = $1`, [patientId])).rows)
        .toHaveLength(0);
    } finally { await page.context().close(); }
  });
});
