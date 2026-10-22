import { mkdirSync } from "node:fs";
import { Client } from "pg";
import { chromium, type Browser, type Locator } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

// UI classification evidence, not proof of server-side refusal/commit behavior.
// Only synthetic fixtures in the existing isolated HTTP database. Correction
// POSTs are intercepted before reaching the server; no Production connection.
const evidence = "artifacts/invoice-correction-explanation";
const conflict = "توجد تسويات أخرى على الحساب؛ راجع تخصيص السندات قبل جدولة تحصيل إضافي.";
const explanation = "رُفض هذا الطلب قبل حفظ التصحيح:";
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
let serviceId: number, alternateId: number, serial = 0;

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const services = await db.query<{ id: number }>(`INSERT INTO services
    (name, category, price_minor, price_configured, is_active)
    VALUES ('كشف اصطناعي أصلي', 'consultation', 80000, TRUE, TRUE),
           ('كشف اصطناعي بديل', 'consultation', 80000, TRUE, TRUE) RETURNING id`);
  [serviceId, alternateId] = services.rows.map(row => row.id);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  mkdirSync(evidence, { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function fixture(width: number) {
  const stamp = `EXPLANATION-${Date.now()}-${++serial}`;
  const patientId = (await db.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name) VALUES($1,'مريض تحقق اصطناعي') RETURNING id", [stamp])).rows[0].id;
  const invoiceId = (await db.query<{ id: number }>(`INSERT INTO invoices
    (invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by)
    VALUES($1,$2,80000,0,'YER','secadmin') RETURNING id`, [stamp, patientId])).rows[0].id;
  await db.query(`INSERT INTO invoice_items(invoice_id,service_id,description,quantity,unit_price_minor,total_minor)
    VALUES($1,$2,'كشف اصطناعي أصلي',1,80000,80000)`, [invoiceId, serviceId]);
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const unexpectedWrites: string[] = [];
  // Exact route handlers registered later override this deny-by-default guard.
  await page.route("**/api/**", async route => {
    if (["GET", "HEAD", "OPTIONS"].includes(route.request().method())) return route.continue();
    unexpectedWrites.push(new URL(route.request().url()).pathname);
    return route.abort("blockedbyclient");
  });
  const open = async () => {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "تصحيح الفاتورة", exact: true }).click();
    await page.getByLabel("سعر التصحيح 1", { exact: true }).waitFor();
  };
  const snapshot = async () => (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id=$1) AS invoices,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM invoice_items i WHERE invoice_id=$2) AS items,
    (SELECT count(*)::int FROM invoice_corrections WHERE patient_id=$1) AS corrections,
    (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments`, [patientId, invoiceId])).rows;
  return { context, page, patientId, invoiceId, open, snapshot, unexpectedWrites };
}

async function capture(panel: Locator, name: string) {
  await panel.scrollIntoViewIfNeeded();
  await expect.poll(() => panel.evaluate(element => {
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1
      && document.documentElement.scrollWidth <= innerWidth + 1;
  })).toBe(true);
  await panel.screenshot({ path: `${evidence}/${name}.png` });
}

describe("Arabic correction explanations, exact refusal classification, and historical labels", () => {
  it.each([390, 1280])("warns only for price edits retaining the service at %i px", async width => {
    const f = await fixture(width);
    try {
      const before = await f.snapshot();
      await f.open();
      const editor = f.page.getByTestId("invoice-correction-editor");
      const warning = editor.getByTestId("invoice-unchanged-service-warning");
      expect(await warning.count()).toBe(0);
      await editor.getByLabel("سبب التصحيح", { exact: true }).fill("تحويل إلى زركون");
      expect(await warning.count()).toBe(0); // A reason alone changes no identity.
      await editor.getByLabel("سعر التصحيح 1", { exact: true }).fill("50000");
      await expect.poll(() => warning.innerText()).toContain("الخدمة ستبقى «كشف اصطناعي أصلي»");
      expect(await warning.innerText()).toContain("تغيير السعر أو كتابة سبب التصحيح لا يغيّر نوع الخدمة");
      await capture(warning, `price-warning-${width}`);
      await editor.getByText("تصحيح الخدمة والطبيب والموضع", { exact: true }).click();
      await editor.getByLabel("خدمة التصحيح 1", { exact: true }).selectOption(String(alternateId));
      await expect.poll(() => warning.count()).toBe(0);
      await editor.getByLabel("خدمة التصحيح 1", { exact: true }).selectOption(String(serviceId));
      await warning.waitFor();
      await editor.getByLabel("سعر التصحيح 1", { exact: true }).fill("80000");
      await expect.poll(() => warning.count()).toBe(0);
      await editor.getByLabel("سعر التصحيح 1", { exact: true }).fill("50000");
      await warning.waitFor();
      await editor.getByLabel("إبقاء البند", { exact: true }).uncheck();
      await expect.poll(() => warning.count()).toBe(0);
      await editor.getByRole("button", { name: "إغلاق التصحيح", exact: true }).click();
      await expect.poll(() => editor.count()).toBe(0);
      expect(await f.snapshot()).toEqual(before);
      expect(f.unexpectedWrites).toEqual([]);
    } finally { await f.context.close(); }
  });

  const responses = [
    { name: "exact-409", status: 409, code: "conflict", message: conflict, refused: true, special: true },
    { name: "other-message", status: 409, code: "conflict", message: "تعارض اصطناعي مختلف", refused: true, special: false },
    { name: "near-message", status: 409, code: "conflict", message: `${conflict} `, refused: true, special: false },
    { name: "other-code", status: 409, code: "stale", message: conflict, refused: true, special: false },
    { name: "other-status", status: 400, code: "conflict", message: conflict, refused: true, special: false },
    { name: "unknown-code", status: 409, code: "unknown", message: conflict, refused: false, special: false },
    { name: "server-error", status: 500, code: "conflict", message: conflict, refused: false, special: false },
    { name: "malformed", status: 409, code: "conflict", message: conflict, refused: false, special: false },
    { name: "redirected-409", status: 409, code: "conflict", message: conflict, refused: false, special: false },
    { name: "lost-response", status: 409, code: "conflict", message: conflict, refused: false, special: false },
  ];
  it.each(responses)("classifies $name without inventing a save or discarding retry intent", async scenario => {
    const f = await fixture(390), bodies: string[] = [];
    try {
      const before = await f.snapshot();
      await f.open();
      const endpoint = `**/api/invoices/${f.invoiceId}/correct`;
      // Playwright routes only the first URL of a redirect chain. Inject only
      // redirected metadata for this classifier case; do not claim transport
      // redirect coverage. The status/body still arrive through browser fetch.
      if (scenario.name === "redirected-409") {
        await f.page.addInitScript(({ invoiceId }) => {
          const nativeFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const response = await nativeFetch(...args);
            if (String(args[0]) === `/api/invoices/${invoiceId}/correct` && args[1]?.method === "POST") {
              Object.defineProperty(response, "redirected", { value: true });
            }
            return response;
          };
        }, { invoiceId: f.invoiceId });
        // Install the same wrapper in the current document and on reload.
        await f.page.reload({ waitUntil: "domcontentloaded" });
        await f.page.getByRole("button", { name: "تصحيح الفاتورة", exact: true }).click();
        await f.page.getByLabel("سعر التصحيح 1", { exact: true }).waitFor();
      }
      await f.page.route(endpoint, async route => {
        if (route.request().method() !== "POST") return route.continue();
        bodies.push(route.request().postData()!);
        if (scenario.name === "lost-response") return route.abort("failed");
        return route.fulfill({ status: scenario.status, contentType: "application/json",
          body: scenario.name === "malformed" ? "{" : JSON.stringify({ code: scenario.code, message: scenario.message }) });
      });
      const editor = f.page.getByTestId("invoice-correction-editor");
      await editor.getByLabel("سعر التصحيح 1", { exact: true }).fill("50000");
      await editor.getByLabel("سبب التصحيح", { exact: true }).fill("تصحيح السعر الاصطناعي");
      await editor.getByRole("button", { name: "تأكيد تصحيح الفاتورة", exact: true }).click();
      const recovery = f.page.getByTestId("invoice-revision-recovery");
      const review = recovery.getByRole("button", { name: "مراجعة التصحيح بعد الرفض", exact: true });
      const retry = recovery.getByRole("button", { name: "إعادة نفس طلب التصحيح", exact: true });
      await expect.poll(() => retry.isEnabled()).toBe(true);
      expect(await review.count()).toBe(scenario.refused ? 1 : 0);
      expect((await recovery.innerText()).includes(explanation)).toBe(scenario.special);
      if (scenario.special) {
        expect(await recovery.innerText()).toContain("هذا الرفض يخص هذا الطلب ولا يحسم نتيجة أي طلب سابق");
        expect(await recovery.innerText()).toContain("لا تُنقل الإيصالات القديمة تلقائيًا");
        await capture(recovery, "exact-refusal-390");
      } else if (scenario.refused) expect(await recovery.innerText()).toContain(scenario.message.trim());
      else expect(await recovery.innerText()).toMatch(/لم يكتمل تأكيد النتيجة|انقطع الرد/);
      expect(await editor.getByLabel("سعر التصحيح 1", { exact: true }).isDisabled()).toBe(true);
      expect(await editor.getByRole("button", { name: "إغلاق التصحيح", exact: true }).isDisabled()).toBe(true);
      expect(await f.page.getByText(/حُفظ التصحيح في/).count()).toBe(0);
      if (!scenario.refused) {
        if (scenario.name === "redirected-409") await capture(recovery, "uncertain-redirect-390");
        await f.page.reload({ waitUntil: "domcontentloaded" });
        await retry.click();
        await expect.poll(() => retry.isEnabled()).toBe(true);
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toBe(bodies[0]);
        expect(JSON.parse(bodies[1]).idempotencyKey).toBeTruthy();
        expect(await review.count()).toBe(0);
      } else {
        await review.click();
        await editor.getByLabel("سعر التصحيح 1", { exact: true }).waitFor();
        await expect.poll(() => recovery.count()).toBe(0);
        expect(await editor.getByLabel("سبب التصحيح", { exact: true }).inputValue()).toBe("");
        expect(bodies).toHaveLength(1);
      }
      expect(await f.snapshot()).toEqual(before);
      expect(f.unexpectedWrites).toEqual([]);
    } finally { await f.context.close(); }
  });

  it.each([390, 1280])("labels manual/imported history as historical, not extra debt at %i px", async width => {
    const f = await fixture(width);
    try {
      const before = await f.snapshot();
      await f.page.route(`**/api/patients/${f.patientId}/legacy`, route => route.fulfill({
        status: 200, contentType: "application/json", body: JSON.stringify({ treatments: [
          { id: 1, legacyNumber: 101, sourceKind: "legacy_import", historicalAsOf: null, treatedOn: "2025-01-01", doctorName: null,
            service: "معالجة مستوردة اصطناعية", currency: "YER", priceMinor: 80000, rate: null, paidMinor: 30000, remainingMinor: 50000, payments: [] },
          { id: 2, legacyNumber: null, sourceKind: "manual_history", historicalAsOf: "2026-01-01", treatedOn: "2025-02-01", doctorName: null,
            service: "معالجة يدوية اصطناعية", currency: "SAR", priceMinor: 100000, rate: 140, paidMinor: 20000, remainingMinor: 80000, payments: [] },
        ], orphanPayments: [] }),
      }));
      await f.page.goto(`${baseUrl}/patients/${f.patientId}?tab=account`, { waitUntil: "domcontentloaded" });
      const archive = f.page.getByRole("region", { name: "سجل النظام القديم", exact: true });
      await archive.getByRole("button", { name: /سجل النظام القديم/ }).click();
      for (const label of ["السعر التاريخي", "المدفوع تاريخيًا", "المتبقي تاريخيًا"]) {
        await expect.poll(() => archive.locator("li").getByText(new RegExp(label)).count()).toBe(2);
      }
      expect(await archive.innerText()).toContain("المتبقي تاريخيًا ليس دينًا إضافيًا على الرصيد الحالي");
      expect(await archive.innerText()).toContain("تصحيح السجل التاريخي وحده لا يصحح الرصيد الافتتاحي تلقائيًا");
      expect(await archive.innerText()).toContain("لا يحدد هذا العرض حصة كل معالجة من الرصيد الحالي");
      expect(await archive.innerText()).toContain("البيانات التاريخية حتى 2026-01-01");
      await capture(archive, `historical-labels-${width}`);
      await archive.getByRole("button", { name: /سجل النظام القديم/ }).click();
      expect(await archive.getByText("السعر التاريخي", { exact: false }).count()).toBe(0);
      expect(await f.snapshot()).toEqual(before);
      expect(f.unexpectedWrites).toEqual([]);
    } finally { await f.context.close(); }
  });
});
