import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import type { CommissionDetailLine } from "../../lib/commission";

// Actual built app + isolated synthetic PG fixtures. No Production probes or writes.
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
const stamp = Date.now();
let sequence = 0;
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function fixture(tag: string, rawConfig: Record<string, unknown> | ((serviceName: string) => Record<string, unknown>) | null = null) {
  const id = `${stamp}-${++sequence}`;
  const name = `طبيب سياسة اصطناعي ${tag} ${id}`;
  const serviceName = `عمل قديم اصطناعي ${id}`;
  const storedConfig = typeof rawConfig === "function" ? rawConfig(serviceName) : rawConfig;
  const [{ id: partyId }] = (await db.query<{ id: number }>(`INSERT INTO parties (name, kind, commission_percent) VALUES ($1, 'doctor', 20) RETURNING id`, [name])).rows;
  const [{ id: userId }] = (await db.query<{ id: number }>(`INSERT INTO users (username, display_name, password_hash, role, party_id, commission_config)
    VALUES ($1, $2, 'unused-synthetic-hash', 'doctor', $3, $4) RETURNING id`, [`intent-${id}`, name, partyId, storedConfig === null ? null : JSON.stringify(storedConfig)])).rows;
  const [{ id: patientId }] = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`INTENT-${id}`, name])).rows;
  // Closed fixture avoids the one-open-shift index and the shared cash workflow.
  const [{ id: shiftId }] = (await db.query<{ id: number }>(`INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at) VALUES ('synthetic', 'closed', 'synthetic', NOW()) RETURNING id`)).rows;
  const [{ id: serviceId }] = (await db.query<{ id: number }>(`INSERT INTO services (name, category) VALUES ($1, 'rct') RETURNING id`, [serviceName])).rows;
  const fact = async (suffix: string, at: string) => {
    const [{ id: invoiceId }] = (await db.query<{ id: number }>(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
      VALUES ($1, $2, 10000, 0, 'YER', 'synthetic', $3::timestamptz) RETURNING id`, [`INTENT-INV-${id}-${suffix}`, patientId, at])).rows;
    await db.query(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id)
      VALUES ($1, $2, $3, 1, 10000, 10000, $4)`, [invoiceId, serviceId, serviceName, partyId]);
    await db.query(`INSERT INTO visits (patient_name, patient_id, doctor_id, status, invoice_id, arrived_at, signed_at, signed_by)
      VALUES ($1, $2, $3, 'done', $4, $5::timestamptz, $5::timestamptz, 'synthetic')`, [name, patientId, partyId, invoiceId, at]);
    await db.query(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
      VALUES ($1, $2, $3, $4, 'payment', 10000, 'YER', 1, 10000, 'YER', 'cash', 'synthetic', $5::timestamptz)`, [`INTENT-PAY-${id}-${suffix}`, patientId, invoiceId, shiftId, at]);
    return invoiceId;
  };
  const storage = async (): Promise<string | null> => (await db.query(`SELECT commission_config FROM users WHERE id = $1`, [userId])).rows[0].commission_config;
  const history = async () => (await db.query(`SELECT * FROM doctor_commission_history WHERE party_id = $1 ORDER BY id`, [partyId])).rows;
  const audits = async () => (await db.query(`SELECT * FROM audit_log WHERE action = 'doctor.commission.update' AND entity = 'party' AND entity_id = $1 ORDER BY id`, [String(partyId)])).rows;
  const facts = async () => ({
    invoices: (await db.query(`SELECT * FROM invoices WHERE patient_id = $1 ORDER BY id`, [patientId])).rows,
    items: (await db.query(`SELECT ii.* FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.patient_id = $1 ORDER BY ii.id`, [patientId])).rows,
    payments: (await db.query(`SELECT * FROM payments WHERE patient_id = $1 ORDER BY id`, [patientId])).rows,
    visits: (await db.query(`SELECT * FROM visits WHERE patient_id = $1 ORDER BY id`, [patientId])).rows,
  });
  const report = async () => {
    const response = await authedGet(`/api/finance/commissions?detail=1&from=1970-01-01&to=2099-12-31&doctorId=${partyId}`, h.sessions.admin);
    expect(response.status).toBe(200); return (await response.json()).lines as CommissionDetailLine[];
  };
  const snapshot = async () => ({ storage: await storage(), history: await history(), audits: await audits(), facts: await facts(), lines: await report(),
    ordinaryPercent: Number((await db.query(`SELECT commission_percent FROM parties WHERE id = $1`, [partyId])).rows[0].commission_percent) });
  return { name, userId, partyId, fact, storage, history, audits, facts, report, snapshot };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const saveLabel = "حفظ التغييرات والصلاحيات";
function omitted(body: Record<string, unknown>) {
  for (const key of ["commissionConfig", "commissionPercent", "clearCommissionConfig"]) expect(Object.hasOwn(body, key)).toBe(false);
}
async function ui(f: Fixture) {
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
  page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push({ url: request.url(), body: request.postDataJSON() }); });
  await page.goto(`${baseUrl}/settings/users`);
  const open = async (target = f) => {
    await page.getByPlaceholder("بحث بالاسم أو التخصص...").fill(target.name);
    await page.getByRole("button", { name: "تعديل الملف", exact: true }).click();
  };
  await open();
  return { context, page, writes, open };
}
async function finance(page: Page) {
  await page.getByRole("button", { name: "💰 النِسب وطريقة احتساب الأتعاب", exact: true }).click();
  await page.getByText("هذه مسودة إعداد متقدم", { exact: false }).waitFor();
  return page.getByText("النسبة المئوية العامة في المسودة", { exact: true }).locator("..").getByRole("spinbutton").first();
}
async function save(page: Page, userId: number, status = 200) {
  const response = page.waitForResponse(r => r.url() === `${baseUrl}/api/users/${userId}` && r.request().method() === "PATCH");
  await page.getByRole("button", { name: saveLabel, exact: true }).click(); expect((await response).status()).toBe(status);
  if (status === 200) await page.getByRole("button", { name: "إغلاق", exact: true }).waitFor({ state: "hidden" });
}
async function expectExplicit(f: Fixture, before: Awaited<ReturnType<Fixture["snapshot"]>>, percent: number) {
  const history = await f.history(); expect(before.history).toEqual([]); expect(history).toHaveLength(2);
  expect(history[0]).toMatchObject({ config: null, source: "baseline" }); expect(Number(history[0].percent)).toBe(20);
  expect(history[1]).toMatchObject({ source: "advanced", config: { defaultPercent: percent } }); expect(Number(history[1].percent)).toBe(20);
  expect(JSON.parse((await f.storage())!)).toMatchObject({ calculationMode: "percentage", defaultPercent: percent });
  const audits = await f.audits(); expect(audits).toHaveLength(before.audits.length + 1);
  expect(audits.at(-1)).toMatchObject({ actor: "secadmin", details: { "قبل_القيمة": { percent: 20, config: null }, "بعد_القيمة": { percent: 20, config: { defaultPercent: percent } } } });
  expect(await f.facts()).toEqual(before.facts); expect(await f.report()).toEqual(before.lines);
  expect(Number((await db.query(`SELECT commission_percent FROM parties WHERE id = $1`, [f.partyId])).rows[0].commission_percent)).toBe(20);
  return new Date(history[1].effective_from).getTime();
}

describe("actual Basic omission and explicit financial Save", () => {
  it.each([0, 12.345, 30])("Basic edits preserve rawNULL/ordinary20, then deliberate %s starts only at the server cutover", async percent => {
    const f = await fixture(`explicit-${percent}`);
    const beforeTime = new Date(Date.now() - 3_600_000).toISOString();
    const oldInvoice = await f.fact("old", beforeTime); const before = await f.snapshot();
    expect(before.storage).toBeNull(); expect(before.ordinaryPercent).toBe(20); expect(before.lines).toHaveLength(1);
    expect(before.lines[0]).toMatchObject({ invoiceId: oldInvoice, percent: 20, earnedMinor: 2000 });
    const projection = await authedGet("/api/users", h.sessions.admin); expect(projection.status).toBe(200);
    expect((await projection.json()).find((user: { id: number }) => user.id === f.userId).commissionConfig).toMatchObject({ defaultPercent: 30 });
    const control = await authedMutation(`/api/users/${f.userId}`, h.sessions.admin, "PATCH", JSON.stringify({ displayName: f.name }));
    expect(control.status).toBe(200); expect(await f.snapshot()).toEqual(before);
    const u = await ui(f);
    try {
      await u.page.getByText("الاسم الظاهر", { exact: true }).locator("..").locator("input").fill(`${f.name} اسم محدّث فقط`);
      await save(u.page, f.userId); expect(u.writes).toHaveLength(1); omitted(u.writes[0].body);
      expect(u.writes[0].url).toBe(`${baseUrl}/api/users/${f.userId}`); expect(await f.snapshot()).toEqual(before);
      const stillOrdinary = await f.fact("after-basic", new Date().toISOString());
      const beforeFinancial = await f.snapshot();
      expect(beforeFinancial.lines.find(line => line.invoiceId === stillOrdinary)).toMatchObject({ percent: 20, earnedMinor: 2000 });
      await u.open(); const input = await finance(u.page); expect(await input.getAttribute("step")).toBe("any");
      await input.fill(String(percent)); expect(await input.evaluate(element => (element as HTMLInputElement).checkValidity())).toBe(true);
      await save(u.page, f.userId); expect(u.writes).toHaveLength(2);
      expect(u.writes[1].body.commissionConfig).toMatchObject({ defaultPercent: percent });
      const cutover = await expectExplicit(f, beforeFinancial, percent);
      expect(new Date(beforeTime).getTime()).toBeLessThan(cutover);
      const at = new Date(cutover + 1000).toISOString(); expect(cutover).toBeLessThan(new Date(at).getTime());
      const fresh = await f.fact("after-financial", at); const lines = await f.report();
      for (const old of beforeFinancial.lines) expect(lines.find(line => line.invoiceId === old.invoiceId)).toEqual(old);
      expect(lines.find(line => line.invoiceId === fresh)).toMatchObject({ percent, earnedMinor: Math.round(10000 * percent / 100) });
      // Earlier nonzero facts keep an aggregate row. The isolated zero-only row-absence contract is prerequisite245's test.
    } finally { await u.context.close(); }
  }, 180_000);

  it("map-only legacy Basic Save preserves real old facts, exact JSON, history, audit and4150 earnings", async () => {
    const f = await fixture("legacy", serviceName => ({ calculationMode: "percentage", defaultPercent: 17, categoryRates: {}, serviceRates: { [serviceName]: 41.5 }, deductLabCost: false, deductMaterialCost: false, basis: "collected_cash" }));
    const oldInvoice = await f.fact("old", new Date(Date.now() - 3_600_000).toISOString()); const before = await f.snapshot();
    expect(before.lines).toHaveLength(1); expect(before.lines[0]).toMatchObject({ invoiceId: oldInvoice, percent: 41.5, earnedMinor: 4150 });
    expect(before.history).toEqual([]); expect(before.audits).toEqual([]);
    const u = await ui(f);
    try {
      const input = await finance(u.page); expect(await input.isDisabled()).toBe(true);
      await u.page.getByRole("note").filter({ hasText: "الإعدادات المالية للقراءة فقط" }).waitFor();
      await u.page.getByRole("button", { name: "👤 البيانات الأساسية", exact: true }).click();
      await u.page.getByText("الاسم الظاهر", { exact: true }).locator("..").locator("input").fill(`${f.name} تحديث أساسي`);
      await save(u.page, f.userId); expect(u.writes).toHaveLength(1); omitted(u.writes[0].body);
      expect(await f.snapshot()).toEqual(before);
    } finally { await u.context.close(); }
  }, 180_000);

  it("failed Save retains the same-session fractional draft; only the successful retry creates history/audit", async () => {
    const f = await fixture("retry"); await f.fact("old", new Date(Date.now() - 3_600_000).toISOString()); const before = await f.snapshot();
    const u = await ui(f); let failures = 0;
    await u.page.route(`**/api/users/${f.userId}`, async route => {
      if (route.request().method() === "PATCH" && failures++ === 0) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "تعذّر الحفظ التجريبي، أعد المحاولة" }) });
      } else await route.continue();
    });
    try {
      const input = await finance(u.page); await input.fill("12.345"); await save(u.page, f.userId, 503);
      await u.page.getByRole("alert").filter({ hasText: "تعذّر الحفظ التجريبي، أعد المحاولة" }).waitFor();
      expect(await input.inputValue()).toBe("12.345"); expect(u.writes).toHaveLength(1); expect(await f.snapshot()).toEqual(before);
      await save(u.page, f.userId); expect(u.writes).toHaveLength(2); expect(u.writes[1]).toEqual(u.writes[0]);
      await expectExplicit(f, before, 12.345);
    } finally { await u.context.close(); }
  }, 180_000);

  it("a delayed successful Save cannot close a newly opened same-account editor or leak intent through cancellation/role changes", async () => {
    const f = await fixture("lifetime"); const other = await fixture("other");
    await f.fact("old", new Date(Date.now() - 3_600_000).toISOString()); const before = await f.snapshot();
    const u = await ui(f);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void; const started = new Promise<void>(resolve => { requested = resolve; });
    let first = true;
    await u.page.route(`**/api/users/${f.userId}`, async route => {
      if (route.request().method() === "PATCH" && first) { first = false; requested(); await held; }
      await route.continue();
    });
    try {
      await (await finance(u.page)).fill("12.345");
      const response = u.page.waitForResponse(r => r.url() === `${baseUrl}/api/users/${f.userId}` && r.request().method() === "PATCH");
      await u.page.getByRole("button", { name: saveLabel, exact: true }).click(); await started;
      await u.page.getByRole("button", { name: "إغلاق", exact: true }).click(); await u.open(); release();
      expect((await response).status()).toBe(200);
      await u.page.getByRole("button", { name: saveLabel, exact: true }).waitFor();
      await expectExplicit(f, before, 12.345); const afterFinancial = await f.snapshot();
      await save(u.page, f.userId); expect(u.writes).toHaveLength(2); omitted(u.writes[1].body); expect(await f.snapshot()).toEqual(afterFinancial);
      await u.open(); await (await finance(u.page)).fill("88"); await u.page.getByRole("button", { name: "إغلاق", exact: true }).click();
      await u.open(other); const otherBefore = await other.snapshot();
      await (await finance(u.page)).fill("77"); await u.page.getByRole("button", { name: "👤 البيانات الأساسية", exact: true }).click();
      const role = u.page.getByText("الدور الوظيفي", { exact: true }).locator("..").locator("select");
      await role.selectOption("reception"); await role.selectOption("doctor");
      await save(u.page, other.userId); expect(u.writes).toHaveLength(3); omitted(u.writes[2].body); expect(await other.snapshot()).toEqual(otherBefore);
    } finally { release(); await u.context.close(); }
  }, 180_000);
});
