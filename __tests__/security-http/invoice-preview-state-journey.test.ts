import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { chromium, type Browser, type Locator, type Page, type Request, type Response, type Route } from "playwright";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";
import { invoiceViewportProof, revealInvoiceControlByWheel, settleBrowser } from "./_invoice-browser-geometry";

/** Real form and shared chart; transport failures/delays are controlled at the browser boundary.
 * Only isolated harness fixtures are written. Preview-only probes intercept writes;
 * native command-recovery cases explicitly commit through the real isolated server. */
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorPartyId = 0;
let filling = 0;
let consultation = 0;
let rootCanal = 0;
const stamp = Date.now();
let serial = 0;
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  ({ rows: [{ party_id: doctorPartyId }] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`));
  for (const category of ["filling", "consultation", "rct"]) {
    const { rows: [{ id }] } = await db.query<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 1500000, TRUE, TRUE, $2) RETURNING id`,
      [`معاينة آمنة ${category} ${stamp}`, category]);
    if (category === "filling") filling = id; else if (category === "rct") rootCanal = id; else consultation = id;
  }
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

const networkByPage = new WeakMap<Page, { url: string; method: string; status: number; fromServiceWorker: boolean }[]>();
/** Bounded transport evidence for a failure message: responses seen, SW control, and the row's current inputs. */
async function transport(page: Page, line = 0) {
  const row = page.getByTestId(`invoice-row-${line}`);
  return {
    responses: (networkByPage.get(page) ?? []).slice(-8),
    controlled: await page.evaluate(() => Boolean(navigator.serviceWorker?.controller)).catch(() => null),
    service: await row.getByLabel("الخدمة", { exact: true }).inputValue().catch(() => null),
    price: await row.getByLabel("السعر", { exact: true }).inputValue().catch(() => null),
    site: await page.getByTestId(`invoice-tooth-button-${line}`).innerText().catch(() => null),
  };
}

async function openInvoice(width = 1280, native = false) {
  const { rows: [{ id }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`IPS-${stamp}-${++serial}`, "مريض اختبار ملكية المعاينة", doctorPartyId]);
  // Route-mocked failure injection needs controlled transport: a service worker can serve requests outside page.route
  // (Playwright network docs), so this context blocks it, as the other route-mocked browser fixtures do.
  const context = await browser.newContext({ viewport: { width, height: native ? 844 : 1100 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const network: { url: string; method: string; status: number; fromServiceWorker: boolean }[] = [];
  page.on("response", (response) => {
    if (!response.url().includes("/api/invoices")) return;
    network.push({ url: new URL(response.url()).pathname, method: response.request().method(), status: response.status(),
      fromServiceWorker: response.fromServiceWorker() });
  });
  networkByPage.set(page, network);
  await page.goto(`${baseUrl}/patients/${id}?tab=account`, { waitUntil: "domcontentloaded" });
  if (native) {
    await nativeClick(page, page.getByTestId("treatment-entry-open"));
    await nativeClick(page, page.getByRole("button", { name: "علاج جديد", exact: true }));
  } else {
    await page.getByTestId("treatment-entry-open").click();
    await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
  }
  return { context, page, patientId: id };
}
async function selectFilling(page: Page, line = 0, tooth = 26) {
  await page.getByTestId(`invoice-row-${line}`).getByLabel("الخدمة", { exact: true }).selectOption(String(filling));
  await page.getByTestId(`invoice-tooth-button-${line}`).click();
  await page.getByTestId("tooth-dialog").getByTestId(`odontogram-tooth-${tooth}`).click();
  await page.getByTestId("tooth-dialog-confirm").click();
  await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
}
function success(route: Route, refusal: string | null = null) {
  const body = route.request().postDataJSON() as { existingPlanId?: number | null; items: { serviceId: number | null }[] };
  return { existingPlanId: body.existingPlanId ?? null, planChoices: [], lines: body.items.map((item, line) => ({ line, kind: item.serviceId === filling ? "clinical" : "financial",
    specialtyLabel: item.serviceId === filling ? "ترميم" : null,
    item: item.serviceId === filling ? { mode: "new", id: null } : null,
    case: item.serviceId === filling ? { mode: "none", id: null, title: null, options: [] } : null,
    refusal, refusalMessage: refusal ? "هذا العلاج مفوتر سابقًا." : null,
    itemCandidates: [],
  })) };
}
const json = (route: Route, payload: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
const ready = (page: Page, line = 0) => page.locator(`[data-testid="invoice-clinical-preview-${line}"][data-preview-state="ready"]`).waitFor();
const save = (page: Page) => page.getByRole("button", { name: "احفظ الفاتورة", exact: true });

async function nativeClick(page: Page, target: Locator) {
  await target.waitFor({ state: "visible" });
  const proof = await revealInvoiceControlByWheel(page, target);
  await page.mouse.click(proof.left + proof.width / 2, proof.top + proof.height / 2);
}
async function nativeSelect(page: Page, target: Locator, value: string) {
  await target.waitFor({ state: "visible" });
  await revealInvoiceControlByWheel(page, target);
  await target.selectOption(value);
}
async function visibleModalClick(page: Page, target: Locator) {
  const proof = await target.evaluate(invoiceViewportProof);
  expect(proof.left).toBeGreaterThanOrEqual(0); expect(proof.right).toBeLessThanOrEqual(proof.viewportWidth);
  expect(proof.top).toBeGreaterThanOrEqual(0); expect(proof.bottom).toBeLessThanOrEqual(proof.viewportHeight);
  expect(proof.hitPoints.map(point => point.unobscured)).toEqual(Array(9).fill(true));
  await page.mouse.click(proof.left + proof.width / 2, proof.top + proof.height / 2);
}
async function chooseNativeTemplate(page: Page) {
  await nativeClick(page, page.getByRole("button", { name: "اختيار قالب علاج", exact: true }));
  const template = page.getByLabel("قالب العلاج", { exact: true });
  await template.waitFor();
  await nativeSelect(page, template, "endo");
  await nativeSelect(page, page.getByLabel("خدمة علاج الجذور", { exact: true }), String(rootCanal));
  await nativeSelect(page, page.getByLabel("طبيب بنود القالب", { exact: true }), String(doctorPartyId));
  await nativeClick(page, page.getByTestId("invoice-template-teeth"));
  await page.locator('[data-testid="tooth-dialog"][data-chart-state="ready"]').waitFor();
  const navigation = page.getByTestId("tooth-chart-navigation");
  expect(await navigation.innerText()).toContain("اسحب المخطط أفقيًا");
  await visibleModalClick(page, page.getByTestId("odontogram-tooth-18"));
  await visibleModalClick(page, page.getByTestId("tooth-dialog-confirm"));
  await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
  const review = page.getByLabel("راجعت بنود القالب ومبلغه وجدول جلساته", { exact: true });
  await expect.poll(() => review.isEnabled(), { timeout: 15_000 }).toBe(true);
  expect(await page.getByTestId("invoice-template-preview").innerText()).toContain("فتح السن وتنظيف القنوات");
  await nativeClick(page, review.locator(".."));
  expect(await review.isChecked()).toBe(true);
  await expect.poll(() => save(page).isEnabled()).toBe(true);
}
async function patientCommandSnapshot(patientId: number) {
  const result: Record<string, unknown> = {};
  for (const table of ["invoices", "payments", "treatment_plans", "clinical_cases", "planned_visits"]) {
    result[table] = (await db.query(`SELECT * FROM ${table} WHERE patient_id = $1 ORDER BY id`, [patientId])).rows;
  }
  result.items = (await db.query(`SELECT i.* FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1 ORDER BY i.id`, [patientId])).rows;
  result.sessions = (await db.query(`SELECT s.* FROM treatment_sessions s JOIN plan_items i ON i.id=s.plan_item_id JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1 ORDER BY s.id`, [patientId])).rows;
  result.audit = (await db.query(`SELECT * FROM audit_log WHERE (entity='patient' AND entity_id=$1) OR (entity='invoice' AND entity_id IN (SELECT id::text FROM invoices WHERE patient_id=$2)) ORDER BY id`, [String(patientId),patientId])).rows;
  return result;
}

type AccountReadProof = {
  patientId: number; savedInvoiceId: number; invoiceIds: number[]; invoiceNumbers: string[]; dueMinor: number;
  ledgerUrl: string; workflowUrl: string;
};
async function renderedAccount(page: Page, proof: AccountReadProof, expectedWriteErrors = 0) {
  const invoices = page.getByRole("region", { name: "الفواتير", exact: true });
  await expect.poll(async () => ({
    ledgerPending: await page.getByTestId("account-balance-unavailable").count(),
    workflowPending: await page.getByTestId("patient-workflow-read-state").count(),
    ledgerErrors: await page.getByRole("alert", { name: "خطأ حساب المريض", exact: true }).count(),
    writeErrors: await page.getByRole("alert", { name: "تعذّر حفظ إجراء الحساب", exact: true }).count(),
    balance: await page.locator('[data-testid="account-canonical-balance"][data-currency="YER"]').count(),
    heading: await invoices.getByRole("heading").textContent(),
    links: await invoices.locator('a[href^="/print/invoice/"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("href")).sort()),
  }), { timeout: 15_000 }).toEqual({
    ledgerPending: 0, workflowPending: 0, ledgerErrors: 0, writeErrors: expectedWriteErrors, balance: 1,
    heading: `الفواتير (${proof.invoiceIds.length})`, links: proof.invoiceIds.map(id => `/print/invoice/${id}`).sort(),
  });
  for (const number of proof.invoiceNumbers) expect(await invoices.getByText(number, { exact: true }).count()).toBe(1);
}
/** Observe the application's own post-write reads; never substitute a test fetch or a sleep. */
async function nativeSaveAndReadAccount(page: Page, patientId: number, control: Locator, expectedCount: number): Promise<AccountReadProof> {
  const ledgerPath = `/api/patients/${patientId}/ledger`, workflowPath = `/api/patients/${patientId}/workflow`;
  const reads = new Set<Request>(); let writeSeen = false;
  const isWrite = (response: Response) => new URL(response.url()).pathname === "/api/invoices"
    && response.request().method() === "POST";
  const observeWrite = (response: Response) => { if (isWrite(response)) writeSeen = true; };
  const observeRead = (request: Request) => {
    if (writeSeen && request.method() === "GET" && [ledgerPath, workflowPath].includes(new URL(request.url()).pathname)) reads.add(request);
  };
  page.on("response", observeWrite); page.on("request", observeRead);
  try {
    const [saved, ledgerResponse, workflowResponse] = await Promise.all([
      page.waitForResponse(isWrite, { timeout: 15_000 }),
      page.waitForResponse(response => reads.has(response.request()) && new URL(response.url()).pathname === ledgerPath, { timeout: 15_000 }),
      page.waitForResponse(response => reads.has(response.request()) && new URL(response.url()).pathname === workflowPath, { timeout: 15_000 }),
      nativeClick(page, control),
    ]);
    expect([200, 201]).toContain(saved.status());
    for (const response of [ledgerResponse, workflowResponse]) {
      expect(response.status()).toBe(200); expect(response.fromServiceWorker()).toBe(false);
    }
    const receipt = await saved.json() as { id: number };
    const ledger = await ledgerResponse.json() as { invoices: { id: number; invoiceNumber: string }[]; balances: { YER: { dueMinor: number } } };
    const workflow = await workflowResponse.json() as { patient: { id: number }; financial: { byCurrency: { YER: { balanceMinor: number } } } };
    const stored = (await db.query<{ id: number; invoice_number: string }>(
      "SELECT id, invoice_number FROM invoices WHERE patient_id=$1 ORDER BY id", [patientId])).rows;
    expect(stored).toHaveLength(expectedCount);
    const invoiceIds = stored.map(row => row.id);
    expect(invoiceIds).toContain(receipt.id);
    expect(ledger.invoices.map(row => row.id).sort((a, b) => a - b)).toEqual(invoiceIds);
    expect(ledger.invoices.map(row => row.invoiceNumber).sort()).toEqual(stored.map(row => row.invoice_number).sort());
    expect(workflow.patient.id).toBe(patientId);
    expect(workflow.financial.byCurrency.YER.balanceMinor).toBe(ledger.balances.YER.dueMinor);
    const proof = { patientId, savedInvoiceId: receipt.id, invoiceIds, invoiceNumbers: stored.map(row => row.invoice_number),
      dueMinor: ledger.balances.YER.dueMinor, ledgerUrl: ledgerResponse.url(), workflowUrl: workflowResponse.url() };
    await renderedAccount(page, proof);
    return proof;
  } finally { page.off("response", observeWrite); page.off("request", observeRead); }
}
async function captureSettledAccount(page: Page, proof: AccountReadProof, path: string) {
  await renderedAccount(page, proof);
  writeFileSync(path.replace(/\.png$/, ".json"), `${JSON.stringify({ phase: "authoritative-reads-rendered", ...proof }, null, 2)}\n`);
  await page.screenshot({ path, fullPage: false });
}

describe("final native template command recovery", () => {
  it.each([390, 1280])("a new refused command retires prior success while preserving the authoritative balance at %i×844", async width => {
    const { page, context, patientId } = await openInvoice(width, true);
    let posts = 0;
    await page.route("**/api/invoices", async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      if (posts === 2) return json(route, { message: "رفض اصطناعي للطلب الجديد؛ لم تُحفظ فاتورة أخرى." }, 400);
      return route.continue();
    });
    mkdirSync(".settings-ui-artifacts", { recursive: true });
    try {
      await chooseNativeTemplate(page);
      const account = await nativeSaveAndReadAccount(page, patientId, save(page), 1);
      await page.getByTestId("invoice-clinical-notice").waitFor();
      const before = await patientCommandSnapshot(patientId);
      const balance = page.locator('[data-testid="account-canonical-balance"][data-currency="YER"]');
      const balanceText = await balance.innerText();
      await nativeClick(page, page.getByTestId("treatment-entry-open"));
      await nativeClick(page, page.getByRole("button", { name: "علاج جديد", exact: true }));
      await nativeSelect(page, page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }), String(consultation));
      const refused = page.waitForResponse(response => new URL(response.url()).pathname === "/api/invoices" && response.request().method() === "POST");
      await nativeClick(page, save(page)); expect((await refused).status()).toBe(400);
      const error = page.getByRole("alert", { name: "تعذّر حفظ إجراء الحساب", exact: true });
      await expect.poll(() => error.innerText()).toContain("رفض اصطناعي للطلب الجديد");
      await renderedAccount(page, account, 1);
      expect(await balance.innerText()).toBe(balanceText);
      expect(await patientCommandSnapshot(patientId)).toEqual(before); expect(posts).toBe(2);
      const success = page.getByTestId("invoice-clinical-notice");
      const proof = { phase: "known-refusal-preserved-authoritative-ledger", ...account,
        error: await error.innerText(), balanceText, priorSuccess: await success.count() ? await success.innerText() : null };
      writeFileSync(`.settings-ui-artifacts/new-command-refusal-${width}.json`, `${JSON.stringify(proof, null, 2)}\n`);
      await page.screenshot({ path: `.settings-ui-artifacts/new-command-refusal-${width}.png`, fullPage: false });
      expect(await success.count(), "The new failed command must not show the old command's success").toBe(0);
    } finally { await context.close(); }
  }, 120_000);

  it.each([390, 1280].flatMap(width => ["malformed-links", "hanging-headers", "hanging-body"].map(fault => ({ width, fault }))))(
    "retains the committed command after $fault at $width×844, bounds uncertainty and fences a late reply", async ({ width, fault }) => {
      const { page, context, patientId } = await openInvoice(width, true);
      const commands: string[] = []; const serverErrors: string[] = [];
      const heldReply: { release?: () => void } = {};
      let committed = false;
      const streaming = createServer((request, response) => {
        response.setHeader("Access-Control-Allow-Origin", baseUrl);
        response.setHeader("Access-Control-Allow-Credentials", "true");
        response.setHeader("Access-Control-Allow-Headers", "content-type");
        if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const exact = Buffer.concat(chunks).toString("utf8");
          expect(exact).toBe(commands[0]);
          const saved = await authedMutation("/api/invoices", h.sessions.reception, "POST", exact);
          expect(saved.status).toBe(201);
          const body = await saved.text(); committed = true;
          response.statusCode = 201;
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Content-Length", Buffer.byteLength(body));
          if (fault === "hanging-body") { response.flushHeaders(); response.write(body.slice(0, 1)); }
          await new Promise<void>(resolve => { heldReply.release = resolve; });
          response.end(fault === "hanging-body" ? body.slice(1) : body);
        })().catch(error => { serverErrors.push(String(error)); response.destroy(); });
      });
      await new Promise<void>(resolve => streaming.listen(0, "127.0.0.1", resolve));
      const address = streaming.address();
      if (!address || typeof address === "string") throw new Error("Expected isolated streaming listener");
      await page.route("**/api/invoices", async route => {
        if (route.request().method() !== "POST") return route.continue();
        commands.push(route.request().postData()!);
        if (commands.length > 1) return route.continue();
        if (fault !== "malformed-links") return route.continue({ url: `http://127.0.0.1:${address.port}/api/invoices` });
        const saved = await route.fetch(); expect(saved.status()).toBe(201);
        const payload = await saved.json() as { clinical: { links: unknown } }; committed = true;
        payload.clinical.links = [{ line: "not-an-integer", planItemId: -1 }];
        return route.fulfill({ response: saved, json: payload });
      });
      mkdirSync(".settings-ui-artifacts", { recursive: true });
      try {
        await chooseNativeTemplate(page);
        const started = Date.now(); await nativeClick(page, save(page));
        await expect.poll(() => committed, { timeout: 15_000 }).toBe(true);
        const snapshot = await patientCommandSnapshot(patientId);
        expect(snapshot.invoices as unknown[]).toHaveLength(1);
        const recovery = page.getByTestId("invoice-command-recovery");
        await expect.poll(() => recovery.innerText(), { timeout: 25_000 }).toContain("نتيجة الطلب غير مؤكدة");
        if (fault !== "malformed-links") {
          expect(Date.now() - started).toBeGreaterThanOrEqual(19_000);
          expect(Date.now() - started).toBeLessThan(30_000);
        }
        expect(await page.getByRole("region", { name: "فاتورة جديدة", exact: true }).count()).toBe(1);
        expect(await page.getByLabel("قالب العلاج", { exact: true }).inputValue()).toBe("endo");
        expect(await page.getByLabel("قالب العلاج", { exact: true }).isDisabled()).toBe(true);
        expect(await save(page).isDisabled()).toBe(true);
        expect(await page.getByTestId("invoice-clinical-notice").count()).toBe(0);
        const account = await nativeSaveAndReadAccount(page, patientId,
          recovery.getByRole("button", { name: "إعادة نفس طلب الفاتورة", exact: true }), 1);
        await page.getByTestId("invoice-clinical-notice").waitFor();
        expect(commands).toHaveLength(2); expect(commands[1]).toBe(commands[0]);
        expect(await patientCommandSnapshot(patientId)).toEqual(snapshot);
        heldReply.release?.(); await settleBrowser(page);
        expect(await page.getByRole("region", { name: "فاتورة جديدة", exact: true }).count()).toBe(0);
        expect(await recovery.count()).toBe(0);
        expect(await patientCommandSnapshot(patientId)).toEqual(snapshot);
        expect(serverErrors).toEqual([]);
        await captureSettledAccount(page, account, `.settings-ui-artifacts/template-${fault}-finished-${width}.png`);
      } catch (error) {
        await page.screenshot({ path: `.settings-ui-artifacts/template-${fault}-failure-${width}.png`, fullPage: false }); throw error;
      } finally {
        heldReply.release?.(); await context.close(); streaming.closeAllConnections();
        await new Promise<void>(resolve => streaming.close(() => resolve()));
      }
    }, 120_000);

  it.each([390, 1280])("lost acknowledgement plus catalogue drift retries exactly, clears parent recovery and permits one independent next invoice at %i×844", async width => {
    const { page, context, patientId } = await openInvoice(width, true);
    const commands: string[] = []; const receipts: Record<string, unknown>[] = [];
    await page.route("**/api/invoices", async route => {
      if (route.request().method() !== "POST") return route.continue();
      commands.push(route.request().postData()!);
      const response = await route.fetch();
      receipts.push(await response.json() as Record<string, unknown>);
      if (commands.length === 1) { expect(response.status()).toBe(201); return route.abort("failed"); }
      return route.fulfill({ response });
    });
    mkdirSync(".settings-ui-artifacts", { recursive: true });
    try {
      await chooseNativeTemplate(page);
      await nativeClick(page, save(page));
      const recovery = page.getByTestId("invoice-command-recovery");
      await expect.poll(() => recovery.innerText()).toContain("نتيجة الطلب غير مؤكدة");
      const committed = await patientCommandSnapshot(patientId);
      expect((committed.invoices as unknown[])).toHaveLength(1);
      expect(await page.getByLabel("قالب العلاج", { exact: true }).isDisabled()).toBe(true);
      expect(await save(page).isDisabled()).toBe(true);
      await nativeClick(page, page.getByTestId("patient-tab-summary"));
      expect(new URL(page.url()).searchParams.get("tab")).toBe("account");
      expect((await authedMutation(`/api/services/${rootCanal}`, h.sessions.admin, "PATCH", JSON.stringify({ price: "1600000" }))).status).toBe(200);
      await page.screenshot({ path: `.settings-ui-artifacts/template-recovery-uncertain-${width}.png`, fullPage: false });
      await nativeSaveAndReadAccount(page, patientId, recovery.getByRole("button", { name: "إعادة نفس طلب الفاتورة", exact: true }), 1);
      await page.getByTestId("invoice-clinical-notice").waitFor();
      expect(commands).toHaveLength(2); expect(commands[1]).toBe(commands[0]);
      expect(receipts[1]).toMatchObject({ id: receipts[0].id, replayed: true });
      const identity = (receipt: Record<string, unknown>) => {
        const clinical = receipt.clinical as { planId: number; links: Record<string, unknown>[] };
        return { planId: clinical.planId, links: clinical.links.map(({ line, kind, specialty, planItemId, caseId, scheduled }) =>
          ({ line, kind, specialty, planItemId, caseId, scheduled })) };
      };
      expect(identity(receipts[1])).toEqual(identity(receipts[0]));
      expect((receipts[1].clinical as { links: Record<string, unknown>[] }).links.every(link => link.planItemCreated === false && link.caseCreated === false)).toBe(true);
      expect(await patientCommandSnapshot(patientId)).toEqual(committed);
      await nativeClick(page, page.getByTestId("treatment-entry-open"));
      await nativeClick(page, page.getByRole("button", { name: "علاج جديد", exact: true }));
      expect(await recovery.count()).toBe(0);
      expect(await page.getByRole("button", { name: "استعادة الطلب للتحقق بنفس المفتاح" }).count()).toBe(0);
      await nativeSelect(page, page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }), String(consultation));
      const account = await nativeSaveAndReadAccount(page, patientId, save(page), 2);
      await page.getByRole("region", { name: "فاتورة جديدة", exact: true }).waitFor({ state: "detached" });
      expect(commands).toHaveLength(3);
      const independent = JSON.parse(commands[2]);
      expect(independent.idempotencyKey).not.toBe(JSON.parse(commands[0]).idempotencyKey);
      expect(independent.templateSelection).toBeUndefined();
      expect((await db.query(`SELECT id FROM invoices WHERE patient_id=$1`, [patientId])).rows).toHaveLength(2);
      writeFileSync(`.settings-ui-artifacts/template-recovery-${width}.json`, JSON.stringify({ commands, receiptIds: receipts.map(one => one.id) }, null, 2));
      await captureSettledAccount(page, account, `.settings-ui-artifacts/template-recovery-finished-${width}.png`);
    } catch (error) {
      await page.screenshot({ path: `.settings-ui-artifacts/template-recovery-failure-${width}.png`, fullPage: false }); throw error;
    } finally {
      await authedMutation(`/api/services/${rootCanal}`, h.sessions.admin, "PATCH", JSON.stringify({ price: "1500000" }));
      await context.close();
    }
  }, 120_000);

  it.each([390, 1280])("explicit BUSY allows confirmed edit but refuses manual removal, restores the parent command and clears it only on exact success at %i×844", async width => {
    const { page, context, patientId } = await openInvoice(width, true);
    const commands: string[] = [];
    await page.route("**/api/invoices", async route => {
      if (route.request().method() !== "POST") return route.continue();
      commands.push(route.request().postData()!);
      if (commands.length === 1) return json(route, { code: "INVOICE_TEMPLATE_BUSY", message: "الدليل مشغول؛ أعد المحاولة." }, 409);
      return route.continue();
    });
    try {
      await chooseNativeTemplate(page); await nativeClick(page, save(page));
      const recovery = page.getByTestId("invoice-command-recovery");
      const edit = recovery.getByRole("button", { name: "تعديل المسودة بعد الرفض", exact: true });
      await edit.waitFor();
      page.once("dialog", dialog => dialog.accept()); await nativeClick(page, edit);
      const template = page.getByLabel("قالب العلاج", { exact: true });
      expect(await template.isEnabled()).toBe(true);
      // Playwright's state check follows the enclosing label to its enabled
      // select. Inspect the option itself, then exercise native keyboard input.
      expect(await template.locator('option[value=""]').evaluate(option => (option as HTMLOptionElement).disabled)).toBe(true);
      const reason = page.getByTestId("invoice-template-retained-origin");
      await revealInvoiceControlByWheel(page, reason);
      expect(await reason.innerText()).toContain("لا يمكن تحويله إلى فاتورة يدوية");
      await revealInvoiceControlByWheel(page, template);
      await template.press("Home"); await template.press("Enter");
      expect(await template.inputValue()).toBe("endo");
      expect(commands).toHaveLength(1);
      page.once("dialog", dialog => dialog.accept());
      await nativeClick(page, page.getByTestId("treatment-entry-open"));
      await page.getByRole("region", { name: "فاتورة جديدة", exact: true }).waitFor({ state: "detached" });
      await nativeClick(page, page.getByTestId("treatment-entry-open"));
      const restore = page.getByRole("button", { name: "استعادة الطلب للتحقق بنفس المفتاح", exact: true });
      await restore.waitFor(); expect(await save(page).isDisabled()).toBe(true);
      expect(await page.getByTestId("invoice-template-preview").count()).toBe(0);
      await nativeClick(page, restore);
      expect(await save(page).isDisabled()).toBe(true);
      await nativeSaveAndReadAccount(page, patientId, recovery.getByRole("button", { name: "إعادة نفس طلب الفاتورة", exact: true }), 1);
      await page.getByTestId("invoice-clinical-notice").waitFor();
      expect(commands).toHaveLength(2); expect(commands[1]).toBe(commands[0]);
      expect((await db.query(`SELECT id FROM invoices WHERE patient_id=$1`, [patientId])).rows).toHaveLength(1);
      await nativeClick(page, page.getByTestId("treatment-entry-open"));
      await nativeClick(page, page.getByRole("button", { name: "علاج جديد", exact: true }));
      expect(await restore.count()).toBe(0); expect(await recovery.count()).toBe(0);
      await nativeSelect(page, page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }), String(consultation));
      await nativeSaveAndReadAccount(page, patientId, save(page), 2);
      await page.getByRole("region", { name: "فاتورة جديدة", exact: true }).waitFor({ state: "detached" });
      expect(commands).toHaveLength(3);
      expect((await db.query(`SELECT id FROM invoices WHERE patient_id=$1`, [patientId])).rows).toHaveLength(2);
    } catch (error) {
      mkdirSync(".settings-ui-artifacts", { recursive: true });
      await page.screenshot({ path: `.settings-ui-artifacts/template-manual-removal-failure-${width}.png`, fullPage: false }); throw error;
    } finally { await context.close(); }
  }, 120_000);
});
/** Waits for one element's state and, on timeout, reports every observed state plus caller evidence (CI diagnosis). */
async function waitForState(target: Locator, attribute: string, expected: string, evidence: () => Record<string, unknown>) {
  const seen: string[] = [];
  try {
    await expect.poll(async () => {
      const value = await target.getAttribute(attribute, { timeout: 1_000 }).catch(() => "absent") ?? "null";
      if (seen.at(-1) !== value) seen.push(value);
      return value;
    }, { timeout: 30_000, interval: 200 }).toBe(expected);
  } catch {
    throw new Error(`${attribute} never became ${expected}: observed ${JSON.stringify(seen)}; evidence ${JSON.stringify(evidence())}`);
  }
  // The original oracle was locator.waitFor(): the state must also be visible to the user, not merely attached.
  await target.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {
    throw new Error(`${attribute}=${expected} is attached but not visible; evidence ${JSON.stringify(evidence())}`);
  });
}

describe("invoice form preview safety and shared chart interruption journeys", () => {
  it("requires a fresh preview generation when A returns after B, without reviving the earlier ready A", async () => {
    const { page, context, patientId } = await openInvoice();
    const held: Route[] = [];
    let hold = false;
    let submissions = 0;
    await page.route("**/api/invoices", async (route) => { submissions++; await route.abort(); });
    await page.route("**/api/invoices/clinical-preview", async (route) => {
      if (hold) { held.push(route); return; }
      await json(route, success(route));
    });
    try {
      await selectFilling(page);
      await ready(page);
      expect(await save(page).isEnabled()).toBe(true);
      const price = page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true });
      const originalPrice = await price.inputValue();
      hold = true;
      const changedPrice = originalPrice === "1600000" ? "1700000" : "1600000";
      await price.fill(changedPrice);
      expect(await save(page).isEnabled()).toBe(false);
      await expect.poll(() => held.length).toBe(1);
      await price.fill(originalPrice);
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByTestId("invoice-clinical-preview-0").getAttribute("data-preview-state")).not.toBe("ready");
      await expect.poll(() => held.length).toBe(2);
      expect(held[0].request().postDataJSON().items[0].price).toBe(changedPrice);
      expect(held[1].request().postDataJSON().items[0].price).toBe(originalPrice);
      // The retired B transport may have been aborted; it must never make the current A ready.
      await json(held[0], success(held[0])).catch(() => undefined);
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByTestId("invoice-clinical-preview-0").getAttribute("data-preview-state")).not.toBe("ready");
      await json(held[1], success(held[1]));
      await ready(page);
      expect(await save(page).isEnabled()).toBe(true);
      expect(await price.inputValue()).toBe(originalPrice);
      expect(submissions).toBe(0);
      expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1", [patientId])).rows).toHaveLength(0);
    } finally {
      await Promise.all(held.map((route) => route.abort().catch(() => undefined)));
      await context.close();
    }
  });

  it("invalidates prior success immediately, blocks a pending/failed save, and recovers only after an explicit successful retry", async () => {
    const { page, context, patientId } = await openInvoice();
    let held: Route | null = null;
    let hold = false;
    let submissions = 0;
    await page.route("**/api/invoices", async (route) => { submissions++; await route.abort(); });
    await page.route("**/api/invoices/clinical-preview", async (route) => {
      if (hold) { held = route; return; }
      await json(route, success(route));
    });
    try {
      await selectFilling(page);
      await ready(page);
      expect(await save(page).isEnabled()).toBe(true);
      hold = true;
      await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).fill("1600000");
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByTestId("invoice-clinical-preview-0").innerText()).not.toContain("بند خطة جديد");
      try {
        await expect.poll(() => held !== null, { timeout: 30_000 }).toBe(true);
      } catch {
        throw new Error(`the held preview handler was never reached: ${JSON.stringify(await transport(page))}`);
      }
      await json(held!, { message: "unavailable" }, 503);
      await page.locator('[data-preview-state="unavailable"]').waitFor();
      expect(await save(page).isEnabled()).toBe(false);
      hold = false;
      await page.getByRole("button", { name: "إعادة المعاينة" }).click();
      await ready(page);
      expect(await save(page).isEnabled()).toBe(true);
      expect(submissions).toBe(0);
      expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    } finally { await context.close(); }
  });

  it("shows refusal without an affirmative creation promise, rejects malformed evidence, and contains a failed request", async () => {
    const { page, context } = await openInvoice();
    let mode: "refused" | "malformed" | "network" = "refused";
    await page.route("**/api/invoices/clinical-preview", async (route) => {
      if (mode === "network") { await route.abort("failed"); return; }
      await json(route, mode === "refused" ? success(route, "already_billed") : { lines: [] });
    });
    try {
      await selectFilling(page);
      await page.locator('[data-preview-state="refused"]').waitFor();
      expect(await page.getByTestId("invoice-clinical-preview-0").innerText()).toContain("هذا العلاج مفوتر سابقًا");
      expect(await page.getByTestId("invoice-clinical-preview-0").innerText()).not.toContain("ستنشئ/تربط");
      expect(await save(page).isEnabled()).toBe(false);
      mode = "malformed";
      await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).fill("1700000");
      await page.locator('[data-preview-state="unavailable"]').waitFor();
      expect(await save(page).isEnabled()).toBe(false);
      mode = "network";
      await page.getByRole("button", { name: "إعادة المعاينة" }).click();
      await page.locator('[data-preview-state="unavailable"]').waitFor();
      expect(await save(page).isEnabled()).toBe(false);
    } finally { await context.close(); }
  });

  it("preserves an actionable server price/discount refusal rather than hiding it behind retry", async () => {
    const { page, context } = await openInvoice();
    let reject = true;
    const previews: number[] = [];
    await page.route("**/api/invoices/clinical-preview", (route) => {
      previews.push(reject ? 400 : 200);
      return reject ? json(route, { message: "اكتب سبب الخصم قبل الحفظ." }, 400) : json(route, success(route));
    });
    try {
      await selectFilling(page);
      await waitForState(page.getByTestId("invoice-clinical-preview-0"), "data-preview-state", "refused", () => ({
        previews, url: page.url() }));
      // The intended 400 handler was actually exercised (not a real-server or service-worker response).
      expect(previews.filter((status) => status === 400).length, JSON.stringify(await transport(page))).toBeGreaterThan(0);
      expect((networkByPage.get(page) ?? []).some((one) => one.url.endsWith("/clinical-preview") && one.status === 400 && !one.fromServiceWorker)).toBe(true);
      expect(await page.getByTestId("invoice-clinical-preview-0").innerText()).toContain("اكتب سبب الخصم قبل الحفظ.");
      // The actionable refusal itself is visible to the user (a hidden attached refusal must not pass).
      expect(await page.getByTestId("invoice-clinical-preview-0").getByText("اكتب سبب الخصم قبل الحفظ.").isVisible()).toBe(true);
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByRole("button", { name: "إعادة المعاينة" }).count()).toBe(0);
      reject = false;
      await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).fill("1600000");
      await ready(page);
    } finally { await context.close(); }
  });

  it("does not move a removed row's preview onto its successor at the same index", async () => {
    const { page, context } = await openInvoice();
    let held: Route | null = null;
    let hold = false;
    await page.route("**/api/invoices/clinical-preview", async (route) => {
      if (hold) { held = route; return; }
      await json(route, success(route));
    });
    try {
      await selectFilling(page);
      await ready(page);
      await page.getByRole("button", { name: "+ بند آخر", exact: true }).click();
      await selectFilling(page, 1, 36);
      await ready(page, 1);
      const successor = await page.getByTestId("invoice-row-1").getAttribute("data-row-key");
      hold = true;
      await page.getByTestId("invoice-row-0").getByTitle("حذف البند", { exact: true }).click();
      expect(await page.getByTestId("invoice-row-0").getAttribute("data-row-key")).toBe(successor);
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByTestId("invoice-clinical-preview-0").getAttribute("data-preview-state")).toBe("pending");
      await expect.poll(() => held !== null).toBe(true);
      await json(held!, success(held!));
      await ready(page);
      expect(await save(page).isEnabled()).toBe(true);
    } finally { await context.close(); }
  });

  it("ignores an older delayed response after changing to a financial-only service", async () => {
    const { page, context } = await openInvoice();
    let held: Route | null = null;
    await page.route("**/api/invoices/clinical-preview", async (route) => { held = route; });
    try {
      await selectFilling(page);
      await expect.poll(() => held !== null).toBe(true);
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(consultation));
      expect(await page.getByTestId("invoice-clinical-preview-0").count()).toBe(0);
      expect(await save(page).isEnabled()).toBe(true);
      await json(held!, success(held!)).catch(() => undefined); // The old request may already be aborted.
      expect(await page.getByTestId("invoice-clinical-preview-0").count()).toBe(0);
      expect(await page.getByTestId("invoice-tooth-chip-0").count()).toBe(0);
    } finally { await context.close(); }
  });

  it.each([
    { price: "abc", quantity: "1", currency: "YER" },
    { price: "", quantity: "1", currency: "SAR" },
    { price: "", quantity: "1", currency: "USD" },
    { price: "1500000", quantity: "1000", currency: "YER" },
  ])("invalid current values never retain a ready preview or enable save: %j", async (input) => {
    const { page, context } = await openInvoice();
    await page.route("**/api/invoices/clinical-preview", (route) => json(route, success(route)));
    try {
      await selectFilling(page);
      await ready(page);
      await page.getByLabel("عملة الفاتورة", { exact: true }).selectOption(input.currency);
      await page.getByTestId("invoice-row-0").getByLabel("السعر", { exact: true }).fill(input.price);
      await page.getByTestId("invoice-row-0").getByLabel("الكمية", { exact: true }).fill(input.quantity);
      await page.locator('[data-testid="invoice-clinical-preview-0"][data-preview-state="invalid"]').waitFor();
      expect(await save(page).isEnabled()).toBe(false);
      expect(await page.getByTestId("invoice-input-problem-0").innerText()).not.toBe("");
      expect(await page.getByTestId("invoice-clinical-preview-0").innerText()).not.toContain("ستنشئ/تربط");
    } finally { await context.close(); }
  });

  it("uses an explicit provider choice for both preview and save, then clears it on a different service", async () => {
    const { page, context, patientId } = await openInvoice();
    const requests: {
      saved: { items: { doctorId?: number }[] } | null;
      previewed: { items: { doctorId?: number | null }[] } | null;
    } = { saved: null, previewed: null };
    await page.route("**/api/invoices/clinical-preview", async (route) => {
      requests.previewed = route.request().postDataJSON();
      await json(route, success(route));
    });
    await page.route("**/api/invoices", async (route) => {
      requests.saved = route.request().postDataJSON();
      await json(route, { message: "Synthetic stopped save: no write was sent." }, 503);
    });
    try {
      await selectFilling(page);
      await ready(page);
      const provider = page.getByTestId("invoice-provider-0");
      expect(await provider.inputValue()).toBe("");
      expect(await page.getByTestId("invoice-provider-review-0").innerText()).toContain("المراجعة المالية مطلوبة");
      await provider.selectOption(String(doctorPartyId));
      expect(await save(page).isEnabled()).toBe(false);
      await ready(page);
      expect(requests.previewed?.items[0].doctorId).toBe(doctorPartyId);
      expect(await page.getByTestId("invoice-provider-review-0").count()).toBe(0);
      await save(page).click();
      await expect.poll(() => requests.saved !== null).toBe(true);
      expect(requests.saved?.items[0].doctorId).toBe(doctorPartyId);
      await page.getByText("Synthetic stopped save: no write was sent.", { exact: true }).waitFor();
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(consultation));
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(filling));
      expect(await page.getByTestId("invoice-provider-0").inputValue()).toBe("");
      expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    } finally { await context.close(); }
  });

  it.each(["failure", "malformed"])("%s chart reads show unknown selectable anatomy; surfaces reset on tooth change and focus remains in the dialog", async (failure) => {
    const { page, context } = await openInvoice();
    const charts: string[] = [];
    await page.route("**/api/patients/*/chart", async (route) => {
      charts.push(route.request().url());
      await json(route, failure === "failure" ? { message: "unavailable" } : { records: [{ toothCode: 26 }] }, failure === "failure" ? 503 : 200);
    });
    await page.route("**/api/invoices/clinical-preview", (route) => json(route, success(route)));
    try {
      await page.getByTestId("invoice-row-0").getByLabel("الخدمة", { exact: true }).selectOption(String(filling));
      const opener = page.getByTestId("invoice-tooth-button-0");
      await opener.click();
      const dialog = page.getByTestId("tooth-dialog");
      await waitForState(dialog, "data-chart-state", "unavailable", () => ({ charts, url: page.url() }));
      // The unavailable state is shown to the user before any tooth is picked.
      expect(await dialog.getByText("تعذّر تحميل حالة الأسنان", { exact: false }).isVisible()).toBe(true);
      const tooth = dialog.getByTestId("odontogram-tooth-26");
      expect(await tooth.getAttribute("data-chart-known")).toBe("false");
      expect(await tooth.getAttribute("aria-label")).toContain("الحالة غير متاحة");
      expect(await tooth.locator("path").first().getAttribute("stroke-dasharray")).toBe("2 2");
      expect(await tooth.isEnabled()).toBe(true);
      await tooth.click();
      await dialog.getByTestId("surface-M").click();
      await dialog.getByTestId("surface-O").click();
      await dialog.getByTestId("odontogram-tooth-27").click();
      expect(await dialog.getByTestId("surface-M").getAttribute("aria-pressed")).toBe("false");
      expect(await dialog.getByTestId("surface-O").getAttribute("aria-pressed")).toBe("false");
      await dialog.getByRole("button", { name: "إغلاق", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      expect(await page.getByTestId("tooth-dialog-confirm").evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await dialog.getByRole("button", { name: "إغلاق", exact: true }).evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await page.getByTestId("invoice-row-0").getAttribute("data-tooth")).toBe("");
    } finally { await context.close(); }
  });
});
