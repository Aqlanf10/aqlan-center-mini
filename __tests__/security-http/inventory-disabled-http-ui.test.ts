import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_CUSTODY_SQL } from "../../lib/inventory-domain/custody-schema-proposal";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
beforeAll(async () => {
  h = await harness();
  const url = new URL(h.seeded.dbUrl);
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: url.toString(), ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, ...(process.env.INVENTORY_CHROMIUM_EXECUTABLE ? { executablePath: process.env.INVENTORY_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
it("built main-schema application hides dormant links and rejects every new API command without proposal SQL", async () => {
  const schema = async () => (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const before = await schema();
  // Read proposal names only: never execute either SQL string in this suite.
  const proposedTables = [...`${INVENTORY_PROCUREMENT_SQL}
${INVENTORY_CUSTODY_SQL}`.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(match => match[1]);
  expect(proposedTables).toHaveLength(29);
  for (const table of proposedTables) expect(before.map(row => row.tablename)).not.toContain(table);
  const count = async () => (await db.query("SELECT (SELECT count(*) FROM inventory_movements)::int AS movements, (SELECT count(*) FROM audit_log)::int AS audit")).rows[0];
  const beforeCounts = await count();
  for (const actor of [h.sessions.admin, h.sessions.doctorA, h.sessions.reception]) {
    for (const view of ["", "?view=catalog", "?view=workbench", "?view=custody"]) {
      const response = await authedGet(`/api/inventory/procurement${view}`, actor);
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("inventory_integration_disabled");
    }
    for (const command of ["request.submit", "request.revise", "request.approve", "order.issue", "order.amend", "receipt.post", "quarantine.resolve", "invoice.match", "custody.dispatch", "custody.acknowledge", "legacy.reconcile", "custody.return_to_store", "custody.consume", "custody.stocktake", "custody.close_package", "custody.propose_settlement", "custody.object_settlement", "custody.approve_waste"]) {
      const response = await authedMutation("/api/inventory/procurement", actor, "POST", JSON.stringify({ command }));
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("inventory_integration_disabled");
    }
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const [name, ...value] = actor.cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const newRequests: string[] = [];
      context.on("request", request => { if (new URL(request.url()).pathname === "/api/inventory/procurement") newRequests.push(request.url()); });
      try {
        const page = await context.newPage();
        const inventoryResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/inventory" && response.request().method() === "GET");
        await page.goto(`${baseUrl}/inventory`);
        const response = await inventoryResponse;
        expect(response.status()).toBe(200);
        const inventory = await response.json();
        expect(Array.isArray(inventory.items)).toBe(true);
        // Wait for a positive ready state, not absence of a possibly misspelled spinner.
        if (inventory.items.length) await page.getByRole("columnheader", { name: "المادة / البند", exact: true }).waitFor();
        else await page.getByText("لا توجد مواد مسجلة بالمخزن بعد.", { exact: true }).waitFor();
        expect(await page.getByText("جارٍ التحميل…", { exact: true }).count()).toBe(0);
        expect(await page.locator('a[href^="/inventory/procurement"], a[href="/inventory/custody"]').count()).toBe(0);
        for (const path of ["procurement", "procurement/review", "procurement/operations", "custody"]) {
          await page.goto(`${baseUrl}/inventory/${path}`);
          await page.getByTestId("inventory-integration-disabled").waitFor();
          expect(await page.locator("form").count()).toBe(0);
          expect(await page.locator('[data-testid="inventory-procurement"], [data-testid="procurement-administration"], [data-testid="procurement-operations"], [data-testid="doctor-custody"], [data-testid="procurement-print-document"]').count()).toBe(0);
          expect(await page.getByRole("button", { name: /طباعة|Print/i }).count()).toBe(0);
          await page.emulateMedia({ media: "print" });
          expect(await page.getByTestId("inventory-integration-disabled").isVisible()).toBe(true);
          expect(await page.locator('[data-testid="procurement-print-document"], [class*="printHeader"], [class*="printItems"]').count()).toBe(0);
          await page.emulateMedia({ media: "screen" });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        expect(newRequests).toEqual([]);
      } finally { await context.close(); }
    }
  }
  expect((await authedGet("/api/inventory", h.sessions.admin)).status).toBe(200);
  expect(await schema()).toEqual(before);
  expect(await count()).toEqual(beforeCounts);
});

it("keeps authentication, role admission and route/method denial ahead of the dormant integration", async () => {
  const path = "/api/inventory/procurement";
  const check = async (cookie: string, status: number) => {
    for (const response of [await authedGet(path, { cookie }), await authedMutation(path, { cookie }, "POST", "not-json")]) {
      expect(response.status).toBe(status);
      expect((await response.json()).code).not.toBe("inventory_integration_disabled");
    }
  };
  await check("", 401);
  await check("aqlan_flow_session=forged.invalid.signature", 401);
  for (const actor of [h.sessions.cashier, h.sessions.accountant]) await check(actor.cookie, 403);
  await db.query("UPDATE users SET is_active=FALSE WHERE username='secdoctorb'");
  try { await check(h.sessions.doctorB.cookie, 401); }
  finally { await db.query("UPDATE users SET is_active=TRUE WHERE username='secdoctorb'"); }
  for (const method of ["PUT", "PATCH", "DELETE"] as const) {
    const response = await authedMutation(path, h.sessions.admin, method, "{}");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
    expect(response.headers.get("allow")).toContain("POST");
  }
  expect((await authedGet(`${path}/unregistered`, h.sessions.admin)).status).toBe(404);
  expect((await authedMutation(`${path}/unregistered`, h.sessions.admin, "POST", "{}")).status).toBe(404);
});
