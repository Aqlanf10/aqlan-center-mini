import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";

let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let db: Client;
let pricedId: number;
let unknownId: number;
let freeId: number;
let supplierId: number;
let payableId: number;
const evidence = process.env.INVENTORY_EVIDENCE_DIR ?? ".inventory-foundation-artifacts";
const witness = `SYN-INV-${Date.now()}`;

beforeAll(async () => {
  h = await harness();
  const url = new URL(h.seeded.dbUrl);
  expect(url.hostname).toBe("127.0.0.1"); expect(url.pathname).toBe("/aqlan_sec_http");
  db = new Client({ host: url.hostname, port: Number(url.port), database: "aqlan_sec_http", user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false });
  await db.connect();
  const supplier = await db.query("INSERT INTO parties(name,kind) VALUES ($1,'supplier') RETURNING id", [`${witness}-supplier`]);
  supplierId = supplier.rows[0].id;
  async function create(name: string, unitCost?: string, supplierPartyId?: number) {
    const created = await authedMutation("/api/inventory", h.sessions.admin, "POST", JSON.stringify({ name, category: "other", unit: "piece", minLevel: 5 }));
    expect(created.status).toBe(201); const item = await created.json();
    const receipt = await authedMutation(`/api/inventory/${item.id}/movements`, h.sessions.admin, "POST", JSON.stringify({ kind: "in", qty: 5, unitCost, supplierPartyId }));
    expect(receipt.status).toBe(201); const result = await receipt.json();
    if (supplierPartyId) payableId = result.movement.payableId;
    return item.id as number;
  }
  pricedId = await create(`${witness}-known`, "123", supplierId);
  unknownId = await create(`${witness}-missing`);
  freeId = await create(`${witness}-free`, "0");
  browser = await chromium.launch({ headless: true, ...(process.env.INVENTORY_CHROMIUM_EXECUTABLE ? { executablePath: process.env.INVENTORY_CHROMIUM_EXECUTABLE } : {}) });
  await mkdir(evidence, { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });

async function counts() {
  return (await db.query(`SELECT (SELECT count(*) FROM inventory_movements) AS movements,
    (SELECT count(*) FROM payables) AS payables, (SELECT count(*) FROM expenses) AS expenses,
    (SELECT count(*) FROM payments) AS payments`)).rows[0];
}

describe("inventory foundation: built HTTP and browser, synthetic database", () => {
  it("P30 partial: price fields absent for non-admin roles and present for admin; no session denied", async () => {
    const anonymous = await fetch(`${baseUrl}/api/inventory/${pricedId}`, { redirect: "manual" });
    expect([401, 403, 307]).toContain(anonymous.status);
    for (const role of ["doctorA", "reception", "cashier", "accountant"] as const) {
      const response = await authedGet(`/api/inventory/${pricedId}`, h.sessions[role]);
      expect([200, 403]).toContain(response.status);
      const text = await response.text();
      expect(text).not.toContain("unitCostMinor"); expect(text).not.toContain("payableId");
      expect((await authedGet("/api/inventory/value", h.sessions[role])).status).toBe(403);
    }
    const detail = await (await authedGet(`/api/inventory/${pricedId}`, h.sessions.admin)).json();
    expect(detail.movements[0]).toMatchObject({ unitCostMinor: 123, partyId: supplierId, payableId });
  });
  it("P15/P31 partial: unknown valuation stays incomplete; free stock known; boundary consistent", async () => {
    const report = await (await authedGet("/api/inventory/value", h.sessions.admin)).json();
    expect(report.totalMinor).toBeNull();
    expect(report.items.find((i: { id: number }) => i.id === unknownId)).toMatchObject({ valueMinor: null, costStatus: "missing" });
    expect(report.items.find((i: { id: number }) => i.id === freeId)).toMatchObject({ valueMinor: 0, costStatus: "known" });
    const detail = await (await authedGet(`/api/inventory/${pricedId}`, h.sessions.admin)).json();
    expect(detail.item.status).toBe("low");
  });
  it.each([390, 1280])("P37 partial: real RTL/English review, print and unavailable-state safety at %ipx", async width => {
    const before = await counts();
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const [name, ...parts] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: parts.join("="), url: baseUrl }]);
    const unexpected: string[] = [];
    let unavailable = false;
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        unexpected.push(`${request.method()} ${url.pathname}`); await route.abort(); return;
      }
      if (unavailable && url.pathname === "/api/inventory/value") { await route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"synthetic unavailable"}' }); return; }
      await route.continue();
    });
    await guard.run(async () => {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/inventory/review`, { waitUntil: "domcontentloaded" });
      const root = page.getByTestId("inventory-valuation-review");
      await root.getByRole("heading", { name: "التقييم غير مكتمل", exact: true }).waitFor();
      expect(await root.getAttribute("dir")).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${evidence}/valuation-ar-${width}.png`, fullPage: true });
      await root.getByRole("button", { name: "English", exact: true }).click();
      await root.getByRole("heading", { name: "Valuation incomplete", exact: true }).waitFor();
      expect(await root.getAttribute("dir")).toBe("ltr");
      expect(await root.innerText()).toContain(`${witness}-missing`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${evidence}/valuation-en-${width}.png`, fullPage: true });
      await page.pdf({ path: `${evidence}/valuation-en-${width}.pdf`, format: "A4", printBackground: true });
      unavailable = true;
      await root.getByRole("button", { name: "Refresh", exact: true }).click();
      await root.getByRole("alert").waitFor();
      expect(await root.innerText()).not.toContain(`${witness}-known`);
      expect(await root.getByRole("button", { name: "Print report", exact: true }).isDisabled()).toBe(true);
      unavailable = false;
      await root.getByRole("button", { name: "Refresh", exact: true }).click();
      await root.getByRole("heading", { name: "Valuation incomplete", exact: true }).waitFor();
    }, () => expect(unexpected).toEqual([]));
    expect(await counts()).toEqual(before);
    await writeFile(`${evidence}/verification-${width}.json`, JSON.stringify({ width, languages: ["ar", "en"], horizontalOverflow: false, noBrowserWrites: true, readCountsUnchanged: true, unavailableWithdrawsReport: true }, null, 2));
  });
});
