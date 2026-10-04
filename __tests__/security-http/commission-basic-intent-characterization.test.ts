import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import type { CommissionDetailLine } from "../../lib/commission";

/** BUG characterization, never a live-site probe. Uses the actual built app and
 * isolated synthetic PG fixtures. Passing means an unrelated Basic save changes
 * future earnings; historical facts/earnings must still remain unchanged. */
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
const stamp = Date.now();
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

describe("characterization: unrelated doctor Basic save materializes an advanced financial policy", () => {
  it("contrasts the true omitted-config HTTP control with actual browser name-only save and immutable past earnings", async () => {
    const name = `طبيب غياب السياسة ${stamp}`;
    const [{ id: partyId }] = (await db.query<{ id: number }>(`INSERT INTO parties (name, kind, commission_percent) VALUES ($1, 'doctor', 20) RETURNING id`, [name])).rows;
    const [{ id: userId }] = (await db.query<{ id: number }>(`INSERT INTO users (username, display_name, password_hash, role, party_id, commission_config)
      VALUES ($1, $2, 'unused-synthetic-hash', 'doctor', $3, NULL) RETURNING id`, [`null-policy-${stamp}`, name, partyId])).rows;
    const [{ id: patientId }] = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`NULL-POL-${stamp}`, name])).rows;
    // Explicitly closed fixture avoids the one-open-shift index and does not alter shared cash workflow.
    const [{ id: shiftId }] = (await db.query<{ id: number }>(`INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at) VALUES ('synthetic', 'closed', 'synthetic', NOW()) RETURNING id`)).rows;
    const beforeTime = new Date(Date.now() - 3_600_000).toISOString();
    const reportPath = `/api/finance/commissions?detail=1&from=1970-01-01&to=2099-12-31&doctorId=${partyId}`;
    const report = async () => { const r = await authedGet(reportPath, h.sessions.admin); expect(r.status).toBe(200); return (await r.json()).lines as CommissionDetailLine[]; };
    const fact = async (suffix: string, at: string) => {
      const [{ id: invoiceId }] = (await db.query<{ id: number }>(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
        VALUES ($1, $2, 10000, 0, 'YER', 'synthetic', $3::timestamptz) RETURNING id`, [`NULL-INV-${stamp}-${suffix}`, patientId, at])).rows;
      await db.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor, doctor_id) VALUES ($1, 'عمل اصطناعي', 1, 10000, 10000, $2)`, [invoiceId, partyId]);
      await db.query(`INSERT INTO visits (patient_name, patient_id, doctor_id, status, invoice_id, arrived_at, signed_at, signed_by)
        VALUES ($1, $2, $3, 'done', $4, $5::timestamptz, $5::timestamptz, 'synthetic')`, [name, patientId, partyId, invoiceId, at]);
      await db.query(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
        VALUES ($1, $2, $3, $4, 'payment', 10000, 'YER', 1, 10000, 'YER', 'cash', 'synthetic', $5::timestamptz)`, [`NULL-PAY-${stamp}-${suffix}`, patientId, invoiceId, shiftId, at]);
      return invoiceId;
    };
    const storage = async () => (await db.query(`SELECT commission_config FROM users WHERE id = $1`, [userId])).rows[0].commission_config;
    const history = async () => (await db.query(`SELECT * FROM doctor_commission_history WHERE party_id = $1 ORDER BY id`, [partyId])).rows;
    const audits = async () => (await db.query(`SELECT * FROM audit_log WHERE action = 'doctor.commission.update' AND entity = 'party' AND entity_id = $1 ORDER BY id`, [String(partyId)])).rows;
    const immutableFacts = async () => {
      const invoices = (await db.query(`SELECT * FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId])).rows;
      const items = (await db.query(`SELECT ii.* FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.patient_id = $1 ORDER BY ii.id`, [patientId])).rows;
      const payments = (await db.query(`SELECT * FROM payments WHERE patient_id = $1 ORDER BY id`, [patientId])).rows;
      const visits = (await db.query(`SELECT * FROM visits WHERE patient_id = $1 ORDER BY id`, [patientId])).rows;
      return { invoices, items, payments, visits };
    };
    const oldInvoice = await fact("before", beforeTime);
    const beforeLines = await report();
    expect(beforeLines).toHaveLength(1); expect(beforeLines[0]).toMatchObject({ invoiceId: oldInvoice, percent: 20, earnedMinor: 2000 });
    const oldFacts = await immutableFacts(); const oldHistory = await history(); const oldAudits = await audits();
    expect(await storage()).toBeNull();
    const getUsers = await authedGet("/api/users", h.sessions.admin); expect(getUsers.status).toBe(200);
    const projected = (await getUsers.json()).find((user: { id: number }) => user.id === userId);
    expect(projected.commissionConfig).toMatchObject({ calculationMode: "percentage", defaultPercent: 30 });
    const control = await authedMutation(`/api/users/${userId}`, h.sessions.admin, "PATCH", JSON.stringify({ displayName: name }));
    expect(control.status).toBe(200); expect(await storage()).toBeNull();
    expect(await history()).toEqual(oldHistory); expect(await audits()).toEqual(oldAudits);
    expect(await report()).toEqual(beforeLines); expect(await immutableFacts()).toEqual(oldFacts);
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "ar-YE" });
    const [cookieName, ...cookieValue] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name: cookieName, value: cookieValue.join("="), url: baseUrl }]);
    const page = await context.newPage();
    const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
    page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push({ url: request.url(), body: request.postDataJSON() }); });
    try {
      await page.goto(`${baseUrl}/settings/users`); await page.getByPlaceholder("بحث بالاسم أو التخصص...").fill(name);
      await page.getByRole("button", { name: "تعديل الملف", exact: true }).click();
      const label = page.getByText("الاسم الظاهر", { exact: true });
      await label.locator("..").locator("input").fill(`${name} اسم محدّث فقط`);
      const saved = page.waitForResponse(r => r.url() === `${baseUrl}/api/users/${userId}` && r.request().method() === "PATCH");
      await page.getByRole("button", { name: "حفظ التغييرات والصلاحيات", exact: true }).click(); expect((await saved).status()).toBe(200);
      expect(writes).toHaveLength(1); expect(writes[0].url).toBe(`${baseUrl}/api/users/${userId}`);
      expect(writes[0].body.commissionConfig).toMatchObject({ calculationMode: "percentage", defaultPercent: 30 });
      expect(JSON.parse(await storage())).toMatchObject({ calculationMode: "percentage", defaultPercent: 30 });
      expect(Number((await db.query(`SELECT commission_percent FROM parties WHERE id = $1`, [partyId])).rows[0].commission_percent)).toBe(20);
      const afterHistory = await history(); expect(afterHistory).toHaveLength(oldHistory.length > 0 ? oldHistory.length + 1 : 2);
      if (oldHistory.length > 0) expect(afterHistory.slice(0, oldHistory.length)).toEqual(oldHistory);
      expect(Number(afterHistory[0].percent)).toBe(20); expect(afterHistory[0]).toMatchObject({ config: null, source: "baseline" });
      expect(Number(afterHistory.at(-1).percent)).toBe(20); expect(afterHistory.at(-1)).toMatchObject({ source: "advanced", config: { defaultPercent: 30 } });
      const changed = await audits(); expect(changed).toHaveLength(oldAudits.length + 1);
      expect(changed.at(-1)).toMatchObject({ actor: "secadmin", details: { "قبل_القيمة": { percent: 20, config: null }, "بعد_القيمة": { percent: 20, config: { defaultPercent: 30 } } } });
      expect(await immutableFacts()).toEqual(oldFacts); expect(await report()).toEqual(beforeLines);
      const cutover = new Date(afterHistory.at(-1).effective_from).getTime();
      const afterTime = new Date(cutover + 1000).toISOString();
      expect(new Date(beforeTime).getTime()).toBeLessThan(cutover);
      expect(cutover).toBeLessThan(new Date(afterTime).getTime());
      const nextInvoice = await fact("after", afterTime);
      const finalLines = await report();
      expect(finalLines.find(line => line.invoiceId === oldInvoice)).toEqual(beforeLines[0]);
      expect(finalLines.find(line => line.invoiceId === nextInvoice)).toMatchObject({ percent: 30, earnedMinor: 3000 });
    } finally { await context.close(); }
  }, 180_000);
});
