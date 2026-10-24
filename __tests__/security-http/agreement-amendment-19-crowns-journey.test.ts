import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";
import type { HistoricalDocumentReceipt } from "../../lib/legacy-treatment-document";

/**
 * Characterisation of the owner's 19-crown upgrade request on the frozen candidate, on the real built app
 * and isolated harness DB (synthetic data only). It records what the UI actually creates and how the dated
 * amendment answers; it does not fix anything.
 *
 * New treatment: crowns are a multi-tooth episode. Choosing one crown service and 19 teeth in «علاج جديد»
 * creates 19 invoice lines and 19 plan items (one per tooth, quantity 1), all carrying the same episode.
 * After consent, approval against that invoice and a prior payment, «ترقية خدمة الاتفاق بفرق مؤرخ» refuses
 * atomically because the dated amendment supports exactly one plan item. In the combined candidate, the
 * reviewed preview-message correction shows that exact controlled reason. A directly seeded single item with
 * quantity 10 (agreement-delta tests) proves the arithmetic only, not this journey.
 *
 * Historical treatment (separate, direct HTTP API path, NOT a browser journey): the document keeps the prosthetic episode as ONE grouped
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
const MULTI_ITEM_REFUSAL = "تعدد بنود العلاج يحتاج تخصيصًا ماليًا مستقلًا؛ لا يُخمّن فرق السعر.";
const HISTORICAL_REFUSAL = "مطلوب اتفاق فعال معتمد ومغطى بفاتورة واحدة مثبتة؛ لم يُنشأ تعديل.";
const INVALID_REQUEST = "يرجى مراجعة الخدمة المحددة والسعر ومفتاح الطلب والسبب.";
const evidence: Record<string, unknown> = {
  kind: "synthetic-built-app-characterization",
  characterizationBaseRevision: "4b21d71d2422888f01185bb39f07358cbdd1aa0e",
  note: "Tests and evidence only; no production data, no multi-item policy implementation, no fix claim.",
  scenarios: { newTreatment: "not_run", newTreatmentApi: "not_run", historicalApi: "not_run" },
};
const q = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.query<T>(sql, values)).rows;

beforeAll(async () => {
  expect(TEETH).toHaveLength(19);
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  evidence.runtime = { node: process.version, observedAt: new Date().toISOString(),
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    testSourceSha256: createHash("sha256").update(readFileSync("__tests__/security-http/agreement-amendment-19-crowns-journey.test.ts")).digest("hex") };
  // Synthetic catalog/doctor setup only. Treatment, consent and approval use the real UI or named API path.
  doctorPartyId = (await q<{ id: number }>("INSERT INTO parties(name,kind,commission_percent) VALUES($1,'doctor',20) RETURNING id",
    [`Synthetic 19-crown doctor ${stamp}`]))[0].id;
  await db.query(`INSERT INTO doctor_commission_history(party_id,percent,effective_from,source,reason,recorded_by)
    VALUES($1,20,'1970-01-01','party','Synthetic 19-crown characterization','secadmin')`, [doctorPartyId]);
  for (const [key, name, price] of [["original", "تاج معدني خزفي اصطناعي", 50000], ["upgraded", "تاج زركونيا اصطناعي", 80000]] as const) {
    services[key] = (await q<{ id: number }>(`INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, $2, TRUE, TRUE, 'crown') RETURNING id`,
      [`${name} ${stamp}`, price]))[0].id;
  }
  await db.query("INSERT INTO cashier_shifts(opened_by) SELECT 'secadmin' WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
}, 240_000);
afterAll(async () => {
  try {
    // This is an observed-run record, not proof merely because a file exists. Each scenario marks completion
    // only after every assertion passes. A reviewed passing run is copied into docs/review for durable evidence.
    mkdirSync(".settings-ui-artifacts", { recursive: true });
    writeFileSync(".settings-ui-artifacts/agreement-amendment-19-crowns.json", `${JSON.stringify(evidence, null, 2)}\n`);
  } finally { await browser?.close(); await db?.end(); }
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

async function readJson(path: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Cookie: h.sessions.admin.cookie } });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

/** Compare full stored rows, not just counts/totals, plus the cash and commission readers.
 * Raw rows stay inside the test process. The evidence contains only synthetic aggregate observations.
 */
async function financialState(patientId: number) {
  const stored = (await q<{ snapshot: Record<string, unknown[] | null> }>(`SELECT jsonb_build_object(
    'invoices',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM invoices x WHERE patient_id=$1),
    'invoiceItems',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM invoice_items x JOIN invoices i ON i.id=x.invoice_id WHERE i.patient_id=$1),
    'payments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM payments x WHERE patient_id=$1),
    'plans',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM treatment_plans x WHERE patient_id=$1),
    'planItems',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM plan_items x JOIN treatment_plans p ON p.id=x.plan_id WHERE p.patient_id=$1),
    'installments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM plan_installments x JOIN treatment_plans p ON p.id=x.plan_id WHERE p.patient_id=$1),
    'approvals',(SELECT jsonb_agg(to_jsonb(x) ORDER BY plan_id) FROM approved_agreement_principals x WHERE patient_id=$1),
    'amendments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM agreement_delta_amendments x WHERE patient_id=$1),
    'staleRejections',(SELECT jsonb_agg(to_jsonb(x) ORDER BY idempotency_key) FROM agreement_delta_attempt_rejections x WHERE patient_id=$1),
    'collections',(SELECT jsonb_agg(to_jsonb(x) ORDER BY idempotency_key) FROM agreement_delta_collection_receipts x WHERE patient_id=$1),
    'historicalDocuments',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM legacy_treatment_documents x WHERE patient_id=$1),
    'historicalRevisions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM legacy_treatment_document_revisions x JOIN legacy_treatment_documents d ON d.id=x.document_id WHERE d.patient_id=$1),
    'historicalAgreements',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM legacy_treatment_agreements x WHERE patient_id=$1),
    'historicalCoverage',(SELECT jsonb_agg(to_jsonb(x) ORDER BY agreement_id) FROM legacy_treatment_coverage_snapshots x JOIN legacy_treatment_agreements a ON a.id=x.agreement_id WHERE a.patient_id=$1),
    'openingBalances',(SELECT jsonb_agg(to_jsonb(x) ORDER BY currency) FROM patient_opening_balances x WHERE patient_id=$1),
    'openingHistory',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM patient_opening_balance_history x WHERE patient_id=$1),
    'repaymentArrangements',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM debt_repayment_arrangements x WHERE patient_id=$1),
    'repaymentRevisions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM debt_repayment_revisions x JOIN debt_repayment_arrangements a ON a.id=x.arrangement_id WHERE a.patient_id=$1),
    'doctorCommissionHistory',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM doctor_commission_history x WHERE party_id=$2)
    ) AS snapshot`, [patientId, doctorPartyId]))[0].snapshot;
  const cash = await readJson("/api/shifts");
  const commission = await readJson(`/api/finance/commissions?detail=1&from=1970-01-01&to=2099-12-31&doctorId=${doctorPartyId}`);
  const lines = (commission.lines as { patientId: number; accruedMinor: number; earnedMinor: number }[])
    .filter((line) => line.patientId === patientId);
  return { stored, cash, commission: { lines,
    accruedMinor: lines.reduce((sum, line) => sum + line.accruedMinor, 0),
    earnedMinor: lines.reduce((sum, line) => sum + line.earnedMinor, 0) } };
}

function unchangedEvidence(before: Awaited<ReturnType<typeof financialState>>) {
  return { fullStoredRowsUnchanged: Object.keys(before.stored).sort(),
    storedRowCounts: Object.fromEntries(Object.entries(before.stored).map(([table, rows]) => [table, rows?.length ?? 0])),
    cashReaderUnchanged: true, commissionReaderUnchanged: true,
    commission: { lineCount: before.commission.lines.length,
      accruedMinor: before.commission.accruedMinor, earnedMinor: before.commission.earnedMinor } };
}

async function assertRefusal(planId: number, scenario: string, message: string) {
  const path = `/api/plans/${planId}/agreement-amendment`;
  const response = await fetch(`${baseUrl}${path}`, { headers: { Cookie: h.sessions.admin.cookie } });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(409);
  expect(body).toEqual({ code: "conflict", message });

  // GET refuses before snapshot() can produce sourceHash. There is no valid preview-backed upgrade to
  // submit for this unsupported source. These are deliberately labelled schema-valid guard probes,
  // not real client commands. Exact conflict/message and absence of rejection rows prove they did NOT
  // pass merely because of an invalid request, stale hash, authentication failure or server error.
  const command = { idempotencyKey: `c19-${scenario}-${planId}`, newServiceId: services.upgraded,
    newUnitMinor: 80000, reason: "ترقية اصطناعية للتيجان" };
  const malformed = await authedMutation(path, h.sessions.admin, "POST",
    JSON.stringify({ ...command, expectedSourceHash: "not-a-source-hash" }));
  const malformedBody = await malformed.json();
  expect(malformed.status, JSON.stringify(malformedBody)).toBe(400);
  expect(malformedBody).toEqual({ code: "invalid", message: INVALID_REQUEST });

  const posts = [];
  for (const probe of ["a", "b"]) {
    const expectedSourceHash = createHash("sha256").update(`unsupported-preview:${scenario}:${probe}`).digest("hex");
    const post = await authedMutation(path, h.sessions.admin, "POST",
      JSON.stringify({ ...command, idempotencyKey: `${command.idempotencyKey}-${probe}`, expectedSourceHash }));
    const postBody = await post.json();
    expect(post.status, JSON.stringify(postBody)).toBe(409);
    expect(postBody).toEqual({ code: "conflict", message });
    posts.push({ status: post.status, ...postBody });
  }
  expect(await q("SELECT idempotency_key FROM agreement_delta_attempt_rejections WHERE plan_id=$1", [planId])).toEqual([]);
  return { get: { status: response.status, ...body },
    malformedHashControl: { status: malformed.status, ...malformedBody }, posts,
    postKind: "schema-valid guard probes; preview source hash unavailable for refused source",
    twoDistinctWellFormedProbeHashes: true, staleRejectionRows: 0 };
}

describe("19 crowns: new treatment from the UI, then a dated upgrade attempt", () => {
  it("creates one plan item per tooth, and the amendment refuses atomically after consent, approval and payment", async () => {
    (evidence.scenarios as Record<string, string>).newTreatment = "started_not_completed";
    // Keep the separate API scenario runnable when browser infrastructure is unavailable. Browser failure
    // still fails this case; it must never silently become a passing API substitute or skipped assertion.
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
    evidence.chromium = browser.version();
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
      // Explicitly attribute each line, so the unchanged-commission assertion is non-vacuous.
      for (let index = 0; index < TEETH.length; index++) {
        await page.getByTestId(`invoice-provider-${index}`).selectOption(String(doctorPartyId));
      }
      const save = page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
      await expect.poll(() => save.isEnabled(), { timeout: 60_000 }).toBe(true);
      await save.click();
      await page.getByTestId("invoice-clinical-notice").waitFor({ timeout: 60_000 });

      // The data shape the UI created.
      const created = await state(patientId);
      const items = await q(`SELECT ii.id, ii.service_id, ii.doctor_id, ii.quantity, ii.unit_price_minor::text, ii.plan_item_id FROM invoice_items ii
        JOIN invoices i ON i.id=ii.invoice_id WHERE i.patient_id=$1 ORDER BY ii.id`, [patientId]);
      const plans = await q("SELECT id, total_minor::text, status, consent_at FROM treatment_plans WHERE patient_id=$1", [patientId]);
      evidence.newTreatment = { creation: "browser UI; synthetic catalog, doctor and patient seeded only",
        invoiceCount: created.invoices.length, invoiceTotalMinor: created.invoices[0]?.total_minor,
        invoiceLines: items.length, plans: plans.length,
        planItems: created.planItems.map(({ quantity, unit_price_minor, tooth_code }) => ({ quantity, unit_price_minor, tooth_code })) };
      expect(created.invoices).toHaveLength(1);
      expect(created.invoices[0]).toMatchObject({ total_minor: String(19 * 50000), discount_minor: "0" });
      expect(items).toHaveLength(19);
      expect(plans).toHaveLength(1);
      expect(created.planItems).toHaveLength(19);
      expect(created.planItems.every((row) => row.quantity === 1 && row.unit_price_minor === "50000" && row.service_id === services.original)).toBe(true);
      expect(created.planItems.map((row) => row.tooth_code).sort((a, b) => Number(a) - Number(b))).toEqual(TEETH);
      expect(items.every((row) => row.quantity === 1 && row.unit_price_minor === "50000"
        && row.service_id === services.original && row.doctor_id === doctorPartyId)).toBe(true);
      expect(new Set(items.map((row) => row.plan_item_id)).size).toBe(19);
      expect(items.map((row) => row.plan_item_id).sort()).toEqual(created.planItems.map((row) => row.id).sort());
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
      expect((await state(patientId)).payments).toEqual([{ n: 1, total: "180000" }]);
      // Approved-agreement collection is attributed to its invoice, not the legacy plan-payment field.
      expect(await q("SELECT invoice_id, plan_id, kind, amount_minor::text, currency, method FROM payments WHERE patient_id=$1", [patientId]))
        .toEqual([{ invoice_id: invoiceId, plan_id: null, kind: "payment", amount_minor: "180000", currency: "YER", method: "cash" }]);
      expect(await q("SELECT plan_id, invoice_id, total_minor::text, source_kind FROM approved_agreement_principals WHERE patient_id=$1", [patientId]))
        .toEqual([{ plan_id: planId, invoice_id: invoiceId, total_minor: "950000", source_kind: "invoice" }]);
      const before = await financialState(patientId);
      expect(before.commission.lines.length).toBeGreaterThan(0);
      expect(before.commission.accruedMinor).toBeGreaterThan(0);
      expect(before.commission.earnedMinor).toBeGreaterThan(0);
      expect(before.stored.amendments).toBeNull();
      expect(before.stored.staleRejections).toBeNull();

      // The dated upgrade attempt.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "ترقية خدمة الاتفاق بفرق مؤرخ" }).click();
      const panel = page.getByTestId("agreement-amendment");
      // Composition with #464 preserves the exact controlled multi-item refusal. It does not enable
      // multi-item upgrades or relax the unchanged money, lineage and tooth-geometry assertions below.
      await expect.poll(async () => panel.innerText(), { timeout: 30_000 }).toContain(MULTI_ITEM_REFUSAL);
      evidence.newTreatmentPanelText = (await panel.innerText()).split("\n").filter(Boolean);
      expect(await panel.innerText()).not.toContain("البيانات أو الهجرة المالية غير جاهزة");
      expect(await panel.getByLabel("الخدمة الجديدة — اختيار صريح").count()).toBe(0);
      evidence.newTreatmentRefusal = await assertRefusal(planId, "new", MULTI_ITEM_REFUSAL);
      expect(await financialState(patientId)).toEqual(before);
      evidence.newTreatmentUnchanged = { ...unchangedEvidence(before), priorPaymentMinor: 180000 };
      (evidence.scenarios as Record<string, string>).newTreatment = "passed";
    } finally { await page.context().close(); }
  }, 300_000);
});

describe("19 crowns: new treatment created by direct HTTP API (not a browser journey)", () => {
  it("creates, consents, approves and collects through real endpoints before exact multi-item refusal", async () => {
    (evidence.scenarios as Record<string, string>).newTreatmentApi = "started_not_completed";
    const patientId = await newPatient("new-api");
    const invoice = await authedMutation("/api/invoices", h.sessions.admin, "POST", JSON.stringify({
      patientId, currency: "YER", existingPlanId: null, discount: "0", discountReason: null,
      idempotencyKey: `c19-api-invoice-${patientId}`, repaymentTerms: { mode: "full", installments: [] },
      items: TEETH.map((toothCode) => ({ serviceId: services.original, doctorId: doctorPartyId,
        quantity: 1, price: "50000", catalogPriceMinor: 50000, toothCode, episodeTeeth: TEETH })),
    }));
    const receipt = await invoice.json();
    expect(invoice.status, JSON.stringify(receipt)).toBe(201);
    const shape = await state(patientId);
    const plans = await q<{ id: number }>("SELECT id FROM treatment_plans WHERE patient_id=$1", [patientId]);
    expect(plans).toHaveLength(1);
    expect(shape.invoices).toHaveLength(1);
    expect(shape.invoices[0]).toMatchObject({ id: receipt.id, total_minor: "950000", discount_minor: "0" });
    const planId = plans[0].id;
    expect(receipt.clinical.planId).toBe(planId);
    expect(shape.planItems).toHaveLength(19);
    expect(shape.planItems.every((item) => item.quantity === 1 && item.unit_price_minor === "50000"
      && item.service_id === services.original && item.doctor_id === doctorPartyId)).toBe(true);
    expect(shape.planItems.map((item) => item.tooth_code).sort((a, b) => Number(a) - Number(b))).toEqual(TEETH);
    const lines = await q("SELECT plan_item_id, doctor_id, service_id, quantity, unit_price_minor::text FROM invoice_items WHERE invoice_id=$1 ORDER BY id", [receipt.id]);
    expect(lines).toHaveLength(19);
    expect(lines.every((line) => line.quantity === 1 && line.unit_price_minor === "50000"
      && line.service_id === services.original && line.doctor_id === doctorPartyId)).toBe(true);
    expect(lines.map((line) => line.plan_item_id).sort()).toEqual(shape.planItems.map((item) => item.id).sort());
    const consent = await authedMutation(`/api/plans/${planId}/consent`, h.sessions.admin, "POST",
      JSON.stringify({ note: "موافقة اصطناعية عبر واجهة البرمجة" }));
    expect(consent.status, await consent.clone().text()).toBe(201);
    const approval = await authedMutation(`/api/plans/${planId}/financial-approval`, h.sessions.admin, "POST",
      JSON.stringify({ expectedTotalMinor: 950000, currency: "YER", source: { kind: "invoice", invoiceId: receipt.id },
        reason: "مطابقة اصطناعية لفاتورة التيجان عبر واجهة البرمجة" }), { "Idempotency-Key": `c19-api-approval-${planId}` });
    expect(approval.status, await approval.clone().text()).toBe(201);
    const paid = await authedMutation(`/api/plans/${planId}`, h.sessions.admin, "POST",
      JSON.stringify({ amount: "180000", currency: "YER" }), { "Idempotency-Key": `c19-api-deposit-${planId}` });
    expect(paid.status, await paid.clone().text()).toBe(201);
    expect(await q("SELECT invoice_id, plan_id, kind, amount_minor::text, currency, method FROM payments WHERE patient_id=$1", [patientId]))
      .toEqual([{ invoice_id: receipt.id, plan_id: null, kind: "payment", amount_minor: "180000", currency: "YER", method: "cash" }]);
    expect(await q("SELECT plan_id, invoice_id, total_minor::text, source_kind FROM approved_agreement_principals WHERE patient_id=$1", [patientId]))
      .toEqual([{ plan_id: planId, invoice_id: receipt.id, total_minor: "950000", source_kind: "invoice" }]);
    const before = await financialState(patientId);
    expect(before.commission.lines.length).toBeGreaterThan(0);
    expect(before.commission.accruedMinor).toBeGreaterThan(0);
    expect(before.commission.earnedMinor).toBeGreaterThan(0);
    expect(before.stored.amendments).toBeNull();
    expect(before.stored.staleRejections).toBeNull();
    evidence.newTreatmentApi = { creation: "direct HTTP API for invoice, consent, approval and payment; not browser UI; no direct plan/item financial seeding",
      invoiceCount: shape.invoices.length, invoiceTotalMinor: "950000", invoiceLines: lines.length,
      planCount: plans.length, planItemCount: shape.planItems.length, itemQuantity: 1, itemUnitMinor: 50000,
      teeth: TEETH, priorPaymentMinor: 180000, refusal: await assertRefusal(planId, "new-api", MULTI_ITEM_REFUSAL) };
    expect(await financialState(patientId)).toEqual(before);
    evidence.newTreatmentApiUnchanged = unchangedEvidence(before);
    (evidence.scenarios as Record<string, string>).newTreatmentApi = "passed";
  }, 120_000);
});

describe("19 crowns: historical treatment created by direct HTTP API (not a browser journey)", () => {
  it("requires one grouped 19-tooth plan item and historical paid fact, then refuses GET and POST without mutations", async () => {
    (evidence.scenarios as Record<string, string>).historicalApi = "started_not_completed";
    const patientId = await newPatient("hist");
    const cashBeforeCreation = await readJson("/api/shifts");
    const body = { patientId, currency: "YER", items: [{ serviceId: services.original, quantity: 1, price: "950000", catalogPriceMinor: 50000,
      toothCode: TEETH[0], episodeTeeth: TEETH, priceReason: "اتفاق تاريخي اصطناعي لحلقة التيجان كاملة" }],
      discount: "0", discountReason: null, previouslyPaidAmount: "180000", historicalAsOf: "2026-09-20", note: null,
      idempotencyKey: `c19-hist-${stamp}`, repaymentTerms: { mode: "installments", installments: [{ dueDate: "2026-12-12", amountMinor: 770000, kind: "installment" }] },
      repaymentRemainingMinor: 770000, repaymentVersion: 0, repaymentSourceHash: null };
    const response = await authedMutation(`/api/patients/${patientId}/historical-documents`, h.sessions.admin, "POST", JSON.stringify(body));
    const json = await response.json();
    evidence.historicalCreate = { status: response.status, message: json.message ?? null, lines: json.document?.lines?.length ?? null };
    expect(response.status, JSON.stringify(json)).toBe(201);
    const document = json.document as HistoricalDocumentReceipt;
    expect(document).toMatchObject({ patientId, version: 1, currency: "YER", totalMinor: 950000, discountMinor: 0,
      agreedMinor: 950000, previouslyPaidMinor: 180000, remainingMinor: 770000, historicalAsOf: "2026-09-20" });
    const lines = document.lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ serviceId: services.original, unitPriceMinor: 950000, discountMinor: 0, netMinor: 950000 });
    expect(lines[0].site.episodeTeeth).toEqual(TEETH);
    const persisted = await readJson(`/api/patients/${patientId}/historical-documents`);
    expect(persisted.documents).toHaveLength(1);
    expect(persisted.documents[0]).toMatchObject({ id: document.id, previouslyPaidMinor: 180000, remainingMinor: 770000, lines });
    const shape = await state(patientId);
    expect(shape.invoices).toHaveLength(0);
    expect(shape.planItems).toHaveLength(1);
    expect(shape.planItems[0]).toMatchObject({ id: lines[0].planItemId, service_id: services.original,
      quantity: 1, unit_price_minor: "950000", tooth_code: TEETH[0] });
    expect(shape.payments).toEqual([{ n: 0, total: "0" }]); // Historical paid fact is NOT a present-day receipt.
    const plans = await q<{ id: number }>("SELECT id FROM treatment_plans WHERE patient_id=$1", [patientId]);
    expect(plans, "Historical API must create the claimed plan; a missing plan must fail, not skip amendment assertions").toHaveLength(1);
    expect(plans[0].id).toBe(lines[0].planId);
    expect(await q("SELECT snapshot_tooth_codes FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [lines[0].agreementId]))
      .toEqual([{ snapshot_tooth_codes: TEETH }]);
    const before = await financialState(patientId);
    expect(before.cash).toEqual(cashBeforeCreation);
    expect(before.stored.approvals).toBeNull();
    expect(before.stored.amendments).toBeNull();
    expect(before.stored.staleRejections).toBeNull();
    evidence.historical = { creation: "direct HTTP API, not browser UI; no plan/item direct seeding",
      documentLines: lines.length, plans: plans.length, episodeTeeth: lines[0].site.episodeTeeth,
      agreedMinor: document.agreedMinor, previouslyPaidMinor: document.previouslyPaidMinor, remainingMinor: document.remainingMinor,
      planItems: shape.planItems.map(({ quantity, unit_price_minor, tooth_code }) => ({ quantity, unit_price_minor, tooth_code })),
      invoices: shape.invoices.length, currentPaymentReceipts: 0, creationCashReaderUnchanged: true };
    evidence.historicalRefusal = await assertRefusal(plans[0].id, "hist", HISTORICAL_REFUSAL);
    expect(await financialState(patientId)).toEqual(before);
    evidence.historicalUnchanged = unchangedEvidence(before);
    (evidence.scenarios as Record<string, string>).historicalApi = "passed";
  }, 120_000);
});
