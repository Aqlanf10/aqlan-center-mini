import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/** (FIN-DISC) Admin discount on an issued invoice over real HTTP and the built page. Synthetic isolated database only. */
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let shiftId = 0;
const stamp = Date.now();
let seq = 0;
const SHOTS = ".settings-ui-artifacts";

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض خصم الإدارة الاصطناعي') RETURNING id", [`DISC-${stamp}`]));
  ({ rows: [{ id: shiftId }] } = await db.query<{ id: number }>(
    "INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd, status) VALUES ('disc-ui', 0, 0, 0, 'closed') RETURNING id"));
  mkdirSync(SHOTS, { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function invoice(total = 100000, paid = 0): Promise<number> {
  seq += 1;
  const { rows: [{ id }] } = await db.query<{ id: number }>(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
    VALUES ($1, $2, $3, 0, 'YER', 'reception1') RETURNING id`, [`DISC-UI-${stamp}-${seq}`, patientId, total]);
  await db.query("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor) VALUES ($1, 'علاج اصطناعي', 1, $2, $2)", [id, total]);
  if (paid > 0) {
    await db.query(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate,
      base_amount_minor, base_currency, method, created_by) VALUES ($1, $2, $3, $4, 'payment', $5, 'YER', 1, $5, 'YER', 'cash', 'reception1')`,
    [`DISC-UI-R-${stamp}-${seq}`, patientId, id, shiftId, paid]);
  }
  return id;
}
const post = (id: number, who: keyof typeof h.sessions | null, body: unknown) => fetch(`${baseUrl}/api/invoices/${id}/discount`, {
  method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/json", Origin: baseUrl, "Sec-Fetch-Site": "same-origin", ...(who ? { Cookie: h.sessions[who].cookie } : {}) },
  body: JSON.stringify(body),
});
/** The patient's YER balance as the server reports it to the patient file header. */
const headerBalance = async () => {
  const response = await fetch(`${baseUrl}/api/patients/${patientId}/workflow`, { headers: { Cookie: h.sessions.admin.cookie } });
  const body = await response.json() as { financial: { balanceMinor: number; byCurrency?: Record<string, { balanceMinor: number }> } };
  return body.financial.byCurrency?.YER?.balanceMinor ?? body.financial.balanceMinor;
};
const discountOf = async (id: number) => (await db.query<{ d: number }>("SELECT discount_minor::int AS d FROM invoices WHERE id = $1", [id])).rows[0].d;
const arabic = async (response: Response) => {
  const body = await response.json() as { message?: string };
  expect(body.message).toMatch(/[؀-ۿ]/);
  expect(JSON.stringify(body)).not.toMatch(/error:|stack|at \//i);
  return body.message!;
};

describe("(FIN-DISC) admin discount API", () => {
  it("is refused for every non-admin role and anonymous callers, with no change", async () => {
    const id = await invoice();
    expect((await post(id, null, { amount: "1000", reason: "خصم", expectedDiscountMinor: 0 })).status).toBe(401);
    for (const role of ["reception", "doctorA", "cashier", "accountant"] as const) {
      const response = await post(id, role, { amount: "1000", reason: "قرار", expectedDiscountMinor: 0 });
      expect(response.status, role).toBe(403);
      await arabic(response);
    }
    expect(await discountOf(id)).toBe(0);
  });

  it("applies for the admin within the remaining amount and refuses the rest in Arabic", async () => {
    const id = await invoice(100000, 70000);
    let response = await post(id, "admin", { amount: "1000", reason: "x", expectedDiscountMinor: 0 });
    expect(response.status).toBe(400); await arabic(response);
    response = await post(id, "admin", { amount: "abc", reason: "قرار الإدارة", expectedDiscountMinor: 0 });
    expect(response.status).toBe(400); await arabic(response);
    response = await post(id, "admin", { amount: "30001", reason: "قرار الإدارة", expectedDiscountMinor: 0 });
    expect(response.status).toBe(400); expect(await arabic(response)).toContain("المتبقي");
    response = await post(id, "admin", { amount: "10000", reason: "قرار الإدارة", expectedDiscountMinor: 0 });
    expect(response.status).toBe(200);
    expect(await discountOf(id)).toBe(10000);
    response = await post(id, "admin", { amount: "10000", reason: "قرار الإدارة", expectedDiscountMinor: 0 });
    expect(response.status).toBe(409); await arabic(response);
    expect(await discountOf(id)).toBe(10000);
  });
});

describe("(FIN-DISC) admin discount on the built patient account page", () => {
  it.each([1280, 390])("applies from the invoice row at %s and the reception does not see the action", async (width) => {
    const id = await invoice(50000, 10000);
    const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
      await page.getByTestId(`invoice-admin-discount-open-${id}`).click();
      const form = page.getByTestId(`invoice-admin-discount-${id}`);
      expect(await form.getByTestId("admin-discount-remaining").innerText()).toContain("40,000");
      await form.getByLabel("مبلغ الخصم الإداري").fill("15000");
      await form.getByLabel("سبب الخصم الإداري").fill("قرار الإدارة لمريض اجتماعي");
      expect(await form.getByTestId("admin-discount-net-after").innerText()).toContain("35,000");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${SHOTS}/invoice-admin-discount-form-${width}.png`, fullPage: true });
      const before = await headerBalance();
      await expect.poll(() => page.getByText(`مستحق: ${before.toLocaleString("en-US")}`).count()).toBeGreaterThan(0);
      await form.getByRole("button", { name: "اعتماد الخصم" }).click();
      await expect.poll(() => page.getByText(/سُجّل خصم إداري/).count()).toBe(1);
      expect(await discountOf(id)).toBe(15000);
      // The file header re-reads the balance: it never keeps showing the amount due from before the discount.
      expect(await headerBalance()).toBe(before - 15000);
      await expect.poll(() => page.getByText(`مستحق: ${(before - 15000).toLocaleString("en-US")}`).count()).toBeGreaterThan(0);
      expect(await page.getByText(`مستحق: ${before.toLocaleString("en-US")}`).count()).toBe(0);
      await page.screenshot({ path: `${SHOTS}/invoice-admin-discount-done-${width}.png`, fullPage: true });
    } finally { await context.close(); }

    const reception = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
    const [rname, ...rvalue] = h.sessions.reception.cookie.split("=");
    await reception.addCookies([{ name: rname, value: rvalue.join("="), url: baseUrl }]);
    const rpage = await reception.newPage();
    try {
      await rpage.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
      await rpage.getByText(`DISC-UI-${stamp}-${seq}`).first().waitFor();
      expect(await rpage.getByTestId(`invoice-admin-discount-open-${id}`).count()).toBe(0);
    } finally { await reception.close(); }
  });
});
