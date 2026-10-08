import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Download, type Locator, type Page } from "playwright";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import type { ReportResult } from "../../lib/reports-types";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { authedGet, baseUrl, harness } from "./_server";
import { COLLECTIONS_NATIVE_COLUMN_KEYS, emitCollectionsNativeEvidence, emitCollectionsNativeFailure,
  emitCollectionsNativePreGateGeometry, type CollectionsNativeEvidenceMember, type CollectionsNativeLayoutMetrics } from "./_collections-native-evidence";

// Real built report loader, UI, downloads and official Chromium PDFs. Fixtures
// are inserted only into the existing isolated localhost HTTP harness database.
// No report mocks, copied projection, exchange-rate edits, print-log or cleanup
// DELETEs. Old, fully settled invoice buckets avoid today's totals/debtor lists.
let h: Awaited<ReturnType<typeof harness>>;
let browser: Browser;
let db: Client;
const stamp = Date.now();
const fixtureDay = "2000-03-03";
const fixtureAt = `${fixtureDay}T10:00:00.000Z`;
const artifacts = ".collections-native-artifacts";
const receiverA = `SYN-A-${stamp.toString(36)}`;
const receiverB = `SYN-B-${stamp.toString(36)}`;
const patients: number[] = [];
const geometry: { scene: string; bounds: Record<string, number | boolean> }[] = [];
const columnKeys = COLLECTIONS_NATIVE_COLUMN_KEYS;

interface WitnessRow {
  note: string;
  patientName: string;
  patientId: number;
  patientNumber: string;
  receiptId: number;
  currency: "YER" | "SAR" | "USD";
  nativeMinor: number;
  amountText: string;
  nativeText: string;
  exportText: string;
  targetLabel: string;
  settlementText: string;
  receiver: string;
  kindLabel: "قبض" | "استرداد";
}
const rows: WitnessRow[] = [];
const allKpis = [
  { key: "cur-YER", currency: "YER", minor: 750, text: "750 ر.ي" },
  { key: "cur-SAR", currency: "SAR", minor: 19000, text: "190.00 ر.س" },
  { key: "cur-USD", currency: "USD", minor: 9876, text: "98.76 $" },
  { key: "refunds-SAR", currency: "SAR", minor: 2945, text: "29.45 ر.س" },
];
const filteredKpis = [
  { key: "cur-SAR", currency: "SAR", minor: 13000, text: "130.00 ر.س" },
  { key: "refunds-SAR", currency: "SAR", minor: 2945, text: "29.45 ر.س" },
];
type KpiWitness = typeof allKpis;
const plain = (value: string) => value.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
const compact = (value: string) => plain(value).replace(/\s+/g, "");

function params(extra: Record<string, string> = {}) {
  return new URLSearchParams({ report: "collections", preset: "custom", from: fixtureDay, to: fixtureDay, ...extra });
}

beforeAll(async () => {
  h = await harness();
  const url = new URL(h.seeded.dbUrl);
  expect(["postgres:", "postgresql:"]).toContain(url.protocol);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
  expect(url.pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  // Explicit fields prevent a connection-string query parameter overriding host.
  db = new Client({ host: url.hostname === "[::1]" ? "::1" : url.hostname,
    port: Number(url.port || "5432"), database: "aqlan_sec_http",
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false });
  await db.connect();
  expect((await db.query("SELECT current_database() AS name")).rows[0].name).toBe("aqlan_sec_http");
  expect((await apiReport()).rows, "the old witness date is not shared with another fixture").toHaveLength(0);
  const { rows: [shift] } = await db.query<{ id: number }>(
    `INSERT INTO cashier_shifts (opened_by, status, closed_by, opened_at, closed_at)
     VALUES ($1, 'closed', $1, $2, $2) RETURNING id`, [receiverA, fixtureAt]);

  async function patient(key: string, currency: string, totalMinor: number) {
    const name = `SYN-${key}`, number = `NC-${key}-${stamp.toString(36)}`;
    const { rows: [p] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, created_at) VALUES ($1, $2, $3) RETURNING id`,
      [number, name, fixtureAt]);
    patients.push(p.id);
    const { rows: [invoice] } = await db.query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
       VALUES ($1, $2, $3, 0, $4, $5, $6) RETURNING id`,
      [`NC-INV-${key}-${stamp}`, p.id, totalMinor, currency, receiverA, fixtureAt]);
    await db.query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
      VALUES ($1, 'SYNTHETIC-NATIVE-SERVICE', 1, $2, $2)`, [invoice.id, totalMinor]);
    return { patientId: p.id, patientName: name, patientNumber: number, invoiceId: invoice.id };
  }

  async function receipt(p: Awaited<ReturnType<typeof patient>>, data: {
    note: string; currency: WitnessRow["currency"]; amount: number; base: number; rate: number;
    nativeMinor: number; nativeText: string; amountText: string; exportText: string;
    settlementText?: string; receiver?: string; refund?: boolean; unlinked?: boolean; reversalOf?: number;
  }) {
    const { rows: [payment] } = await db.query<{ id: number }>(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor,
        currency, exchange_rate, base_amount_minor, base_currency, method, note, created_by, created_at, reversal_of_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'YER', 'cash', $10, $11, $12, $13) RETURNING id`,
      [`NC-RCP-${data.note}-${stamp}`, p.patientId, data.unlinked ? null : p.invoiceId, shift.id,
        data.refund ? "refund" : "payment", data.amount, data.currency, data.rate, data.base,
        data.note, data.receiver ?? receiverA, fixtureAt, data.reversalOf ?? null]);
    rows.push({ note: data.note, patientName: p.patientName, patientId: p.patientId, patientNumber: p.patientNumber,
      receiptId: payment.id, currency: data.currency, nativeMinor: data.nativeMinor, amountText: data.amountText,
      nativeText: data.nativeText, exportText: data.exportText,
      targetLabel: data.unlinked ? "غير محدد في السند" : `فاتورة #${p.invoiceId}`,
      settlementText: data.settlementText ?? "—", receiver: data.receiver ?? receiverA,
      kindLabel: data.refund ? "استرداد" : "قبض" });
    return payment.id;
  }

  const same = await patient("SAME", "SAR", 10000);
  const samePaymentId = await receipt(same, { note: "NCSAM", currency: "SAR", amount: 12345, base: 18518, rate: 150,
    nativeMinor: 12345, nativeText: "123.45 ر.س", amountText: "123.45 ر.س", exportText: "123.45 SAR" });
  await receipt(same, { note: "NCRET", currency: "SAR", amount: 2345, base: 3518, rate: 150, refund: true, reversalOf: samePaymentId,
    nativeMinor: -2345, nativeText: "-23.45 ر.س", amountText: "23.45 ر.س", exportText: "-23.45 SAR" });
  const cross = await patient("CROSS", "YER", 4500);
  const crossPaymentId = await receipt(cross, { note: "NCXFX", currency: "SAR", amount: 3600, base: 5400, rate: 150,
    nativeMinor: 3600, nativeText: "36.00 ر.س", amountText: "36.00 ر.س", exportText: "36.00 SAR", settlementText: "5,400 ر.ي" });
  await receipt(cross, { note: "NCXRF", currency: "SAR", amount: 600, base: 900, rate: 150, refund: true, reversalOf: crossPaymentId,
    nativeMinor: -600, nativeText: "-6.00 ر.س", amountText: "6.00 ر.س", exportText: "-6.00 SAR", settlementText: "-900 ر.ي" });
  const unknown = await patient("LEGACY", "YER", 9000);
  // A later unrelated SAR plan must not make an old unlinked receipt look linked.
  // This insert shape is shared with existing Postgres integrity tests.
  await db.query(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date, created_at)
    VALUES ($1, 'SYNTHETIC-UNRELATED-SAR', 0, 'SAR', 'completed', '2000-03-04', '2000-03-04T10:00:00Z')`, [unknown.patientId]);
  await receipt(unknown, { note: "NCUNK", currency: "SAR", amount: 6000, base: 9000, rate: 150, unlinked: true, receiver: receiverB,
    nativeMinor: 6000, nativeText: "60.00 ر.س", amountText: "60.00 ر.س", exportText: "60.00 SAR" });
  const usd = await patient("USD", "USD", 9876);
  await receipt(usd, { note: "NCUSD", currency: "USD", amount: 9876, base: 59256, rate: 600,
    nativeMinor: 9876, nativeText: "98.76 $", amountText: "98.76 $", exportText: "98.76 USD" });
  const yer = await patient("YER", "YER", 750);
  await receipt(yer, { note: "NCYER", currency: "YER", amount: 750, base: 750, rate: 1, receiver: receiverB,
    nativeMinor: 750, nativeText: "750 ر.ي", amountText: "750 ر.ي", exportText: "750 YER" });
  await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);

afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

async function financialSnapshot() {
  return (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM patients p WHERE id=ANY($1::int[])) AS patients,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id=ANY($1::int[])) AS invoices,
    (SELECT jsonb_agg(to_jsonb(it) ORDER BY it.id) FROM invoice_items it JOIN invoices i ON i.id=it.invoice_id
      WHERE i.patient_id=ANY($1::int[])) AS items,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p WHERE patient_id=ANY($1::int[])) AS payments,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM treatment_plans p WHERE patient_id=ANY($1::int[])) AS plans`,
  [patients])).rows[0];
}

function assertResult(result: ReportResult, expected: WitnessRow[], kpis: KpiWitness) {
  expect(result.report).toBe("collections");
  expect(result.from).toBe(fixtureDay);
  expect(result.to).toBe(fixtureDay);
  expect(result.columns?.map(column => column.key)).toEqual(columnKeys);
  expect(result.columns?.find(column => column.key === "nativeMinor")).toMatchObject({ type: "money", currencyKey: "currency", stackCurrencyTotals: true });
  expect(result.columns?.filter(column => column.type === "money").map(column => column.key)).toEqual(["nativeMinor"]);
  expect(result.rows).toHaveLength(expected.length);
  for (const row of expected) {
    const actual = result.rows?.find(item => item.receiptId === row.receiptId);
    expect(actual, row.note).toMatchObject({ receiptId: row.receiptId, patientId: row.patientId,
      patientName: row.patientName, patientNumber: row.patientNumber, kindLabel: row.kindLabel,
      nativeMinor: row.nativeMinor, currency: row.currency, amountText: row.amountText,
      targetLabel: row.targetLabel, settlementText: row.settlementText, receiver: row.receiver, note: row.note });
    expect(actual).not.toHaveProperty("baseMinor");
  }
  expect(result.kpis.map(kpi => ({ key: kpi.key, currency: kpi.currency, minor: kpi.minor })))
    .toEqual(kpis.map(({ key, currency, minor }) => ({ key, currency, minor })));
}

async function apiReport(extra: Record<string, string> = {}) {
  const response = await authedGet(`/api/reports?${params(extra)}`, h.sessions.admin);
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: ReportResult }).result;
}

async function settlePaint(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function assertTable(page: Page, table: Locator, expected: WitnessRow[], totals: string[]) {
  expect(await table.locator("thead th").count()).toBe(columnKeys.length);
  expect(await table.locator("tbody tr").count()).toBe(expected.length);
  for (const row of expected) {
    const cells = table.locator("tbody tr").filter({ has: page.getByText(row.note, { exact: true }) }).locator("td");
    expect(await cells.count(), row.note).toBe(10);
    expect(plain(await cells.nth(1).innerText())).toBe(row.patientName);
    expect(plain(await cells.nth(2).innerText())).toBe(row.patientNumber);
    expect(plain(await cells.nth(3).innerText())).toBe(row.kindLabel);
    expect(plain(await cells.nth(4).innerText())).toBe(row.nativeText);
    expect(plain(await cells.nth(5).innerText())).toBe(row.targetLabel);
    expect(plain(await cells.nth(6).innerText())).toBe(row.settlementText);
    expect(plain(await cells.nth(8).innerText())).toBe(row.receiver);
  }
  const nativeFooter = table.locator("tfoot td").nth(4);
  const totalSpans = nativeFooter.locator("[data-report-currency-total]");
  expect(await totalSpans.count(), "one atomic footer line per native currency").toBe(totals.length);
  const totalTexts = (await totalSpans.allTextContents()).map(plain);
  expect([...totalTexts].sort()).toEqual([...totals].sort());
  expect(compact(await nativeFooter.textContent() ?? ""), "no joined separators or extra footer amounts")
    .toBe(totalTexts.map(compact).join(""));
  const lines = await totalSpans.evaluateAll(elements => elements.map(element => {
    const r = element.getBoundingClientRect();
    return { tag: element.tagName, children: element.childElementCount,
      marker: element.getAttribute("data-report-currency-total"), whiteSpace: getComputedStyle(element).whiteSpace,
      boxes: element.getClientRects().length, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  }));
  for (const [index, line] of lines.entries()) {
    expect(line).toMatchObject({ tag: "SPAN", children: 0, marker: "", whiteSpace: "nowrap", boxes: 1 });
    expect(line.width).toBeGreaterThan(0);
    expect(line.height).toBeGreaterThan(0);
    if (index > 0) {
      expect(line.top, "native footer currencies occupy distinct non-overlapping vertical lines").toBeGreaterThanOrEqual(lines[index - 1].bottom - 0.5);
    }
  }
  expect(await table.locator("tfoot td").nth(6).innerText()).toBe("");
}

async function assertScreen(page: Page, result: ReportResult, expected: WitnessRow[], kpis: KpiWitness, totals: string[]) {
  await page.getByRole("heading", { name: "تقرير التحصيل", exact: true }).waitFor();
  await page.locator("main table tbody tr").filter({ has: page.getByText(expected[0].note, { exact: true }) }).waitFor();
  await settlePaint(page);
  expect(await page.locator("main [role=alert]").count()).toBe(0);
  const table = page.locator("main table");
  expect(await table.count()).toBe(1);
  expect((await table.locator("thead th").allTextContents()).map(plain)).toEqual(result.columns?.map(column => column.label));
  await assertTable(page, table, expected, totals);
  for (const kpi of kpis) {
    const label = result.kpis.find(item => item.key === kpi.key)!.label;
    const card = page.locator("main").getByText(label, { exact: true }).locator("..");
    expect(plain(await card.locator("p").first().innerText())).toBe(kpi.text);
  }
  for (const oldLabel of ["المكافئ المسجّل بالأساس", "استردادات (مكافئ أساسي)", "صافي التسوية بعملة الحساب", "باقي التسوية بعد الرصيد السابق", "تسوية مصنفة على رصيد سابق"]) {
    expect(await page.locator("main").getByText(oldLabel, { exact: true }).count()).toBe(0);
  }
}

async function assertDesktopTableBounds(page: Page, scene: CollectionsNativeLayoutMetrics["scene"]) {
  // Called only after API fixtures and every displayed row/card/footer match.
  // Capture the real scene before testing width so a failure remains inspectable.
  const screenshot = await page.screenshot({ fullPage: true });
  const metrics: CollectionsNativeLayoutMetrics = await page.locator("main table").evaluate((table, input) => {
    const frame = table.parentElement!, t = table.getBoundingClientRect(), f = frame.getBoundingClientRect();
    const round = (number: number) => Math.round(number * 100) / 100;
    const measure = (element: Element) => {
      const r = element.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      return { left: round(r.left), right: round(r.right), top: round(r.top), bottom: round(r.bottom),
        width: round(r.width), height: round(r.height), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        textWidth: round(text.width), textHeight: round(text.height) };
    };
    const headers = [...table.querySelectorAll("thead th")], body = [...table.querySelectorAll("tbody tr")];
    const footers = [...table.querySelectorAll("tfoot td")];
    return { scene: input.scene, rowCount: body.length,
      totalsCount: footers[4].querySelectorAll("[data-report-currency-total]").length,
      bounds: { tableLeft: t.left, tableRight: t.right, frameLeft: f.left, frameRight: f.right,
        clientWidth: frame.clientWidth, scrollWidth: frame.scrollWidth, viewportWidth: innerWidth },
      columns: input.keys.map((key, index) => ({ key, header: measure(headers[index]),
        body: body.map(row => measure(row.querySelectorAll("td")[index])), footer: measure(footers[index]),
        totals: [...footers[index].querySelectorAll("[data-report-currency-total]")].map(measure) })) };
  }, { scene, keys: columnKeys });
  emitCollectionsNativePreGateGeometry(metrics);
  const bounds = metrics.bounds;
  try {
    // Keep these original acceptance limits unchanged. Diagnostics never turn a
    // failed bound into success, nor enter the seven-member success transport.
    expect(bounds.scrollWidth, "desktop evidence must show the entire table, not an internally clipped slice").toBeLessThanOrEqual(bounds.clientWidth + 1);
    expect(bounds.tableLeft).toBeGreaterThanOrEqual(bounds.frameLeft - 1);
    expect(bounds.tableRight).toBeLessThanOrEqual(bounds.frameRight + 1);
    expect(bounds.frameLeft).toBeGreaterThanOrEqual(-1);
    expect(bounds.frameRight).toBeLessThanOrEqual(bounds.viewportWidth + 1);
  } catch (error) {
    try {
      emitCollectionsNativeFailure({ filename: "collections-native-desktop-failed.png", mime: "image/png", bytes: screenshot }, metrics);
    } catch (diagnosticError) {
      throw new AggregateError([error, diagnosticError], "Desktop bounds failed and diagnostic preparation also failed");
    }
    throw error;
  }
  geometry.push({ scene, bounds });
  return screenshot;
}

async function assertPaperBounds(sheet: Locator, scene: string) {
  const bounds = await sheet.evaluate(root => {
    const table = root.querySelector(".report-table")!, r = root.getBoundingClientRect(), t = table.getBoundingClientRect();
    const style = getComputedStyle(root);
    const cells = [...table.querySelectorAll("tbody tr td:nth-child(5), tfoot tr td:nth-child(5)")];
    return { contentLeft: r.left + parseFloat(style.paddingLeft), contentRight: r.right - parseFloat(style.paddingRight),
      tableLeft: t.left, tableRight: t.right,
      nativeCellsUnclipped: cells.every(cell => cell.scrollWidth <= cell.clientWidth + 1) };
  });
  expect(bounds.tableLeft, "paper table left edge").toBeGreaterThanOrEqual(bounds.contentLeft - 1);
  expect(bounds.tableRight, "paper table right edge").toBeLessThanOrEqual(bounds.contentRight + 1);
  expect(bounds.nativeCellsUnclipped, "paper native amounts remain within their cells").toBe(true);
  geometry.push({ scene, bounds });
}

async function assertMobileNativeCell(page: Page) {
  const cell = page.locator("main table tbody tr").filter({ has: page.getByText("NCSAM", { exact: true }) }).locator("td").nth(4);
  await cell.scrollIntoViewIfNeeded();
  const bounds = await cell.evaluate(element => {
    const frame = element.closest("table")!.parentElement!, r = element.getBoundingClientRect(), f = frame.getBoundingClientRect();
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return { cellLeft: r.left, cellRight: r.right, frameLeft: f.left, frameRight: f.right,
      viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
      scrollWidth: frame.scrollWidth, clientWidth: frame.clientWidth,
      unobscured: hit !== null && (hit === element || element.contains(hit)) };
  });
  expect(bounds.documentWidth, "phone page itself must not overflow").toBeLessThanOrEqual(bounds.viewportWidth + 1);
  expect(bounds.scrollWidth, "the wide report has an intentional local horizontal scroll frame").toBeGreaterThan(bounds.clientWidth);
  expect(bounds.cellLeft).toBeGreaterThanOrEqual(Math.max(0, bounds.frameLeft) - 1);
  expect(bounds.cellRight).toBeLessThanOrEqual(Math.min(bounds.viewportWidth, bounds.frameRight) + 1);
  expect(bounds.unobscured, "native amount is visible after local horizontal scrolling").toBe(true);
  geometry.push({ scene: "mobile-native-cell", bounds });
}

async function downloadText(download: Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Synthetic report download stream missing");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 128 * 1024) throw new Error("Synthetic report download exceeds bounded fixture size");
    chunks.push(bytes);
  }
  expect(await download.failure()).toBeNull();
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
}

/** Independent CSV reader; the export implementation is never imported. */
function csvCells(text: string): string[][] {
  const output: string[][] = [], row: string[] = [];
  let value = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\n" || char === "\r")) {
      row.push(value); value = "";
      if (char !== ",") { output.push([...row]); row.length = 0; if (char === "\r" && text[index + 1] === "\n") index++; }
    } else value += char;
  }
  expect(quoted).toBe(false);
  if (value !== "" || row.length) { row.push(value); output.push(row); }
  return output;
}

async function assertDownloads(page: Page, result: ReportResult, expected: WitnessRow[]) {
  for (const kind of ["CSV", "Excel"] as const) {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: kind, exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(`collections.${kind === "CSV" ? "csv" : "xls"}`);
    const text = await downloadText(download);
    const cells = kind === "CSV" ? csvCells(text) : await page.evaluate(xml => {
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      if (doc.querySelector("parsererror")) throw new Error("Downloaded Excel XML is invalid");
      return [...doc.getElementsByTagName("Row")].map(row => [...row.getElementsByTagName("Data")].map(cell => cell.textContent ?? ""));
    }, text);
    expect(cells[0]).toEqual(result.columns?.map(column => column.label));
    expect(cells).toHaveLength(expected.length + 1);
    for (const row of expected) {
      const actual = cells.slice(1).find(values => values[9] === row.note);
      expect(actual, `${kind}: ${row.note}`).toBeDefined();
      expect(actual?.[1]).toBe(row.patientName);
      expect(actual?.[4]).toBe(kind === "CSV" && row.nativeMinor < 0 ? `'${row.exportText}` : row.exportText);
      expect(actual?.[5]).toBe(row.targetLabel);
      expect(actual?.[6]).toBe(kind === "CSV" && row.settlementText.startsWith("-") ? `'${row.settlementText}` : row.settlementText);
      expect(actual?.[8]).toBe(row.receiver);
    }
  }
}

interface PdfWord { page: number; pageWidth: number; text: string; xMin: number; xMax: number; yMin: number; yMax: number }
async function pdfWords(page: Page, path: string): Promise<PdfWord[]> {
  const xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  return page.evaluate(source => {
    const doc = new DOMParser().parseFromString(source, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("PDF bounding-box extraction is invalid");
    return [...doc.getElementsByTagName("page")].flatMap((sheet, index) =>
      [...sheet.getElementsByTagName("word")].map(word => ({ page: index, pageWidth: Number(sheet.getAttribute("width")), text: word.textContent ?? "",
        xMin: Number(word.getAttribute("xMin")), xMax: Number(word.getAttribute("xMax")),
        yMin: Number(word.getAttribute("yMin")), yMax: Number(word.getAttribute("yMax")) })));
  }, xml);
}

function hasPdfWord(text: string, word: string) {
  const source = compact(text), wanted = compact(word);
  return source.includes(wanted) || source.includes([...wanted].reverse().join(""));
}

/** Row-local PDF oracle: markers are short synthetic note cells, not DOM text.
 * Poppler may reverse Arabic glyph order or move an RTL minus behind a number.
 */
function assertPdfRows(words: PdfWord[], expected: WitnessRow[]) {
  expect(words.length, "actual PDF contains extractable text").toBeGreaterThan(0);
  for (const word of words) {
    expect([word.pageWidth, word.xMin, word.xMax, word.yMin, word.yMax].every(Number.isFinite)).toBe(true);
    expect(word.xMin, "PDF word left boundary").toBeGreaterThanOrEqual(0);
    expect(word.xMax, "PDF word right boundary").toBeLessThanOrEqual(word.pageWidth);
  }
  const anchors = expected.map(row => {
    const matching = words.filter(word => compact(word.text) === row.note);
    expect(matching, `PDF marker ${row.note}`).toHaveLength(1);
    return { row, word: matching[0] };
  });
  for (const { row, word } of anchors) {
    const next = anchors.filter(item => item.word.page === word.page && item.word.yMin > word.yMin + 1)
      .sort((a, b) => a.word.yMin - b.word.yMin)[0];
    // The final row ends at its first text line, before the table footer. Other
    // rows may wrap labels; stop before the next row's top glyphs, not after it.
    const bottom = next ? next.word.yMin - 3 : word.yMax + 2;
    const text = words.filter(item => item.page === word.page && item.yMin >= word.yMin - 3 && item.yMin < bottom)
      .map(item => plain(item.text)).join(" ");
    const number = row.nativeText.split(" ")[0];
    const numeric = compact(text);
    expect(numeric.includes(number) || (number.startsWith("-") && numeric.includes(`${number.slice(1)}-`)),
      `PDF native amount ${row.note}: ${number}`).toBe(true);
    const symbol = row.currency === "SAR" ? "ر.س" : row.currency === "YER" ? "ر.ي" : "$";
    expect(hasPdfWord(text, symbol), `PDF native currency ${row.note}: ${symbol}`).toBe(true);
    if (row.settlementText === "—" && row.currency !== "YER") {
      expect(hasPdfWord(text, "ر.ي"), `PDF must not invent YER on ${row.note}`).toBe(false);
    } else if (row.settlementText !== "—") {
      const settlement = row.settlementText.split(" ")[0];
      expect(numeric.includes(settlement) || (settlement.startsWith("-") && numeric.includes(`${settlement.slice(1)}-`)),
        `PDF recorded settlement ${row.note}`).toBe(true);
      expect(hasPdfWord(text, "ر.ي")).toBe(true);
    }
    if (row.note === "NCUNK") for (const label of ["غير", "محدد", "في", "السند"]) {
      expect(hasPdfWord(text, label), `PDF unknown target: ${label}`).toBe(true);
    }
  }
}

async function officialDocument(page: Page, href: string, result: ReportResult, expected: WitnessRow[], kpis: KpiWitness,
  totals: string[], filtered: boolean, evidence: CollectionsNativeEvidenceMember[]) {
  const response = await page.goto(new URL(href, baseUrl).href, { waitUntil: "load" });
  expect(response?.status()).toBe(200);
  await settlePaint(page);
  const sheet = page.locator(".sheet-report");
  const table = sheet.locator(".report-table");
  expect(await table.count()).toBe(1);
  await assertTable(page, table, expected, totals);
  expect(await sheet.locator(".report-kpi").count()).toBe(kpis.length);
  for (const kpi of kpis) {
    const label = result.kpis.find(item => item.key === kpi.key)!.label;
    const card = sheet.locator(".report-kpi").filter({ has: page.getByText(label, { exact: true }) });
    expect(plain(await card.locator("strong").innerText())).toBe(kpi.text);
  }
  const screenContent = await table.innerText();
  await page.emulateMedia({ media: "print" });
  // Match A4 landscape's 281 mm printable width (297 mm minus two 8 mm
  // margins), rather than checking a misleading desktop-wide print viewport.
  await page.setViewportSize({ width: Math.floor(281 * 96 / 25.4), height: 900 });
  await settlePaint(page);
  expect(await table.innerText()).toBe(screenContent);
  await assertPaperBounds(sheet, filtered ? "filtered-paper" : "all-paper");
  expect(await page.getByRole("button", { name: "اطبع", exact: true }).isVisible()).toBe(false);
  const prefix = filtered ? "collections-native-filtered" : "collections-native";
  evidence.push({ filename: `${prefix}-print.png`, mime: "image/png", bytes: await sheet.screenshot() });
  const path = `${artifacts}/${prefix}.pdf`;
  const pdf = await page.pdf({ path, format: "A4", landscape: true, printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true });
  evidence.push({ filename: `${prefix}.pdf`, mime: "application/pdf", bytes: pdf });
  const words = await pdfWords(page, path);
  assertPdfRows(words, expected);
  const text = words.map(word => word.text).join(" ");
  for (const total of totals) expect(compact(text)).toContain(total.split(" ")[0]);
  for (const forbidden of ["18,518", "3,518", "59,256", "9,000"]) expect(compact(text)).not.toContain(forbidden);
  if (!filtered) {
    // Negative control proves the actual PDF oracle rejects the original YER
    // relabeling regression; restore DOM immediately and never emit this PDF.
    const cell = table.locator("tbody tr").filter({ has: page.getByText("NCSAM", { exact: true }) }).locator("td").nth(4);
    const original = await cell.textContent();
    try {
      await cell.evaluate(element => { element.textContent = "18,518 ر.ي"; });
      const negativePath = `${artifacts}/collections-native-negative-control.pdf`;
      await page.pdf({ path: negativePath, format: "A4", landscape: true, printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true });
      const negativeWords = await pdfWords(page, negativePath);
      expect(() => assertPdfRows(negativeWords, expected)).toThrow(/PDF native amount NCSAM/);
    } finally { await cell.evaluate((element, value) => { element.textContent = value; }, original); }
    expect(await table.innerText()).toBe(screenContent);
  }
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 1920, height: 1200 });
}

describe("collections native currency across the actual loader, report, downloads and official PDF", () => {
  it("keeps native signed amounts, records only explicit cross-currency settlements and applies exact tender/receiver filters", async () => {
    const before = await financialSnapshot();
    const result = await apiReport();
    assertResult(result, rows, allKpis);
    const debtParams = { report: "debt", debtMode: "collected" };
    const debtResult = await apiReport(debtParams);
    expect(debtResult.report).toBe("debt");
    expect(debtResult.title).toBe("تحصيل المديونيات خلال الفترة");
    expect(debtResult.columns).toEqual(result.columns);
    expect(debtResult.rows).toEqual(result.rows);
    expect(debtResult.kpis).toEqual(result.kpis);
    const filtered = rows.filter(row => row.currency === "SAR" && row.receiver === receiverA);
    const filteredResult = await apiReport({ currency: "SAR", receivedBy: receiverA });
    assertResult(filteredResult, filtered, filteredKpis);
    // Filtering YER must exclude SAR tenders that settle a YER invoice.
    assertResult(await apiReport({ currency: "YER" }), rows.filter(row => row.note === "NCYER"), [allKpis[0]]);
    const same = rows.find(row => row.note === "NCSAM")!;
    assertResult(await apiReport({ patientId: String(same.patientId) }), rows.filter(row => row.patientId === same.patientId), [
      { key: "cur-SAR", currency: "SAR", minor: 10000, text: "100.00 ر.س" },
      { key: "refunds-SAR", currency: "SAR", minor: 2345, text: "23.45 ر.س" },
    ]);
    const evidence: CollectionsNativeEvidenceMember[] = [];
    const context = await browser.newContext({ viewport: { width: 1920, height: 1200 }, locale: "ar-YE", serviceWorkers: "block", acceptDownloads: true });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const unexpected: string[] = [], errors: string[] = [];
    context.on("page", page => { page.on("pageerror", error => errors.push(error.message)); });
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD"].includes(request.method())) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort();
      } else await route.continue();
    });
    await guard.run(async () => {
      const page = await context.newPage();
      const response = await page.goto(`${baseUrl}/reports?${params()}`, { waitUntil: "load" });
      expect(response?.status()).toBe(200);
      const allTotals = ["750 ر.ي", "190.00 ر.س", "98.76 $"];
      await assertScreen(page, result, rows, allKpis, allTotals);
      const allDesktop = await assertDesktopTableBounds(page, "all-desktop");
      evidence.push({ filename: "collections-native-screen.png", mime: "image/png", bytes: allDesktop });
      await assertDownloads(page, result, rows);
      const printLink = page.getByRole("link", { name: "مستند رسمي / PDF", exact: true });
      const originalHref = await printLink.getAttribute("href");
      expect(originalHref).toBeTruthy();
      const printUrl = new URL(originalHref!, baseUrl);
      expect(printUrl.pathname).toBe("/print/report");
      expect(printUrl.searchParams.get("from")).toBe(fixtureDay);
      expect(printUrl.searchParams.get("to")).toBe(fixtureDay);
      const printPage = await context.newPage();
      await officialDocument(printPage, originalHref!, result, rows, allKpis, allTotals, false, evidence);

      await page.getByRole("button", { name: /فلاتر إضافية/ }).click();
      await page.getByLabel("العملة", { exact: true }).selectOption("SAR");
      await page.getByLabel("المستلِم", { exact: true }).selectOption(receiverA);
      // Unapplied edits do not alter the already displayed report or print link.
      await assertScreen(page, result, rows, allKpis, allTotals);
      expect(await printLink.getAttribute("href")).toBe(originalHref);
      for (let attempt = 0; attempt < 2; attempt++) {
        const loaded = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === "/api/reports" && url.searchParams.get("report") === "collections"
            && url.searchParams.get("currency") === "SAR" && url.searchParams.get("receivedBy") === receiverA;
        });
        await page.getByRole("button", { name: "تطبيق وإظهار التقرير", exact: true }).click();
        const api = await loaded;
        expect(api.status()).toBe(200);
        assertResult(((await api.json()) as { result: ReportResult }).result, filtered, filteredKpis);
        await page.getByText(/^جارٍ إعداد /).waitFor({ state: "hidden" });
        await assertScreen(page, filteredResult, filtered, filteredKpis, ["130.00 ر.س"]);
      }
      await page.getByRole("button", { name: "إخفاء الفلاتر", exact: true }).click();
      const filteredDesktop = await assertDesktopTableBounds(page, "filtered-desktop");
      evidence.push({ filename: "collections-native-filtered-screen.png", mime: "image/png", bytes: filteredDesktop });
      await assertDownloads(page, filteredResult, filtered);
      const filteredHref = await printLink.getAttribute("href");
      expect(filteredHref).toBeTruthy();
      const filteredUrl = new URL(filteredHref!, baseUrl);
      expect(filteredUrl.searchParams.get("currency")).toBe("SAR");
      expect(filteredUrl.searchParams.get("receivedBy")).toBe(receiverA);
      await officialDocument(printPage, filteredHref!, filteredResult, filtered, filteredKpis, ["130.00 ر.س"], true, evidence);

      // A copied pre-fix view must not hide the new signed/native money column.
      // Check the real client at phone width and the independent print loader.
      await page.setViewportSize({ width: 390, height: 844 });
      const legacyParams = params({ columns: "date,amountText,baseMinor", sort: "baseMinor:desc" });
      const mobile = await page.goto(`${baseUrl}/reports?${legacyParams}`, { waitUntil: "load" });
      expect(mobile?.status()).toBe(200);
      await assertScreen(page, result, rows, allKpis, allTotals);
      await assertMobileNativeCell(page);
      evidence.push({ filename: "collections-native-mobile.png", mime: "image/png", bytes: await page.screenshot() });
      const legacyPrint = await printPage.goto(`${baseUrl}/print/report?${legacyParams}`, { waitUntil: "load" });
      expect(legacyPrint?.status()).toBe(200);
      await assertTable(printPage, printPage.locator(".sheet-report .report-table"), rows, allTotals);

      const debtPrint = await printPage.goto(`${baseUrl}/print/report?${params(debtParams)}`, { waitUntil: "load" });
      expect(debtPrint?.status()).toBe(200);
      await settlePaint(printPage);
      const debtSheet = printPage.locator(".sheet-report");
      expect(await debtSheet.locator(".doc-title").innerText()).toBe(debtResult.title);
      await assertTable(printPage, debtSheet.locator(".report-table"), rows, allTotals);
      expect(await debtSheet.locator(".report-kpi").count()).toBe(allKpis.length);
      for (const kpi of allKpis) {
        const label = debtResult.kpis.find(item => item.key === kpi.key)!.label;
        const card = debtSheet.locator(".report-kpi").filter({ has: printPage.getByText(label, { exact: true }) });
        expect(plain(await card.locator("strong").innerText())).toBe(kpi.text);
      }
      await printPage.emulateMedia({ media: "print" });
      await printPage.setViewportSize({ width: Math.floor(281 * 96 / 25.4), height: 900 });
      await settlePaint(printPage);
      await assertTable(printPage, debtSheet.locator(".report-table"), rows, allTotals);
      await assertPaperBounds(debtSheet, "debt-collected-paper");
    }, () => { expect(unexpected, "no external requests or mutations, including print-log").toEqual([]); expect(errors).toEqual([]); });
    expect(await financialSnapshot(), "all stored synthetic money, patient and plan rows remain byte-equivalent").toEqual(before);
    console.log(`SYNTHETIC_COLLECTIONS_GEOMETRY_V1 ${JSON.stringify(geometry)}`);
    emitCollectionsNativeEvidence(evidence);
  }, 180_000);
});
