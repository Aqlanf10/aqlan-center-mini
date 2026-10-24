import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";

/**
 * Characterisation of the owner's 19-crown upgrade request on the frozen candidate, on the real built app
 * and isolated harness DB (synthetic data only). It records what the UI actually creates and how the dated
 * amendment answers; it does not fix anything.
 *
 * New treatment: crowns are a multi-tooth episode. Choosing one crown service and 19 teeth in «علاج جديد»
 * creates 19 invoice lines and 19 plan items (one per tooth, quantity 1), all carrying the same episode.
 * After consent, approval against that invoice and a prior payment, «ترقية خدمة الاتفاق بفرق مؤرخ» refuses
 * atomically because the dated amendment supports exactly one plan item (the panel currently hides that reason
 * behind a generic message; pinned below). A directly seeded single item with
 * quantity 19 (agreement-delta tests) proves the arithmetic only, not this journey.
 *
 * Historical treatment (separate path): the historical document keeps the prosthetic episode as ONE grouped
 * line for all teeth, deliberately (no invented per-tooth prices). It is not an invoice-backed approved
 * agreement, so the dated amendment does not apply to it; correction stays the historical workflow.
 */
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorPartyId = 0;
const stamp = Date.now();
let serial = 0;
const TEETH = [11, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26, 27, 31, 32, 33, 34, 35];
const services = { original: 0, upgraded: 0 };
const evidence: Record<string, unknown> = { note: "Synthetic characterisation on c998b435; no fix applied." };
const q = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.query<T>(sql, values)).rows;

beforeAll(async () => {
  expect(TEETH).toHaveLength(19);
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ({ rows: [{ party_id: doctorPartyId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  for (const [key, name, price] of [["original", "تاج معدني خزفي اصطناعي", 50000], ["upgraded", "تاج زركونيا اصطناعي", 80000]] as const) {
    services[key] = (await q<{ id: number }>(`INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, $2, TRUE, TRUE, 'crown') RETURNING id`,
      [`${name} ${stamp}`, price]))[0].id;
  }
  await db.query("INSERT INTO cashier_shifts(opened_by) SELECT 'secadmin' WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
}, 240_000);
afterAll(async () => {
  try { mkdirSync(".settings-ui-artifacts", { recursive: true }); writeFileSync(".settings-ui-artifacts/agreement-amendment-19-crowns.json", JSON.stringify(evidence, null, 2)); } catch { /* evidence is optional */ }
  await browser?.close(); await db?.end();
});

async function newPatient(label: string) {
  return (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`C19-${label}-${String(stamp).slice(-6)}-${++serial}`, `مريض تيجان اصطناعي ${label}`, doctorPartyId]))[0].id;
}
async function adminPage(path: string, width = 1280): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}
const state = async (patientId: number) => ({
  invoices: await q("SELECT id, total_minor::text, discount_minor::text, status FROM invoices WHERE patient_id=$1 ORDER BY id", [patientId]),
  amendments: await q("SELECT count(*)::int AS n FROM agreement_delta_amendments WHERE patient_id=$1", [patientId]),
  planItems: await q(`SELECT pi.id, pi.service_id, pi.quantity, pi.unit_price_minor::text, pi.tooth_code, pi.status, pi.doctor_id FROM plan_items pi
    JOIN treatment_plans tp ON tp.id=pi.plan_id WHERE tp.patient_id=$1 ORDER BY pi.id`, [patientId]),
  payments: await q("SELECT count(*)::int AS n, coalesce(sum(amount_minor),0)::text AS total FROM payments WHERE patient_id=$1", [patientId]),
});

describe("19 crowns: new treatment from the UI, then a dated upgrade attempt", () => {
  it("creates one plan item per tooth, and the amendment refuses atomically after consent, approval and payment", async () => {
    const patientId = await newPatient("new");
    const page = await adminPage(`/patients/${patientId}?tab=account`);
    try {
      await page.getByTestId("treatment-entry-open").click();
      await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(services.original));
      await page.getByTestId("invoice-tooth-button-0").click();
      const dialog = page.getByTestId("tooth-dialog");
      await dialog.waitFor();
      for (const tooth of TEETH) await dialog.getByTestId(`odontogram-tooth-${tooth}`).click();
      await page.getByTestId("tooth-dialog-confirm").click();
      await dialog.waitFor({ state: "detached" });
      await expect.poll(() => page.locator('[data-testid^="invoice-row-"]').count(), { timeout: 20_000 }).toBe(19);
      const save = page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
      await expect.poll(() => save.isEnabled(), { timeout: 60_000 }).toBe(true);
      await save.click();
      await page.getByTestId("invoice-clinical-notice").waitFor({ timeout: 60_000 });

      // The data shape the UI created.
      const created = await state(patientId);
      const items = await q(`SELECT ii.id, ii.service_id, ii.quantity, ii.unit_price_minor::text, ii.plan_item_id FROM invoice_items ii
        JOIN invoices i ON i.id=ii.invoice_id WHERE i.patient_id=$1 ORDER BY ii.id`, [patientId]);
      const plans = await q("SELECT id, total_minor::text, status, consent_at FROM treatment_plans WHERE patient_id=$1", [patientId]);
      evidence.newTreatment = { invoices: created.invoices, invoiceLines: items.length, plans: plans.length,
        planItems: created.planItems.map(({ quantity, unit_price_minor, tooth_code, service_id }) => ({ quantity, unit_price_minor, tooth_code, service_id })) };
      expect(created.invoices).toHaveLength(1);
      expect(created.invoices[0]).toMatchObject({ total_minor: String(19 * 50000), discount_minor: "0" });
      expect(items).toHaveLength(19);
      expect(plans).toHaveLength(1);
      expect(created.planItems).toHaveLength(19);
      expect(created.planItems.every((row) => row.quantity === 1 && row.unit_price_minor === "50000" && row.service_id === services.original)).toBe(true);
      expect(created.planItems.map((row) => row.tooth_code).sort((a, b) => Number(a) - Number(b))).toEqual(TEETH);
      expect(new Set(items.map((row) => row.plan_item_id)).size).toBe(19);
      const planId = plans[0].id as number, invoiceId = created.invoices[0].id as number;

      // Consent through the plan UI.
      await page.goto(`${baseUrl}/patients/${patientId}?tab=plans`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "سجّل موافقة المريض — ويُقفل الاتفاق" }).click();
      await page.getByLabel("كيف وُثّقت الموافقة", { exact: true }).fill("موافقة اصطناعية موثقة");
      await page.getByRole("button", { name: "سجّل الموافقة", exact: true }).click();
      await expect.poll(async () => (await q("SELECT consent_at FROM treatment_plans WHERE id=$1", [planId]))[0].consent_at !== null, { timeout: 30_000 }).toBe(true);

      // Approval of the full principal against the existing invoice, through the panel.
      await page.getByRole("button", { name: "اعتماد أصل الاتفاق المالي" }).click();
      await page.getByLabel("مصدر الأصل").selectOption("invoice");
      await page.getByLabel("رقم الفاتورة المطابقة").fill(String(invoiceId));
      await page.getByLabel("سبب الاعتماد أو دليل المطابقة").fill("مطابقة اصطناعية لفاتورة التيجان كاملة");
      await page.getByRole("button", { name: "تأكيد المبلغ والمصدر واعتماد الالتزام" }).click();
      await page.getByTestId("approved-agreement").waitFor({ timeout: 30_000 });

      // A prior payment through the plan collection endpoint the plan screen uses.
      const paid = await authedMutation(`/api/plans/${planId}`, h.sessions.admin, "POST", JSON.stringify({ amount: "180000", currency: "YER" }),
        { "Idempotency-Key": `c19-deposit-${planId}` });
      expect(paid.status, await paid.clone().text()).toBe(201);
      const before = await state(patientId);

      // The dated upgrade attempt.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "ترقية خدمة الاتفاق بفرق مؤرخ" }).click();
      const panel = page.getByTestId("agreement-amendment");
      // Observed defect (pinned, not fixed here): the panel discards the server's Arabic refusal and shows a generic
      // "data or migration not ready" message, so staff cannot see that multiple plan items are the reason.
      await expect.poll(async () => panel.innerText(), { timeout: 30_000 }).toContain("البيانات أو الهجرة المالية غير جاهزة");
      evidence.newTreatmentPanelText = (await panel.innerText()).split("\n").filter(Boolean);
      expect(await panel.innerText()).not.toContain("تعدد بنود العلاج");
      expect(await panel.getByLabel("الخدمة الجديدة — اختيار صريح").count()).toBe(0);
      const response = await fetch(`${baseUrl}/api/plans/${planId}/agreement-amendment`, { headers: { Cookie: h.sessions.admin.cookie } });
      const body = await response.json();
      evidence.newTreatmentAmendment = { status: response.status, message: body.message };
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(body.message).toContain("تعدد بنود العلاج");
      // A direct POST is refused the same way and writes nothing.
      const post = await authedMutation(`/api/plans/${planId}/agreement-amendment`, h.sessions.admin, "POST",
        JSON.stringify({ idempotencyKey: `c19-upgrade-${planId}`, expectedSourceHash: "0".repeat(64), newServiceId: services.upgraded, newUnitMinor: 80000, reason: "ترقية اصطناعية للتيجان" }));
      evidence.newTreatmentAmendmentPost = { status: post.status, message: (await post.json()).message };
      expect(post.status).toBeGreaterThanOrEqual(400);
      expect(await state(patientId)).toEqual(before);
    } finally { await page.context().close(); }
  }, 300_000);
});

describe("19 crowns: historical treatment (separate path)", () => {
  it("keeps the prosthetic episode as one grouped line; the dated amendment does not apply", async () => {
    const patientId = await newPatient("hist");
    const body = { patientId, currency: "YER", items: [{ serviceId: services.original, quantity: 1, price: "950000", catalogPriceMinor: 50000,
      toothCode: TEETH[0], episodeTeeth: TEETH, priceReason: "اتفاق تاريخي اصطناعي لحلقة التيجان كاملة" }],
      discount: "0", discountReason: null, previouslyPaidAmount: "180000", historicalAsOf: "2026-09-20", note: null,
      idempotencyKey: `c19-hist-${stamp}`, repaymentTerms: { mode: "installments", installments: [{ dueDate: "2026-12-12", amountMinor: 770000, kind: "installment" }] },
      repaymentRemainingMinor: 770000, repaymentVersion: 0, repaymentSourceHash: null };
    const response = await authedMutation(`/api/patients/${patientId}/historical-documents`, h.sessions.admin, "POST", JSON.stringify(body));
    const json = await response.json();
    evidence.historicalCreate = { status: response.status, message: json.message ?? null, lines: json.document?.lines?.length ?? null };
    expect(response.status, JSON.stringify(json)).toBe(201);
    const lines = json.document.lines as { netMinor: number; site?: { episodeTeeth?: number[] } }[];
    expect(lines).toHaveLength(1);
    const shape = await state(patientId);
    evidence.historical = { documentLines: lines.length, planItems: shape.planItems.map(({ quantity, unit_price_minor, tooth_code }) => ({ quantity, unit_price_minor, tooth_code })),
      invoices: shape.invoices.length };
    expect(shape.invoices).toHaveLength(0);
    const plan = (await q<{ id: number }>("SELECT id FROM treatment_plans WHERE patient_id=$1", [patientId]))[0];
    if (plan) {
      const amend = await fetch(`${baseUrl}/api/plans/${plan.id}/agreement-amendment`, { headers: { Cookie: h.sessions.admin.cookie } });
      const amendBody = await amend.json();
      evidence.historicalAmendment = { status: amend.status, message: amendBody.message };
      expect(amend.status).toBeGreaterThanOrEqual(400);
    } else {
      evidence.historicalAmendment = { status: null, message: "no plan for the historical document" };
    }
    expect(await state(patientId)).toEqual(shape);
  }, 120_000);
});
