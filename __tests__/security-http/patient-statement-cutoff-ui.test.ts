import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { formatMoney } from "../../lib/money";
import type { ReportResult } from "../../lib/reports-types";
import { authedGet, baseUrl, harness } from "./_server";

// Built app, real isolated security harness DB, synthetic patient only. No API
// interception and no Production credentials/data. Global setup owns disposal.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let patientId = 0;
const stamp = Date.now();
const patientNumber = `ASOF-${stamp}`;
const date = (day: string) => `${day}T10:00:00+03:00`;
const query = () => new URLSearchParams({ report: "patient-statement", patientId: String(patientId),
  preset: "custom", from: "2026-09-01", to: "2026-09-30", currency: "SAR", doctorId: "999991",
  serviceId: "999991", specialty: "endo", method: "transfer", receivedBy: "unmatched-synthetic" });

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, created_at) VALUES ($1, 'مريض كشف تاريخي اصطناعي', $2) RETURNING id`, [patientNumber, date("2026-01-01")]);
  patientId = patient.id;
  await db.query(`INSERT INTO patient_opening_balances (patient_id, currency, amount_minor, as_of_date, created_by)
    VALUES ($1, 'YER', 100, '2026-01-01', 'synthetic-asof'), ($1, 'SAR', 1000, '2026-01-01', 'synthetic-asof'),
           ($1, 'USD', 300, '2026-10-01', 'synthetic-asof')`, [patientId]);
  const { rows: [shift] } = await db.query<{ id: number }>(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd, status)
    VALUES ('synthetic-asof', 0, 0, 0, 'closed') RETURNING id`);
  const invoiceIds: number[] = [];
  for (const [index, currency, amount, day] of [[0, "YER", 900, "2026-08-20"], [1, "SAR", 2000, "2026-09-30"], [2, "YER", 9000, "2026-10-01"]] as const) {
    const { rows: [invoice] } = await db.query<{ id: number }>(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
      VALUES ($1, $2, $3, 0, $4, 'synthetic-asof', $5) RETURNING id`, [`ASOF-I-${stamp}-${index}`, patientId, amount, currency, date(day)]);
    invoiceIds.push(invoice.id);
    await db.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
      VALUES ($1, $2, 1, $3, $3)`, [invoice.id, index === 2 ? "SYN-ASOF-FUTURE" : `SYN-ASOF-${currency}`, amount]);
  }
  for (const [index, currency, amount, kind, invoiceId, day] of [
    [0, "YER", 300, "payment", invoiceIds[0], "2026-08-21"],
    [1, "SAR", 400, "payment", invoiceIds[1], "2026-09-30"],
    [2, "SAR", 50, "refund", invoiceIds[1], "2026-09-30"],
  ] as const) {
    await db.query(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
      exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'YER', 'cash', 'synthetic-asof', $10)`,
    [`ASOF-R-${stamp}-${index}`, patientId, invoiceId, shift.id, kind, amount, currency,
      currency === "YER" ? 1 : 425, currency === "YER" ? amount : Math.round(amount * 425 / 100), date(day)]);
  }
  await db.query(`INSERT INTO visits (patient_id, patient_name, status, arrived_at)
    VALUES ($1, 'مريض كشف تاريخي اصطناعي', 'done', $2), ($1, 'مريض كشف تاريخي اصطناعي', 'done', $3)`,
  [patientId, date("2026-08-15"), date("2026-10-01")]);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

function direct(path: string, who: "admin" | "doctorA" | "accountant" = "admin") {
  return fetch(`${baseUrl}${path}`, { headers: { cookie: h.sessions[who].cookie }, redirect: "manual" });
}

describe("patient statement cutoff on the built app", () => {
  it("reads whole-patient history through the cutoff, then follows its official print link with identical balances", async () => {
    const response = await authedGet(`/api/reports?${query()}`, h.sessions.admin);
    expect(response.status).toBe(200);
    const { result } = await response.json() as { result: ReportResult };
    expect(result.rows).toHaveLength(7);
    expect(result.kpis.find((kpi) => kpi.key === "balance")?.minor).toBe(700);
    expect(result.kpis.find((kpi) => kpi.key === "balance-SAR")?.minor).toBe(2650);
    expect(result.kpis.find((kpi) => kpi.key === "lastVisit")?.text).toBe("15/08/2026");
    expect(JSON.stringify(result.rows)).not.toContain("SYN-ASOF-FUTURE");
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
    try {
      const [name, ...value] = h.sessions.admin.cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const page = await context.newPage();
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}/reports?${query()}`);
      await page.getByRole("heading", { name: "كشف حساب المريض", exact: true }).waitFor();
      const official = page.getByRole("link", { name: "نسخة الطباعة الرسمية", exact: true });
      const href = await official.getAttribute("href");
      expect(href).toBe(`/print/statement/${patientId}?from=2026-09-01&to=2026-09-30`);
      // The app shell also renders <main>; capture the ReportsPage container.
      const reportScreen = page.locator("main.mx-auto.max-w-6xl");
      expect(await reportScreen.count()).toBe(1);
      const screenFooter = reportScreen.locator("tfoot");
      expect(await screenFooter.innerText()).not.toContain(formatMoney(1800, "YER"));
      await mkdir(".settings-ui-artifacts", { recursive: true });
      await reportScreen.screenshot({ path: ".settings-ui-artifacts/patient-statement-cutoff-screen.png" });
      const printErrors: string[] = [];
      context.on("page", (opened) => opened.on("pageerror", (error) => printErrors.push(error.message)));
      const popupPromise = page.waitForEvent("popup"); await official.click(); const print = await popupPromise;
      await print.locator(".sheet-report").waitFor();
      const sheet = print.locator(".sheet-report");
      const text = await sheet.innerText();
      for (const expected of [patientNumber, "30/09/2026", "جميع العملات", formatMoney(700, "YER"), formatMoney(2650, "SAR"), `دفعة ${formatMoney(400, "SAR")}`]) expect(text).toContain(expected);
      expect(text).not.toContain("SYN-ASOF-FUTURE");
      expect(await sheet.locator("tfoot tr td").last().innerText()).toBe("");
      await print.emulateMedia({ media: "print" });
      expect(await sheet.locator("tfoot tr td").last().innerText()).toBe("");
      await sheet.screenshot({ path: ".settings-ui-artifacts/patient-statement-cutoff-print.png" });
      expect(errors).toEqual([]);
      expect(printErrors).toEqual([]);
    } finally { await context.close(); }
  });

  it("keeps legacy no-query behavior and fails closed for dates, query retargeting, and denied roles", async () => {
    const current = await direct(`/print/statement/${patientId}`);
    expect(current.status).toBe(200);
    expect(await current.text()).toContain(`ASOF-I-${stamp}-2`);
    for (const suffix of ["to=2026-02-30", "to=bad", "from=2026-09-01", "to=2026-09-30&to=2026-10-01", `to=2026-09-30&patientId=${patientId + 1}`]) {
      expect((await direct(`/print/statement/${patientId}?${suffix}`)).status).toBe(404);
    }
    expect((await direct(`/print/statement/${patientId}?to=2026-09-30`, "doctorA")).status).toBe(404);
    expect((await direct(`/print/statement/${patientId}?to=2026-09-30`, "accountant")).status).toBe(200);
  });
});
