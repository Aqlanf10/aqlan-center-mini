import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";
import { assertInvoiceViewportBounds, invoiceViewportProof, revealInvoiceControlByWheel, settleBrowser } from "./_invoice-browser-geometry";

/** Real built application + isolated synthetic PostgreSQL only. No mocked route,
 * replaced markup/CSS, storage export, trace, HAR or Production fixture access. */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let serviceId = 0;
const doctors: number[] = [];
const patients = new Map<number, string>();
const evidence = ".settings-ui-artifacts/invoice-grouped-entry";
const initialTeeth = [11, 12, 13, 21, 22, 23];
const finalTeeth = [11, 12, 13, 21, 22, 24];
const stamp = Date.now();

type Child = { serviceId: number; doctorId: number; price: string; quantity: number;
  toothCode: number; episodeTeeth: number[]; planItemId?: number | null };

beforeAll(async () => {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("Grouped evidence requires the isolated loopback harness");
  h = await harness();
  const database = new URL(h.seeded.dbUrl);
  if (database.pathname !== "/aqlan_sec_http") throw new Error("Grouped evidence requires the synthetic security test database");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  for (const suffix of ["أ", "ب"]) doctors.push((await db.query<{ id: number }>(
    "INSERT INTO parties(name,kind) VALUES($1,'doctor') RETURNING id", [`طبيب مجموعة اصطناعي ${suffix} ${stamp}`])).rows[0].id);
  serviceId = (await db.query<{ id: number }>(`INSERT INTO services(name,category,price_minor,price_configured,is_active)
    VALUES($1,'bridge',100000,TRUE,TRUE) RETURNING id`, [`جسر اصطناعي لكل سن ${stamp}`])).rows[0].id;
  mkdirSync(evidence, { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function ready(page: Page) {
  await expect.poll(() => page.locator('[data-testid^="invoice-clinical-preview-"][data-preview-state="ready"]').count(), { timeout: 30_000 }).toBe(6);
  await expect.poll(() => page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).isEnabled()).toBe(true);
}

async function capture(page: Page, patientId: number, width: number, split: boolean) {
  const target = new URL(page.url()), expectedName = patients.get(patientId);
  if (!expectedName || target.origin !== new URL(baseUrl).origin || target.pathname !== `/patients/${patientId}`
    || target.search !== "?tab=account" || target.hash || ![390, 1280].includes(width)) throw new Error("Screenshot outside synthetic grouped-entry allowlist");
  expect(await page.getByText(expectedName, { exact: true }).first().count()).toBeGreaterThan(0);
  expect(page.viewportSize()).toEqual({ width, height: 1040 });
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  const row = page.getByTestId("invoice-row-0");
  // Frame actual visible controls with native wheel input, not DOM scroll mutation.
  await revealInvoiceControlByWheel(page, row);
  if (split) {
    const bothRows = [row, page.getByTestId("invoice-row-1")];
    await expect.poll(async () => {
      const bounds = await Promise.all(bothRows.map(one => one.evaluate(invoiceViewportProof)));
      const top = Math.min(...bounds.map(one => one.top)), bottom = Math.max(...bounds.map(one => one.bottom));
      const availableTop = Math.max(...bounds.map(one => one.availableViewport.top));
      const availableBottom = Math.min(...bounds.map(one => one.availableViewport.bottom));
      expect(bottom - top).toBeLessThanOrEqual(availableBottom - availableTop);
      if (top >= availableTop && bottom <= availableBottom && bounds.every(one => one.unobscured)) return true;
      const y = (availableTop + availableBottom) / 2;
      const pointer = await row.evaluate((node, y) => {
        const x = Math.max(2, Math.min(innerWidth - 2, (node.closest("main")?.getBoundingClientRect().left ?? 0) + 4));
        return { x, y, nativeField: document.elementFromPoint(x, y)?.closest("input,select,textarea")?.tagName ?? null };
      }, y);
      expect(pointer.nativeField).toBeNull();
      await page.mouse.move(pointer.x, pointer.y); await page.mouse.wheel(0, (top + bottom) / 2 - y);
      await settleBrowser(page); return false;
    }).toBe(true);
  }
  const proofs = [];
  const controls = [row.getByLabel("السعر", { exact: true }), row.getByLabel("الكمية", { exact: true }),
    page.getByTestId("invoice-provider-0"), page.getByTestId("invoice-tooth-chip-0"), page.getByTestId("invoice-line-total-0")];
  if (split) controls.push(page.getByTestId("invoice-provider-1"), page.getByTestId("invoice-tooth-chip-1"), page.getByTestId("invoice-line-total-1"));
  for (const control of controls) {
    const proof = await control.evaluate(invoiceViewportProof); assertInvoiceViewportBounds(proof, width); proofs.push(proof);
  }
  const name = `${split ? "split" : "grouped"}-${width}`;
  await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: false, animations: "disabled", caret: "hide", scale: "css" });
  // Only allowlisted synthetic geometry and expected values, never session state.
  writeFileSync(`${evidence}/${name}.json`, JSON.stringify({ width, height: 1040, scene: name,
    source: "real built app; isolated synthetic PostgreSQL; no browser API interception",
    expectedTeeth: split ? finalTeeth : initialTeeth, unitPriceMinor: 100000, totalMinor: 600000,
    visibleLines: await page.locator('[data-testid^="invoice-row-"]').count(), proofs }, null, 2));
}

describe("grouped invoice entry in the built application", () => {
  it.each([1280, 390])("six teeth at 100000 form one line; split/reselection preserve children at %ipx", async width => {
    const patientName = `مريض مجموعة اصطناعي ${width} ${stamp}`;
    const patientId = (await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id",
      [`GROUP-${width}-${stamp}`, patientName])).rows[0].id;
    patients.set(patientId, patientName);
    const context = await browser.newContext({ viewport: { width, height: 1040 }, locale: "ar-YE", deviceScaleFactor: 1, serviceWorkers: "block" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = [], submissions: { items: Child[]; currency: string; discount: string }[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/invoices") submissions.push(request.postDataJSON());
    });
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("treatment-entry-open").click();
      await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(serviceId));
      await page.getByTestId("invoice-tooth-button-0").click();
      const dialog = page.getByTestId("tooth-dialog"); await dialog.waitFor();
      for (const tooth of initialTeeth) await dialog.getByTestId(`odontogram-tooth-${tooth}`).click();
      await page.getByTestId("tooth-dialog-confirm").click(); await dialog.waitFor({ state: "detached" });
      expect(await page.locator('[data-testid^="invoice-row-"]').count()).toBe(1);
      expect(await page.locator('[data-testid^="invoice-provider-"]').count()).toBe(1);
      expect(await page.getByTestId("invoice-row-0").getByLabel("الكمية", { exact: true }).inputValue()).toBe("6");
      expect(await page.getByTestId("invoice-row-0").getByLabel("الكمية", { exact: true }).isDisabled()).toBe(true);
      expect(await page.getByTestId("invoice-line-total-0").innerText()).toContain("600,000");
      // One selection must attribute all six canonical children.
      await page.getByTestId("invoice-provider-0").selectOption(String(doctors[0])); await ready(page);
      await capture(page, patientId, width, false);

      await page.getByTestId("invoice-group-details-0").locator("summary").first().click();
      await page.getByTestId("invoice-split-tooth-1").click();
      expect(await page.locator('[data-testid^="invoice-row-"]').count()).toBe(2);
      const splitKey = await page.getByTestId("invoice-row-1").getAttribute("data-row-key");
      await page.getByTestId("invoice-provider-1").selectOption(String(doctors[1]));
      await page.getByTestId("invoice-tooth-button-0").click(); await dialog.waitFor();
      expect(await dialog.getByTestId("odontogram-tooth-12").getAttribute("aria-pressed")).toBe("false");
      await dialog.getByTestId("odontogram-tooth-23").click(); await dialog.getByTestId("odontogram-tooth-24").click();
      await page.getByTestId("tooth-dialog-confirm").click(); await dialog.waitFor({ state: "detached" });
      expect(await page.getByTestId("invoice-row-1").getAttribute("data-row-key")).toBe(splitKey);
      expect(await page.getByTestId("invoice-provider-1").inputValue()).toBe(String(doctors[1]));
      expect(await page.getByTestId("invoice-row-0").getByLabel("الكمية", { exact: true }).inputValue()).toBe("5");
      expect(await page.getByTestId("invoice-line-total-0").innerText()).toContain("500,000");
      expect(await page.getByTestId("invoice-line-total-1").innerText()).toContain("100,000");
      await ready(page);
      // The details remain user-expandable, but the screenshot shows the compact editor.
      const details = page.getByTestId("invoice-group-details-0");
      if (await details.getAttribute("open") !== null) await details.locator("summary").first().click();
      await capture(page, patientId, width, true);
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/invoices" && response.request().method() === "POST");
      await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).click();
      const response = await saved; expect(response.status()).toBe(201);
      await page.getByTestId("invoice-clinical-notice").waitFor();
      expect(submissions).toHaveLength(1);
      const submitted = submissions[0]; expect(submitted.currency).toBe("YER"); expect(submitted.items).toHaveLength(6);
      expect(submitted.items.map(item => item.toothCode)).toEqual(finalTeeth);
      for (const item of submitted.items) {
        expect(item.serviceId).toBe(serviceId); expect(item.quantity).toBe(1); expect(item.price.replaceAll(",", "")).toBe("100000");
        expect(item.doctorId).toBe(item.toothCode === 12 ? doctors[1] : doctors[0]); expect(item.episodeTeeth).toEqual(finalTeeth);
        expect(item).not.toHaveProperty("displayGroupId"); expect(item).not.toHaveProperty("groupId");
      }
      const stored = (await db.query(`SELECT ii.quantity,ii.unit_price_minor::text,ii.total_minor::text,ii.doctor_id,
        ii.plan_item_id,ii.source_type,ii.source_id::text,pi.tooth_code,pi.case_id FROM invoice_items ii
        JOIN invoices i ON i.id=ii.invoice_id JOIN plan_items pi ON pi.id=ii.plan_item_id WHERE i.patient_id=$1 ORDER BY pi.tooth_code`, [patientId])).rows;
      expect(stored).toHaveLength(6); expect(new Set(stored.map(item => item.plan_item_id)).size).toBe(6);
      expect(new Set(stored.map(item => item.case_id)).size).toBe(1);
      expect(stored.map(item => item.tooth_code)).toEqual(finalTeeth);
      for (const item of stored) {
        expect(item.quantity).toBe(1); expect(item.unit_price_minor).toBe("100000"); expect(item.total_minor).toBe("100000");
        expect(item.source_type).toBe("plan_item"); expect(item.source_id).toBe(String(item.plan_item_id));
        expect(item.doctor_id).toBe(item.tooth_code === 12 ? doctors[1] : doctors[0]);
      }
      expect((await db.query("SELECT total_minor::text,discount_minor::text FROM invoices WHERE patient_id=$1", [patientId])).rows)
        .toEqual([{ total_minor: "600000", discount_minor: "0" }]);
      expect((await db.query("SELECT id FROM payments WHERE patient_id=$1", [patientId])).rows).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 120_000);
});
