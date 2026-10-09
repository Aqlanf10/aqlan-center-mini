import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";
import { emitAcceptedEvidence, type EvidenceFile } from "./_synthetic-evidence-log";

/**
 * (INV-LINK REPORT, Dot review 5461818993 evidence gap) The daily clinic close rendered by the built app from records
 * written by the real HTTP writers on an isolated synthetic database — no mocked report payload:
 *  - a patient who arrives today; an invoice-first RCT invoice (tooth 36) with a real 50,000 receipt on it;
 *  - a pre-system agreement 300,000 / 120,000 → 180,000 opening, then a real 20,000 collection on that opening.
 * The report must show the invoice once with its plan item/case, and the agreement as history: the 120,000 paid before
 * the system is never today's collection, and the remaining is not a second debt.
 */
const ARTIFACTS = ".settings-ui-artifacts";
const stamp = Date.now();
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let invoiceId = 0;
let invoiceNumber = "";
let agreementId = 0;
// Dot review 5461818993/5461563181: this run's own screens and PDF are retained in the CI log (bounded, checksummed,
// with run/checkout identity), accepted per scenario only after all its assertions passed, emitted only when complete.
const EVIDENCE = new Map<string, EvidenceFile["mime"]>([
  ...[1280, 390].flatMap((width) => ["invoices", "legacy"].map((name) => [`daily-clinic-real-${name}-${width}.png`, "image/png"] as const)),
  ["daily-clinic-real-invoices-390-scrolled.png", "image/png"], ["daily-clinic-real-legacy-390-scrolled.png", "image/png"],
  ["daily-clinic-real-a4.pdf", "application/pdf"],
]);
const accepted: EvidenceFile[] = [];
const accept = async (names: string[]) => { for (const filename of names) {
  accepted.push({ filename, mime: EVIDENCE.get(filename)!, bytes: await readFile(`${ARTIFACTS}/${filename}`) });
} };
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Aden" }).format(new Date());

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const { rows: [{ party_id: doctorId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const service = async (name: string) => (await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 150000, TRUE, TRUE, 'rct') RETURNING id`,
    [`${name} ${stamp}`])).rows[0].id;
  const rct = await service("علاج عصب تقرير");
  const legacyRct = await service("علاج عصب سابق تقرير");
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'daily-real', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مراجع تقرير يومي اصطناعي', $2) RETURNING id`,
    [`DCR-${stamp}`, doctorId]));
  await db.query(`INSERT INTO visits (patient_name, patient_id, doctor_id) VALUES ('مراجع تقرير يومي اصطناعي', $1, $2)`, [patientId, doctorId]);

  const invoice = await authedMutation("/api/invoices", h.sessions.reception, "POST", JSON.stringify({
    patientId, currency: "YER", items: [{ serviceId: rct, doctorId, toothCode: 36, quantity: 1 }],
  }));
  expect(invoice.status).toBe(201);
  invoiceId = (await invoice.json() as { id: number }).id;
  invoiceNumber = (await db.query<{ n: string }>(`SELECT invoice_number AS n FROM invoices WHERE id = $1`, [invoiceId])).rows[0].n;
  const pay = (body: Record<string, unknown>) => authedMutation("/api/payments", h.sessions.reception, "POST", JSON.stringify({
    patientId, kind: "payment", currency: "YER", method: "cash", planId: null, note: null, ...body,
  }), { "Idempotency-Key": `daily-real-${stamp}-${String(body.amount)}` });
  expect((await pay({ amount: "50000", invoiceId, openingCurrency: null })).status).toBeLessThan(300);

  const legacy = await authedMutation(`/api/patients/${patientId}/legacy-treatments`, h.sessions.reception, "POST", JSON.stringify({
    serviceId: legacyRct, toothCode: 46, currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000",
    historicalAsOf: "2026-09-30", idempotencyKey: `legacy:daily-real-${stamp}`,
  }));
  expect(legacy.status).toBe(201);
  agreementId = (await legacy.json() as { agreement: { id: number } }).agreement.id;
  expect((await pay({ amount: "20000", invoiceId: null, openingCurrency: "YER" })).status).toBeLessThan(300);
}, 240_000);
afterAll(async () => {
  await browser?.close(); await db?.end();
  if (accepted.length > 0) await emitAcceptedEvidence({ scope: "daily-clinic-real-records", expected: EVIDENCE, files: accepted, aggregateCap: 4 * 1024 * 1024 });
});

async function openReport(width: number) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...parts] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: parts.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/reports/daily-clinic?date=${today}`, { waitUntil: "networkidle" });
  await page.getByTestId("daily-clinic-result").waitFor({ timeout: 60_000 });
  return { page, context, errors };
}

describe("(INV-LINK REPORT) daily close from real records", () => {
  it.each([390, 1280])("shows the real invoice once with its links and the agreement as history at %s", async (width) => {
    const { page, context, errors } = await openReport(width);
    try {
      const invoices = page.getByTestId("daily-clinic-invoices");
      const row = invoices.locator(`tr[data-invoice-id="${invoiceId}"]`);
      expect(await row.count()).toBe(1);
      const text = await row.innerText();
      expect(text).toContain(invoiceNumber);
      expect(text).toMatch(/بند #\d+/);
      expect(text).toMatch(/حالة #\d+/);
      expect(text).toContain("سن 36");
      expect(await row.getAttribute("data-invoice-linkage")).toBe("single_plan_item");

      const legacy = page.getByTestId("daily-clinic-legacy").locator(`tr[data-legacy-id="${agreementId}"]`);
      expect(await legacy.count()).toBe(1);
      expect(await legacy.locator("[data-minor]").evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-minor"))))
        .toEqual(["300000", "120000", "180000"]);

      // The 120,000 paid before the system is not a receipt: today's receipts for this patient are 50,000 and 20,000 only.
      const { rows: receipts } = await db.query<{ amount: number; invoice: number | null; opening: string | null }>(
        `SELECT amount_minor::int AS amount, invoice_id AS invoice, opening_currency AS opening FROM payments WHERE patient_id = $1 ORDER BY id`,
        [patientId]);
      expect(receipts).toEqual([{ amount: 50_000, invoice: invoiceId, opening: null }, { amount: 20_000, invoice: null, opening: "YER" }]);
      const receiptsText = await page.getByTestId("daily-clinic-result").innerText();
      expect(receiptsText).not.toMatch(/120,000[^\n]*سند/);

      expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await mkdir(ARTIFACTS, { recursive: true });
      // What the user sees: each section scrolled to the top of the viewport (below the sticky header).
      for (const [testId, name] of [["daily-clinic-invoices", "invoices"], ["daily-clinic-legacy", "legacy"]] as const) {
        await page.getByTestId(testId).evaluate((element) => { element.scrollIntoView({ block: "start" }); window.scrollBy(0, -90); });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await writeFile(`${ARTIFACTS}/daily-clinic-real-${name}-${width}.png`, await page.screenshot());
        if (width !== 390) continue;
        // On a phone the table scrolls inside its own container; capture it scrolled to the amount columns too.
        const scrolled = await page.getByTestId(testId).evaluate((element) => {
          let box: HTMLElement | null = element.parentElement; // the test id is on the <table>; its wrapper scrolls
          while (box && !(box.scrollWidth > box.clientWidth + 1)) box = box.parentElement;
          if (!box || box === document.documentElement || box === document.body) return false;
          box.scrollLeft = -box.scrollWidth; // RTL: the far (left) end holds the amount columns
          return true;
        });
        expect(scrolled).toBe(true);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await writeFile(`${ARTIFACTS}/daily-clinic-real-${name}-390-scrolled.png`, await page.screenshot());
      }
      expect(errors).toEqual([]);
      await accept(["invoices", "legacy"].flatMap((name) => [`daily-clinic-real-${name}-${width}.png`,
        ...(width === 390 ? [`daily-clinic-real-${name}-390-scrolled.png`] : [])]));
    } finally { await context.close(); }
  });

  it("prints the real invoice and pre-system sections on A4", async () => {
    const { page, context } = await openReport(1280);
    try {
      await page.emulateMedia({ media: "print" });
      await mkdir(ARTIFACTS, { recursive: true });
      const path = `${ARTIFACTS}/daily-clinic-real-a4.pdf`;
      await writeFile(path, await page.pdf({ preferCSSPageSize: true, printBackground: true }));
      expect(execFileSync("pdfinfo", [path], { encoding: "utf8" })).toMatch(/Page size:\s+(84\d\.\d+ x 59\d\.\d+|59\d\.\d+ x 84\d\.\d+)/);
      const text = execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" }).replace(/[‪-‮]/g, "");
      expect(text).toContain(invoiceNumber);
      expect(text).toContain("قبل النظام");
      for (const amount of ["300,000", "120,000", "180,000"]) expect(text).toContain(amount);
      await accept(["daily-clinic-real-a4.pdf"]);
    } finally { await context.close(); }
  });
});
