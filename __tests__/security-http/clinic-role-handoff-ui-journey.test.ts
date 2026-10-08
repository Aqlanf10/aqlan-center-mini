import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response as BrowserResponse } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { baseUrl, harness, type RoleSessions } from "./_server";
import { formatMoney } from "../../lib/money";

/**
 * Actual built-app role handoff on the existing disposable HTTP database.
 * No fulfilled business responses, role impersonation, Production URL, real
 * patient, workflow change or product change. Only two search-only patients
 * and one catalogue service are SQL fixtures. The story's patient, visit,
 * doctor assignment, notes, invoice and receipt are created by real UI actions.
 * This bounded story is YER consultation / on-account partial collection.
 * It does not certify plans, consent, specialty episodes, refunds or day close.
 */
const SUITE = "__tests__/security-http/clinic-role-handoff-ui-journey.test.ts";
const SOURCE_BASE = "bdcaf5bb4829e429fada5f77e23844e0bfb87fa9";
const stamp = randomUUID().replace(/\d/g, (digit) => "ABCDEFGHIJ"[Number(digit)]);
const patientName = `مريض رحلة الأدوار الاصطناعية ${stamp}`;
const alertText = `تنبيه اصطناعي لا يخص مريضاً حقيقياً ${stamp}`;
const serviceName = `كشف اصطناعي لرحلة الأدوار ${stamp}`;
const searchA = `QASEARCHALPHA${stamp}`;
const searchB = `QASEARCHBETA${stamp}`;
const TOTAL = 12_000;
const COLLECTED = 4_000;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let serviceId = 0;
let doctorId = 0;
const contexts: BrowserContext[] = [];
const externalRequests: string[] = [];
const pageErrors: string[] = [];
const evidence: { scene: string; sha256: string; bytes: number; width: number; height: number }[] = [];
let evidenceBytes = 0;

function cookie(raw: string) {
  const [name, ...value] = raw.split("=");
  return { name, value: value.join("=") };
}

type StaffRole = Exclude<keyof RoleSessions, "portalA" | "portalB">;
async function screen(role: StaffRole, width = 1280) {
  const context = await browser.newContext({
    viewport: { width, height: 900 }, locale: "ar-YE", serviceWorkers: "block",
  });
  contexts.push(context);
  await context.addCookies([{ ...cookie(h.sessions[role].cookie), url: baseUrl }]);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl) {
      externalRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  // Passive driver events only: do not replace fetch, response methods or
  // consumption of an obsolete response in the application under test.
  let transportEvents = 0;
  const recordTransport = (urlValue: string, phase: string, status?: number) => {
    const url = new URL(urlValue);
    if (url.origin !== baseUrl || url.pathname !== "/api/patients" || !url.searchParams.has("q")
      || transportEvents >= 40) return;
    transportEvents += 1;
    const query = url.searchParams.get("q") ?? "";
    console.log(`ROLE_QA_TRANSPORT ${JSON.stringify({ role, phase, status,
      queryClass: query.startsWith("QASEARCHALPHA") ? "alpha" : query.startsWith("QASEARCHBETA") ? "beta" : "other" })}`);
  };
  page.on("response", (response) => recordTransport(response.url(), "headers", response.status()));
  page.on("requestfinished", (request) => recordTransport(request.url(), "finished"));
  page.on("requestfailed", (request) => recordTransport(request.url(), "failed"));
  page.on("pageerror", (error) => pageErrors.push(`${role}: ${error.message}`));
  // An alert is not an acceptance gate. Confirmations are never auto-accepted.
  page.on("dialog", (dialog) => void dialog.dismiss());
  return { context, page };
}

async function get<T>(context: BrowserContext, path: string): Promise<T> {
  expect(path.startsWith("/api/")).toBe(true);
  const response = await context.request.get(`${baseUrl}${path}`);
  expect(response.status(), path).toBe(200);
  return await response.json() as T;
}

async function bodyPaint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function observeReleasedResponse(page: Page, response: BrowserResponse, scene: string) {
  expect(response.status()).toBe(200);
  // A retired response need not be consumed by the product. Transport finish
  // is useful diagnostic evidence, not a prerequisite for UI authority. Never
  // drain a response/clone or change the application's fetch scheduling here.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    response.finished().then((result) => result === null, () => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1000); }),
  ]);
  if (timer) clearTimeout(timer);
  await bodyPaint(page);
  console.log(`ROLE_QA_RELEASED ${JSON.stringify({ scene, routeFulfillAcknowledged: true,
    actualHeadersStatus: response.status(), finishedObservedWithinOneSecond: finished })}`);
}

type ChoiceWatch = { obsoleteSeen: boolean; observer: MutationObserver };
async function watchObsoleteChoice(page: Page, marker: string) {
  await page.evaluate((needle) => {
    const target = document.querySelector('[role="dialog"][aria-label="اختيار مريض لإصدار سند قبض"]');
    if (!target) throw new Error("Patient picker missing before old-response release");
    const global = window as unknown as { __roleQaChoiceWatch?: ChoiceWatch };
    global.__roleQaChoiceWatch?.observer.disconnect();
    const watch = { obsoleteSeen: false, observer: null as unknown as MutationObserver };
    const inspect = () => {
      if (Array.from(target.querySelectorAll("button")).some((button) => button.textContent?.includes(needle))) {
        watch.obsoleteSeen = true;
      }
    };
    watch.observer = new MutationObserver(inspect);
    watch.observer.observe(target, { subtree: true, childList: true, characterData: true });
    inspect();
    global.__roleQaChoiceWatch = watch;
  }, marker);
}
async function endChoiceWatch(page: Page) {
  return await page.evaluate(() => {
    const global = window as unknown as { __roleQaChoiceWatch?: ChoiceWatch };
    const watch = global.__roleQaChoiceWatch;
    if (!watch) throw new Error("Patient choice observation missing");
    watch.observer.disconnect();
    delete global.__roleQaChoiceWatch;
    return watch.obsoleteSeen;
  });
}

async function capture(page: Page, scene: string, target?: Locator) {
  if (target) await target.scrollIntoViewIfNeeded();
  await bodyPaint(page);
  // Only exact synthetic viewport scenes, never HAR, trace, cookies or state.
  const bytes = await page.screenshot({ type: "png", fullPage: false });
  expect(bytes.length).toBeLessThanOrEqual(512 * 1024);
  expect(evidenceBytes + bytes.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  evidenceBytes += bytes.length;
  const view = page.viewportSize();
  expect(view).not.toBeNull();
  const entry = { scene, sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length, width: view!.width, height: view!.height };
  evidence.push(entry);
  const encoded = bytes.toString("base64");
  const chunks = Math.ceil(encoded.length / 4096);
  console.log(`ROLE_QA_IMAGE ${JSON.stringify({ ...entry, chunks, encoding: "base64", claim: "observed-scene-not-test-pass" })}`);
  for (let index = 0; index < chunks; index += 1) {
    console.log(`ROLE_QA_CHUNK ${JSON.stringify({ scene, index, data: encoded.slice(index * 4096, (index + 1) * 4096) })}`);
  }
}

async function identity(page: Page, id: number) {
  await expect.poll(() => page.url()).toContain(`/patients/${id}`);
  await expect.poll(() => page.getByTestId("patient-workspace").innerText()).toContain(patientName);
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
}

function noteField(page: Page, label: string) {
  return page.locator(`#visit-notes label:has(> span:text-is("${label}")) > textarea`);
}

interface ShiftRead {
  open: { id: number } | null;
  drawer: { expected: { YER: number; SAR: number; USD: number } } | null;
}
interface LedgerRead {
  balances: Record<string, { dueMinor: number; billedMinor: number; collectedMinor: number; openingMinor: number }>;
  invoices: { id: number; totalMinor: number; discountMinor: number; baseCurrency: string }[];
  payments: { id: number; amountMinor: number; currency: string; patientId: number }[];
}

async function ensureOpenShift(manager: { context: BrowserContext; page: Page }) {
  const existing = await get<ShiftRead>(manager.context, "/api/shifts");
  if (existing.open) return existing;
  await manager.page.goto(`${baseUrl}/finance/reconciliation`, { waitUntil: "domcontentloaded" });
  await manager.page.getByRole("button", { name: "فتح وردية جديدة", exact: true }).click();
  const response = manager.page.waitForResponse((item) => new URL(item.url()).pathname === "/api/shifts"
    && item.request().method() === "POST");
  await manager.page.getByRole("button", { name: "تأكيد وفتح الوردية", exact: true }).click();
  expect((await response).status()).toBe(201);
  return await get<ShiftRead>(manager.context, "/api/shifts");
}

beforeAll(async () => {
  h = await harness();
  const appUrl = new URL(baseUrl);
  const databaseUrl = new URL(h.seeded.dbUrl);
  // Fail before any fixture SQL or browser mutation if this is not the existing
  // loopback-only security harness. Never print the connection string.
  expect(appUrl.protocol).toBe("http:");
  expect(appUrl.hostname).toBe("127.0.0.1");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(databaseUrl.hostname);
  expect(databaseUrl.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  expect((await db.query<{ name: string }>("SELECT current_database() AS name")).rows[0].name).toBe("aqlan_sec_http");
  doctorId = Number((await db.query<{ party_id: number }>(
    "SELECT party_id FROM users WHERE username = 'secdoctora' AND role = 'doctor' AND is_active = TRUE",
  )).rows[0].party_id);
  expect(doctorId).toBeGreaterThan(0);
  serviceId = Number((await db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured, price_sar_minor, price_usd_minor)
     VALUES ($1, 'consultation', $2, TRUE, NULL, NULL) RETURNING id`, [serviceName, TOTAL],
  )).rows[0].id);
  for (const marker of [searchA, searchB]) {
    await db.query("INSERT INTO patients (patient_number, full_name) VALUES ($1, $2)", [marker, `مريض بحث اصطناعي ${marker}`]);
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);

afterAll(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  await browser?.close();
  await db?.end();
  // Global setup owns the disposable database cleanup. No fixture table reset,
  // financial deletion, shift rewrite or removal of another test's records.
  console.log(`ROLE_QA_MANIFEST ${JSON.stringify({
    protocol: 1, suite: SUITE, sourceBase: SOURCE_BASE,
    testSha256: createHash("sha256").update(readFileSync(SUITE)).digest("hex"),
    executionSha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    claim: "scene-evidence-only-use-exact-CI-results-for-pass-fail", evidenceBytes, images: evidence,
  })}`);
});

describe("real clinic role handoff on one synthetic patient", () => {
  it("reception → manager assignment → doctor sign → cashier receipt → accountant and manager reconciliation", async () => {
    const reception = await screen("reception");
    const manager = await screen("admin");
    const doctor = await screen("doctorA");
    const cashier = await screen("cashier", 390);
    const accountant = await screen("accountant");
    const shiftBefore = await ensureOpenShift(manager);
    expect(shiftBefore.open?.id).toBeGreaterThan(0);
    expect(shiftBefore.drawer).not.toBeNull();

    await reception.page.goto(`${baseUrl}/patients`, { waitUntil: "domcontentloaded" });
    await reception.page.getByRole("button", { name: "+ مريض جديد", exact: true }).click();
    await reception.page.getByLabel("الاسم الكامل", { exact: true }).fill(patientName);
    await reception.page.getByLabel("سنة الميلاد", { exact: true }).fill("1990");
    await reception.page.getByLabel("تنبيه طبي", { exact: true }).fill(alertText);
    const createdResponse = reception.page.waitForResponse((item) => new URL(item.url()).pathname === "/api/patients"
      && item.request().method() === "POST");
    await reception.page.getByRole("button", { name: "احفظ وافتح الملف", exact: true }).click();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    // The real form navigates with window.location immediately after success.
    // Chromium can retire its response body first; inspect the committed row
    // instead of racing response.json() against the application's navigation.
    const registered = (await db.query<{ id: number; patientNumber: string }>(
      'SELECT id, patient_number AS "patientNumber" FROM patients WHERE full_name = $1', [patientName],
    )).rows;
    expect(registered).toHaveLength(1);
    const patient = registered[0];
    expect(patient.id).toBeGreaterThan(0);
    await identity(reception.page, patient.id);
    expect((await db.query("SELECT id FROM patients WHERE full_name = $1", [patientName])).rows).toHaveLength(1);
    await reception.page.getByTestId("patient-tab-today").click();
    const startedResponse = reception.page.waitForResponse((item) => new URL(item.url()).pathname === "/api/visits"
      && item.request().method() === "POST");
    await reception.page.getByRole("button", { name: /بدء زيارة اليوم/ }).click();
    const started = await startedResponse;
    expect(started.status()).toBe(201);
    const visit = await started.json() as { id: number; patientId: number; status: string };
    expect(visit.patientId).toBe(patient.id);
    expect(visit.status).toBe("waiting");
    await reception.page.getByRole("region", { name: "زيارة اليوم", exact: true }).waitFor();
    expect(await reception.page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).count()).toBe(0);
    await capture(reception.page, "reception-waiting-1280", reception.page.getByRole("region", { name: "زيارة اليوم", exact: true }));

    // Assignment is a real manager UI action, not a SQL shortcut around doctor
    // patient-scope enforcement. The reception walk-in form has no doctor field.
    await manager.page.goto(`${baseUrl}/patients/${patient.id}?tab=today`, { waitUntil: "domcontentloaded" });
    await identity(manager.page, patient.id);
    await manager.page.getByLabel("الطبيب المعالج").selectOption(String(doctorId));
    const assignedResponse = manager.page.waitForResponse((item) => new URL(item.url()).pathname === `/api/visits/${visit.id}/clinical`
      && item.request().method() === "POST");
    await manager.page.getByRole("button", { name: "احفظ بلا توقيع", exact: true }).click();
    expect((await assignedResponse).status()).toBe(200);
    const assigned = (await db.query("SELECT patient_id, doctor_id, signed_at FROM visits WHERE id = $1", [visit.id])).rows[0];
    expect(Number(assigned.patient_id)).toBe(patient.id);
    expect(Number(assigned.doctor_id)).toBe(doctorId);
    expect(assigned.signed_at).toBeNull();

    await doctor.page.goto(`${baseUrl}/patients/${patient.id}?tab=today`, { waitUntil: "domcontentloaded" });
    await identity(doctor.page, patient.id);
    await expect.poll(() => doctor.page.getByTestId("patient-workspace").innerText()).toContain(alertText);
    await noteField(doctor.page, "① الشكوى الرئيسية").fill("فحص اصطناعي لا يخص مريضاً حقيقياً");
    await noteField(doctor.page, "② الفحص").fill("نتيجة فحص اصطناعية لاختبار انتقال السياق");
    await noteField(doctor.page, "② التشخيص").fill(`تشخيص اصطناعي خاص ${stamp}`);
    await doctor.page.getByLabel("أضف إجراءً", { exact: true }).selectOption(String(serviceId));
    await noteField(doctor.page, "③ ما نُفّذ").fill("كشف اصطناعي مسجل مرة واحدة");
    await noteField(doctor.page, "الخطة القادمة").fill("لا توجد متابعة حقيقية، سيناريو قبول اصطناعي");
    await doctor.page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).click();
    const review = doctor.page.getByRole("dialog", { name: "مراجعة وإنهاء الزيارة", exact: true });
    await review.waitFor();
    expect(await review.innerText()).toContain(patientName);
    expect(await review.innerText()).toContain(formatMoney(TOTAL, "YER"));
    await capture(doctor.page, "doctor-sign-review-1280", review);
    await review.getByRole("button", { name: "رجوع — أكمل العمل", exact: true }).click();
    expect((await db.query("SELECT signed_at FROM visits WHERE id = $1", [visit.id])).rows[0].signed_at).toBeNull();
    expect((await db.query("SELECT id FROM invoices WHERE patient_id = $1", [patient.id])).rows).toHaveLength(0);
    await doctor.page.getByRole("button", { name: "مراجعة وإنهاء الزيارة", exact: true }).click();
    const signedResponse = doctor.page.waitForResponse((item) => new URL(item.url()).pathname === `/api/visits/${visit.id}/clinical`
      && item.request().method() === "POST" && item.request().postDataJSON()?.action === "sign");
    await review.getByRole("button", { name: /وقّع الزيارة|تأكيد إنهاء الزيارة/ }).click();
    const signed = await signedResponse;
    expect(signed.status()).toBe(200);
    const signResult = await signed.json() as { invoiceId: number };
    expect(signResult.invoiceId).toBeGreaterThan(0);
    const bills = (await db.query("SELECT id, total_minor::text, discount_minor::text, base_currency FROM invoices WHERE patient_id = $1", [patient.id])).rows;
    expect(bills).toHaveLength(1);
    expect(Number(bills[0].id)).toBe(signResult.invoiceId);
    expect(Number(bills[0].total_minor) - Number(bills[0].discount_minor)).toBe(TOTAL);
    expect(bills[0].base_currency).toBe("YER");
    expect((await db.query("SELECT signed_by FROM visits WHERE id = $1", [visit.id])).rows[0].signed_by).toBe("secdoctora");

    await cashier.page.goto(`${baseUrl}/finance`, { waitUntil: "domcontentloaded" });
    await cashier.page.getByRole("button", { name: /سند قبض سريع/ }).click();
    const picker = cashier.page.getByRole("dialog", { name: "اختيار مريض لإصدار سند قبض", exact: true });
    await picker.getByPlaceholder("ابحث بالاسم أو رقم الهاتف أو الملف…").fill(patient.patientNumber);
    const patientChoice = picker.getByRole("button").filter({ hasText: patientName });
    await patientChoice.waitFor();
    expect(await patientChoice.innerText()).toContain(patient.patientNumber);
    await patientChoice.click();
    const collect = cashier.page.getByRole("dialog", { name: "تحصيل دفعة", exact: true });
    await collect.waitFor();
    expect(await collect.innerText()).toContain(patientName);
    expect(await collect.innerText()).not.toContain(alertText);
    await collect.getByLabel("المبلغ", { exact: true }).fill(String(COLLECTED));
    // Explicit foreign-target refusal before restoring this YER-only scenario.
    await collect.getByLabel("العملة", { exact: true }).selectOption("SAR");
    expect(await collect.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true }).isDisabled()).toBe(true);
    await collect.getByRole("alert").filter({ hasText: "هدف تسوية صريحًا" }).waitFor();
    await capture(cashier.page, "cashier-foreign-target-refusal-390", collect);
    await collect.getByLabel("العملة", { exact: true }).selectOption("YER");
    const paymentRequests: string[] = [];
    cashier.page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/payments" && request.method() === "POST") {
        paymentRequests.push(request.headers()["idempotency-key"] ?? "");
      }
    });
    const paymentResponse = cashier.page.waitForResponse((item) => new URL(item.url()).pathname === "/api/payments"
      && item.request().method() === "POST");
    await collect.getByRole("button", { name: "سجّل الدفعة واطبع السند", exact: true }).dblclick();
    const paymentResult = await paymentResponse;
    expect([200, 201]).toContain(paymentResult.status());
    const receipt = await paymentResult.json() as { id: number };
    await collect.waitFor({ state: "hidden" });
    const receipts = (await db.query("SELECT id, patient_id, amount_minor::text, currency, kind, method, created_by, invoice_id, shift_id FROM payments WHERE patient_id = $1", [patient.id])).rows;
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].id)).toBe(receipt.id);
    expect(Number(receipts[0].patient_id)).toBe(patient.id);
    expect(Number(receipts[0].amount_minor)).toBe(COLLECTED);
    expect(receipts[0]).toMatchObject({ currency: "YER", kind: "payment", method: "cash", created_by: "seccashier", invoice_id: null });
    expect(Number(receipts[0].shift_id)).toBe(shiftBefore.open!.id);
    expect(paymentRequests.length).toBeGreaterThan(0);
    expect(paymentRequests.every((key) => /^[A-Za-z0-9._:-]{8,128}$/.test(key))).toBe(true);
    expect(new Set(paymentRequests).size).toBe(1);

    await cashier.page.getByPlaceholder("بحث باسم المريض أو رقم السند…").fill(patientName);
    const printLink = cashier.page.locator(`a[href="/print/receipt/${receipt.id}"]`);
    await printLink.waitFor();
    const receiptPagePromise = cashier.context.waitForEvent("page");
    await printLink.click();
    const printed = await receiptPagePromise;
    await printed.waitForLoadState("domcontentloaded");
    await expect.poll(() => printed.locator("body").innerText()).toContain(patientName);
    expect(await printed.locator("body").innerText()).toContain(formatMoney(COLLECTED, "YER"));
    expect(await printed.locator("body").innerText()).not.toContain(alertText);
    await capture(printed, "cashier-receipt-390");
    await printed.close();

    await accountant.page.goto(`${baseUrl}/finance`, { waitUntil: "domcontentloaded" });
    await accountant.page.getByRole("note").filter({ hasText: "وضع الاطلاع" }).waitFor();
    await accountant.page.getByPlaceholder("بحث باسم المريض أو رقم السند…").fill(patientName);
    await accountant.page.locator(`a[href="/print/receipt/${receipt.id}"]`).waitFor();
    expect(await accountant.page.locator("main").last().innerText()).toContain(formatMoney(COLLECTED, "YER"));
    expect(await accountant.page.locator("main").last().innerText()).not.toContain(alertText);
    for (const name of [/سند قبض سريع/, /سند صرف نثري/, /إغلاق الوردية/, /تصحيح السند/]) {
      expect(await accountant.page.getByRole("button", { name }).count(), String(name)).toBe(0);
    }
    await capture(accountant.page, "accountant-receipt-readonly-1280", accountant.page.locator(`a[href="/print/receipt/${receipt.id}"]`));
    const ledger = await get<LedgerRead>(accountant.context, `/api/patients/${patient.id}/ledger`);
    expect(ledger.balances.YER.dueMinor).toBe(TOTAL - COLLECTED);
    expect(ledger.balances.YER.billedMinor).toBe(TOTAL);
    expect(ledger.balances.YER.collectedMinor).toBe(COLLECTED);
    expect(ledger.balances.SAR).toEqual({ billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 });
    expect(ledger.balances.USD).toEqual({ billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 });
    expect(ledger.invoices).toHaveLength(1);
    expect(ledger.payments).toHaveLength(1);
    const deniedCollection = await accountant.context.request.post(`${baseUrl}/api/payments`, {
      headers: { Origin: baseUrl, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": `role-qa-denied-${stamp}` },
      data: { patientId: patient.id, amount: "1", currency: "YER", kind: "payment", method: "cash" },
    });
    expect(deniedCollection.status()).toBe(403);
    expect((await db.query("SELECT id FROM payments WHERE patient_id = $1", [patient.id])).rows).toHaveLength(1);

    // Actual browser redirects and fresh denied API reads use the same real
    // patient. These are not simulated role labels on an administrator cookie.
    for (const restricted of [cashier, accountant]) {
      expect((await restricted.context.request.get(`${baseUrl}/api/patients/${patient.id}`)).status()).toBe(403);
      expect((await restricted.context.request.get(`${baseUrl}/api/visits/${visit.id}/clinical`)).status()).toBe(403);
      await restricted.page.goto(`${baseUrl}/patients/${patient.id}`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => new URL(restricted.page.url()).pathname).toBe("/finance");
      expect(await restricted.page.locator("body").innerText()).not.toContain(alertText);
    }
    const otherDoctor = await screen("doctorB");
    expect((await otherDoctor.context.request.get(`${baseUrl}/api/patients/${patient.id}`)).status()).toBe(403);
    expect((await doctor.context.request.get(`${baseUrl}/api/patients/${patient.id}/ledger`)).status()).toBe(403);
    const shiftAfter = await get<ShiftRead>(manager.context, "/api/shifts");
    expect(shiftAfter.open?.id).toBe(shiftBefore.open?.id);
    expect(shiftAfter.drawer!.expected.YER - shiftBefore.drawer!.expected.YER).toBe(COLLECTED);
    expect(shiftAfter.drawer!.expected.SAR).toBe(shiftBefore.drawer!.expected.SAR);
    expect(shiftAfter.drawer!.expected.USD).toBe(shiftBefore.drawer!.expected.USD);
    await manager.page.goto(`${baseUrl}/finance/reconciliation`, { waitUntil: "domcontentloaded" });
    await manager.page.getByRole("button", { name: "جرد وإقفال الوردية", exact: true }).waitFor();
    await expect.poll(() => manager.page.locator("main").last().innerText()).toContain(formatMoney(shiftAfter.drawer!.expected.YER, "YER"));
    await capture(manager.page, "manager-reconciliation-1280");
    await manager.page.getByRole("button", { name: "جرد وإقفال الوردية", exact: true }).click();
    for (const currency of ["YER", "SAR", "USD"]) expect(await manager.page.getByLabel(`المعدود ${currency}`).inputValue()).toBe("");
    await manager.page.getByRole("button", { name: "إلغاء", exact: true }).click();
    expect((await get<ShiftRead>(manager.context, "/api/shifts")).open?.id).toBe(shiftBefore.open?.id);
    expect(externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    console.log(`ROLE_QA_FACTS ${JSON.stringify({ scenario: "cross-role-handoff", patientId: patient.id,
      visitId: visit.id, invoiceId: signResult.invoiceId, receiptId: receipt.id,
      invoiceMinor: TOTAL, paymentMinor: COLLECTED, balanceMinor: TOTAL - COLLECTED, currency: "YER",
      roles: ["reception", "admin", "doctor", "cashier", "accountant"],
      shiftAction: "read-and-cancel-only", clinicalScope: "consultation-no-plan-or-consent" })}`);
  }, 240_000);

  it("cashier search keeps the latest patient query after an older real response arrives", async () => {
    const cashier = await screen("cashier", 390);
    const manager = await screen("admin");
    await ensureOpenShift(manager);
    await cashier.page.goto(`${baseUrl}/finance`, { waitUntil: "domcontentloaded" });
    await cashier.page.getByRole("button", { name: /سند قبض سريع/ }).click();
    const picker = cashier.page.getByRole("dialog", { name: "اختيار مريض لإصدار سند قبض", exact: true });
    const input = picker.getByPlaceholder("ابحث بالاسم أو رقم الهاتف أو الملف…");
    let releaseOld: (() => void) | null = null;
    let oldSettled: Promise<void> | null = null;
    let oldStatus = 0;
    let oldCount = 0;
    await cashier.page.route("**/api/patients?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("q") !== searchA) { await route.continue(); return; }
      oldCount += 1;
      const actual = await route.fetch();
      oldStatus = actual.status();
      // Delay the genuine backend result; do not invent a patient or success.
      const released = new Promise<void>((resolve) => { releaseOld = resolve; });
      oldSettled = released.then(async () => { await route.fulfill({ response: actual }); });
      await oldSettled;
    });
    const countsBefore = (await db.query("SELECT COUNT(*)::int AS n FROM payments WHERE patient_id IN (SELECT id FROM patients WHERE patient_number = ANY($1::text[]))", [[searchA, searchB]])).rows[0].n;
    try {
      await input.fill(searchA);
      await expect.poll(() => releaseOld !== null).toBe(true);
      expect(oldStatus).toBe(200);
      const newer = cashier.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/patients" && url.searchParams.get("q") === searchB;
      });
      await input.fill(searchB);
      expect((await newer).status()).toBe(200);
      await picker.getByRole("button").filter({ hasText: searchB }).waitFor();
      await watchObsoleteChoice(cashier.page, searchA);
      const oldResponse = cashier.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/patients" && url.searchParams.get("q") === searchA;
      });
      (releaseOld as unknown as () => void)();
      await oldSettled;
      await observeReleasedResponse(cashier.page, await oldResponse, "older-query-after-newer");
      const obsoleteSeen = await endChoiceWatch(cashier.page);
      const shownOld = await picker.getByRole("button").filter({ hasText: searchA }).count();
      const shownNew = await picker.getByRole("button").filter({ hasText: searchB }).count();
      const countsAfter = (await db.query("SELECT COUNT(*)::int AS n FROM payments WHERE patient_id IN (SELECT id FROM patients WHERE patient_number = ANY($1::text[]))", [[searchA, searchB]])).rows[0].n;
      await capture(cashier.page, "cashier-search-race-observed-390", picker);
      console.log(`ROLE_QA_FACTS ${JSON.stringify({ scenario: "cashier-patient-search-race", oldCount, oldStatus,
        inputIsLatest: await input.inputValue() === searchB, oldPatientButtons: shownOld, latestPatientButtons: shownNew,
        paymentCountBefore: countsBefore, paymentCountAfter: countsAfter })}`);
      expect(countsAfter).toBe(countsBefore);
      expect(obsoleteSeen, "No obsolete patient may appear even transiently after release").toBe(false);
      expect(await input.inputValue()).toBe(searchB);
      expect(shownOld, "An old patient must never replace the results for the visible latest query").toBe(0);
      expect(shownNew).toBe(1);
    } finally {
      if (releaseOld) (releaseOld as () => void)();
      await oldSettled;
      await cashier.context.close();
    }
  }, 120_000);

  it.each([1280, 390])("cashier edit, clear and same-query reopen retire old real responses at %ipx", async (width) => {
    const cashier = await screen("cashier", width);
    const manager = await screen("admin");
    await ensureOpenShift(manager);
    const held: { release: () => void; done: Promise<void> }[] = [];
    await cashier.page.route("**/api/patients?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("q") !== searchA) { await route.continue(); return; }
      const actual = await route.fetch();
      expect(actual.status()).toBe(200);
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const done = pending.then(async () => { await route.fulfill({ response: actual }); });
      held.push({ release, done });
      await done;
    });
    const open = () => cashier.page.getByRole("button", { name: /سند قبض سريع/ }).click();
    const picker = cashier.page.getByRole("dialog", { name: "اختيار مريض لإصدار سند قبض", exact: true });
    const input = picker.getByPlaceholder("ابحث بالاسم أو رقم الهاتف أو الملف…");
    const oldChoice = picker.getByRole("button").filter({ hasText: searchA });
    const newChoice = picker.getByRole("button").filter({ hasText: searchB });
    const start = async (count: number) => {
      await input.fill(searchA);
      await expect.poll(() => held.length).toBe(count);
    };
    const release = async (index: number) => {
      const response = cashier.page.waitForResponse((item) => {
        const url = new URL(item.url());
        return url.pathname === "/api/patients" && url.searchParams.get("q") === searchA;
      });
      held[index].release();
      await held[index].done;
      await observeReleasedResponse(cashier.page, await response, `reopen-${width}-release-${index}`);
    };
    try {
      await cashier.page.goto(`${baseUrl}/finance`, { waitUntil: "domcontentloaded" });
      await open();
      await start(1); await release(0); await oldChoice.waitFor();
      await input.fill(searchB);
      // Immediate withdrawal, including the debounce interval before B exists.
      expect(await oldChoice.count()).toBe(0);
      await newChoice.waitFor();
      await start(2);
      await picker.getByRole("button", { name: "إلغاء", exact: true }).click();
      await picker.waitFor({ state: "hidden" });
      await open(); expect(await input.inputValue()).toBe("");
      await start(3);
      await watchObsoleteChoice(cashier.page, searchA);
      await release(1); // Old open's response arrives during the same new query.
      expect(await endChoiceWatch(cashier.page)).toBe(false);
      expect(await input.inputValue()).toBe(searchA);
      expect(await oldChoice.count()).toBe(0);
      await capture(cashier.page, `cashier-reopen-waiting-${width}`, picker);
      await release(2); await oldChoice.waitFor();
      await oldChoice.click();
      const collect = cashier.page.getByRole("dialog", { name: "تحصيل دفعة", exact: true });
      await collect.waitFor();
      expect(await collect.innerText()).toContain(searchA);
      expect(await collect.innerText()).not.toContain(searchB);
      await collect.getByRole("button", { name: "إغلاق", exact: true }).click();
      await open(); await start(4); await input.fill(""); await release(3);
      expect(await input.inputValue()).toBe(""); expect(await oldChoice.count()).toBe(0);
      expect(await newChoice.count()).toBe(0);
      const count = (await db.query("SELECT COUNT(*)::int AS n FROM payments WHERE patient_id IN (SELECT id FROM patients WHERE patient_number = ANY($1::text[]))", [[searchA, searchB]])).rows[0].n;
      expect(count).toBe(0);
      console.log(`ROLE_QA_LIFETIME_FACTS ${JSON.stringify({ width, realHeldResponses: held.length,
        sameQueryReopenOldChoices: 0, clearedQueryOldChoices: 0, paymentCount: count })}`);
    } finally {
      for (const item of held) item.release();
      await Promise.all(held.map((item) => item.done));
      await cashier.context.close();
    }
  }, 120_000);

  it("the passive completion oracle detects the exact pre-fix component's obsolete patient", async () => {
    // Counterfactual challenge, not fixed-product or whole-app acceptance.
    // Preserve the exact old component bytes rather than inventing a buggy toy.
    const oldSource = readFileSync("__tests__/fixtures/QuickCollectModal-before-guard.tsx");
    const oldBlob = createHash("sha1").update(`blob ${oldSource.length}\0`).update(oldSource).digest("hex");
    expect(oldBlob).toBe("e6bbaeaaf2a7ccab41bdad89d4f839bc2f09b9f6");
    const bundle = await build({
      stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
        import { createElement, useState } from "react";
        import { createRoot } from "react-dom/client";
        import { QuickCollectModal } from "./__tests__/fixtures/QuickCollectModal-before-guard";
        function Fixture() {
          const [open, setOpen] = useState(true);
          return createElement(QuickCollectModal, { isOpen: open, onClose: () => setOpen(false),
            onSelectPatient: () => {}, debtors: [], currency: "YER" });
        }
        createRoot(document.getElementById("counterfactual-root")!).render(createElement(Fixture));
      ` },
      bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
      alias: { "@": process.cwd() }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
    });
    const cashier = await screen("cashier", 390);
    await cashier.page.route("**/__role-qa-counterfactual", (route) => route.fulfill({
      status: 200, contentType: "text/html; charset=utf-8",
      body: '<!doctype html><html dir="rtl"><body><div id="counterfactual-root"></div></body></html>',
    }));
    let releaseOld: (() => void) | null = null;
    let released: Promise<void> | null = null;
    await cashier.page.route("**/api/patients?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("q") !== searchA) { await route.continue(); return; }
      const actual = await route.fetch();
      expect(actual.status()).toBe(200);
      const wait = new Promise<void>((resolve) => { releaseOld = resolve; });
      released = wait.then(async () => { await route.fulfill({ response: actual }); });
      await released;
    });
    const unexpectedCounterfactual: string[] = [];
    // Highest-priority route: the counterfactual can only read this synthetic
    // origin. All mutations and external requests are blocked before fallback.
    await cashier.page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        unexpectedCounterfactual.push(`${request.method()} ${url.pathname}`);
        await route.abort();
        return;
      }
      await route.fallback();
    });
    try {
      await cashier.page.goto(`${baseUrl}/__role-qa-counterfactual`);
      await cashier.page.addScriptTag({ content: bundle.outputFiles[0].text });
      const picker = cashier.page.getByRole("dialog", { name: "اختيار مريض لإصدار سند قبض", exact: true });
      const input = picker.getByPlaceholder("ابحث بالاسم أو رقم الهاتف أو الملف…");
      await input.fill(searchA); await expect.poll(() => releaseOld !== null).toBe(true);
      await input.fill(searchB);
      await picker.getByRole("button").filter({ hasText: searchB }).waitFor();
      await watchObsoleteChoice(cashier.page, searchA);
      const oldResponse = cashier.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/patients" && url.searchParams.get("q") === searchA;
      });
      (releaseOld as unknown as () => void)(); await released;
      await observeReleasedResponse(cashier.page, await oldResponse, "counterfactual-old-query");
      const detected = await endChoiceWatch(cashier.page);
      const oldChoices = await picker.getByRole("button").filter({ hasText: searchA }).count();
      const latestChoices = await picker.getByRole("button").filter({ hasText: searchB }).count();
      expect(await input.inputValue()).toBe(searchB);
      expect(detected, "The unchanged old handler must fail this same stale-choice oracle").toBe(true);
      expect(oldChoices).toBe(1); expect(latestChoices).toBe(0);
      const count = (await db.query("SELECT COUNT(*)::int AS n FROM payments WHERE patient_id IN (SELECT id FROM patients WHERE patient_number = ANY($1::text[]))", [[searchA, searchB]])).rows[0].n;
      expect(count).toBe(0);
      expect(unexpectedCounterfactual).toEqual([]);
      console.log(`ROLE_QA_COUNTERFACTUAL ${JSON.stringify({ oldBlob, oracleDetected: detected,
        latestInputPreserved: true, oldChoices, latestChoices, paymentCount: count })}`);
    } finally {
      if (releaseOld) (releaseOld as () => void)();
      await released;
      await cashier.context.close();
    }
  }, 120_000);
});
