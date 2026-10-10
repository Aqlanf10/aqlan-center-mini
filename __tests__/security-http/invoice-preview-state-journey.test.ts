import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/** Real form and shared chart; transport failures/delays are controlled at the browser boundary.
 * Only isolated harness fixtures are written. Invoice-save transport is intercepted when inspected; no save request reaches the server. */
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorPartyId = 0;
let filling = 0;
let consultation = 0;
const stamp = Date.now();
let serial = 0;
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ({ rows: [{ party_id: doctorPartyId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  for (const category of ["filling", "consultation"]) {
    const { rows: [{ id }] } = await db.query<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 1500000, TRUE, TRUE, $2) RETURNING id`,
      [`معاينة آمنة ${category} ${stamp}`, category]);
    if (category === "filling") filling = id; else consultation = id;
  }
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

const networkByPage = new WeakMap<Page, { url: string; method: string; status: number; fromServiceWorker: boolean }[]>();
/** Bounded transport evidence for a failure message: responses seen, SW control, and the row's current inputs. */
async function transport(page: Page, line = 0) {
  const row = page.getByTestId(`invoice-row-${line}`);
  return {
    responses: (networkByPage.get(page) ?? []).slice(-8),
    controlled: await page.evaluate(() => Boolean(navigator.serviceWorker?.controller)).catch(() => null),
    service: await row.getByLabel("الخدمة", { exact: true }).inputValue().catch(() => null),
    price: await row.getByLabel("السعر", { exact: true }).inputValue().catch(() => null),
    site: await page.getByTestId(`invoice-tooth-button-${line}`).innerText().catch(() => null),
  };
}

async function openInvoice() {
  const { rows: [{ id }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`IPS-${stamp}-${++serial}`, "مريض اختبار ملكية المعاينة", doctorPartyId]);
  // Route-mocked failure injection needs controlled transport: a service worker can serve requests outside page.route
  // (Playwright network docs), so this context blocks it, as the other route-mocked browser fixtures do.
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const network: { url: string; method: string; status: number; fromServiceWorker: boolean }[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/api/invoices")) return;
    network.push({ url: new URL(response.url()).pathname, method: response.request().method(), status: response.status(),
      fromServiceWorker: response.fromServiceWorker() });
  });
  networkByPage.set(page, network);
  await page.goto(`${baseUrl}/patients/${id}?tab=account`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "فاتورة يدوية" }).click();
  return { context, page, patientId: id };
}
async function selectFilling(page: Page, line = 0, tooth = 26) {
  await page.getByTestId(`invoice-row-${line}`).getByLabel("الخدمة", { exact: true }).selectOption(String(filling));
  await page.getByTestId(`invoice-tooth-button-${line}`).click();
  await page.getByTestId("tooth-dialog").getByTestId(`odontogram-tooth-${tooth}`).click();
  await page.getByTestId("tooth-dialog-confirm").click();
  await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
}
function success(route: Route, refusal: string | null = null) {
  const body = route.request().postDataJSON() as { existingPlanId?: number | null; items: { serviceId: number | null }[] };
  return { existingPlanId: body.existingPlanId ?? null, planChoices: [], lines: body.items.map((item, line) => ({ line, kind: item.serviceId === filling ? "clinical" : "financial",
    specialtyLabel: item.serviceId === filling ? "ترميم" : null,
    item: item.serviceId === filling ? { mode: "new", id: null } : null,
    case: item.serviceId === filling ? { mode: "none", id: null, title: null, options: [] } : null,
    refusal, refusalMessage: refusal ? "هذا العلاج مفوتر سابقًا." : null,
    itemCandidates: [],
  })) };
}
const json = (route: Route, payload: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
const ready = (page: Page, line = 0) => page.locator(`[data-testid="invoice-clinical-preview-${line}"][data-preview-state="ready"]`).waitFor();
const save = (page: Page) => page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
/** Waits for one element's state and, on timeout, reports every observed state plus caller evidence (CI diagnosis). */
async function waitForState(target: Locator, attribute: string, expected: string, evidence: () => Record<string, unknown>) {
  const seen: string[] = [];
  try {
    await expect.poll(async () => {
      const value = await target.getAttribute(attribute, { timeout: 1_000 }).catch(() => "absent") ?? "null";
      if (seen.at(-1) !== value) seen.push(value);
      return value;
    }, { timeout: 30_000, interval: 200 }).toBe(expected);
  } catch {
    throw new Error(`${attribute} never became ${expected}: observed ${JSON.stringify(seen)}; evidence ${JSON.stringify(evidence())}`);
  }
  // The original oracle was locator.waitFor(): the state must also be visible to the user, not merely attached.
  await target.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {
    throw new Error(`${attribute}=${expected} is attached but not visible; evidence ${JSON.stringify(evidence())}`);
  });
}

describe("invoice form preview safety and shared chart interruption journeys", () => {
  it("requires a fresh preview generation when A returns after B, without reviving the earlier ready A", async () => {
    const { page, context, patientId } = await openInvoice();
    const held: Route[] = [];
    let hold = false;
    let submissions = 0;
    await page.route("**/api/invoices", async (route) => { submissions++; await route.abort(); });
    await page.route("**/api/invoices/clinical-preview", async (route) => {
      if (hold) { held.push(route); return; }
      await json(route, success(route));
    });
    try {
      await selectFilling(page);
      await ready(page);
      expect(await save(page).isEnabled()).toBe(true);
      const price = page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true });
      const originalPrice = await price.inputValue();
      hold = true;
      const changedPrice = originalPrice === "1600000" ? "1700000" : "1600000";
      await price.fill(changedPrice);
      expect(await save(page).isEnabled()).toBe(false);
      await expect.poll(() => held.length).toBe(1);
      await price.fill(originalPrice);
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByTestId("invoice-clinical-preview-0").getAttribute("data-preview-state")).not.toBe("ready");
      await expect.poll(() => held.length).toBe(2);
      expect(held[0].request().postDataJSON().items[0].price).toBe(changedPrice);
      expect(held[1].request().postDataJSON().items[0].price).toBe(originalPrice);
      // The retired B transport may have been aborted; it must never make the current A ready.
      await json(held[0], success(held[0])).catch(() => undefined);
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByTestId("invoice-clinical-preview-0").getAttribute("data-preview-state")).not.toBe("ready");
      await json(held[1], success(held[1]));
      await ready(page);
      expect(await save(page).isEnabled()).toBe(true);
      expect(await price.inputValue()).toBe(originalPrice);
      expect(submissions).toBe(0);
      expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1", [patientId])).rows).toHaveLength(0);
    } finally {
      await Promise.all(held.map((route) => route.abort().catch(() => undefined)));
      await context.close();
    }
  });

  it("invalidates prior success immediately, blocks a pending/failed save, and recovers only after an explicit successful retry", async () => {
    const { page, context, patientId } = await openInvoice();
    let held: Route | null = null;
    let hold = false;
    let submissions = 0;
    await page.route("**/api/invoices", async (route) => { submissions++; await route.abort(); });
    await page.route("**/api/invoices/clinical-preview", async (route) => {
      if (hold) { held = route; return; }
      await json(route, success(route));
    });
    try {
      await selectFilling(page);
      await ready(page);
      expect(await save(page).isEnabled()).toBe(true);
      hold = true;
      await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).fill("1600000");
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByTestId("invoice-clinical-preview-0").innerText()).not.toContain("بند خطة جديد");
      try {
        await expect.poll(() => held !== null, { timeout: 30_000 }).toBe(true);
      } catch {
        throw new Error(`the held preview handler was never reached: ${JSON.stringify(await transport(page))}`);
      }
      await json(held!, { message: "unavailable" }, 503);
      await page.locator('[data-preview-state="unavailable"]').waitFor();
      expect(await save(page).isEnabled()).toBe(false);
      hold = false;
      await page.getByRole("button", { name: "إعادة المعاينة" }).click();
      await ready(page);
      expect(await save(page).isEnabled()).toBe(true);
      expect(submissions).toBe(0);
      expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    } finally { await context.close(); }
  });

  it("shows refusal without an affirmative creation promise, rejects malformed evidence, and contains a failed request", async () => {
    const { page, context } = await openInvoice();
    let mode: "refused" | "malformed" | "network" = "refused";
    await page.route("**/api/invoices/clinical-preview", async (route) => {
      if (mode === "network") { await route.abort("failed"); return; }
      await json(route, mode === "refused" ? success(route, "already_billed") : { lines: [] });
    });
    try {
      await selectFilling(page);
      await page.locator('[data-preview-state="refused"]').waitFor();
      expect(await page.getByTestId("invoice-clinical-preview-0").innerText()).toContain("هذا العلاج مفوتر سابقًا");
      expect(await page.getByTestId("invoice-clinical-preview-0").innerText()).not.toContain("ستنشئ/تربط");
      expect(await save(page).isEnabled()).toBe(false);
      mode = "malformed";
      await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).fill("1700000");
      await page.locator('[data-preview-state="unavailable"]').waitFor();
      expect(await save(page).isEnabled()).toBe(false);
      mode = "network";
      await page.getByRole("button", { name: "إعادة المعاينة" }).click();
      await page.locator('[data-preview-state="unavailable"]').waitFor();
      expect(await save(page).isEnabled()).toBe(false);
    } finally { await context.close(); }
  });

  it("preserves an actionable server price/discount refusal rather than hiding it behind retry", async () => {
    const { page, context } = await openInvoice();
    let reject = true;
    const previews: number[] = [];
    await page.route("**/api/invoices/clinical-preview", (route) => {
      previews.push(reject ? 400 : 200);
      return reject ? json(route, { message: "اكتب سبب الخصم قبل الحفظ." }, 400) : json(route, success(route));
    });
    try {
      await selectFilling(page);
      await waitForState(page.getByTestId("invoice-clinical-preview-0"), "data-preview-state", "refused", () => ({
        previews, url: page.url() }));
      // The intended 400 handler was actually exercised (not a real-server or service-worker response).
      expect(previews.filter((status) => status === 400).length, JSON.stringify(await transport(page))).toBeGreaterThan(0);
      expect((networkByPage.get(page) ?? []).some((one) => one.url.endsWith("/clinical-preview") && one.status === 400 && !one.fromServiceWorker)).toBe(true);
      expect(await page.getByTestId("invoice-clinical-preview-0").innerText()).toContain("اكتب سبب الخصم قبل الحفظ.");
      // The actionable refusal itself is visible to the user (a hidden attached refusal must not pass).
      expect(await page.getByTestId("invoice-clinical-preview-0").getByText("اكتب سبب الخصم قبل الحفظ.").isVisible()).toBe(true);
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByRole("button", { name: "إعادة المعاينة" }).count()).toBe(0);
      reject = false;
      await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).fill("1600000");
      await ready(page);
    } finally { await context.close(); }
  });

  it("does not move a removed row's preview onto its successor at the same index", async () => {
    const { page, context } = await openInvoice();
    let held: Route | null = null;
    let hold = false;
    await page.route("**/api/invoices/clinical-preview", async (route) => {
      if (hold) { held = route; return; }
      await json(route, success(route));
    });
    try {
      await selectFilling(page);
      await ready(page);
      await page.getByRole("button", { name: "+ بند آخر", exact: true }).click();
      await selectFilling(page, 1, 36);
      await ready(page, 1);
      const successor = await page.getByTestId("invoice-row-1").getAttribute("data-row-key");
      hold = true;
      await page.getByTestId("invoice-row-0").getByTitle("حذف البند", { exact: true }).click();
      expect(await page.getByTestId("invoice-row-0").getAttribute("data-row-key")).toBe(successor);
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByTestId("invoice-clinical-preview-0").getAttribute("data-preview-state")).toBe("pending");
      await expect.poll(() => held !== null).toBe(true);
      await json(held!, success(held!));
      await ready(page);
      expect(await save(page).isEnabled()).toBe(true);
    } finally { await context.close(); }
  });

  it("ignores an older delayed response after changing to a financial-only service", async () => {
    const { page, context } = await openInvoice();
    let held: Route | null = null;
    await page.route("**/api/invoices/clinical-preview", async (route) => { held = route; });
    try {
      await selectFilling(page);
      await expect.poll(() => held !== null).toBe(true);
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(consultation));
      expect(await page.getByTestId("invoice-clinical-preview-0").count()).toBe(0);
      expect(await save(page).isEnabled()).toBe(true);
      await json(held!, success(held!)).catch(() => undefined); // The old request may already be aborted.
      expect(await page.getByTestId("invoice-clinical-preview-0").count()).toBe(0);
      expect(await page.getByTestId("invoice-tooth-chip-0").count()).toBe(0);
    } finally { await context.close(); }
  });

  it.each([
    { price: "abc", quantity: "1", currency: "YER" },
    { price: "", quantity: "1", currency: "SAR" },
    { price: "", quantity: "1", currency: "USD" },
    { price: "1500000", quantity: "1000", currency: "YER" },
  ])("invalid current values never retain a ready preview or enable save: %j", async (input) => {
    const { page, context } = await openInvoice();
    await page.route("**/api/invoices/clinical-preview", (route) => json(route, success(route)));
    try {
      await selectFilling(page);
      await ready(page);
      await page.getByLabel("عملة الفاتورة", { exact: true }).selectOption(input.currency);
      await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).fill(input.price);
      await page.getByTestId("invoice-row-0").getByLabel("الكمية", { exact: true }).fill(input.quantity);
      await page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="invalid"]').waitFor();
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByTestId("invoice-input-problem-0").innerText()).not.toBe("");
      expect(await page.getByTestId("invoice-clinical-preview-0").innerText()).not.toContain("ستنشئ/تربط");
    } finally { await context.close(); }
  });

  it("uses an explicit provider choice for both preview and save, then clears it on a different service", async () => {
    const { page, context, patientId } = await openInvoice();
    const requests: {
      saved: { items: { doctorId?: number }[] } | null;
      previewed: { items: { doctorId?: number | null }[] } | null;
    } = { saved: null, previewed: null };
    await page.route("**/api/invoices/clinical-preview", async (route) => {
      requests.previewed = route.request().postDataJSON();
      await json(route, success(route));
    });
    await page.route("**/api/invoices", async (route) => {
      requests.saved = route.request().postDataJSON();
      await json(route, { message: "Synthetic stopped save: no write was sent." }, 503);
    });
    try {
      await selectFilling(page);
      await ready(page);
      const provider = page.getByTestId("invoice-provider-0");
      expect(await provider.inputValue()).toBe("");
      expect(await page.getByTestId("invoice-provider-review-0").innerText()).toContain("المراجعة المالية مطلوبة");
      await provider.selectOption(String(doctorPartyId));
      expect(await save(page).isEnabled()).toBe(false);
      await ready(page);
      expect(requests.previewed?.items[0].doctorId).toBe(doctorPartyId);
      expect(await page.getByTestId("invoice-provider-review-0").count()).toBe(0);
      await save(page).click();
      await expect.poll(() => requests.saved !== null).toBe(true);
      expect(requests.saved?.items[0].doctorId).toBe(doctorPartyId);
      await page.getByText("Synthetic stopped save: no write was sent.", { exact: true }).waitFor();
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(consultation));
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(filling));
      expect(await page.getByTestId("invoice-provider-0").inputValue()).toBe("");
      expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    } finally { await context.close(); }
  });

  it.each(["failure", "malformed"])("%s chart reads show unknown selectable anatomy; surfaces reset on tooth change and focus remains in the dialog", async (failure) => {
    const { page, context } = await openInvoice();
    const charts: string[] = [];
    await page.route("**/api/patients/*/chart", async (route) => {
      charts.push(route.request().url());
      await json(route, failure === "failure" ? { message: "unavailable" } : { records: [{ toothCode: 26 }] }, failure === "failure" ? 503 : 200);
    });
    await page.route("**/api/invoices/clinical-preview", (route) => json(route, success(route)));
    try {
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(filling));
      const opener = page.getByTestId("invoice-tooth-button-0");
      await opener.click();
      const dialog = page.getByTestId("tooth-dialog");
      await waitForState(dialog, "data-chart-state", "unavailable", () => ({ charts, url: page.url() }));
      // The unavailable state is shown to the user before any tooth is picked.
      expect(await dialog.getByText("تعذّر تحميل حالة الأسنان", { exact: false }).isVisible()).toBe(true);
      const tooth = dialog.getByTestId("odontogram-tooth-26");
      expect(await tooth.getAttribute("data-chart-known")).toBe("false");
      expect(await tooth.getAttribute("aria-label")).toContain("الحالة غير متاحة");
      expect(await tooth.locator("path").first().getAttribute("stroke-dasharray")).toBe("2 2");
      expect(await tooth.isEnabled()).toBe(true);
      await tooth.click();
      await dialog.getByTestId("surface-M").click();
      await dialog.getByTestId("surface-O").click();
      await dialog.getByTestId("odontogram-tooth-27").click();
      expect(await dialog.getByTestId("surface-M").getAttribute("aria-pressed")).toBe("false");
      expect(await dialog.getByTestId("surface-O").getAttribute("aria-pressed")).toBe("false");
      await dialog.getByRole("button", { name: "إغلاق", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      expect(await page.getByTestId("tooth-dialog-confirm").evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await dialog.getByRole("button", { name: "إغلاق", exact: true }).evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe("");
    } finally { await context.close(); }
  });
});

