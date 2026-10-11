import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { baseUrl, harness } from "./_server";
import { formatMoney } from "../../lib/money";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const CATALOG_EVIDENCE_MARKER = "AQLAN_VISIT_CATALOG_UI_PNG_V1";
const CATALOG_TEST_PATH = "__tests__/security-http/clinical-visit-workspace-ui.test.ts";
const catalogHash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
type CatalogScene = "grouped-closed" | "search-filtered" | "currency-SAR" | "currency-USD" | "currency-YER";

async function captureCatalog(page: Page, scene: CatalogScene) {
  const select = page.getByRole("combobox", { name: "أضف إجراءً", exact: true });
  const search = page.getByRole("searchbox", { name: "بحث في الخدمات", exact: true });
  // Scroll the actual controls into the viewport; never restyle or clone them.
  await select.evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const proof = await select.evaluate((node) => {
    if (!(node instanceof HTMLSelectElement)) throw new Error("Native catalogue select missing");
    const bounds = node.getBoundingClientRect();
    return {
      tag: node.tagName, selectedValue: node.value,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      unobscured: node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)),
      groups: Array.from(node.querySelectorAll("optgroup"), (group) => ({ label: group.label,
        options: Array.from(group.querySelectorAll("option"), (option) => ({ value: option.value, text: option.textContent, disabled: option.disabled })) })),
      viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
    };
  });
  const searchBounds = await search.boundingBox();
  const currency = await page.getByRole("radio", { checked: true }).innerText();
  expect(searchBounds).not.toBeNull();
  for (const bounds of [proof.bounds, searchBounds!]) {
    expect(bounds.width).toBeGreaterThan(0); expect(bounds.height).toBeGreaterThan(0);
    expect(bounds.x).toBeGreaterThanOrEqual(-1); expect(bounds.x + bounds.width).toBeLessThanOrEqual(proof.viewport.width + 1);
    expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(proof.viewport.height);
  }
  expect(proof.unobscured).toBe(true);
  expect(proof.documentWidth).toBeLessThanOrEqual(proof.viewport.width + 1);
  // The closed control is captured. Native OS popup pixels/scroll dimensions
  // are not claimed; the real option text/grouping is recorded as DOM evidence.
  return { scene, proof: { ...proof, searchBounds, query: await search.inputValue(), currency,
    nativePopupPixels: "not-captured", optionEvidence: "asserted-live-DOM" },
    png: await page.screenshot({ type: "png", fullPage: false }) };
}

type CatalogCapture = Awaited<ReturnType<typeof captureCatalog>>;
async function emitCatalogEvidence(width: number, kind: "catalogue" | "currency", captures: readonly CatalogCapture[]) {
  // Follow the existing _invoice-visual-evidence.ts bounded stdout protocol.
  // Fixed synthetic browser buffers only, after assertions and context teardown.
  const scenes: readonly CatalogScene[] = kind === "catalogue"
    ? ["grouped-closed", "search-filtered"] : ["currency-SAR", "currency-USD", "currency-YER"];
  if (![390, 1280].includes(width) || captures.length !== scenes.length) throw new Error("Incomplete catalogue evidence batch");
  let totalBytes = 0;
  const images = captures.map(({ scene, proof, png }, index) => {
    if (scene !== scenes[index] || !Buffer.isBuffer(png) || png.length < 45 || png.length > 256 * 1024
      || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.readUInt32BE(8) !== 13
      || png.toString("ascii", 12, 16) !== "IHDR" || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== 844
      || !png.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))
      || proof.viewport.width !== width || proof.viewport.height !== 844) throw new Error("Invalid required catalogue capture");
    const geometry = JSON.stringify(proof);
    if (Buffer.byteLength(geometry) > 6144) throw new Error("Catalogue DOM evidence exceeds bound");
    totalBytes += png.length;
    return { scene: `${scene}-${width}`, width, height: 844, bytes: png.length, sha256: catalogHash(png),
      proofSha256: catalogHash(geometry), chunks: Math.ceil(png.toString("base64").length / 4096) };
  });
  if (totalBytes > 768 * 1024) throw new Error("Catalogue PNG batch exceeds bound");
  const runId = /^\d{1,24}$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : "unavailable";
  const checkoutSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "unavailable";
  const identity = { suite: CATALOG_TEST_PATH, testSha256: catalogHash(readFileSync(CATALOG_TEST_PATH)),
    kind, width, runId, checkoutSha, synthetic: true, nativePopupPixels: "not-captured", totalBytes, images };
  const batch = catalogHash(JSON.stringify(identity));
  const records = [`${CATALOG_EVIDENCE_MARKER} BEGIN ${JSON.stringify({ batch, scenes: images.length })}`];
  for (const [position, { png, proof }] of captures.entries()) {
    const image = images[position], encoded = png.toString("base64");
    records.push(`${CATALOG_EVIDENCE_MARKER} DOM ${JSON.stringify({ batch, scene: image.scene, proof })}`);
    for (let index = 0; index < image.chunks; index++) {
      records.push(`${CATALOG_EVIDENCE_MARKER} CHUNK ${JSON.stringify({ batch, scene: image.scene,
        index: index + 1, count: image.chunks, data: encoded.slice(index * 4096, (index + 1) * 4096) })}`);
    }
  }
  records.push(`${CATALOG_EVIDENCE_MARKER} MANIFEST ${JSON.stringify({ batch, ...identity })}`);
  if (records.some((record) => Buffer.byteLength(record) > 8192)
    || records.reduce((total, record) => total + Buffer.byteLength(record) + 1, 0) > 1280 * 1024) {
    throw new Error("Catalogue stdout evidence exceeds transport bound");
  }
  // Validate the complete batch before the first frame; propagate write failure.
  for (const record of records) await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${record}\n`, (error) => error ? reject(error) : resolve());
  });
}

// Real built app + isolated HTTP harness. Synthetic intercepted browser API data;
// no browser clinical, inventory, payment, signature or other write reaches a server.
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); });
const patientId = 98301, visitId = 98302, doctorId = 98303;
const clinicalPath = `/api/visits/${visitId}/clinical`;
const services = [
  { id: 98304, name: "خدمة حشو اصطناعية", category: "filling", priceMinor: 100, priceConfigured: true,
    priceIn: { SAR: { minor: 2500, source: "catalog" }, USD: { minor: 700, source: "converted" } } },
  { id: 98305, name: "خدمة بفئة مخصصة اصطناعية", category: "قسم مخصص", priceMinor: 0, priceConfigured: false },
  { id: 98306, name: "خدمة عامة اصطناعية", category: null, priceMinor: 200, priceConfigured: true },
  { id: 98307, name: "خدمة معطلة اصطناعية", category: "consultation", isActive: false, priceMinor: 100, priceConfigured: true },
];
const outstanding = Array.from({ length: 14 }, (_, index) => ({
  planItemId: 98400 + index, serviceId: services[0].id, serviceName: `بند اصطناعي ${index + 1}`,
  planTitle: "خطة اصطناعية", caseId: 98501, caseSite: "الفك العلوي", toothCode: 16, surfaces: "MO",
  billingRule: "per_session", sessionCount: 2, doneSessions: 0, quantity: 1, unitPriceMinor: 2000,
  status: "in_progress", planCurrency: "SAR", clinicalConsentRecorded: false, financialReviewRequired: true,
  origin: "invoice", unmetRequirements: index === 0 ? ["انتظار تقييم البند المرجعي #98502"] : undefined,
}));
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status,
  contentType: "application/json", body: JSON.stringify(body) });
const field = (page: Page, label: string) => page.locator("#visit-notes").getByRole("textbox", { name: label, exact: true });

async function fixture(width: number, planned = true) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [], writes: Record<string, unknown>[] = [];
  let stored: Record<string, unknown> = {
    id: visitId, patientId, patientName: "مريض مساحة زيارة اصطناعي", chiefComplaint: "نص الشكوى الأصلي",
    examination: "", diagnosis: "", treatmentDone: "ملاحظة الطبيب الأصلية", nextPlan: "",
    doctorId, status: "open", signedAt: null, signedBy: null, invoiceId: null, addendum: null,
    procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: null, plannedVisit: null, previousVisit: null, latestDiagnosis: null, activeCases: [],
    outstanding: planned ? outstanding : [], billingCurrency: "YER", sessionPricing: [], labOrders: [],
  };
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== baseUrl) { unexpected.push(`${method} ${url.origin}${path}`); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const body = path === clinicalPath && method === "POST" ? request.postDataJSON() as Record<string, unknown> : null;
      if (body && !("action" in body)) {
        writes.push(body); stored = { ...stored, ...body };
        await json(route, { ok: true }); return;
      }
      unexpected.push(`${method} ${path}`); await json(route, { message: "Synthetic write blocked" }, 409); return;
    }
    if (path === clinicalPath) await json(route, stored);
    else if (path === `/api/visits/${visitId}/billing-preview`) await json(route, { message: "Synthetic preview unavailable" }, 503);
    else if (path === `/api/visits/${visitId}/materials`) await json(route, { lines: [], patientId });
    else if (path === "/api/services") await json(route, services);
    else if (path === "/api/parties") await json(route, [{ id: doctorId, name: "طبيب اصطناعي" }]);
    else if (path === "/api/booking-requests") await json(route, []);
    else if (path === "/api/lab") await json(route, { late: 0 });
    else if (path === "/api/messages") await json(route, { unread: 0, urgent: 0 });
    else if (path === "/api/auth/me") await json(route, { username: "secadmin", role: "admin" });
    else if (path.startsWith("/api/") || path.startsWith("/print/")) {
      unexpected.push(`${method} ${path}`); await json(route, { message: "Synthetic read blocked" }, 404);
    } else await route.continue();
  });
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/visits/${visitId}`);
    await field(page, "② الفحص").waitFor();
    return { page, context, writes, verify: () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); } };
  } catch (error) { await context.close(); throw error; }
}

describe("actual visit workspace choices and review", () => {
  it.each([390, 1280])("searches and scrolls phrases without losing narrative at %ipx", async (width) => {
    const f = await fixture(width);
    try {
      const { page } = f;
      expect(await field(page, "② الفحص").inputValue()).toBe("");
      expect(await field(page, "② التشخيص").inputValue()).toBe("");
      const group = page.locator('[aria-label="عبارات سريعة — ① الشكوى الرئيسية"]');
      const trigger = group.getByRole("button", { name: "اختر عبارة محفوظة", exact: true });
      await trigger.click();
      const search = group.getByRole("combobox"), options = group.getByRole("option");
      await expect.poll(() => options.count()).toBeGreaterThan(1);
      const phrase = (await options.first().textContent())!.trim();
      const list = group.getByRole("listbox");
      expect(await list.evaluate((node) => getComputedStyle(node).overflowY)).toBe("auto");
      await search.press("ArrowDown");
      expect(await search.getAttribute("aria-activedescendant")).toBeTruthy();
      expect(await field(page, "① الشكوى الرئيسية").inputValue()).toBe("نص الشكوى الأصلي");
      await search.press("Escape");
      expect(await trigger.evaluate((node) => document.activeElement === node)).toBe(true);
      expect(await field(page, "① الشكوى الرئيسية").inputValue()).toBe("نص الشكوى الأصلي");
      await trigger.click(); await search.fill(phrase); await search.press("Enter");
      // Searching, including Enter without an active option, never picks the first result.
      expect(await field(page, "① الشكوى الرئيسية").inputValue()).toBe("نص الشكوى الأصلي");
      await search.press("ArrowDown");
      const activeId = await search.getAttribute("aria-activedescendant");
      expect(await group.getByRole("option", { selected: true }).getAttribute("id")).toBe(activeId);
      await search.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
      expect(await field(page, "① الشكوى الرئيسية").inputValue()).toBe("نص الشكوى الأصلي");
      await search.press("Enter");
      expect(await field(page, "① الشكوى الرئيسية").inputValue()).toBe(`نص الشكوى الأصلي، ${phrase}`);
      await trigger.click(); await search.fill("ZZZ-no-saved-phrase");
      expect(await options.count()).toBe(0);
      expect(await search.getAttribute("aria-activedescendant")).toBeNull();
      expect(await group.getByText("لا توجد عبارة تطابق البحث.").count()).toBe(1);
      await group.getByRole("button", { name: "كتابة نص آخر", exact: true }).click();
      const narrative = field(page, "① الشكوى الرئيسية");
      expect(await narrative.evaluate((node) => document.activeElement === node)).toBe(true);
      await narrative.fill("نص حر أصلي");
      await trigger.click(); await search.press("Tab");
      await group.getByRole("button", { name: "إغلاق العبارات" }).click();
      expect(await narrative.inputValue()).toBe("نص حر أصلي");
      await narrative.fill("س".repeat(499)); await trigger.click(); await search.press("ArrowDown"); await search.press("Enter");
      expect(await narrative.inputValue()).toBe("س".repeat(499));
      expect(await group.getByText(/لا تتسع هذه العبارة/).count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await field(page, "② الفحص").inputValue()).toBe("");
      expect(await field(page, "② التشخيص").inputValue()).toBe("");
      expect(f.writes).toHaveLength(0); f.verify();
    } finally { await f.context.close(); }
  });

  it.each([390, 1280])("retains every active category in one searchable native grouped dropdown at %ipx", async (width) => {
    const f = await fixture(width);
    const captures: CatalogCapture[] = [];
    try {
      const { page } = f;
      const add = page.getByRole("combobox", { name: "أضف إجراءً", exact: true });
      const search = page.getByRole("searchbox", { name: "بحث في الخدمات", exact: true });
      expect(await add.count()).toBe(1);
      expect(await page.getByRole("button", { name: "أضف إجراءً", exact: true }).count()).toBe(0);
      expect(await page.getByRole("dialog", { name: "أضف إجراءً للزيارة", exact: true }).count()).toBe(0);
      expect(await add.evaluate((node) => node.tagName)).toBe("SELECT");
      for (const service of services.filter((row) => row.isActive !== false)) {
        expect(await add.locator(`option[value="${service.id}"]`).count()).toBe(1);
      }
      expect(await add.locator(`option[value="${services[3].id}"]`).count()).toBe(0);
      expect(await add.locator('option[value="manual"]').count()).toBe(0);
      expect(await add.locator('optgroup[label*="قسم مخصص"]').count()).toBe(1);
      expect(await add.locator('optgroup[label*="عام"]').count()).toBe(1);
      captures.push(await captureCatalog(page, "grouped-closed"));
      await search.fill("لا توجد خدمة بهذا الاسم");
      expect(await add.locator("optgroup option").count()).toBe(0);
      expect(await page.getByText("لا خدمة تطابق البحث.", { exact: true }).count()).toBe(1);
      expect(await page.getByTestId("visit-work-recorded").count()).toBe(0);
      await search.fill(services[1].name);
      const choice = add.locator(`option[value="${services[1].id}"]`);
      expect(await choice.textContent()).toContain("غير مُسعّر");
      expect(await add.locator("optgroup option").count()).toBe(1);
      captures.push(await captureCatalog(page, "search-filtered"));
      // Native keyboard selection invokes the same callback as pointer selection.
      await search.press("Tab");
      expect(await add.evaluate((node) => document.activeElement === node)).toBe(true);
      await add.press("ArrowDown");
      await expect.poll(() => page.getByTestId("visit-work-recorded").count()).toBe(1);
      expect(await page.getByRole("textbox", { name: "السعر", exact: true }).inputValue()).toBe("0");
      expect(await field(page, "③ ما نُفّذ").inputValue()).toBe("ملاحظة الطبيب الأصلية");
      await search.fill("");
      expect(await add.locator("optgroup option").count()).toBe(3);
      expect(await page.getByTestId("visit-work-recorded").count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(f.writes).toHaveLength(0); f.verify();
    } finally { await f.context.close(); }
    await emitCatalogEvidence(width, "catalogue", captures);
  });

  it.each([390, 1280])("keeps live YER/SAR/USD catalog prices and locked plan ownership at %ipx", async (width) => {
    const f = await fixture(width);
    const captures: CatalogCapture[] = [];
    try {
      const { page } = f;
      const add = page.getByRole("combobox", { name: "أضف إجراءً", exact: true });
      const search = page.getByRole("searchbox", { name: "بحث في الخدمات", exact: true });
      await page.getByTestId("planned-item-98400").getByRole("button", { name: "+ نفّذ اليوم", exact: true }).click();
      const planned = page.getByTestId("visit-work-recorded").filter({ hasText: "من الخطة — سعرها من قاعدة البند" });
      const plannedPrice = planned.getByRole("textbox", { name: "السعر", exact: true });
      // Staging a plan before any free row adopts the plan currency, SAR.
      // Re-selecting that currency is a no-op, not permission to erase a price.
      const sar = page.getByRole("radio", { name: "ريال سعودي", exact: true });
      expect(await sar.getAttribute("aria-checked")).toBe("true");
      await add.selectOption(String(services[0].id));
      const free = page.getByTestId("visit-work-recorded").filter({ hasText: "إجراء من الدليل" });
      const freePrice = free.getByRole("textbox", { name: "السعر", exact: true });
      await freePrice.fill("123");
      await search.fill("لا توجد خدمة بهذا الاسم");
      await search.fill("");
      expect(await freePrice.inputValue()).toBe("123");
      expect(await plannedPrice.inputValue()).toBe("10.00");
      expect(await page.getByTestId("visit-work-recorded").count()).toBe(2);
      expect(f.writes).toHaveLength(0);
      await sar.click();
      expect(await freePrice.inputValue()).toBe("123");
      expect(await plannedPrice.inputValue()).toBe("10.00");
      expect(await plannedPrice.isDisabled()).toBe(true);
      expect(await add.locator(`option[value="${services[0].id}"]`).textContent()).toContain(formatMoney(2500, "SAR"));
      expect(await page.locator("#visit-procedures").textContent()).toContain(formatMoney(13300, "SAR"));
      expect(f.writes).toHaveLength(0);
      // Exercise real currency changes below. The existing explicit change
      // handler reprices free drafts; it never reprices the linked plan row.
      await page.getByRole("radio", { name: "ريال يمني", exact: true }).click();
      expect(await freePrice.inputValue()).toBe("100");
      expect(await plannedPrice.inputValue()).toBe("10.00");
      expect(await add.locator(`option[value="${services[0].id}"]`).textContent()).toContain(formatMoney(100, "YER"));
      expect(await page.getByTestId("visit-work-recorded").count()).toBe(2);
      expect(f.writes).toHaveLength(0);
      for (const [currency, label, minor, amount] of [
        ["SAR", "ريال سعودي", 2500, "25.00"], ["USD", "دولار", 700, "7.00"], ["YER", "ريال يمني", 100, "100"],
      ] as const) {
        await page.getByRole("radio", { name: label, exact: true }).click();
        expect(await page.getByRole("radio", { name: label, exact: true }).getAttribute("aria-checked")).toBe("true");
        expect(await add.locator(`option[value="${services[0].id}"]`).textContent()).toContain(formatMoney(minor, currency));
        expect(await freePrice.inputValue()).toBe(amount);
        expect(await plannedPrice.inputValue()).toBe("10.00");
        expect(await plannedPrice.isDisabled()).toBe(true);
        expect(await planned.textContent()).toContain("الحالة #98501");
        expect(await planned.textContent()).toContain("انتظار تقييم البند المرجعي #98502");
        if (currency === "SAR") {
          expect(await page.getByTestId("currency-subtotals").count()).toBe(0);
          expect(await page.locator("#visit-procedures").textContent()).toContain(formatMoney(3500, "SAR"));
        } else {
          expect(await page.getByTestId("currency-subtotals").textContent()).toContain(formatMoney(1000, "SAR"));
          expect(await page.getByTestId("currency-subtotals").textContent()).toContain(formatMoney(minor, currency));
        }
        if (currency !== "YER") expect(await add.locator(`option[value="${services[2].id}"]`).textContent()).toContain("لا سعر بهذه العملة");
        expect(await page.getByTestId("visit-work-recorded").count()).toBe(2);
        expect(await field(page, "③ ما نُفّذ").inputValue()).toBe("ملاحظة الطبيب الأصلية");
        expect(f.writes).toHaveLength(0);
        captures.push(await captureCatalog(page, `currency-${currency}`));
      }
      await page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).click();
      await expect.poll(() => f.writes.length).toBe(1);
      expect(f.writes[0].billingCurrency).toBe("YER");
      expect(f.writes[0].procedures).toEqual([
        expect.objectContaining({ planItemId: 98400, toothCode: 16, unitPriceMinor: 1000 }),
        expect.objectContaining({ planItemId: null, serviceId: services[0].id, unitPriceMinor: 100 }),
      ]);
      f.verify();
    } finally { await f.context.close(); }
    await emitCatalogEvidence(width, "currency", captures);
  });

  it("keeps a staged plan item, its tooth, currency and unmet requirements together without marking clearance", async () => {
    const f = await fixture(1280);
    try {
      const { page } = f;
      await page.getByTestId("planned-item-98400").getByRole("button", { name: "+ نفّذ اليوم", exact: true }).click();
      expect(await page.getByTestId("planned-item-98400").count()).toBe(0);
      const staged = page.getByTestId("visit-work-recorded");
      expect(await staged.count()).toBe(1);
      expect(await staged.textContent()).toContain("الحالة #98501");
      expect(await staged.textContent()).toContain("انتظار تقييم البند المرجعي #98502");
      expect(await staged.textContent()).toContain("قيد التنفيذ");
      expect(await staged.textContent()).not.toContain("جميع الشروط متحققة");
      expect(await staged.getByRole("textbox", { name: "السعر", exact: true }).isDisabled()).toBe(true);
      // Per-session plan total: 2000 minor × quantity 1 ÷ 2 sessions = 1000
      // minor for this first session, displayed as SAR 10.00 (not SAR 20.00).
      expect(await staged.getByRole("textbox", { name: "السعر", exact: true }).inputValue()).toBe("10.00");
      expect(await staged.getByRole("spinbutton", { name: "الكمية", exact: true }).inputValue()).toBe("1");
      expect(await staged.getByRole("textbox", { name: "الأسطح", exact: true }).inputValue()).toBe("MO");
      expect(await staged.getByRole("button", { name: "رقم السن", exact: true }).textContent()).toContain("16");
      expect(await page.getByRole("radio", { name: "ريال سعودي", exact: true }).getAttribute("aria-checked")).toBe("true");
      expect(f.writes).toHaveLength(0);
      // Only an explicit save may send the staged session. This is a captured
      // draft payload, not financial/clinical clearance or a sign result.
      await page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).click();
      await expect.poll(() => f.writes.length).toBe(1);
      expect(f.writes[0]).toEqual({
        chiefComplaint: "نص الشكوى الأصلي", examination: "", diagnosis: "",
        treatmentDone: "ملاحظة الطبيب الأصلية", nextPlan: "", doctorId, billingCurrency: "SAR",
        procedures: [{ serviceId: services[0].id, toothCode: 16, surfaces: "MO", quantity: 1,
          unitPriceMinor: 1000, priceReason: null, doctorId, planItemId: 98400 }],
      });
      await expect.poll(() => staged.getByRole("button", { name: "احذف", exact: true }).isEnabled()).toBe(true);
      expect(await staged.textContent()).toContain("انتظار تقييم البند المرجعي #98502");
      expect(await staged.textContent()).toContain("قيد التنفيذ");
      await staged.getByRole("button", { name: "احذف", exact: true }).click();
      expect(await page.getByTestId("planned-item-98400").count()).toBe(1);
      expect(await field(page, "③ ما نُفّذ").inputValue()).toBe("ملاحظة الطبيب الأصلية");
      expect(f.writes).toHaveLength(1); f.verify();
    } finally { await f.context.close(); }
  });

  it.each([390, 1280])("keeps no-procedure review truthful and scrollable with focus retained at %ipx", async (width) => {
    const f = await fixture(width);
    try {
      const { page } = f;
      await page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).click();
      const review = page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true });
      await review.waitFor(); expect(f.writes).toHaveLength(1);
      expect(await review.textContent()).toContain("لا إجراءات مسجلة");
      expect(await review.textContent()).toContain("الاستحقاق المالي غير متحقق");
      expect(await review.getByTestId("no-additional-due").count()).toBe(0);
      expect(await review.getByText("بند اصطناعي 14", { exact: false }).count()).toBe(1);
      const scroll = review.getByTestId("visit-review-scroll");
      expect(await scroll.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
      await scroll.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      const back = review.getByRole("button", { name: "رجوع — أكمل العمل", exact: true });
      const box = (await back.boundingBox())!; expect(box.y + box.height).toBeLessThanOrEqual(844);
      await review.locator("section").focus(); await page.keyboard.press("Tab");
      expect(await review.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      const first = review.locator("summary").first();
      const last = review.getByRole("button").last();
      await last.focus(); await page.keyboard.press("Tab");
      expect(await first.evaluate((node) => document.activeElement === node)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await last.evaluate((node) => document.activeElement === node)).toBe(true);
      await page.keyboard.press("Escape"); await expect.poll(() => review.count()).toBe(0);
      expect(await field(page, "③ ما نُفّذ").inputValue()).toBe("ملاحظة الطبيب الأصلية");
      expect(f.writes).toHaveLength(1); f.verify();
    } finally { await f.context.close(); }
  });
});
