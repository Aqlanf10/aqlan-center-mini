import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page, type Request, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Currency } from "@/lib/money";
import type { RecoveryProjection } from "@/lib/reversed-installment-recovery";
import { baseUrl, harness } from "./_server";

/**
 * Read-only UI acceptance on the existing isolated, built-app security harness.
 * The real patient Account component consumes synthetic ledger GET responses.
 * These fixtures test presentation of server-owned evidence, not the accounting
 * projection/writer itself. Only a synthetic patient is inserted during setup;
 * no invoice, plan, payment, refund or audit is seeded or submitted by this test.
 * Browser writes and external requests are rejected, including unexpected ones.
 * No alternate app, clinical endpoint fixture or authentication bypass is used.
 *
 * SOURCE-ONLY AUTHORING: running/collecting this file starts the security harness
 * through its global setup. Do so only with a separately approved local harness.
 * Synthetic invoice-row screenshots and bounds are always written to the
 * established .settings-ui-artifacts directory for an exact CI upload allowlist.
 */
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
let patientId = 0;

const recoveredText = "متبقٍ مرتبط بالفاتورة بعد عكس السداد";
const reviewText = "حالة السداد تحتاج مراجعة";
const unavailableText = "تعذّر التحقق من حالة السداد؛ راجع رصيد الحساب بعملته";
const creditText = "المتبقي المرتبط بالفاتورة ليس مبلغًا للتحصيل؛ راجع رصيد الحساب بعملته";
const deniedText = "تعذّر تحميل حساب المريض: رفض تجريبي لقراءة الحساب";

type Recoverable = Extract<RecoveryProjection, { kind: "recoverable" }>;
type InvoiceFixture = {
  id: number; invoiceNumber: string; patientId: number; planId: number | null;
  status: "open" | "paid" | "cancelled"; totalMinor: number; discountMinor: number;
  baseCurrency: Currency; createdAt: string; note: string | null;
  items: { id: number; description: string; quantity: number; unitPriceMinor: number; totalMinor: number }[];
};
const definitions = [
  { key: "full", id: 97001, status: "paid", currency: "YER", total: 18000, planId: 98001 },
  { key: "partial", id: 97002, status: "paid", currency: "SAR", total: 95000, planId: 98002 },
  { key: "credit", id: 97003, status: "paid", currency: "USD", total: 60000, planId: 98003 },
  { key: "review", id: 97004, status: "paid", currency: "USD", total: 30000, planId: 98004 },
  { key: "unrelated", id: 97005, status: "paid", currency: "YER", total: 75000, planId: 98005 },
  { key: "manual", id: 97006, status: "open", currency: "SAR", total: 23450, planId: null },
  { key: "cancelled", id: 97007, status: "cancelled", currency: "USD", total: 9000, planId: 98007 },
  { key: "corrected", id: 97008, status: "open", currency: "USD", total: 20000, planId: 98007 },
  { key: "legacy", id: 97009, status: "paid", currency: "YER", total: 6000, planId: null },
] as const;
type InvoiceKey = typeof definitions[number]["key"];

function invoice(key: InvoiceKey): InvoiceFixture {
  const row = definitions.find((definition) => definition.key === key);
  if (!row) throw new Error(`Missing synthetic invoice: ${key}`);
  return {
    id: row.id, invoiceNumber: `RECOVERY-UI-${row.key.toUpperCase()}`, patientId,
    planId: row.planId, status: row.status, totalMinor: row.total, discountMinor: 0,
    baseCurrency: row.currency, createdAt: "2026-01-15T09:00:00.000Z",
    // Neither a copied plan link nor correction-note prose is recovery evidence.
    note: key === "corrected" ? "تصحيح للفاتورة RECOVERY-UI-CANCELLED" : null,
    items: [{ id: row.id + 1000, description: `بند تجريبي ${row.key}`, quantity: 1,
      unitPriceMinor: row.total, totalMinor: row.total }],
  };
}

function recovery(key: "full" | "partial" | "credit"): Recoverable {
  const row = invoice(key);
  const remainingMinor = key === "full" ? 18000 : key === "partial" ? 13750 : 23456;
  const actualAccountDueMinor = key === "credit" ? -8000 : remainingMinor;
  return {
    kind: "recoverable", purpose: "reversed-installment-recovery", patientId,
    invoiceId: row.id, planId: row.planId!, originPaymentId: row.id + 2000,
    creationAuditId: row.id + 3000, currency: row.baseCurrency, rawInvoiceStatus: "paid",
    principalMinor: row.totalMinor, linkedNetPaidMinor: row.totalMinor - remainingMinor,
    remainingMinor, actualAccountDueMinor,
    suggestedCashMinor: key === "credit" ? 0 : remainingMinor,
    accountCreditReview: key === "credit", reversalPaymentIds: [row.id + 4000],
  };
}

function ledger(installmentRecovery: unknown = {
  recoveries: [recovery("full"), recovery("partial"), recovery("credit")],
  reviews: [{ invoiceId: invoice("review").id, planId: invoice("review").planId,
    reason: "missing_creation_provenance" }],
}) {
  const balance = { billedMinor: 99000, collectedMinor: 81000, openingMinor: 0, dueMinor: 18000 };
  return {
    invoices: definitions.map(({ key }) => invoice(key)),
    payments: [], opening: null, openings: [], baseCurrency: "YER", balance,
    balances: {
      YER: balance,
      SAR: { billedMinor: 118450, collectedMinor: 104700, openingMinor: 0, dueMinor: 13750 },
      USD: { billedMinor: 110000, collectedMinor: 118000, openingMinor: 0, dueMinor: -8000 },
    },
    plans: [], receiptRemaining: {}, openingAccess: { add: false, edit: false },
    legacyBalanceArrangements: [], legacyOpeningPositions: [],
    legacyArrangementAccess: { manage: false }, installmentRecovery,
  };
}

beforeAll(async () => {
  expect(new URL(baseUrl).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  h = await harness();
  const database = new URL(h.seeded.dbUrl);
  expect(database.pathname).toBe("/aqlan_sec_http");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(database.hostname);
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  patientId = (await db.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id",
    [`INVOICE-RECOVERY-UI-${Date.now()}`, "مريض تسوية الفاتورة التجريبي"],
  )).rows[0].id;
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);

afterAll(async () => { await browser?.close(); await db?.end(); });

async function financialState() {
  // Complete rows, not only counts: unexpected status/amount updates also fail.
  return (await db.query(
    `SELECT
       (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
          FROM patients p WHERE p.id = $1) AS patient,
       (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
          FROM invoices i WHERE i.patient_id = $1) AS invoices,
       (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
          FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id WHERE v.patient_id = $1) AS invoice_items,
       (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
          FROM payments p WHERE p.patient_id = $1) AS payments,
       (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]'::jsonb)
          FROM treatment_plans p WHERE p.patient_id = $1) AS plans,
       (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
          FROM plan_installments i JOIN treatment_plans p ON p.id = i.plan_id WHERE p.patient_id = $1) AS installments,
       (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.patient_id, o.currency), '[]'::jsonb)
          FROM patient_opening_balances o WHERE o.patient_id = $1) AS opening`,
    [patientId],
  )).rows;
}

async function openAccount(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const pending: Route[] = [];
  const writes: string[] = [];
  const external: string[] = [];
  const errors: string[] = [];
  const ledgerPath = `/api/patients/${patientId}/ledger`;
  // The ledger is the only substituted read. All other app reads use the actual
  // harness. Do not fulfill broad API patterns or install a visits-route fixture.
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseUrl) {
      external.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort();
    } else if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ message: "Synthetic read-only Account test: write blocked" }) });
    } else if (request.method() === "GET" && url.pathname === ledgerPath && url.search === "") {
      pending.push(route);
    } else await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const activeReads = new Set<Request>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === baseUrl && request.method() === "GET"
      && (url.pathname === ledgerPath || url.pathname === "/api/services")) activeReads.add(request);
  });
  page.on("requestfinished", (request) => { activeReads.delete(request); });
  page.on("requestfailed", (request) => { activeReads.delete(request); });
  const finishReadRender = async () => {
    // Wait for both response bodies before checking a malformed-state label.
    // Otherwise a transient loading label could make malformed evidence pass.
    await expect.poll(() => activeReads.size).toBe(0);
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  const nextRead = () => {
    const route = pending.shift();
    if (!route) throw new Error("No synthetic patient's ledger GET is pending");
    return route;
  };
  try {
    await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => pending.length).toBe(1);
    const invoices = page.getByRole("region", { name: "الفواتير", exact: true });
    return {
      context, page, invoices, pending,
      settlement: (key: InvoiceKey) => page.getByRole("group", {
        name: `حالة تسوية الفاتورة ${invoice(key).invoiceNumber}`, exact: true,
      }),
      respond: async (body: unknown, status = 200) => {
        await nextRead().fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        await finishReadRender();
      },
      malformedJson: async () => {
        await nextRead().fulfill({ status: 200, contentType: "application/json", body: "{invalid" });
        await finishReadRender();
      },
      reload: async () => {
        expect(pending).toHaveLength(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(() => pending.length).toBe(1);
      },
      assertIsolated: () => {
        expect(writes).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
      },
    };
  } catch (error) { await context.close(); throw error; }
}

type Account = Awaited<ReturnType<typeof openAccount>>;

async function expectRecovered(panel: Locator, amount: string) {
  await panel.getByText(`${recoveredText}: ${amount}`, { exact: true }).waitFor();
  const text = await panel.innerText();
  expect(text).toContain(amount);
  expect(text).toContain("الحالة المسجلة: مسدّدة");
  expect(await panel.getByText("مسدّدة", { exact: true }).count()).toBe(0);
  expect(text).not.toContain(reviewText);
  // Informational labels cannot grow a second collection path.
  expect(await panel.getByRole("button").count()).toBe(0);
  expect(await panel.getByRole("link").count()).toBe(0);
}

async function expectReview(panel: Locator) {
  await panel.getByText(reviewText, { exact: false }).waitFor();
  const text = await panel.innerText();
  expect(text).toContain("الحالة المسجلة: مسدّدة");
  expect(await panel.getByText("مسدّدة", { exact: true }).count()).toBe(0);
  expect(text).not.toContain(recoveredText);
  expect(text).not.toContain("18,000 ر.ي");
  expect(await panel.getByRole("button").count()).toBe(0);
  expect(await panel.getByRole("link").count()).toBe(0);
}

async function expectUnavailable(panel: Locator) {
  await panel.getByText(unavailableText, { exact: true }).waitFor();
  const text = await panel.innerText();
  expect(text).toContain("الحالة المسجلة: مسدّدة");
  expect(await panel.getByText("مسدّدة", { exact: true }).count()).toBe(0);
  expect(text).not.toContain(recoveredText);
  expect(text).not.toContain("18,000 ر.ي");
  expect(await panel.getByRole("button").count()).toBe(0);
  expect(await panel.getByRole("link").count()).toBe(0);
}

async function expectUnknownRead(f: Account) {
  // A loading/failed read may hide the list or retain rows with unknown labels.
  // It may not reuse a stale recovery amount or present paid as a current claim.
  const count = await f.invoices.count();
  const text = count ? await f.invoices.innerText() : "";
  expect(text).not.toContain(recoveredText);
  expect(await f.page.getByRole("group", { name: /^حالة تسوية الفاتورة / })
    .getByText("مسدّدة", { exact: true }).count()).toBe(0);
  expect(await f.page.getByRole("group", { name: /^حالة تسوية الفاتورة / })
    .getByRole("button").count()).toBe(0);
}

async function expectLedgerError(f: Account, message?: string) {
  // The framework's route announcer is also role=alert. Require the actual
  // named Account error, uniquely visible and carrying a user-facing message.
  const alert = f.page.getByRole("alert", { name: "خطأ حساب المريض", exact: true });
  await alert.waitFor({ state: "visible" });
  expect(await alert.count()).toBe(1);
  const text = (await alert.innerText()).trim();
  expect(text).not.toBe("");
  if (message !== undefined) expect(text).toBe(message);
}

const evidenceDirectory = ".settings-ui-artifacts";

async function captureInvoiceEvidence(page: Page, panel: Locator, file: string) {
  await mkdir(evidenceDirectory, { recursive: true });
  // Capture the complete synthetic invoice row: invoice number, recorded status,
  // remaining amount/currency, guidance, line item and original invoice total.
  // A badge-only crop could hide truncation or the meaning of the warning.
  const row = panel.locator("xpath=ancestor::li[1]");
  await row.evaluate((element) => element.scrollIntoView({
    block: "center", inline: "nearest", behavior: "instant",
  }));
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await row.screenshot({ path: join(evidenceDirectory, file) });
  const bounds = await panel.evaluate((element) => {
    const invoiceRow = element.closest("li");
    if (!invoiceRow) throw new Error("Synthetic settlement label has no invoice row");
    const rect = (value: DOMRect) => ({
      x: value.x, y: value.y, width: value.width, height: value.height,
      top: value.top, right: value.right, bottom: value.bottom, left: value.left,
    });
    const rowBounds = invoiceRow.getBoundingClientRect();
    const inViewport = (value: DOMRect) => value.left >= 0 && value.top >= 0
      && value.right <= window.innerWidth + 1 && value.bottom <= window.innerHeight + 1;
    const inRow = (value: DOMRect) => value.left >= rowBounds.left - 1 && value.top >= rowBounds.top - 1
      && value.right <= rowBounds.right + 1 && value.bottom <= rowBounds.bottom + 1;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textRuns = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const line of Array.from(range.getClientRects())) {
        if (line.width <= 0 || line.height <= 0) continue;
        const dx = Math.min(1, line.width / 4);
        const dy = Math.min(1, line.height / 4);
        // Retain real sticky headers/overlays. Every rendered text fragment must
        // fit and be hit-testable through the label at its edges and centre.
        const hits = [line.left + dx, line.left + line.width / 2, line.right - dx].flatMap((x) =>
          [line.top + dy, line.top + line.height / 2, line.bottom - dy].map((y) => {
            const hit = document.elementFromPoint(x, y);
            return { x, y, contained: hit !== null && element.contains(hit),
              target: hit === null ? null : { tag: hit.tagName.toLowerCase(),
                role: hit.getAttribute("role"), id: hit.id, class: hit.getAttribute("class") } };
          }));
        // Same nine points and exact label containment as the original gate;
        // retain failed targets so a future failure cannot be guessed from PNGs.
        const unoccluded = hits.every((hit) => hit.contained);
        textRuns.push({ text: node.textContent.trim(), bounds: rect(line),
          inViewport: inViewport(line), inRow: inRow(line), unoccluded,
          failedHits: hits.filter((hit) => !hit.contained) });
      }
    }
    return {
      direction: document.documentElement.dir,
      labelDirection: getComputedStyle(element).direction,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      row: { bounds: rect(rowBounds), clientWidth: invoiceRow.clientWidth,
        scrollWidth: invoiceRow.scrollWidth, inViewport: inViewport(rowBounds) },
      label: { name: element.getAttribute("aria-label"), display: getComputedStyle(element).display,
        bounds: rect(element.getBoundingClientRect()), textRuns },
    };
  });
  return { screenshot: file, ...bounds };
}

async function captureAndAssertInvoiceEvidence(f: Account, width: number) {
  const captures = [
    await captureInvoiceEvidence(f.page, f.settlement("partial"), `invoice-recovery-partial-${width}.png`),
    await captureInvoiceEvidence(f.page, f.settlement("credit"), `invoice-recovery-credit-${width}.png`),
  ];
  // Save inspectable synthetic geometry before assertions, including on failure.
  // No request bodies, auth state, environment, traces or real patient data.
  await writeFile(join(evidenceDirectory, `invoice-recovery-${width}-bounds.json`),
    JSON.stringify({ version: 1, fixture: "synthetic-ledger-only", width, captures }, null, 2) + "\n", "utf8");
  for (const capture of captures) {
    expect(capture.direction).toBe("rtl");
    expect(capture.labelDirection).toBe("rtl");
    expect(capture.label.display).toBe("inline-block");
    expect(capture.viewport.width).toBe(width);
    expect(capture.documentWidth).toBeLessThanOrEqual(width + 1);
    expect(capture.row.scrollWidth).toBeLessThanOrEqual(capture.row.clientWidth + 1);
    expect(capture.row.inViewport).toBe(true);
    expect(capture.label.textRuns.length).toBeGreaterThan(0);
    expect(capture.label.textRuns.filter((run) => !run.inViewport || !run.inRow || !run.unoccluded)).toEqual([]);
  }
}

describe("server-evidence invoice settlement labels in the real Account UI", () => {
  it.each([1280, 390])("shows full/partial reversal amounts and currency-credit caution without collection at %ipx", async (width) => {
    const before = await financialState();
    const f = await openAccount(width);
    try {
      await expectUnknownRead(f);
      await f.respond(ledger());
      await expectRecovered(f.settlement("full"), "18,000 ر.ي");
      await expectRecovered(f.settlement("partial"), "137.50 ر.س");
      expect(await f.settlement("partial").innerText()).not.toContain("950.00 ر.س");
      await expectRecovered(f.settlement("credit"), "234.56 $");
      await f.settlement("credit").getByText(creditText, { exact: true }).waitFor();
      expect(await f.settlement("full").innerText()).not.toContain(creditText);
      expect(await f.settlement("partial").innerText()).not.toContain(creditText);
      await expectReview(f.settlement("review"));
      for (const [key, status] of [
        ["unrelated", "مسدّدة"], ["manual", "مفتوحة"], ["cancelled", "ملغاة"],
        ["corrected", "مفتوحة"], ["legacy", "مسدّدة"],
      ] as const) {
        const text = await f.settlement(key).innerText();
        expect(text).toBe(status);
        expect(text).not.toContain(recoveredText);
        expect(text).not.toContain(reviewText);
      }
      expect(await f.invoices.getByRole("button", { name: /قبض|تحصيل|استرداد/ }).count()).toBe(0);
      await captureAndAssertInvoiceEvidence(f, width);
      f.assertIsolated();
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });

  it("preserves the ordinary raw status when the server omits the optional projection", async () => {
    const before = await financialState();
    const f = await openAccount();
    try {
      const payload = ledger();
      const { installmentRecovery: _projection, ...withoutProjection } = payload;
      void _projection;
      await f.respond(withoutProjection);
      await f.settlement("full").waitFor();
      expect(await f.settlement("full").innerText()).toBe("مسدّدة");
      expect(await f.invoices.innerText()).not.toContain(recoveredText);
      expect(await f.invoices.innerText()).not.toContain(reviewText);
      f.assertIsolated();
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });

  it.each(["invalid-amount", "foreign-patient", "currency-mismatch", "duplicate-evidence", "conflicting-review"] as const)(
    "withholds a settled or collectible claim for malformed %s evidence", async (mode) => {
      const before = await financialState();
      const f = await openAccount(390);
      try {
        const valid = recovery("full");
        let recoveries: unknown[] = [valid];
        let reviews: { invoiceId: number; planId: number | null; reason: string }[] = [];
        if (mode === "invalid-amount") recoveries = [{ ...valid, remainingMinor: "18000" }];
        if (mode === "foreign-patient") recoveries = [{ ...valid, patientId: patientId + 1000000 }];
        if (mode === "currency-mismatch") recoveries = [{ ...valid, currency: "USD" }];
        if (mode === "duplicate-evidence") recoveries = [valid, valid];
        if (mode === "conflicting-review") reviews = [{ invoiceId: valid.invoiceId,
          planId: valid.planId, reason: "incomplete_snapshot" }];
        await f.respond(ledger({ recoveries, reviews }));
        await expectUnavailable(f.settlement("full"));
        expect(await f.settlement("unrelated").innerText()).toBe("مسدّدة");
        f.assertIsolated();
        expect(await financialState()).toEqual(before);
      } finally { await f.context.close(); }
    },
  );

  it.each(["null", "missing-array", "unidentified-entry"] as const)(
    "does not silently treat a malformed %s projection envelope as absent", async (mode) => {
      const before = await financialState();
      const f = await openAccount();
      try {
        const malformed = mode === "null" ? null : mode === "missing-array" ? { recoveries: [] }
          : { recoveries: [{ ...recovery("full"), invoiceId: null }], reviews: [] };
        await f.respond(ledger(malformed));
        await expectUnavailable(f.settlement("full"));
        await expectUnavailable(f.settlement("unrelated"));
        expect(await f.settlement("cancelled").innerText()).toBe("ملغاة");
        f.assertIsolated();
        expect(await financialState()).toEqual(before);
      } finally { await f.context.close(); }
    },
  );

  it.each([401, 403, 500])("does not reuse a successful recovery label while reloading or after HTTP %i", async (status) => {
    const before = await financialState();
    const f = await openAccount(390);
    try {
      await f.respond(ledger());
      await expectRecovered(f.settlement("partial"), "137.50 ر.س");
      // Full browser reload is a supported read-only transition. In-place reload
      // invalidation is separately covered by focused component lifecycle tests.
      await f.reload();
      await expectUnknownRead(f);
      await f.respond({ message: deniedText }, status);
      await expectLedgerError(f, status === 401 || status === 403
        ? "غير مصرّح لك بعرض حساب المريض." : "تعذّر تحميل حساب المريض.");
      await expectUnknownRead(f);
      expect(await f.page.getByText("137.50 ر.س", { exact: true }).count()).toBe(0);
      await f.reload();
      await expectUnknownRead(f);
      await f.respond(ledger());
      await expectRecovered(f.settlement("partial"), "137.50 ر.س");
      f.assertIsolated();
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });

  it("does not resurrect a recovery amount after an unreadable ledger reload", async () => {
    const before = await financialState();
    const f = await openAccount();
    try {
      await f.respond(ledger());
      await expectRecovered(f.settlement("credit"), "234.56 $");
      await f.reload();
      await expectUnknownRead(f);
      await f.malformedJson();
      await expectLedgerError(f);
      await expectUnknownRead(f);
      expect(await f.page.getByText("234.56 $", { exact: true }).count()).toBe(0);
      f.assertIsolated();
      expect(await financialState()).toEqual(before);
    } finally { await f.context.close(); }
  });
});
