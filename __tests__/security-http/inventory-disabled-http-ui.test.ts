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
    const context = await browser.newContext();
    const [name, ...value] = actor.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const newRequests: string[] = [];
    context.on("request", request => { if (new URL(request.url()).pathname === "/api/inventory/procurement") newRequests.push(request.url()); });
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/inventory`);
      await expect.poll(async () => page.getByText("جارٍ تحميل", { exact: true }).count()).toBe(0);
      expect(await page.locator('a[href^="/inventory/procurement"], a[href="/inventory/custody"]').count()).toBe(0);
      for (const path of ["procurement", "procurement/review", "procurement/operations", "custody"]) {
        await page.goto(`${baseUrl}/inventory/${path}`);
        await page.getByTestId("inventory-integration-disabled").waitFor();
        expect(await page.locator("form").count()).toBe(0);
      }
      expect(newRequests).toEqual([]);
    } finally { await context.close(); }
  }
  expect((await authedGet("/api/inventory", h.sessions.admin)).status).toBe(200);
  expect(await schema()).toEqual(before);
  expect(await count()).toEqual(beforeCounts);
});
