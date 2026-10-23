import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { Currency } from "../../lib/money";

/**
 * The CURRENT printed patient statement shows historical treatment agreements (registered before
 * the system) from their saved latest revision, in the invoice detail layout, distinctly labelled.
 * Previously-paid is history, not a receipt; current collections settle the opening bucket once per
 * currency. Everything is read on the statement's one snapshot. Synthetic data only.
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_statement_historical_test");

vi.mock("@/lib/session", async (importOriginal) => ({ ...(await importOriginal<object>()),
  requireSession: async () => ({ role: "admin", username: "synthetic-print", userId: 1 }) }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: ({ title }: { title: string }) => createElement("h1", null, title), PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));

const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const documents = await import("../../lib/legacy-treatment-document-db");
const legacy = await import("../../lib/legacy-treatment-db");
const { parseLegacyTreatmentRequest } = await import("../../lib/legacy-treatment");
const { DEFAULT_SPECIALTY_TEMPLATES } = await import("../../lib/specialty-templates");
const { readStatementHistoricalAgreements, StatementHistoricalDetailsError } = await import("../../lib/statement-historical-details");
const { default: StatementPage } = await import("../../app/print/statement/[id]/page");
const { formatMoney } = await import("../../lib/money");

const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
let session: SessionPayload;
const services: Record<string, number> = {};
const catalog = new Map<number, Partial<Record<Currency, number>>>();
let serial = 0;

beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-statement-history");
  const [{ id: userId }] = await q<{ id: number }>(`INSERT INTO users(username,display_name,password_hash,role,is_active)
    VALUES('statement-history-owner','Synthetic statement history',$1,'admin',TRUE) RETURNING id`, [hash]);
  session = { userId, username: "statement-history-owner", role: "admin", credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
  for (const [key, name, category, price, sar] of [["rct", "Synthetic historical root canal", "rct", 200000, 140000], ["crown", "Synthetic historical zirconia crown", "crown", 300000, 150050],
    ["ortho", "Synthetic historical orthodontics", "ortho", 400000, 280000], ["filling", "Synthetic historical filling", "filling", 50000, 30000]] as const) {
    services[key] = (await q<{ id: number }>(`INSERT INTO services(name,category,price_minor,price_sar_minor,price_configured,is_active) VALUES($1,$2,$3,$4,TRUE,TRUE) RETURNING id`, [name, category, price, sar]))[0].id;
    catalog.set(services[key], { YER: price, SAR: sar });
  }
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  await q("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140'),('finance.rate.USD','530') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
}, 240_000);
afterAll(async () => { await db.resetPoolForTesting(); });

const newPatient = async (label: string) => (await q<{ id: number }>(
  "INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [`HIST-STMT-${++serial}`, `Synthetic ${label}`]))[0].id;
const terms = (amount: number) => amount ? { mode: "installments", installments: [{ dueDate: "2026-12-12", amountMinor: amount, kind: "installment" }] } : { mode: "full", installments: [] };

type Item = { serviceId: number; price: string; toothCode?: number; scope?: string };
/** A historical multi-item document through the real writer (preview first, exactly as the UI). */
async function historical(patientId: number, input: { currency?: Currency; items: Item[]; discount: string; paid: string; asOf?: string }) {
  const currency = input.currency ?? "YER";
  const prior = (await documents.listHistoricalDocuments(patientId)).find((view) => view.currency === currency);
  const base = { patientId, currency, discountReason: Number(input.discount) > 0 ? "Synthetic historical discount" : null, note: null,
    items: input.items.map((item) => ({ quantity: 1, catalogPriceMinor: catalog.get(item.serviceId)?.[currency],
      ...(toMinor(item.price, currency) !== catalog.get(item.serviceId)?.[currency] ? { priceReason: "Synthetic historical agreed price" } : {}), ...item })),
    discount: input.discount, previouslyPaidAmount: input.paid, historicalAsOf: input.asOf ?? "2026-09-20",
    idempotencyKey: `statement-history-${++serial}`, repaymentSourceHash: prior?.sourceHash ?? null, repaymentVersion: prior?.scheduleVersion ?? 0 };
  const priorRemaining = prior?.openingRemainingMinor ?? 0;
  const gross = input.items.reduce((sum, item) => sum + toMinor(item.price, currency), 0);
  const remaining = priorRemaining + gross - toMinor(input.discount, currency) - toMinor(input.paid, currency);
  const source = { ...base, repaymentTerms: terms(remaining), repaymentRemainingMinor: remaining };
  return (await documents.createHistoricalDocument(patientId, source, session)).document;
}
const toMinor = (amount: string, currency: Currency) => Math.round(Number(amount) * (currency === "YER" ? 1 : 100));

async function standalone(patientId: number, body: Record<string, unknown>, canEditOpening = true) {
  const parsed = parseLegacyTreatmentRequest({ currency: "YER", historicalAsOf: "2026-09-15", idempotencyKey: `statement-standalone-${++serial}`, ...body }, "2026-10-20");
  if (!parsed.ok) throw new Error(parsed.message);
  const result = await legacy.createLegacyTreatment({ patientId, request: parsed.value, actor: session.username, actorRole: "admin", canEditOpening, templates: DEFAULT_SPECIALTY_TEMPLATES, session });
  if (!result.ok) throw new Error(`standalone refused: ${result.reason}`);
  return result.agreement;
}

async function pay(patientId: number, input: { amountMinor: number; currency?: Currency; kind?: "payment" | "refund"; reversalOfId?: number; invoiceId?: number | null; openingCurrency?: Currency | null }) {
  const currency = input.currency ?? "YER";
  const result = await db.recordPayment({ patientId, invoiceId: input.invoiceId ?? null, planId: null,
    openingCurrency: input.invoiceId ? null : input.openingCurrency === undefined ? currency : input.openingCurrency,
    kind: input.kind ?? "payment", reversalOfId: input.reversalOfId, amountMinor: input.amountMinor, currency, baseCurrency: "YER",
    exchangeRate: currency === "YER" ? 1 : currency === "SAR" ? 140 : 530, method: "cash", note: null, createdBy: session.username,
    idempotencyKey: `statement-history-pay-${++serial}` });
  expect(result.reason).toBeNull(); if (!result.payment) throw new Error("Synthetic payment failed"); return result.payment;
}

const print = async (patientId: number) => renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ id: String(patientId) }) }));
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The table rendered for one historical agreement. */
function agreementTable(html: string, kind: "document" | "standalone", id: number) {
  const start = html.indexOf(`data-historical-kind="${kind}" data-historical-id="${id}"`);
  expect(start, `historical ${kind} #${id} printed`).toBeGreaterThan(0);
  return html.slice(start, html.indexOf("</table>", start));
}
const totalRow = (table: string, label: string) => {
  const match = table.match(new RegExp(`<td colSpan="5">${label.replace(/[()]/g, "\\$&")}</td><td class="num">([^<]*)</td>`));
  expect(match, `row ${label}`).not.toBeNull(); return match![1];
};
const lineRows = (table: string) => [...table.matchAll(/<tr><td class="statement-description">([^<]*)<\/td><td>([^<]*)<\/td><td class="num">([^<]*)<\/td><td class="num">([^<]*)<\/td><td class="num">([^<]*)<\/td><td class="num">([^<]*)<\/td><\/tr>/g)]
  .map((match) => match.slice(1, 7));
/** The current-balance block line for a label (the existing canonical summary). */
const summary = (html: string, label: string) => [...html.matchAll(new RegExp(`<span>${label}</span><span class="num">([^<]*)</span>`, "g"))].map((match) => match[1]);
const bucket = (html: string, currency: Currency) => {
  const start = html.indexOf(`data-historical-currency="${currency}"`);
  expect(start).toBeGreaterThan(0);
  const next = html.indexOf("data-historical-currency=", start + 10);
  return html.slice(start, next > 0 ? next : html.indexOf("</section>", start));
};

/** Whole-database content hash: printing must write nothing (payments, cash shifts, journals, history, audit). */
async function financialState(_patientId: number) {
  const tables = (await q<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).map((row) => row.table_name);
  const state: Record<string, string> = {};
  for (const table of tables) {
    const [{ digest }] = await q<{ digest: string }>(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM "${table}" t`);
    state[table] = digest;
  }
  return state;
}

describe("historical agreement details in the current printed statement", () => {
  let examplePatient = 0, exampleDocument = 0, exampleTable = "";

  it("two discounted historical lines with prior payment and no current documents: details visible, billed/collected 0, opening once", async () => {
    examplePatient = await newPatient("historical example");
    const document = await historical(examplePatient, { items: [{ serviceId: services.rct, price: "200000", toothCode: 16 }, { serviceId: services.crown, price: "300000", toothCode: 21 }],
      discount: "50000", paid: "150000" });
    exampleDocument = document.id;
    expect(document).toMatchObject({ totalMinor: 500000, discountMinor: 50000, agreedMinor: 450000, previouslyPaidMinor: 150000, remainingMinor: 300000 });
    expect(await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1", [examplePatient])).toEqual([{ n: 0 }]);
    expect(await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1", [examplePatient])).toEqual([{ n: 0 }]);
    const before = await financialState(examplePatient);
    const html = await print(examplePatient);
    expect(await financialState(examplePatient)).toEqual(before);
    const table = agreementTable(html, "document", document.id);
    exampleTable = table;
    expect(lineRows(table)).toEqual([
      [esc(document.lines[0].description), "16", "1", formatMoney(200000, "YER"), formatMoney(document.lines[0].discountMinor, "YER"), formatMoney(document.lines[0].netMinor, "YER")],
      [esc(document.lines[1].description), "21", "1", formatMoney(300000, "YER"), formatMoney(document.lines[1].discountMinor, "YER"), formatMoney(document.lines[1].netMinor, "YER")],
    ]);
    expect(document.lines[0].discountMinor + document.lines[1].discountMinor).toBe(50000);
    expect(totalRow(table, "الإجمالي قبل الخصم")).toBe(formatMoney(500000, "YER"));
    expect(totalRow(table, "الخصم المسجل")).toBe(formatMoney(50000, "YER"));
    expect(totalRow(table, "المتفق عليه بعد الخصم")).toBe(formatMoney(450000, "YER"));
    expect(totalRow(table, "مدفوع قبل البرنامج (سجل تاريخي — ليس سند قبض حاليًا)")).toBe(formatMoney(150000, "YER"));
    expect(totalRow(table, "المتبقي عند التسجيل — أُضيف إلى الرصيد السابق")).toBe(formatMoney(300000, "YER"));
    // Canonical balances unchanged: nothing billed or collected now; the opening counted once.
    expect(summary(html, "إجمالي المفوتر")).toEqual([formatMoney(0, "YER")]);
    expect(summary(html, "صافي المحصّل بعد الاستردادات وعكس السندات")).toEqual([formatMoney(0, "YER")]);
    expect(summary(html, "رصيد افتتاحي")).toEqual([formatMoney(300000, "YER")]);
    expect(html).toContain("لا فواتير حالية");
    expect(html).toContain("لا دفعات");
    expect(summary(bucket(html, "YER"), "المحصّل منه في البرنامج بعد الاستردادات")).toEqual([formatMoney(0, "YER")]);
    expect(summary(bucket(html, "YER"), "المتبقي من الرصيد السابق")).toEqual([formatMoney(300000, "YER")]);
    expect(html).not.toContain("لا تقابله تفاصيل علاج مسجلة");
  });

  it("a current receipt 40,000 and refund 10,000 leave 270,000 once at currency level; historical facts and journal/cash are preserved", async () => {
    const receipt = await pay(examplePatient, { amountMinor: 40000 });
    await pay(examplePatient, { amountMinor: 10000, kind: "refund", reversalOfId: receipt.id });
    const before = await financialState(examplePatient);
    const html = await print(examplePatient);
    expect(await financialState(examplePatient)).toEqual(before);
    const table = agreementTable(html, "document", exampleDocument);
    expect(totalRow(table, "مدفوع قبل البرنامج (سجل تاريخي — ليس سند قبض حاليًا)")).toBe(formatMoney(150000, "YER"));
    expect(totalRow(table, "المتبقي عند التسجيل — أُضيف إلى الرصيد السابق")).toBe(formatMoney(300000, "YER"));
    // The historical table is byte-identical after current collections: they are never allocated to it.
    expect(table).toBe(exampleTable);
    expect(summary(bucket(html, "YER"), "المحصّل منه في البرنامج بعد الاستردادات")).toEqual([formatMoney(30000, "YER")]);
    expect(summary(bucket(html, "YER"), "المتبقي من الرصيد السابق")).toEqual([formatMoney(270000, "YER")]);
    expect(summary(html, "الرصيد الحالي").join(" ")).toContain(formatMoney(270000, "YER"));
    expect(summary(html, "صافي المحصّل بعد الاستردادات وعكس السندات")).toEqual([formatMoney(30000, "YER")]);
    expect(html).toContain(receipt.receiptNumber);
    // The history is never a receipt: exactly two current receipts, both real.
    expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1", [examplePatient]))[0]).toEqual({ n: 2 });
  });

  it("several same-currency documents: each printed once; current collections/remainder shown once for the currency", async () => {
    const patientId = await newPatient("multi documents");
    const first = await historical(patientId, { items: [{ serviceId: services.rct, price: "200000", toothCode: 36 }], discount: "0", paid: "50000" });
    const second = await historical(patientId, { items: [{ serviceId: services.crown, price: "300000", toothCode: 11 }, { serviceId: services.filling, price: "50000", toothCode: 12 }],
      discount: "10000", paid: "40000" });
    await pay(patientId, { amountMinor: 25000 });
    const html = await print(patientId);
    expect(agreementTable(html, "document", first.id)).toContain(formatMoney(150000, "YER"));
    expect(totalRow(agreementTable(html, "document", second.id), "المتبقي عند التسجيل — أُضيف إلى الرصيد السابق")).toBe(formatMoney(300000, "YER"));
    const yer = bucket(html, "YER");
    expect(summary(yer, "المحصّل منه في البرنامج بعد الاستردادات")).toEqual([formatMoney(25000, "YER")]);
    expect(summary(yer, "المتبقي من الرصيد السابق")).toEqual([formatMoney(425000, "YER")]);
    expect(html.match(/المحصّل منه في البرنامج بعد الاستردادات/g)).toHaveLength(1);
    // Document children are never printed again as standalone agreements.
    expect(html).not.toContain('data-historical-kind="standalone"');
    expect(html.match(/data-historical-kind="document"/g)).toHaveLength(2);
  });

  it("mixed with a current invoice: both printed; the invoice totals and canonical balance are unchanged", async () => {
    const patientId = await newPatient("mixed current");
    const document = await historical(patientId, { items: [{ serviceId: services.rct, price: "120000", toothCode: 46 }], discount: "0", paid: "20000" });
    const invoice = await db.createInvoice({ patientId, baseCurrency: "YER", discountMinor: 5000, note: null, createdBy: "synthetic-reception",
      items: [{ serviceId: null, doctorId: null, description: "CURRENT-INVOICE-LINE", quantity: 2, unitPriceMinor: 30000 }] });
    if (!invoice) throw new Error("Synthetic invoice failed");
    await pay(patientId, { amountMinor: 15000, invoiceId: invoice.id });
    const html = await print(patientId);
    expect(totalRow(agreementTable(html, "document", document.id), "المتبقي عند التسجيل — أُضيف إلى الرصيد السابق")).toBe(formatMoney(100000, "YER"));
    expect(html).toContain("CURRENT-INVOICE-LINE");
    expect(summary(html, "إجمالي المفوتر")).toEqual([formatMoney(55000, "YER")]);
    expect(summary(html, "صافي المحصّل بعد الاستردادات وعكس السندات")).toEqual([formatMoney(15000, "YER")]);
    // Invoice receipts never count as opening collections.
    expect(summary(bucket(html, "YER"), "المحصّل منه في البرنامج بعد الاستردادات")).toEqual([formatMoney(0, "YER")]);
    expect(summary(html, "الرصيد الحالي").join(" ")).toContain(formatMoney(100000 + 55000 - 15000, "YER"));
  });

  it("a corrected document prints its latest saved revision, not the first revision or child agreed values", async () => {
    const patientId = await newPatient("corrected");
    const document = await historical(patientId, { items: [{ serviceId: services.rct, price: "200000", toothCode: 26 }, { serviceId: services.crown, price: "300000", toothCode: 27 }],
      discount: "20000", paid: "100000" });
    const [view] = await documents.listHistoricalDocuments(patientId);
    const remaining = view.openingRemainingMinor + document.previouslyPaidMinor - 130000 + (520000 - 500000);
    await documents.correctHistoricalDocument(patientId, document.id, { idempotencyKey: `statement-correct-${++serial}`, expectedVersion: 1, expectedSourceHash: view.sourceHash,
      prices: ["220000", "300000"], discount: "20000", discountReason: "Synthetic historical discount", previouslyPaidAmount: "130000", historicalAsOf: document.historicalAsOf,
      note: null, reason: "Corrected documented historical facts", repaymentTerms: terms(remaining), repaymentRemainingMinor: remaining, repaymentVersion: view.scheduleVersion }, session);
    expect((await q<{ agreed_minor: string }>("SELECT agreed_minor::text FROM legacy_treatment_agreements WHERE document_id=$1 ORDER BY document_line", [document.id])).map((row) => row.agreed_minor))
      .toEqual(["200000", "300000"]);
    const html = await print(patientId);
    const table = agreementTable(html, "document", document.id);
    expect(table).toContain("النسخة المصححة 2");
    expect(lineRows(table).map((row) => row[3])).toEqual([formatMoney(220000, "YER"), formatMoney(300000, "YER")]);
    expect(totalRow(table, "الإجمالي قبل الخصم")).toBe(formatMoney(520000, "YER"));
    expect(totalRow(table, "مدفوع قبل البرنامج (سجل تاريخي — ليس سند قبض حاليًا)")).toBe(formatMoney(130000, "YER"));
    expect(totalRow(table, "المتبقي عند التسجيل — أُضيف إلى الرصيد السابق")).toBe(formatMoney(370000, "YER"));
    expect(table).not.toContain(formatMoney(200000, "YER"));
    expect(summary(html, "رصيد افتتاحي")).toEqual([formatMoney(370000, "YER")]);
  });

  it("fully paid historically: no opening row, remainder 0, no invented opening collections", async () => {
    const patientId = await newPatient("fully paid");
    const document = await historical(patientId, { items: [{ serviceId: services.filling, price: "50000", toothCode: 15 }], discount: "0", paid: "50000" });
    expect(await q("SELECT count(*)::int AS n FROM patient_opening_balances WHERE patient_id=$1", [patientId])).toEqual([{ n: 0 }]);
    const html = await print(patientId);
    const table = agreementTable(html, "document", document.id);
    expect(totalRow(table, "مدفوع قبل البرنامج (سجل تاريخي — ليس سند قبض حاليًا)")).toBe(formatMoney(50000, "YER"));
    expect(totalRow(table, "المتبقي عند التسجيل — أُضيف إلى الرصيد السابق")).toBe(formatMoney(0, "YER"));
    expect(bucket(html, "YER")).toContain("لا رصيد سابق قائم بهذه العملة.");
    expect(summary(html, "رصيد افتتاحي")).toEqual([]);
  });

  it("a standalone legacy agreement prints once with its stored site; a void one does not print", async () => {
    const patientId = await newPatient("standalone");
    const live = await standalone(patientId, { serviceId: services.ortho, scope: "both", agreedAmount: "400000", previouslyPaidAmount: "100000" });
    const voided = await standalone(patientId, { serviceId: services.rct, toothCode: 31, agreedAmount: "90000", previouslyPaidAmount: "90000" });
    expect((await legacy.voidLegacyTreatment({ patientId, agreementId: voided.id, reason: "Synthetic entered in error", actor: session.username, actorRole: "admin" })).ok).toBe(true);
    const html = await print(patientId);
    const table = agreementTable(html, "standalone", live.id);
    expect(lineRows(table)).toEqual([[esc(live.serviceName), "الفكّان", "1", formatMoney(400000, "YER"), "—", formatMoney(400000, "YER")]]);
    expect(totalRow(table, "مدفوع قبل البرنامج (سجل تاريخي — ليس سند قبض حاليًا)")).toBe(formatMoney(100000, "YER"));
    expect(totalRow(table, "المتبقي عند التسجيل — أُضيف إلى الرصيد السابق")).toBe(formatMoney(300000, "YER"));
    expect(html).not.toContain(`data-historical-id="${voided.id}"`);
    expect(summary(bucket(html, "YER"), "المتبقي من الرصيد السابق")).toEqual([formatMoney(300000, "YER")]);
  });

  it("a manual opening with no stored detail says so and infers nothing; SAR and YER stay in separate buckets", async () => {
    const patientId = await newPatient("manual opening");
    await db.setPatientOpeningBalance({ patientId, currency: "SAR", amountMinor: 12345, asOfDate: "2026-09-01", note: "Synthetic imported balance", createdBy: session.username, reason: "Synthetic import" });
    const document = await historical(patientId, { currency: "YER", items: [{ serviceId: services.rct, price: "80000", toothCode: 44 }], discount: "0", paid: "30000" });
    await pay(patientId, { amountMinor: 2345, currency: "SAR" });
    const html = await print(patientId);
    const sar = bucket(html, "SAR");
    expect(sar).toContain("تفاصيل العلاج غير مسجلة للرصيد السابق بهذه العملة.");
    expect(sar).not.toContain("data-historical-kind");
    expect(summary(sar, "المحصّل منه في البرنامج بعد الاستردادات")).toEqual([formatMoney(2345, "SAR")]);
    expect(summary(sar, "المتبقي من الرصيد السابق")).toEqual([formatMoney(10000, "SAR")]);
    const yer = bucket(html, "YER");
    expect(totalRow(agreementTable(yer, "document", document.id), "المتبقي عند التسجيل — أُضيف إلى الرصيد السابق")).toBe(formatMoney(50000, "YER"));
    expect(summary(yer, "المتبقي من الرصيد السابق")).toEqual([formatMoney(50000, "YER")]);
  });

  it("an SAR document uses ×100 minor units through formatMoney and never mixes with YER", async () => {
    const patientId = await newPatient("sar document");
    const document = await historical(patientId, { currency: "SAR", items: [{ serviceId: services.crown, price: "1500.50", toothCode: 13 }, { serviceId: services.filling, price: "300", toothCode: 14 }],
      discount: "100.50", paid: "500" });
    expect(document).toMatchObject({ currency: "SAR", totalMinor: 180050, discountMinor: 10050, agreedMinor: 170000, previouslyPaidMinor: 50000, remainingMinor: 120000 });
    const html = await print(patientId);
    const table = agreementTable(html, "document", document.id);
    expect(totalRow(table, "الإجمالي قبل الخصم")).toBe(formatMoney(180050, "SAR"));
    expect(totalRow(table, "المتبقي عند التسجيل — أُضيف إلى الرصيد السابق")).toBe(formatMoney(120000, "SAR"));
    expect(html).not.toContain('data-historical-currency="YER"');
  });

  it("only this patient's agreements are printed", async () => {
    const html = await print(examplePatient);
    const others = await q<{ id: number }>("SELECT id FROM legacy_treatment_documents WHERE patient_id<>$1", [examplePatient]);
    expect(others.length).toBeGreaterThan(0);
    for (const { id } of others) expect(html).not.toContain(`data-historical-kind="document" data-historical-id="${id}"`);
    expect(html.match(/data-historical-kind=/g)).toHaveLength(1);
  });
});

const sqlOf = (args: unknown[]) => typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string }).text ?? "");
/** Runs `during` after the statement's receipts are listed and before its historical agreements are read. */
async function interleaved(patientId: number, during: () => Promise<unknown>) {
  const pool = db.getPool();
  const original = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  let injected = false;
  const spy = vi.spyOn(pool, "connect").mockImplementation(((...args: unknown[]) => {
    if (typeof args[0] === "function") return original(...args);
    return (async () => {
      const client = await (original() as Promise<PoolClient>);
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      const release = client.release.bind(client);
      client.query = (async (...args: unknown[]) => {
        if (!injected && sqlOf(args).includes("FROM legacy_treatment_documents d") && sqlOf(args).includes("LEFT JOIN LATERAL")) {
          injected = true; spy.mockRestore(); await during();
        }
        return query(...args);
      }) as typeof client.query;
      client.release = ((destroy?: boolean | Error) => { client.query = query as typeof client.query; client.release = release; return release(destroy); }) as typeof client.release;
      return client;
    })();
  }) as unknown as typeof pool.connect);
  try { const html = await print(patientId); expect(injected).toBe(true); return html; } finally { spy.mockRestore(); }
}

describe("one coherent snapshot and fail-closed reads", () => {
  it("a historical correction and an opening payment committed mid-print appear in neither the agreement nor the balances", async () => {
    const patientId = await newPatient("concurrent");
    const document = await historical(patientId, { items: [{ serviceId: services.rct, price: "100000", toothCode: 17 }], discount: "0", paid: "40000" });
    const before = await print(patientId);
    const html = await interleaved(patientId, async () => {
      const [view] = await documents.listHistoricalDocuments(patientId);
      await documents.correctHistoricalDocument(patientId, document.id, { idempotencyKey: `statement-race-${++serial}`, expectedVersion: 1, expectedSourceHash: view.sourceHash,
        prices: ["100000"], discount: "0", discountReason: null, previouslyPaidAmount: "50000", historicalAsOf: document.historicalAsOf, note: null,
        reason: "Synthetic concurrent correction", repaymentTerms: terms(50000), repaymentRemainingMinor: 50000, repaymentVersion: view.scheduleVersion }, session);
      await pay(patientId, { amountMinor: 7000 });
    });
    expect(html).toBe(before);
    const after = await print(patientId);
    const table = agreementTable(after, "document", document.id);
    expect(totalRow(table, "مدفوع قبل البرنامج (سجل تاريخي — ليس سند قبض حاليًا)")).toBe(formatMoney(50000, "YER"));
    expect(summary(after, "رصيد افتتاحي")).toEqual([formatMoney(50000, "YER")]);
    expect(summary(bucket(after, "YER"), "المحصّل منه في البرنامج بعد الاستردادات")).toEqual([formatMoney(7000, "YER")]);
    expect(summary(bucket(after, "YER"), "المتبقي من الرصيد السابق")).toEqual([formatMoney(43000, "YER")]);
  });

  it("a failing historical read fails the print instead of printing an empty history", async () => {
    const patientId = await newPatient("read failure");
    await historical(patientId, { items: [{ serviceId: services.rct, price: "60000", toothCode: 47 }], discount: "0", paid: "0" });
    const pool = db.getPool();
    const original = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
    const spy = vi.spyOn(pool, "connect").mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "function") return original(...args);
      return (async () => {
        const client = await (original() as Promise<PoolClient>);
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        const release = client.release.bind(client);
        client.query = (async (...args: unknown[]) => {
          if (sqlOf(args).includes("FROM legacy_treatment_agreements a") && sqlOf(args).includes("a.document_id IS NULL")) throw new Error("synthetic historical read failure");
          return query(...args);
        }) as typeof client.query;
        client.release = ((destroy?: boolean | Error) => { client.query = query as typeof client.query; client.release = release; return release(destroy); }) as typeof client.release;
        return client;
      })();
    }) as unknown as typeof pool.connect);
    try { await expect(print(patientId)).rejects.toThrow(/synthetic historical read failure/); } finally { spy.mockRestore(); }
  });

  it("malformed stored facts throw a typed error rather than becoming empty or zero", async () => {
    const fake = (documents: unknown[], standalone: unknown[] = []) => ({ query: vi.fn()
      .mockResolvedValueOnce({ rows: documents }).mockResolvedValueOnce({ rows: standalone }) }) as never;
    const line = { description: "Synthetic", site: { mode: "tooth", toothCode: 16, surfaces: null, episodeTeeth: null, scope: null }, unitPriceMinor: 1000, discountMinor: 0, netMinor: 1000 };
    const doc = { id: 1, currency: "YER", line_count: 1, version: 1, total_minor: "1000", discount_minor: "0", previously_paid_minor: "0", remaining_minor: "1000", historical_as_of: "2026-09-01", lines: [line] };
    expect(await readStatementHistoricalAgreements(fake([doc]), 1)).toHaveLength(1);
    for (const broken of [{ ...doc, version: null }, { ...doc, lines: [] }, { ...doc, line_count: 2 }, { ...doc, lines: null }, { ...doc, currency: "EUR" },
      { ...doc, lines: [{ ...line, netMinor: 999 }] }, { ...doc, lines: [{ ...line, unitPriceMinor: "1000" }] }, { ...doc, lines: [{ ...line, description: "" }] },
      { ...doc, total_minor: "1001" }, { ...doc, remaining_minor: "0" }, { ...doc, historical_as_of: null }]) {
      await expect(readStatementHistoricalAgreements(fake([broken]), 1)).rejects.toBeInstanceOf(StatementHistoricalDetailsError);
    }
    const agreement = { id: 9, service_id: 1, service_name: "Synthetic", tooth_code: 16, currency: "YER", agreed_minor: "1000", previously_paid_minor: "200", remaining_minor: "800", historical_as_of: "2026-09-01", coverage_snapshot: null };
    expect((await readStatementHistoricalAgreements(fake([], [agreement]), 1))[0].lines[0]).toMatchObject({ site: "16", discountMinor: null, netMinor: 1000 });
    for (const broken of [{ ...agreement, remaining_minor: "700" }, { ...agreement, previously_paid_minor: null }, { ...agreement, agreed_minor: "0" }]) {
      await expect(readStatementHistoricalAgreements(fake([], [broken]), 1)).rejects.toBeInstanceOf(StatementHistoricalDetailsError);
    }
  });
});
