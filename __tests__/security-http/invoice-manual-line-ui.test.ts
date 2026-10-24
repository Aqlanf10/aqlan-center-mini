import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

/**
 * «بند يدوي حر» on the real built app and isolated harness DB (synthetic data only). The selector must keep
 * the manual choice, keep the typed description and price across re-selection and re-render, and never carry
 * a catalogue service's name or price into the manual line. The manual line then goes through the real
 * preview, a save whose first transport attempt fails before reaching the server, and the same-request retry;
 * exactly one invoice is written, its line without a service id.
 */
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorPartyId = 0;
let consultation = 0;
const stamp = Date.now();
let serial = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ({ rows: [{ party_id: doctorPartyId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  ({ rows: [{ id: consultation }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 7000, TRUE, TRUE, 'consultation') RETURNING id`,
    [`كشف اصطناعي للبند اليدوي ${stamp}`]));
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function openInvoice(width: number) {
  const { rows: [{ id }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`IML-${stamp}-${++serial}`, "مريض بند يدوي اصطناعي", doctorPartyId]);
  const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/patients/${id}?tab=account`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("treatment-entry-open").click();
  await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
  return { context, page, patientId: id };
}
const row = (page: Page) => page.getByTestId("invoice-row-0");
const service = (page: Page) => row(page).getByLabel("الخدمة", { exact: true });
const description = (page: Page) => row(page).getByLabel("وصف البند", { exact: true });
const price = (page: Page) => row(page).getByLabel("السعر", { exact: true });
const save = (page: Page) => page.getByRole("button", { name: "احفظ الفاتورة", exact: true });

describe.each([390, 1280])("free manual invoice line at %ipx", (width) => {
  it("keeps the manual choice and typed values, never leaks a catalogue service, and saves once through preview and retry", async () => {
    const { page, context, patientId } = await openInvoice(width);
    try {
      await service(page).selectOption("manual");
      expect(await service(page).inputValue()).toBe("manual");
      await description(page).fill("وصف مؤقت اصطناعي");
      await price(page).fill("999");
      // Catalogue and back: the catalogue name and price never enter the manual line.
      await service(page).selectOption(String(consultation));
      expect(await description(page).count()).toBe(0);
      expect(await price(page).inputValue()).not.toBe("");
      await service(page).selectOption("manual");
      expect(await service(page).inputValue()).toBe("manual");
      expect(await description(page).inputValue()).toBe("");
      expect(await price(page).inputValue()).toBe("");
      // Catalogue → placeholder → manual must also discard catalogue-origin text.
      await service(page).selectOption(String(consultation));
      await service(page).selectOption("");
      await service(page).selectOption("manual");
      expect(await service(page).inputValue()).toBe("manual");
      expect(await description(page).inputValue()).toBe("");
      expect(await price(page).inputValue()).toBe("");
      // Text typed in the placeholder state is genuinely manual and must survive that transition.
      await service(page).selectOption(String(consultation));
      await service(page).selectOption("");
      const text = `بند يدوي اصطناعي ${stamp}-${width}`;
      await description(page).fill(text);
      await price(page).fill("12345");
      await service(page).selectOption("manual");
      // Re-selecting manual (and the re-render it causes) keeps what the user typed.
      await service(page).selectOption("manual");
      expect(await service(page).inputValue()).toBe("manual");
      expect(await description(page).inputValue()).toBe(text);
      expect(await price(page).inputValue()).toBe("12345");

      // A real currency switch preserves manual identity/text, but never reinterprets its amount.
      const currency = page.getByLabel("عملة الفاتورة", { exact: true });
      expect(await currency.inputValue()).toBe("YER");
      await currency.selectOption("SAR");
      expect(await currency.inputValue()).toBe("SAR");
      expect(await service(page).inputValue()).toBe("manual");
      expect(await description(page).inputValue()).toBe(text);
      expect(await price(page).inputValue()).toBe("");
      await price(page).fill("50");
      await currency.selectOption("YER");
      expect(await currency.inputValue()).toBe("YER");
      expect(await description(page).inputValue()).toBe(text);
      expect(await price(page).inputValue()).toBe("");
      await price(page).fill("12345");

      // Real preview gate, then a save whose first transport attempt never reaches the server.
      await expect.poll(() => save(page).isEnabled(), { timeout: 30_000 }).toBe(true);
      const sent: { items: Record<string, unknown>[] }[] = [];
      let aborted = false;
      await page.route("**/api/invoices", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        sent.push(route.request().postDataJSON());
        if (!aborted) { aborted = true; return route.abort("failed"); }
        return route.continue();
      });
      await save(page).click();
      const retry = page.getByRole("button", { name: "إعادة نفس طلب الفاتورة", exact: true });
      await retry.waitFor({ timeout: 30_000 });
      expect(await db.query("SELECT 1 FROM invoices WHERE patient_id = $1", [patientId]).then((r) => r.rowCount)).toBe(0);
      await retry.click();
      await expect.poll(async () => (await db.query("SELECT count(*)::int AS n FROM invoices WHERE patient_id = $1", [patientId])).rows[0].n,
        { timeout: 30_000 }).toBe(1);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
      expect(sent[0].items).toHaveLength(1);
      expect(sent[0].items[0].serviceId).toBeUndefined();
      expect(sent[0].items[0].description).toBe(text);
      const { rows: items } = await db.query(
        `SELECT ii.service_id, ii.description, ii.quantity, ii.unit_price_minor::int AS unit_price_minor FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.patient_id = $1`, [patientId]);
      expect(items).toEqual([{ service_id: null, description: text, quantity: 1, unit_price_minor: 12345 }]);
    } catch (error) {
      await page.screenshot({ path: `.settings-ui-artifacts/invoice-manual-line-${width}.png`, fullPage: true }).catch(() => undefined);
      throw error;
    } finally { await context.close(); }
  }, 180_000);
});
