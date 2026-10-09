import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import type { LabOrder } from "../../lib/lab";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import { emitLabAccountingEvidence, type LabAccountingEvidenceMember } from "./_lab-accounting-evidence";

// Real Next standalone /lab, authenticated browser, real PATCH route and writer.
// The only read-scope adjustment adds this dedicated synthetic patient's ID to
// GET /api/lab. It does not fabricate any order, DTO, amount or PATCH response.
// Delayed/failed settings reads are explicitly confined to the final race case.
// No schema setup, resets, deletes, production access, workflow or app stubs.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
const RATE_KEYS = ["finance.rate.USD", "finance.rate.SAR"] as const;
type RateValues = Record<typeof RATE_KEYS[number], string>;
type SettingsSnapshot = RateValues & { __versions: Record<string, string | null> };
type Fixture = { patientId: number; orderId: number; payableId: number; categoryId: number };
const run = `synthetic-lab-accounting-${Date.now().toString(36)}`;

beforeAll(async () => {
  h = await harness();
  // Verify both targets before any fixture connection or mutation. The existing
  // global harness alone owns creation/teardown of this disposable database.
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(baseUrl).protocol).toBe("http:");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  expect((await db.query<{ current_database: string }>("SELECT current_database()")).rows[0].current_database)
    .toBe("aqlan_sec_http");
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

async function settings(): Promise<SettingsSnapshot> {
  const response = await authedGet("/api/settings", h.sessions.admin);
  expect(response.status).toBe(200);
  return await response.json() as SettingsSnapshot;
}
async function setRates(values: Partial<RateValues>): Promise<void> {
  const current = await settings();
  const keys = Object.keys(values) as (keyof RateValues)[];
  expect(keys.every(key => RATE_KEYS.includes(key))).toBe(true);
  const response = await authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({
    ...values, __versions: Object.fromEntries(keys.map(key => [key, current.__versions[key]])),
    __reason: "Synthetic isolated lab accounting browser regression",
  }));
  expect(response.status).toBe(200);
  const result = await response.json() as SettingsSnapshot;
  for (const key of keys) expect(result[key]).toBe(values[key]);
  // The supported audited settings writer also invalidates the built server's
  // settings cache. Direct SQL rate writes cannot establish a genuine stale409.
}

async function fixture(): Promise<Fixture> {
  const { rows: [patient] } = await db.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name) VALUES($1,'SYNTHETIC LAB ACCOUNTING') RETURNING id", [run]);
  const { rows: [party] } = await db.query<{ id: number }>(
    "INSERT INTO parties(name,kind,currency) VALUES($1,'lab','USD') RETURNING id", [run]);
  const { rows: [category] } = await db.query<{ id: number }>(`INSERT INTO expense_categories
    (key,name,category_group,account_code) VALUES($1,'بند مختبر تجريبي','معامل','5102') RETURNING id`, [run]);
  const response = await authedMutation("/api/lab", h.sessions.admin, "POST", JSON.stringify({
    patientId: patient.id, partyId: party.id, labName: run, workType: "Synthetic crown",
    sentDate: "2026-10-05", dueDate: "2026-10-12", toothNumbers: "16",
    cost: "25", costCurrency: "USD", isPosted: false,
    expenseAccountCode: "5101", payableAccountCode: "2101",
  }));
  expect(response.status).toBe(201);
  const order = await response.json() as LabOrder;
  expect(order).toMatchObject({ patientId: patient.id, costMinor: 2500, costCurrency: "USD",
    exchangeRate: 531.125, isPosted: false });
  expect(order.payableId).toBeGreaterThan(0);
  // Reproduce independent historical snapshots in just this newly-created pair,
  // matching the unchanged PostgreSQL snapshot control's legacy divergence case.
  expect((await db.query("UPDATE lab_orders SET base_amount_minor=13001 WHERE id=$1 AND patient_id=$2",
    [order.id, patient.id])).rowCount).toBe(1);
  expect((await db.query(`UPDATE payables SET base_amount_minor=14002,exchange_rate=560.08
    WHERE id=$1 AND lab_order_id=$2`, [order.payableId, order.id])).rowCount).toBe(1);
  return { patientId: patient.id, orderId: order.id, payableId: order.payableId!, categoryId: category.id };
}

async function money(f: Fixture) {
  return {
    order: (await db.query(`SELECT id,cost_minor,cost_currency,exchange_rate,base_amount_minor,payable_id
      FROM lab_orders WHERE id=$1 AND patient_id=$2`, [f.orderId, f.patientId])).rows[0],
    payables: (await db.query(`SELECT id,lab_order_id,amount_minor,currency,exchange_rate,base_amount_minor,base_currency
      FROM payables WHERE lab_order_id=$1 ORDER BY id`, [f.orderId])).rows,
  };
}
async function fullSnapshot(f: Fixture) {
  return {
    orders: (await db.query("SELECT * FROM lab_orders WHERE id=$1 AND patient_id=$2", [f.orderId, f.patientId])).rows,
    payables: (await db.query("SELECT * FROM payables WHERE lab_order_id=$1 ORDER BY id", [f.orderId])).rows,
    tracking: (await db.query("SELECT * FROM lab_order_tracking WHERE lab_order_id=$1 ORDER BY id", [f.orderId])).rows,
    audit: (await db.query("SELECT * FROM audit_log WHERE entity='lab_order' AND entity_id=$1 ORDER BY id", [String(f.orderId)])).rows,
  };
}
async function assertMapping(f: Fixture, posted: boolean) {
  const expected = { expense_category_id: f.categoryId, expense_account_code: "5102", payable_account_code: "2102", is_posted: posted };
  expect((await db.query("SELECT * FROM lab_orders WHERE id=$1", [f.orderId])).rows[0]).toMatchObject(expected);
  const rows = (await db.query("SELECT * FROM payables WHERE lab_order_id=$1", [f.orderId])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ...expected, id: f.payableId });
}
async function assertEditedPair(f: Fixture) {
  expect(await money(f)).toEqual({
    order: { id: f.orderId, cost_minor: "7500", cost_currency: "USD", exchange_rate: "550.123456",
      base_amount_minor: "41259", payable_id: f.payableId },
    payables: [{ id: f.payableId, lab_order_id: f.orderId, amount_minor: "7500", currency: "USD",
      exchange_rate: "550.123456", base_amount_minor: "41259", base_currency: "YER" }],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function browserFixture(f: Fixture) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const unexpected: string[] = [], pageErrors: string[] = [];
  const writes: Record<string, unknown>[] = [];
  const pendingReads: ReturnType<typeof deferred<"continue" | "fail">>[] = [];
  let holdSettings = false;
  let writeGate: ReturnType<typeof deferred<void>> | null = null;
  page.on("pageerror", error => pageErrors.push(error.message));
  const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl) {
      unexpected.push(`${method} ${url.origin}${url.pathname}`); await route.abort(); return;
    }
    if (method === "PATCH" && url.pathname === `/api/lab/${f.orderId}`) {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (!["update_accounting", "post", "unpost"].includes(String(body.action))) {
        unexpected.push(`Unapproved lab action: ${String(body.action)}`); await route.abort(); return;
      }
      writes.push(body);
      if (writeGate) await writeGate.promise;
      await route.continue(); // Real built route and PostgreSQL writer, never fulfilled.
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      unexpected.push(`${method} ${url.pathname}`); await route.abort(); return;
    }
    if (method === "GET" && url.pathname === "/api/lab" && !url.search) {
      url.searchParams.set("patientId", String(f.patientId));
      await route.continue({ url: url.toString() }); // Actual authenticated read, scoped fixture only.
      return;
    }
    if (method === "GET" && url.pathname === "/api/settings" && holdSettings) {
      const pending = deferred<"continue" | "fail">();
      pendingReads.push(pending);
      const action = await pending.promise;
      if (action === "fail") await route.fulfill({ status: 503, contentType: "application/json",
        body: JSON.stringify({ message: "Synthetic settings read unavailable" }) });
      else await route.continue();
      return;
    }
    await route.continue();
  });
  const modal = page.locator("#lab-accounting-modal-container");
  const preview = page.locator("#lab-accounting-money-preview");
  const cost = page.locator("#lab-accounting-cost-input");
  const currency = page.locator("#lab-accounting-currency-select");
  const save = page.locator("#lab-accounting-save-mapping-btn");
  const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const open = async () => {
    await page.locator(`#lab-accounting-btn-${f.orderId}`).click();
    await modal.waitFor({ state: "visible" });
    await expect.poll(() => preview.getAttribute("data-preview-state")).toBe("saved");
    await expect.poll(() => save.isEnabled()).toBe(true);
  };
  const submit = async (selector: string, status = 200) => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/lab/${f.orderId}`
      && response.request().method() === "PATCH");
    await page.locator(selector).click();
    const result = await response;
    expect(result.status()).toBe(status);
    const data = await result.json() as LabOrder & { code?: string };
    if (status === 200) await modal.waitFor({ state: "detached" });
    return data;
  };
  return { page, modal, preview, cost, currency, save, writes, pendingReads, open, submit, settle,
    holdSettings: () => { holdSettings = true; },
    resumeSettings: () => { holdSettings = false; },
    holdWrite: () => { writeGate = deferred<void>(); },
    releaseWrite: () => { writeGate?.resolve(); writeGate = null; },
    async run(body: () => Promise<void>) {
      await guard.run(async () => {
        try {
          await page.goto(`${baseUrl}/lab`, { waitUntil: "networkidle" });
          await page.getByRole("button", { name: "الكل", exact: true }).click();
          await open();
          // Wait for the actual categories load before selecting our own category.
          await page.locator(`#lab-accounting-category-select option[value="${f.categoryId}"]`).waitFor({ state: "attached" });
          await body();
        } finally {
          holdSettings = false;
          for (const pending of pendingReads) pending.resolve("fail");
          writeGate?.resolve();
        }
      }, () => { expect(unexpected).toEqual([]); expect(pageErrors).toEqual([]); });
    },
  };
}

async function assertPreview(page: Page, state: string, currency: string, visibleAmount?: string, rate?: string) {
  const preview = page.locator("#lab-accounting-money-preview");
  await expect.poll(() => preview.getAttribute("data-preview-state")).toBe(state);
  expect(await preview.getAttribute("data-preview-currency")).toBe(currency);
  const text = await preview.textContent();
  if (visibleAmount) expect(text).toContain(visibleAmount);
  if (rate) expect(text).toContain(`بسعر صرف ${rate}`);
  if (state === "loading" || state === "unavailable") {
    expect(text).not.toMatch(/(?:13,001|14,002|40,509|41,259|41,809|10,735)/);
    expect(text).not.toContain("بسعر صرف");
    expect(await page.locator("#lab-accounting-save-mapping-btn").isDisabled()).toBe(true);
    expect(await page.locator("#lab-accounting-final-post-btn").isDisabled()).toBe(true);
  }
}

async function assertCaptureTargetVisible(locator: Locator) {
  const geometry = await locator.evaluate(target => {
    const bounds = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    const rect = bounds(target.getBoundingClientRect());
    const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const intersection = { left: Math.max(rect.left, viewport.left), top: Math.max(rect.top, viewport.top),
      right: Math.min(rect.right, viewport.right), bottom: Math.min(rect.bottom, viewport.bottom) };
    const clippingAncestors: { label: string; overflowX: string; overflowY: string; clipsX: boolean; clipsY: boolean;
      left: number; top: number; right: number; bottom: number }[] = [];
    const hiddenAncestors: string[] = [];
    const clips = /^(auto|scroll|hidden|clip|overlay)$/;
    for (let node: Element | null = target; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const label = `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}`;
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) {
        hiddenAncestors.push(label);
      }
      if (node === target) continue;
      const paintContainment = /\b(paint|strict|content)\b/.test(style.contain);
      const clipsX = clips.test(style.overflowX) || paintContainment;
      const clipsY = clips.test(style.overflowY) || paintContainment;
      if (!clipsX && !clipsY) continue;
      const outer = node.getBoundingClientRect();
      const html = node as HTMLElement;
      // Client edges exclude borders and scrollbars. Scaling keeps these client
      // dimensions in viewport coordinates if a containing element is scaled.
      const scaleX = html.offsetWidth > 0 ? outer.width / html.offsetWidth : 1;
      const scaleY = html.offsetHeight > 0 ? outer.height / html.offsetHeight : 1;
      const left = outer.left + node.clientLeft * scaleX;
      const top = outer.top + node.clientTop * scaleY;
      const right = left + node.clientWidth * scaleX;
      const bottom = top + node.clientHeight * scaleY;
      clippingAncestors.push({ label, overflowX: style.overflowX, overflowY: style.overflowY,
        clipsX, clipsY, left, top, right, bottom });
      if (clipsX) {
        intersection.left = Math.max(intersection.left, left);
        intersection.right = Math.min(intersection.right, right);
      }
      if (clipsY) {
        intersection.top = Math.max(intersection.top, top);
        intersection.bottom = Math.min(intersection.bottom, bottom);
      }
    }
    // Sample nine interior points, avoiding rounded border corners. A modal
    // overlay or sibling occluding a tested point must not pass as visible.
    const hitPoints = [0.25, 0.5, 0.75].flatMap(xFraction => [0.25, 0.5, 0.75].map(yFraction => {
      const x = rect.left + (rect.right - rect.left) * xFraction;
      const y = rect.top + (rect.bottom - rect.top) * yFraction;
      const hit = document.elementFromPoint(x, y);
      return { x, y, owned: hit !== null && (hit === target || target.contains(hit)),
        hit: hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}` : null };
    }));
    return { connected: target.isConnected, rect, viewport, intersection, clippingAncestors, hiddenAncestors, hitPoints };
  });
  const detail = JSON.stringify(geometry);
  const tolerance = 0.5; // Half a CSS pixel accommodates fractional layout only.
  expect(geometry.connected, detail).toBe(true);
  expect(geometry.hiddenAncestors, detail).toEqual([]);
  expect(geometry.rect.right - geometry.rect.left, detail).toBeGreaterThan(0);
  expect(geometry.rect.bottom - geometry.rect.top, detail).toBeGreaterThan(0);
  expect(geometry.rect.left, detail).toBeGreaterThanOrEqual(-tolerance);
  expect(geometry.rect.top, detail).toBeGreaterThanOrEqual(-tolerance);
  expect(geometry.rect.right, detail).toBeLessThanOrEqual(geometry.viewport.right + tolerance);
  expect(geometry.rect.bottom, detail).toBeLessThanOrEqual(geometry.viewport.bottom + tolerance);
  // These controls must be inside the real inner overflow-y-auto scrollport,
  // and their complete rectangles must survive intersection with every clip.
  expect(geometry.clippingAncestors.some(ancestor => /^(auto|scroll|overlay)$/.test(ancestor.overflowY)), detail).toBe(true);
  expect(geometry.intersection.left, detail).toBeLessThanOrEqual(geometry.rect.left + tolerance);
  expect(geometry.intersection.top, detail).toBeLessThanOrEqual(geometry.rect.top + tolerance);
  expect(geometry.intersection.right, detail).toBeGreaterThanOrEqual(geometry.rect.right - tolerance);
  expect(geometry.intersection.bottom, detail).toBeGreaterThanOrEqual(geometry.rect.bottom - tolerance);
  expect(geometry.hitPoints.every(point => point.owned), detail).toBe(true);
}

async function assertCaptureTextUnclipped(locator: Locator) {
  const layout = await locator.evaluate(target => {
    const bounds = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    const range = document.createRange();
    range.selectNodeContents(target);
    return { rect: bounds(target.getBoundingClientRect()),
      textRects: Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0).map(bounds),
      clientWidth: target.clientWidth, scrollWidth: target.scrollWidth,
      textOverflow: getComputedStyle(target).textOverflow };
  });
  const detail = JSON.stringify(layout);
  expect(layout.textRects.length, detail).toBeGreaterThan(0);
  expect(layout.textOverflow, detail).not.toBe("ellipsis");
  expect(layout.scrollWidth, detail).toBeLessThanOrEqual(layout.clientWidth + 1);
  for (const rect of layout.textRects) {
    expect(rect.left, detail).toBeGreaterThanOrEqual(layout.rect.left - 0.5);
    expect(rect.top, detail).toBeGreaterThanOrEqual(layout.rect.top - 0.5);
    expect(rect.right, detail).toBeLessThanOrEqual(layout.rect.right + 0.5);
    expect(rect.bottom, detail).toBeLessThanOrEqual(layout.rect.bottom + 0.5);
  }
}

async function assertSavedLedgerReadable(page: Page, width: number) {
  const ledger = page.locator("#lab-accounting-ledger");
  const layout = await ledger.evaluate(target => ({ scrollLeft: target.scrollLeft,
    clientWidth: target.clientWidth, scrollWidth: target.scrollWidth }));
  // Initial horizontal position only: never pan the table to manufacture a
  // passing capture. Mobile rows must expose every field without horizontal UI.
  expect(layout.scrollLeft).toBe(0);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
  const cells = ledger.getByRole("cell");
  expect(await cells.count()).toBe(12);
  for (const cell of await cells.all()) {
    await assertCaptureTargetVisible(cell);
    await assertCaptureTextUnclipped(cell);
  }
  const nativeAmount = await page.evaluate(() => `${(25).toLocaleString()} USD`);
  for (const [side, label] of [["debit", "مدين"], ["credit", "دائن"]] as const) {
    const heading = page.locator(`#lab-accounting-${side}-${width < 640 ? "label" : "header"}`);
    expect((await heading.textContent())?.trim()).toBe(label);
    await assertCaptureTargetVisible(heading);
    await assertCaptureTextUnclipped(heading);
    const amount = page.locator(`#lab-accounting-${side}-amount`);
    expect((await amount.textContent())?.replace(/\s+/g, " ").trim()).toBe(nativeAmount);
    await assertCaptureTargetVisible(amount);
    await assertCaptureTextUnclipped(amount);
  }
}

describe("saved lab accounting FX through the real built /lab page", () => {
  it("preserves metadata-only snapshots, fences stale edits, and never reuses a pending currency quote", async () => {
    const original = await settings();
    const evidence: LabAccountingEvidenceMember[] = [];
    let f: Fixture | undefined;
    let expectedFinal: Awaited<ReturnType<typeof fullSnapshot>> | undefined;
    try {
      await setRates({ "finance.rate.USD": "531.125", "finance.rate.SAR": "141.25" });
      f = await fixture();
      const fixtureIds = f;
      const originalMoney = await money(f);
      expect(originalMoney).toEqual({
        order: { id: f.orderId, cost_minor: "2500", cost_currency: "USD", exchange_rate: "531.125000", base_amount_minor: "13001", payable_id: f.payableId },
        payables: [{ id: f.payableId, lab_order_id: f.orderId, amount_minor: "2500", currency: "USD", exchange_rate: "560.080000", base_amount_minor: "14002", base_currency: "YER" }],
      });
      await setRates({ "finance.rate.USD": "540.123456" });
      const first = await browserFixture(f);
      await first.run(async () => {
        expect(await first.cost.inputValue()).toBe("25");
        expect(await first.currency.inputValue()).toBe("USD");
        await assertPreview(first.page, "saved", "USD", "13,001", "531.125");
        expect(await first.preview.textContent()).not.toContain("540.123456");
        await first.page.locator("#lab-accounting-category-select").selectOption(String(fixtureIds.categoryId));
        await first.page.locator("#lab-accounting-expense-acc-select").selectOption("5102");
        await first.page.locator("#lab-accounting-payable-acc-select").selectOption("2102");
        for (const width of [1280, 390] as const) {
          await first.page.setViewportSize({ width, height: 1000 });
          await first.save.scrollIntoViewIfNeeded();
          await first.settle();
          await assertPreview(first.page, "saved", "USD", "13,001", "531.125");
          // Prove both viewport axes, every clipping ancestor, and sampled hit
          // ownership, including the formerly clipped currency and ledger.
          for (const locator of [first.cost, first.currency, first.preview, first.save]) {
            await assertCaptureTargetVisible(locator);
          }
          expect(await first.currency.inputValue()).toBe("USD");
          expect(await first.currency.locator("option:checked").textContent()).toBe("دولار");
          expect((await first.currency.boundingBox())!.width).toBeGreaterThanOrEqual(100);
          await assertSavedLedgerReadable(first.page, width);
          // Native modal capture at the initial horizontal position; no
          // setContent, render imitation, style edits or hidden financial fields.
          const bytes = await first.modal.screenshot();
          // Screenshot auto-scrolling must not invalidate the checked region.
          for (const locator of [first.cost, first.currency, first.preview, first.save]) {
            await assertCaptureTargetVisible(locator);
          }
          await assertSavedLedgerReadable(first.page, width);
          evidence.push({ filename: `lab-accounting-saved-fx-${width}.png`, mime: "image/png",
            bytes });
        }
        await first.page.setViewportSize({ width: 1280, height: 1000 });
        const beforeSave = await fullSnapshot(fixtureIds);
        first.holdWrite();
        const response = first.page.waitForResponse(response => new URL(response.url()).pathname === `/api/lab/${fixtureIds.orderId}`
          && response.request().method() === "PATCH");
        // Two same-task DOM clicks and another action while pending exercise
        // repeated submission through the real UI and its disabled presentation.
        await first.save.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
        await expect.poll(() => first.writes.length).toBe(1);
        expect(await first.save.isDisabled()).toBe(true);
        expect(await first.cost.isDisabled()).toBe(true);
        expect(await first.currency.isDisabled()).toBe(true);
        await first.page.locator("#lab-accounting-final-post-btn").evaluate(button => (button as HTMLButtonElement).click());
        await first.settle();
        expect(first.writes).toEqual([{ action: "update_accounting", expenseCategoryId: fixtureIds.categoryId,
          expenseAccountCode: "5102", payableAccountCode: "2102" }]);
        expect(await fullSnapshot(fixtureIds)).toEqual(beforeSave);
        first.releaseWrite();
        expect((await response).status()).toBe(200);
        await first.modal.waitFor({ state: "detached" });
        expect((await fullSnapshot(fixtureIds)).tracking).toHaveLength(beforeSave.tracking.length + 1);
        expect(await money(fixtureIds)).toEqual(originalMoney);
        await assertMapping(fixtureIds, false);
        for (const [selector, action, posted] of [
          ["#lab-accounting-final-post-btn", "post", true],
          ["#lab-accounting-unpost-btn", "unpost", false],
        ] as const) {
          await first.open();
          await assertPreview(first.page, "saved", "USD", "13,001", "531.125");
          const saved = await first.submit(selector);
          expect(saved).toMatchObject({ id: fixtureIds.orderId, costMinor: 2500, costCurrency: "USD",
            exchangeRate: 531.125, baseAmountMinor: 13001, payableId: fixtureIds.payableId, isPosted: posted });
          expect(first.writes.at(-1)).toEqual({ action, expenseCategoryId: fixtureIds.categoryId,
            expenseAccountCode: "5102", payableAccountCode: "2102" });
          expect(await money(fixtureIds)).toEqual(originalMoney);
          await assertMapping(fixtureIds, posted);
        }
        expect(first.writes).toHaveLength(3);
      });
      expect(await money(f)).toEqual(originalMoney);

      const edit = await browserFixture(f);
      await edit.run(async () => {
        await edit.cost.fill("75");
        await assertPreview(edit.page, "ready", "USD", "40,509", "540.123456");
        expect(await edit.preview.getAttribute("data-preview-source")).toBe("current");
        const beforeStale = await fullSnapshot(fixtureIds);
        await setRates({ "finance.rate.USD": "550.123456" });
        // No intercepted PATCH response: this 409 comes from the actual server.
        const refused = await edit.submit("#lab-accounting-save-mapping-btn", 409);
        expect(refused.code).toBe("lab_accounting_rate_changed");
        expect(edit.writes[0]).toMatchObject({ action: "update_accounting", cost: "75", costCurrency: "USD", expectedExchangeRate: 540.123456 });
        await assertPreview(edit.page, "unavailable", "USD");
        expect(await edit.page.locator("#lab-accounting-error").textContent()).toContain("تغيّر سعر الصرف");
        expect(await fullSnapshot(fixtureIds)).toEqual(beforeStale);
        await edit.page.locator("#lab-accounting-refresh-rate-btn").click();
        await assertPreview(edit.page, "ready", "USD", "41,259", "550.123456");
        const saved = await edit.submit("#lab-accounting-save-mapping-btn");
        expect(saved).toMatchObject({ id: fixtureIds.orderId, costMinor: 7500, costCurrency: "USD",
          exchangeRate: 550.123456, baseAmountMinor: 41259, payableId: fixtureIds.payableId });
        expect(edit.writes[1]).toMatchObject({ cost: "75", costCurrency: "USD", expectedExchangeRate: 550.123456 });
        await assertEditedPair(fixtureIds);
        expect((await fullSnapshot(fixtureIds)).tracking).toHaveLength(beforeStale.tracking.length + 1);

        await edit.open();
        await assertPreview(edit.page, "saved", "USD", "41,259", "550.123456");
        const beforeRace = await fullSnapshot(fixtureIds);
        await edit.cost.fill("76");
        await assertPreview(edit.page, "ready", "USD", "41,809", "550.123456");
        edit.holdSettings();
        await edit.currency.selectOption("SAR");
        await expect.poll(() => edit.pendingReads.length).toBe(1);
        await assertPreview(edit.page, "loading", "SAR");
        await edit.currency.selectOption("USD");
        await expect.poll(() => edit.pendingReads.length).toBe(2);
        await assertPreview(edit.page, "loading", "USD");
        // An old B response arrives while a new A request is still pending.
        const oldResponse = edit.page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings");
        edit.pendingReads[0].resolve("continue");
        const oldSettings = await oldResponse;
        expect(oldSettings.status()).toBe(200);
        await oldSettings.finished();
        await edit.settle();
        await assertPreview(edit.page, "loading", "USD");
        edit.pendingReads[1].resolve("fail");
        await assertPreview(edit.page, "unavailable", "USD");
        await edit.save.evaluate(button => (button as HTMLButtonElement).click());
        await edit.page.locator("#lab-accounting-final-post-btn").evaluate(button => (button as HTMLButtonElement).click());
        await edit.settle();
        expect(edit.writes).toHaveLength(2);
        expect(await fullSnapshot(fixtureIds)).toEqual(beforeRace);
        edit.resumeSettings();
        await edit.page.locator("#lab-accounting-refresh-rate-btn").click();
        await assertPreview(edit.page, "ready", "USD", "41,809", "550.123456");
        await edit.page.locator("#lab-accounting-cancel-btn").click();
        await edit.modal.waitFor({ state: "detached" });
        await edit.open();
        expect(await edit.cost.inputValue()).toBe("75");
        await assertPreview(edit.page, "saved", "USD", "41,259", "550.123456");
        expect(await fullSnapshot(fixtureIds)).toEqual(beforeRace);
        expectedFinal = beforeRace;
      });
      await assertEditedPair(f);
      expect(await fullSnapshot(f)).toEqual(expectedFinal);
    } finally {
      // Restore only the two allowed synthetic-database keys, via the same
      // versioned audited API. Never erase settings/audit history or fixture rows.
      await setRates({ "finance.rate.USD": original["finance.rate.USD"], "finance.rate.SAR": original["finance.rate.SAR"] });
      const restored = await settings();
      for (const key of RATE_KEYS) expect(restored[key]).toBe(original[key]);
    }
    expect(f).toBeDefined();
    expect(await fullSnapshot(f!)).toEqual(expectedFinal);
    // Frames are acceptance evidence only after every assertion and cleanup above.
    emitLabAccountingEvidence(evidence);
  });
});
