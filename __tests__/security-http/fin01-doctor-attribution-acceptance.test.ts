import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";
import { insertPlanV2InTx, type DbClient } from "../../lib/db";
import type { LinkageSpecialty, SiteScope } from "../../lib/invoice-clinical-linkage";

/** FIN-01 composition gate: supported RTL form controls only, synthetic disposable data.
 * No fabricated preview, no forced save of a missing-physician invoice, and no live service.
 * The first group can be selected independently on Stage + prior UI; the second needs the server donor.
 */
type Example = { category: string; specialty: LinkageSpecialty; teeth?: number[]; scope?: SiteScope; surface?: string };
const clinical: readonly Example[] = [
  { category: "ortho", specialty: "orthodontics", scope: "both" },
  { category: "rct", specialty: "endodontics", teeth: [36] },
  { category: "post", specialty: "prosthodontics", teeth: [14] },
  { category: "crown", specialty: "prosthodontics", teeth: [26] },
  { category: "bridge", specialty: "prosthodontics", teeth: [14, 15, 16] },
  { category: "implant", specialty: "implantology", teeth: [36] },
  { category: "cleaning", specialty: "periodontics", scope: "full_mouth" },
  { category: "extraction", specialty: "surgery", teeth: [46] },
  { category: "surgery", specialty: "surgery", teeth: [38] },
  { category: "veneer", specialty: "cosmetic", teeth: [11] },
  { category: "whitening", specialty: "cosmetic" },
  { category: "filling", specialty: "restorative", teeth: [26], surface: "O" },
  { category: "sealant", specialty: "restorative", teeth: [16] },
];
const price = 10_000;
const stamp = Date.now();
let ordinal = 0, primaryId = 0, providerId = 0;
const services = new Map<string, { id: number; name: string }>();
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
const contexts = new Set<BrowserContext>();
const local = (url: string) => ["127.0.0.1", "localhost"].includes(new URL(url).hostname);
const saveButton = (page: Page) => page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
const provider = (page: Page) => page.getByTestId("invoice-provider-0");
const service = (page: Page, row = 0) => page.getByTestId(`invoice-row-${row}`).getByLabel("الخدمة", { exact: true });

beforeAll(async () => {
  expect(local(baseUrl)).toBe(true);
  h = await harness();
  expect(local(h.seeded.dbUrl)).toBe(true);
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const staff = await db.query<{ username: string; party_id: number }>(
    "SELECT username, party_id FROM users WHERE username IN ('secdoctora', 'secdoctorb')",
  );
  primaryId = staff.rows.find((row) => row.username === "secdoctora")!.party_id;
  providerId = staff.rows.find((row) => row.username === "secdoctorb")!.party_id;
  expect(primaryId).not.toEqual(providerId);
  for (const category of [...clinical.map((example) => example.category), "consultation", "xray"]) {
    const name = `Synthetic FIN01 ${category} ${stamp}`;
    const { rows: [created] } = await db.query<{ id: number }>(
      "INSERT INTO services(name, category, price_minor, is_active, price_configured) VALUES ($1,$2,$3,true,true) RETURNING id",
      [name, category, price],
    );
    services.set(category, { id: created.id, name });
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => {
  await Promise.all([...contexts].map((context) => context.close()));
  await browser?.close(); await db?.end();
});

async function newPatient(tag: string) {
  return (await db.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id",
    [`FIN01-${stamp}-${++ordinal}`, `Synthetic physician workflow ${tag}`, primaryId],
  )).rows[0].id;
}
async function openAccount(patientId: number, width = 1280) {
  const context = await browser.newContext({ locale: "ar-YE", viewport: { width, height: 1000 } });
  contexts.add(context);
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
  return { context, page };
}
async function enterInvoice(page: Page) {
  await page.getByTestId("treatment-entry-open").click();
  await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
  await page.getByTestId("invoice-workspace").waitFor();
}
async function close(context: BrowserContext) { await context.close(); contexts.delete(context); }
async function selectCatalog(page: Page, category: string, index = 0) {
  await service(page, index).selectOption(String(services.get(category)!.id));
}
async function chooseClinical(page: Page, example: Example) {
  await selectCatalog(page, example.category);
  if (example.scope) {
    await page.getByTestId("invoice-scope-0").selectOption(example.scope);
    expect(await page.getByTestId("invoice-scope-0").inputValue()).toBe(example.scope);
    if (example.category === "ortho") expect(await page.getByTestId("invoice-tooth-button-0").count()).toBe(0);
  } else if (example.teeth) {
    await page.getByTestId("invoice-tooth-button-0").click();
    const dialog = page.getByTestId("tooth-dialog");
    for (const tooth of example.teeth) await dialog.getByTestId(`odontogram-tooth-${tooth}`).click();
    if (example.surface) await dialog.getByTestId(`surface-${example.surface}`).click();
    await dialog.getByTestId("tooth-dialog-confirm").click();
    await dialog.waitFor({ state: "detached" });
  }
  expect(await provider(page).inputValue()).toBe("");
}

type InvoicePayload = {
  id: number; totalMinor: number; discountMinor: number; baseCurrency: string;
  clinical: { links: { kind: string; specialty: string | null; planItemId: number | null; caseId: number | null }[] };
};
function isWrite(response: Response, path: string) {
  return new URL(response.url()).pathname === path && response.request().method() === "POST";
}
async function save(page: Page) {
  await expect.poll(() => saveButton(page).isEnabled(), { timeout: 20_000 }).toBe(true);
  const pending = page.waitForResponse((response) => isWrite(response, "/api/invoices"));
  await saveButton(page).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  const invoice = await response.json() as InvoicePayload;
  expect(invoice.baseCurrency).toBe("YER");
  expect(invoice.discountMinor).toBe(0);
  return { invoice, request: response.request().postDataJSON() as {
    items: { doctorId?: number | null; planItemId?: number | null; scope?: string }[];
  } };
}
async function counts(patientId: number) {
  const { rows } = await db.query(`SELECT
    (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,
    (SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) AS plans,
    (SELECT count(*)::int FROM plan_items pi JOIN treatment_plans t ON t.id=pi.plan_id WHERE t.patient_id=$1) AS items,
    (SELECT count(*)::int FROM clinical_cases WHERE patient_id=$1) AS cases,
    (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments`, [patientId]);
  return rows[0];
}
async function existingItem(patientId: number) {
  const filling = services.get("filling")!;
  const client: DbClient = {
    query: async <T>(sql: string, values?: unknown[]) => {
      const result = await db.query(sql, values);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
    release: () => {},
  };
  await db.query("BEGIN");
  try {
    const result = await insertPlanV2InTx(client, {
      patientId, title: "Synthetic exact matching physician plan", baseCurrency: "YER", billingMode: "per_procedure",
      primaryDoctorId: primaryId, specialty: null, startDate: "2026-10-01", note: null, createdBy: "fin01-plan-fixture",
      installments: [], items: [{ serviceId: filling.id, serviceName: filling.name, category: "filling",
        toothCode: 26, surfaces: "O", quantity: 1, unitPriceMinor: price, billingRule: "on_completion", sessionCount: 1, note: null }],
    });
    if (!result.ok) throw new Error(result.message);
    // Seed the exact existing item's verified physician, distinct from patient/plan primary.
    await db.query("UPDATE plan_items SET doctor_id=$1 WHERE id=$2", [providerId, result.itemIds[0]]);
    await db.query("COMMIT");
    return { planId: result.planId, itemId: result.itemIds[0] };
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}

describe("FIN-01 ordinary success", () => {
  it.each(clinical)("$category uses the selected doctor through real preview and invoice write", async (example) => {
    const patientId = await newPatient(example.category);
    const { page, context } = await openAccount(patientId);
    try {
      await enterInvoice(page);
      await chooseClinical(page, example);
      await provider(page).selectOption(String(providerId));
      const { invoice, request } = await save(page);
      const size = example.teeth?.length ?? 1;
      expect(request.items.map((line) => line.doctorId)).toEqual(Array(size).fill(providerId));
      expect(invoice.totalMinor).toBe(size * price);
      expect(invoice.clinical.links).toHaveLength(size);
      for (const link of invoice.clinical.links) expect(link).toMatchObject({
        kind: "clinical", specialty: example.specialty, planItemId: expect.any(Number),
      });
      const persisted = (await db.query(`SELECT it.doctor_id AS invoice_doctor, pi.doctor_id AS plan_doctor, pi.billing_status, pi.tooth_code
        FROM invoice_items it JOIN plan_items pi ON pi.id=it.plan_item_id WHERE it.invoice_id=$1 ORDER BY it.id`, [invoice.id])).rows;
      expect(persisted).toEqual((example.teeth ?? [null]).map((tooth_code) => ({
        invoice_doctor: providerId, plan_doctor: providerId, billing_status: "billed", tooth_code,
      })));
      if (example.category === "ortho") {
        expect(request.items[0].scope).toBe("both");
        expect((await db.query("SELECT site FROM clinical_cases WHERE patient_id=$1", [patientId])).rows).toEqual([{ site: "الفكّان" }]);
      }
      expect(await counts(patientId)).toMatchObject({ invoices: 1, plans: 1, items: size, payments: 0 });
    } finally { await close(context); }
  });

  it("adopts an exact pre-existing plan item with its own doctor and the selector still empty", async () => {
    const patientId = await newPatient("matching plan doctor");
    const existing = await existingItem(patientId);
    const { context, page } = await openAccount(patientId, 390);
    try {
      await enterInvoice(page);
      await chooseClinical(page, clinical.find((entry) => entry.category === "filling")!);
      const proof = page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="ready"]');
      await proof.waitFor({ state: "attached" });
      if (!await proof.isVisible()) await proof.locator("..").locator("summary").click();
      await proof.waitFor();
      expect(await provider(page).inputValue()).toBe("");
      expect(await page.getByTestId("invoice-provider-review-0").count()).toBe(0);
      await page.getByTestId("invoice-provider-from-plan-0").waitFor();
      const { invoice, request } = await save(page);
      expect(request.items[0]).not.toHaveProperty("doctorId");
      expect(invoice.clinical.links[0].planItemId).toBe(existing.itemId);
      expect((await db.query(`SELECT pi.id, pi.plan_id, pi.doctor_id AS plan_doctor, pi.billing_status, it.doctor_id AS invoice_doctor
        FROM invoice_items it JOIN plan_items pi ON pi.id=it.plan_item_id WHERE it.invoice_id=$1`, [invoice.id])).rows)
        .toEqual([{ id: existing.itemId, plan_id: existing.planId, plan_doctor: providerId, invoice_doctor: providerId, billing_status: "billed" }]);
      expect(await counts(patientId)).toEqual({ invoices: 1, plans: 1, items: 1, cases: 0, payments: 0 });
    } finally { await close(context); }
  });

  it("accepts cash-only consultation, imaging and a manual line without providers, then collects once", async () => {
    const patientId = await newPatient("cash-only");
    const { context, page } = await openAccount(patientId);
    let id = 0;
    try {
      await enterInvoice(page);
      const add = () => page.getByRole("button", { name: "+ بند آخر", exact: true }).click();
      await selectCatalog(page, "consultation");
      await add(); await selectCatalog(page, "xray", 1);
      await add(); await service(page, 2).selectOption("manual");
      const manual = page.getByTestId("invoice-row-2");
      await manual.getByLabel("وصف البند", { exact: true }).fill("Synthetic administrative cash line");
      await manual.getByLabel("السعر", { exact: true }).fill("500");
      expect(await page.locator('[data-testid^="invoice-provider-"]').count()).toBe(0);
      const { invoice, request } = await save(page);
      id = invoice.id;
      expect(invoice.totalMinor).toBe(20_500);
      expect(request.items.every((line) => line.doctorId == null)).toBe(true);
      expect(invoice.clinical.links.map((line) => [line.kind, line.planItemId, line.caseId]))
        .toEqual(Array.from({ length: 3 }, () => ["financial", null, null]));
      expect(await counts(patientId)).toEqual({ invoices: 1, plans: 0, items: 0, cases: 0, payments: 0 });
    } finally { await close(context); }

    await db.query(`INSERT INTO cashier_shifts(opened_by, opening_yer, opening_sar, opening_usd)
      SELECT 'fin01-cash-witness',0,0,0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status='open')`);
    const payment = await openAccount(patientId);
    try {
      await payment.page.getByRole("button", { name: "قبض دفعة", exact: true }).click();
      const dialog = payment.page.getByRole("dialog", { name: "تحصيل دفعة", exact: true });
      await dialog.getByLabel("فاتورة الهدف", { exact: true }).selectOption(String(id));
      await dialog.getByLabel("المبلغ", { exact: true }).fill("20500");
      const pending = payment.page.waitForResponse((response) => isWrite(response, "/api/payments"));
      await dialog.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true }).click();
      expect((await pending).status()).toBe(201);
      expect((await db.query("SELECT invoice_id, amount_minor::int, currency FROM payments WHERE patient_id=$1", [patientId])).rows)
        .toEqual([{ invoice_id: id, amount_minor: 20_500, currency: "YER" }]);
    } finally { await close(payment.context); }
  });
});

describe("FIN-01 prevention after server composition", () => {
  it.each(clinical)("$category preview blocks blank clinician and the normal save stays disabled", async (example) => {
    const patientId = await newPatient(`no doctor ${example.category}`);
    const { page, context } = await openAccount(patientId);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/invoices") writes.push(request.url());
    });
    try {
      await enterInvoice(page);
      await chooseClinical(page, example);
      await expect.poll(async () => {
        const rowProof = page.getByTestId("invoice-clinical-preview-0");
        return await rowProof.count() ? rowProof.getAttribute("data-preview-state") : null;
      }, { timeout: 20_000 }).toBe("refused");
      expect(await saveButton(page).isEnabled()).toBe(false);
      expect(writes).toEqual([]);
      expect(await counts(patientId)).toEqual({ invoices: 0, plans: 0, items: 0, cases: 0, payments: 0 });
    } finally { await close(context); }
  });
});
