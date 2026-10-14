import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";
import { assertInvoiceViewportBounds, invoiceViewportProof, revealInvoiceControlByWheel, settleBrowser } from "./_invoice-browser-geometry";
import { COLLECTOR_PATH, emitVisualEvidence, sha256, VIEWPORT_HEIGHT, VISUAL_TEST_PATH,
  type CapturedScene, type VisualScene } from "./_invoice-visual-evidence";

/** Required visual evidence from the built app, using only this suite's isolated fixtures.
 * No API interception, CSS replacement, cookies/storage/traces/HAR/HTML/environment export.
 * A first real invoice gives a genuine duplicate-linkage refusal on the same synthetic patient.
 * All six bounded PNGs must succeed before any evidence bytes are emitted through existing CI stdout. */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let doctorId = 0;
let serviceId = 0;
const syntheticPatients = new Map<number, string>();
const stamp = Date.now();

async function nativePageClick(page: Page, control: Locator) {
  await control.waitFor({ state: "visible" });
  const proof = await revealInvoiceControlByWheel(page, control);
  await page.mouse.click(proof.left + proof.width / 2, proof.top + proof.height / 2);
  return proof;
}

// Frame the entire group using real wheel input, then measure every target
// against the fixed/sticky shell. Programmatic scrolling cannot supply proof.
async function framePageTargetsByWheel(page: Page, targets: Locator[]) {
  const before = await Promise.all(targets.map(target => target.evaluate(invoiceViewportProof)));
  const availableTop = Math.max(...before.map(proof => proof.availableViewport.top));
  const availableBottom = Math.min(...before.map(proof => proof.availableViewport.bottom));
  const top = Math.min(...before.map(proof => proof.top)), bottom = Math.max(...before.map(proof => proof.bottom));
  expect(bottom - top).toBeLessThanOrEqual(availableBottom - availableTop);
  const y = (availableTop + availableBottom) / 2;
  const pointer = await targets[0].evaluate((node, y) => {
    const x = Math.max(2, Math.min(innerWidth - 2, (node.closest("main")?.getBoundingClientRect().left ?? 0) + 4));
    const hit = document.elementFromPoint(x, y);
    return { x, y, exists: hit !== null, nativeField: hit?.closest("input,select,textarea")?.tagName ?? null };
  }, y);
  expect(pointer.exists).toBe(true); expect(pointer.nativeField).toBeNull();
  const deltaY = (top + bottom) / 2 - y;
  await page.mouse.move(pointer.x, pointer.y); await page.mouse.wheel(0, Math.abs(deltaY) < 1 ? 2 : deltaY);
  await settleBrowser(page);
  await expect.poll(async () => {
    const proofs = await Promise.all(targets.map(target => target.evaluate(invoiceViewportProof)));
    return proofs.every(proof => proof.top >= proof.availableViewport.top && proof.bottom <= proof.availableViewport.bottom && proof.unobscured);
  }).toBe(true);
  const proofs = await Promise.all(targets.map(target => target.evaluate(invoiceViewportProof)));
  for (const proof of proofs) assertInvoiceViewportBounds(proof, before[0].viewportWidth);
  return { method: "native-mouse-wheel", pointer, deltaY, proofs };
}

beforeAll(async () => {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") throw new Error("Visual evidence requires the isolated loopback harness");
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ({ rows: [{ party_id: doctorId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  ({ rows: [{ id: serviceId }] } = await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category)
     VALUES ($1, 1500000, TRUE, TRUE, 'filling') RETURNING id`, [`حشوة الدليل البصري الاصطناعي ${stamp}`]));
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function selectInvoiceLine(page: Page) {
  await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(serviceId));
  await page.getByTestId("invoice-provider-0").selectOption(String(doctorId));
  await page.getByTestId("invoice-tooth-button-0").click();
  const dialog = page.getByTestId("tooth-dialog");
  await page.locator('[data-testid="tooth-dialog"][data-chart-state="ready"]').waitFor();
  await dialog.getByTestId("odontogram-tooth-26").click();
  await dialog.getByTestId("surface-M").click();
  await dialog.getByTestId("surface-O").click();
}

async function capture(page: Page, patientId: number, scene: VisualScene): Promise<CapturedScene> {
  const expectedName = syntheticPatients.get(patientId);
  const location = new URL(page.url());
  if (!expectedName || location.origin !== new URL(baseUrl).origin || location.pathname !== `/patients/${patientId}`
    || location.search !== "?tab=account" || location.hash) throw new Error("Screenshot target is outside the synthetic scene allowlist");
  expect(await page.getByText(expectedName, { exact: true }).first().isVisible()).toBe(true);
  const width = scene.endsWith("-390") ? 390 : 1280;
  expect(page.viewportSize()).toEqual({ width, height: VIEWPORT_HEIGHT });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.evaluate(async () => { await document.fonts.ready; });
  const targets = scene.includes("shared-chart")
    ? ["tooth-dialog", "odontogram-tooth-26", "surface-M", "surface-O", "tooth-dialog-confirm"]
    : ["invoice-provider-0", "invoice-tooth-chip-0", "invoice-clinical-preview-0"];
  for (const target of targets) {
    const control = page.getByTestId(target);
    const bounds = await control.boundingBox();
    expect(bounds, `required visible target ${target}`).not.toBeNull();
    expect(bounds!.x >= -1 && bounds!.y >= -1 && bounds!.x + bounds!.width <= width + 1
      && bounds!.y + bounds!.height <= VIEWPORT_HEIGHT + 1, `target inside actual screenshot ${target}`).toBe(true);
    if (!scene.includes("shared-chart")) assertInvoiceViewportBounds(await control.evaluate(invoiceViewportProof), width);
  }
  if (!scene.includes("shared-chart")) {
    const bounds = await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).boundingBox();
    expect(bounds, "required Save control").not.toBeNull();
    expect(bounds!.x >= -1 && bounds!.y >= -1 && bounds!.x + bounds!.width <= width + 1
      && bounds!.y + bounds!.height <= VIEWPORT_HEIGHT + 1, "Save control inside actual screenshot").toBe(true);
    assertInvoiceViewportBounds(await page.getByRole("button", { name: "احفظ الفاتورة", exact: true }).evaluate(invoiceViewportProof), width);
  }
  const png = await page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide", scale: "css" });
  return { scene, png };
}

describe("required invoice visual evidence through retained CI stdout", () => {
  it.each([390, 1280])("opens the single entry from Plans, protects drafts and keeps Account details secondary at %ipx", async (width) => {
    const { rows: [{ id: patientId }] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
      [`IENTRY-${stamp}-${width}`, `مريض مدخل العلاج الاصطناعي ${width}`, doctorId]);
    await db.query(`INSERT INTO patient_opening_balances (patient_id, currency, amount_minor, as_of_date, note, created_by)
      VALUES ($1, 'SAR', 25000000, CURRENT_DATE, 'رصيد اصطناعي للتحقق من العرض فقط', 'secadmin')`, [patientId]);
    const { rows: [existingPlan] } = await db.query<{ id: number }>(`INSERT INTO treatment_plans
      (patient_id, title, total_minor, base_currency, billing_mode, total_from_items, created_by)
      VALUES ($1, 'خطة اصطناعية قائمة للتحقق من فصل العمل عن الدين', 25250000, 'SAR', 'items', TRUE, 'secadmin') RETURNING id`, [patientId]);
    await db.query(`INSERT INTO plan_items (plan_id, service_name, quantity, unit_price_minor, status)
      VALUES ($1, 'عمل مخطط قائم', 1, 25000000, 'planned'), ($1, 'عمل مخطط إضافي غير مفوتر', 1, 250000, 'planned')`, [existingPlan.id]);
    const financialRows = async () => {
      const rows: Record<string, unknown> = {};
      for (const table of ["invoices", "payments", "treatment_plans", "clinical_cases", "legacy_treatment_agreements", "patient_opening_balances"]) {
        rows[table] = (await db.query(`SELECT * FROM ${table} WHERE patient_id = $1 ORDER BY ${table === "patient_opening_balances" ? "currency" : "id"}`, [patientId])).rows;
      }
      return rows;
    };
    const before = await financialRows();
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, locale: "ar-YE", deviceScaleFactor: 1 });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage();
    const writes: string[] = []; const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())
        && path !== "/api/invoices/clinical-preview" && !path.endsWith("/historical-documents/preview")) writes.push(`${request.method()} ${path}`);
    });
    const fits = async () => {
      expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    };
    const confirmNavigation = async (accept: boolean) => {
      const navigation = page.getByTestId("patient-tab-summary");
      const proof = await revealInvoiceControlByWheel(page, navigation);
      const pending = page.waitForEvent("dialog");
      const click = page.mouse.click(proof.left + proof.width / 2, proof.top + proof.height / 2);
      const dialog = await pending;
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("مسودة فاتورة أو اتفاق غير محفوظة");
      if (accept) await dialog.accept(); else await dialog.dismiss();
      await click;
    };
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=plans`, { waitUntil: "domcontentloaded" });
      await nativePageClick(page, page.getByTestId("plans-open-treatment-entry"));
      const chooser = page.getByTestId("treatment-entry-choice");
      await chooser.waitFor();
      expect(new URL(page.url()).searchParams.get("tab")).toBe("account");
      expect(await page.getByTestId("treatment-entry-open").count()).toBe(1);
      expect(await chooser.getByRole("button").count()).toBe(2);
      expect(await page.getByRole("region", { name: "فاتورة جديدة", exact: true }).count()).toBe(0);
      expect(await page.getByRole("region", { name: "اتفاق تاريخي متعدد البنود", exact: true }).count()).toBe(0);
      expect(await page.getByTestId("account-treatment-details").getAttribute("open")).toBeNull();
      await page.getByTestId("account-canonical-balance").waitFor();
      expect(await page.getByTestId("account-canonical-balance").getAttribute("data-currency")).toBe("SAR");
      expect(await page.getByTestId("account-canonical-balance").innerText()).toContain("250,000");
      const details = page.getByTestId("account-treatment-details");
      expect(await details.count()).toBe(1);
      expect(await page.locator("details").filter({ has: page.locator("summary").filter({ hasText: /تفاصيل العلاج|تفاصيل خطط العلاج/ }) }).count()).toBe(1);
      await nativePageClick(page, details.locator("summary"));
      expect(await details.innerText()).toContain("252,500");
      expect(await details.innerText()).toContain("القيمة المخططة وتقدم العمل منفصلان عن الدَّين");
      expect(await page.getByTestId("account-canonical-balance").innerText()).toContain("250,000");
      expect(await page.getByTestId("account-canonical-balance").innerText()).not.toContain("252,500");
      await page.screenshot({ path: `.settings-ui-artifacts/unified-account-details-${width}.png`, fullPage: false, animations: "disabled" });
      await nativePageClick(page, details.locator("summary"));
      await fits();
      mkdirSync(".settings-ui-artifacts", { recursive: true });
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.screenshot({ path: `.settings-ui-artifacts/unified-entry-chooser-${width}.png`, fullPage: true, animations: "disabled" });
      const choicesProof = await framePageTargetsByWheel(page, ["علاج جديد", "علاج بدأ قبل النظام"]
        .map(label => chooser.getByRole("button", { name: label, exact: true })));
      writeFileSync(`.settings-ui-artifacts/unified-entry-choices-visible-${width}.json`, `${JSON.stringify(choicesProof, null, 2)}\n`);
      await page.screenshot({ path: `.settings-ui-artifacts/unified-entry-choices-visible-${width}.png`, fullPage: false, animations: "disabled" });

      const secondary = page.getByTestId("account-secondary-actions");
      await nativePageClick(page, secondary.locator("summary"));
      expect(await secondary.getAttribute("open")).not.toBeNull();
      await secondary.locator("summary").press("Escape");
      expect(await secondary.getAttribute("open")).toBeNull();
      await nativePageClick(page, secondary.locator("summary"));
      await nativePageClick(page, chooser.getByRole("heading"));
      expect(await secondary.getAttribute("open")).toBeNull();

      await nativePageClick(page, chooser.getByRole("button", { name: "علاج جديد", exact: true }));
      const description = page.getByLabel("وصف البند", { exact: true });
      await description.fill("مسودة محفوظة في الشاشة فقط");
      await confirmNavigation(false);
      expect(new URL(page.url()).searchParams.get("tab")).toBe("account");
      expect(await description.inputValue()).toBe("مسودة محفوظة في الشاشة فقط");
      await fits();
      await page.screenshot({ path: `.settings-ui-artifacts/unified-entry-draft-${width}.png`, fullPage: true, animations: "disabled" });
      await confirmNavigation(true);
      await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("summary");
      await nativePageClick(page, page.getByTestId("patient-tab-account"));
      await page.getByTestId("account-canonical-balance").waitFor();
      expect(await chooser.count()).toBe(0); // consumed Plans request cannot reopen on a later visit
      await nativePageClick(page, page.getByTestId("treatment-entry-open"));
      await nativePageClick(page, chooser.getByRole("button", { name: "علاج بدأ قبل النظام", exact: true }));
      const historical = page.getByRole("region", { name: "اتفاق تاريخي متعدد البنود", exact: true });
      await historical.getByLabel("السعر", { exact: true }).fill("300000");
      await historical.getByLabel("المدفوع قبل النظام").fill("120000");
      await fits();
      await page.screenshot({ path: `.settings-ui-artifacts/unified-entry-history-${width}.png`, fullPage: true, animations: "disabled" });
      expect(writes).toEqual([]); expect(errors).toEqual([]);
      expect(await financialRows()).toEqual(before);
    } finally { await context.close(); }
  }, 120_000);

  it("captures actual provider-ready, shared-chart and refusal scenes at 390 and 1280", async () => {
    const captures: CapturedScene[] = [];
    const staleSuccessFeedback: { width: number; patientId: number; text: string }[] = [];
    for (const width of [390, 1280] as const) {
      const patientName = `مريض الدليل البصري الاصطناعي ${width}`;
      const { rows: [{ id: patientId }] } = await db.query<{ id: number }>(
        `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
        [`IVIS-${stamp}-${width}`, patientName, doctorId]);
      syntheticPatients.set(patientId, patientName);
      const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT }, locale: "ar-YE", deviceScaleFactor: 1 });
      const [name, ...value] = h.sessions.reception.cookie.split("=");
      await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
        await page.getByTestId("treatment-entry-open").click();
        await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
        await selectInvoiceLine(page);
        expect(await page.getByTestId("tooth-dialog").getByTestId("odontogram-tooth-26").getAttribute("aria-pressed")).toBe("true");
        expect(await page.getByTestId("surface-M").getAttribute("aria-pressed")).toBe("true");
        expect(await page.getByTestId("surface-O").getAttribute("aria-pressed")).toBe("true");
        captures.push(await capture(page, patientId, `invoice-shared-chart-${width}`));

        await page.getByTestId("tooth-dialog-confirm").click();
        await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
        const proof=page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="ready"]');
        await proof.waitFor({state:"attached"});
        if(!await proof.isVisible())await proof.locator("..").locator("summary").click();
        await proof.waitFor();
        expect(await page.getByTestId("invoice-provider-0").inputValue()).toBe(String(doctorId));
        expect(await page.getByTestId("invoice-provider-review-0").count()).toBe(0);
        expect(await page.getByTestId("invoice-tooth-chip-0").innerText()).toContain("MO");
        const save = page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
        expect(await save.isEnabled()).toBe(true);
        await framePageTargetsByWheel(page, [page.getByTestId("invoice-provider-0"), page.getByTestId("invoice-tooth-chip-0"),
          page.getByTestId("invoice-clinical-preview-0"), save]);
        captures.push(await capture(page, patientId, `invoice-provider-ready-${width}`));

        await expect.poll(async () => (await page.getByTestId("account-balance-unavailable").count())
          + (await page.getByTestId("patient-workflow-read-state").count())).toBe(0);
        const [issued, ledgerResponse, workflowResponse] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === "/api/invoices" && response.request().method() === "POST"),
          page.waitForResponse(response => new URL(response.url()).pathname === `/api/patients/${patientId}/ledger`),
          page.waitForResponse(response => new URL(response.url()).pathname === `/api/patients/${patientId}/workflow`),
          save.click(),
        ]);
        expect(issued.status()).toBe(201); expect(ledgerResponse.status()).toBe(200); expect(workflowResponse.status()).toBe(200);
        const saved = await issued.json() as { id: number };
        const ledger = await ledgerResponse.json() as { invoices: { id: number }[] };
        const workflow = await workflowResponse.json() as { patient: { id: number } };
        expect(ledger.invoices.map(invoice => invoice.id)).toEqual([saved.id]); expect(workflow.patient.id).toBe(patientId);
        const renderedInvoices = page.getByRole("region", { name: "الفواتير", exact: true });
        const settled = async () => ({
          ledgerPending: await page.getByTestId("account-balance-unavailable").count(),
          workflowPending: await page.getByTestId("patient-workflow-read-state").count(),
          heading: await renderedInvoices.getByRole("heading").textContent(),
          links: await renderedInvoices.locator('a[href^="/print/invoice/"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("href"))),
        });
        const expectedRead = { ledgerPending: 0, workflowPending: 0, heading: "الفواتير (1)", links: [`/print/invoice/${saved.id}`] };
        await expect.poll(settled).toEqual(expectedRead);
        await page.getByTestId("invoice-clinical-notice").waitFor();
        await page.getByTestId("treatment-entry-open").click();
        await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
        await selectInvoiceLine(page);
        const duplicatePreview = page.waitForResponse((response) => {
          if (new URL(response.url()).pathname !== "/api/invoices/clinical-preview" || response.request().method() !== "POST") return false;
          const body = response.request().postDataJSON() as { items?: { toothCode?: number; doctorId?: number; surfaces?: string }[] };
          return body.items?.[0]?.toothCode === 26 && body.items[0].doctorId === doctorId && body.items[0].surfaces === "MO";
        });
        await page.getByTestId("tooth-dialog-confirm").click();
        const duplicateResponse = await duplicatePreview;
        expect(duplicateResponse.status()).toBe(200);
        const duplicateBody = await duplicateResponse.json() as { lines: { line: number; refusal: string | null }[] };
        expect(duplicateBody.lines.find((line) => line.line === 0)?.refusal).toBe("already_billed");
        await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
        const refusal = page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="refused"]');
        await refusal.waitFor();
        expect(await refusal.innerText()).not.toContain("ستنشئ/تربط");
        expect(await save.isEnabled()).toBe(false);
        await framePageTargetsByWheel(page, [page.getByTestId("invoice-provider-0"), page.getByTestId("invoice-tooth-chip-0"),
          page.getByTestId("invoice-clinical-preview-0"), save]);
        captures.push(await capture(page, patientId, `invoice-refusal-${width}`));
        await expect.poll(settled).toEqual(expectedRead);
        const priorNotice = page.getByTestId("invoice-clinical-notice");
        const feedback = { width, patientId, invoiceId: saved.id, reads: await settled(),
          refusal: await refusal.innerText(), saveDisabled: await save.isDisabled(),
          priorSuccess: await priorNotice.count() ? await priorNotice.innerText() : null };
        mkdirSync(".settings-ui-artifacts", { recursive: true });
        writeFileSync(`.settings-ui-artifacts/invoice-refusal-feedback-${width}.json`, `${JSON.stringify(feedback, null, 2)}\n`);
        if (feedback.priorSuccess) staleSuccessFeedback.push({ width, patientId, text: feedback.priorSuccess });
        expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(1);
      } finally { await context.close(); }
    }
    await emitVisualEvidence(captures, {
      testSha256: sha256(readFileSync(join(process.cwd(), VISUAL_TEST_PATH))),
      collectorSha256: sha256(readFileSync(join(process.cwd(), COLLECTOR_PATH))),
    });
    // Preserve both raw refusal scenes before reporting stale success as a source defect.
    expect(staleSuccessFeedback, "A new refused invoice draft must not retain the previous draft's unscoped success notice").toEqual([]);
  }, 240_000);
});
