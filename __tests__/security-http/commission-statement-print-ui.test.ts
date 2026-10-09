import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { chromium, type Browser, type Page } from "playwright";
import { authedGet, baseUrl, harness } from "./_server";

/**
 * كشف عمولة الطبيب المطبوع حسب الحالة — على التطبيق المبني وببيانات اصطناعية.
 *
 * الأرقام كلها تُقارن بما يعيده الخادم نفسه (`/api/finance/commissions`) — لا بمعادلةٍ
 * في الاختبار: السطور من وضع التفصيل، والمصروف والرصيد التراكمي من وضع المجاميع.
 * فإن عرض الكشف رقمًا لم يحسبه المحرّك، أو جمع عملتين، أو أسقط سطرًا، سقط الاختبار.
 *
 * ويغطّي: التجميع حسب الحالة ومجاميعها، وفصل العملات، وأساس العمولة مقابل قيمة العمل
 * والمستحق، ومرشّح التخصص (لا مصروف ولا رصيد منسوبَين إليه بلا مصدر)، والصلاحيات وعدم
 * تسرّب طبيبٍ آخر، والطباعة A4 متعددة الصفحات بترويسة أعمدة مكرّرة وترقيم، والعرضين 390
 * و1280، وتغيير المرشّح أثناء التحميل في لوحة التفصيل، وفشل المصدر لا يصير صفرًا.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;

const stamp = Date.now();
const tag = stamp.toString(36).slice(-5).toUpperCase();
const FROM = "2023-02-01";
const TO = "2023-02-28";
const ARTIFACTS = join(process.cwd(), ".settings-ui-artifacts");
const OTHER_PATIENT = `مريض طبيب آخر ${stamp}`;
const ORTHO_CASE = `تقويم ثابت ${stamp}`;
const IMPLANT_CASE = `زراعة ٣٦ ${stamp}`;
const PAYOUT_YER = 150_000;
const MARCH_FROM = "2023-03-01";
const MARCH_TO = "2023-03-31";
const COORDINATED_CASE = `حالة بمنسّقٍ آخر ${stamp}`;
const COORDINATED_PATIENT = `مريض الحالة المنسّقة ${stamp}`;
let coordinatedInvoice = { invoiceId: 0, invoiceNumber: "" };

let doctorS = 0;
let doctorB = 0;
let supplierId = 0;
let shiftId = 0;
let seq = 0;

interface ApiLine {
  invoiceId: number; doctorId: number; currency: string; caseId: number | null; planId: number | null;
  patientName: string; amountMinor: number; baseMinor: number; accruedMinor: number; earnedMinor: number;
  percent: number; caseTitle: string | null;
}
interface ApiRow {
  doctorId: number; currency: string; accruedMinor: number; earnedMinor: number; paidMinor: number;
  dueMinor: number; netEarnedMinor: number; balanceMinor: number; materialRateApplied: boolean;
}

async function q<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function patient(name: string): Promise<number> {
  seq += 1;
  const [row] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`CS-${stamp}-${seq}`, name]);
  return row.id;
}

/** زيارة موقّعة وفاتورتها: بند واحد للطبيب، واختياريًّا من بند خطةٍ مربوطٍ بحالة. */
async function work(input: {
  patientId: number; doctorId: number; day: number; amount: number; currency?: string;
  serviceId?: number; planItemId?: number; paid?: number; month?: number;
}): Promise<number> {
  seq += 1;
  const at = `2023-${String(input.month ?? 2).padStart(2, "0")}-${String(input.day).padStart(2, "0")} 10:00+03`;
  const currency = input.currency ?? "YER";
  const [invoice] = await q<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, $3, 0, $4, 'test', $5::timestamptz) RETURNING id`,
    [`S${tag}-${seq}`, input.patientId, input.amount, currency, at]);
  const [visit] = await q<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, doctor_id, status, invoice_id, arrived_at, signed_at, signed_by)
     VALUES ('مريض', $1, $2, 'done', $3, $4::timestamptz, $4::timestamptz, 'test') RETURNING id`,
    [input.patientId, input.doctorId, invoice.id, at]);
  let sourceId: number | null = null;
  if (input.serviceId) {
    const [procedure] = await q<{ id: number }>(
      `INSERT INTO visit_procedures (visit_id, service_id, doctor_id, quantity, unit_price_minor, plan_item_id)
       VALUES ($1, $2, $3, 1, $4, $5) RETURNING id`,
      [visit.id, input.serviceId, input.doctorId, input.amount, input.planItemId ?? null]);
    sourceId = procedure.id;
  }
  await q(
    `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id, source_type, source_id)
     VALUES ($1, $2, $3, 1, $4, $4, $5, $6, $7)`,
    [invoice.id, input.serviceId ?? null, input.serviceId ? "عمل" : "عمل بلا خدمة", input.amount, input.doctorId,
      sourceId === null ? null : "visit_procedure", sourceId]);
  if (input.paid) {
    seq += 1;
    await q(
      `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
         exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'payment', $5, $6, 1, $5, $6, 'cash', 'test', $7::timestamptz)`,
      [`CS-R-${stamp}-${seq}`, input.patientId, invoice.id, shiftId, input.paid, currency, at]);
  }
  return invoice.id;
}

async function caseWithPlanItem(patientId: number, specialty: string, title: string, serviceId: number, responsiblePartyId: number | null = null) {
  const [kase] = await q<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, created_by, responsible_party_id) VALUES ($1, $2, $3, 'test', $4) RETURNING id`,
    [patientId, specialty, title, responsiblePartyId]);
  const [plan] = await q<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, $2, 0) RETURNING id`, [patientId, `خطة ${title}`]);
  const [item] = await q<{ id: number }>(
    `INSERT INTO plan_items (plan_id, service_id, service_name, quantity, unit_price_minor, case_id)
     VALUES ($1, $2, 'بند', 1, 0, $3) RETURNING id`, [plan.id, serviceId, kase.id]);
  return { caseId: kase.id, planItemId: item.id };
}

/** فاتورة واحدة بعدة بنود — كل بندٍ بطبيبه المنفّذ وبند خطته — مدفوعة كاملًا. */
async function multiLineInvoice(input: {
  patientId: number; at: string; items: Array<{ doctorId: number; amount: number; serviceId: number; planItemId: number }>;
}): Promise<{ invoiceId: number; invoiceNumber: string }> {
  seq += 1;
  const total = input.items.reduce((sum, item) => sum + item.amount, 0);
  const invoiceNumber = `S${tag}-${seq}`;
  const [invoice] = await q<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, $3, 0, 'YER', 'test', $4::timestamptz) RETURNING id`, [invoiceNumber, input.patientId, total, input.at]);
  const [visit] = await q<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, doctor_id, status, invoice_id, arrived_at, signed_at, signed_by)
     VALUES ('مريض', $1, $2, 'done', $3, $4::timestamptz, $4::timestamptz, 'test') RETURNING id`,
    [input.patientId, input.items[0].doctorId, invoice.id, input.at]);
  for (const item of input.items) {
    const [procedure] = await q<{ id: number }>(
      `INSERT INTO visit_procedures (visit_id, service_id, doctor_id, quantity, unit_price_minor, plan_item_id)
       VALUES ($1, $2, $3, 1, $4, $5) RETURNING id`, [visit.id, item.serviceId, item.doctorId, item.amount, item.planItemId]);
    await q(
      `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id, source_type, source_id)
       VALUES ($1, $2, 'عمل', 1, $3, $3, $4, 'visit_procedure', $5)`, [invoice.id, item.serviceId, item.amount, item.doctorId, procedure.id]);
  }
  seq += 1;
  await q(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
       exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
     VALUES ($1, $2, $3, $4, 'payment', $5, 'YER', 1, $5, 'YER', 'cash', 'test', $6::timestamptz)`,
    [`CS-R-${stamp}-${seq}`, input.patientId, invoice.id, shiftId, total, input.at]);
  return { invoiceId: invoice.id, invoiceNumber };
}

async function payout(at: string, currency: "YER" | "USD", amount: number, rate: number): Promise<void> {
  seq += 1;
  await q(
    `INSERT INTO expenses (voucher_number, category, party_id, shift_id, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, created_at)
     VALUES ($1, 'commission', $2, $3, $4, $5, $6, $7, 'YER', $8::timestamptz)`,
    [`CS-EXP-${stamp}-${seq}`, doctorS, shiftId, amount, currency, rate, Math.round(amount * rate), at]);
}

async function api<T>(path: string, who: "admin" | "doctorA" = "admin"): Promise<T> {
  const response = await authedGet(path, h.sessions[who]);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

function cookieOf(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

async function openAs(who: "admin" | "doctorA", path: string, width = 1280): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  await ctx.addCookies([{ ...cookieOf(h.sessions[who].cookie), url: baseUrl }]);
  const page = await ctx.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}

const statementPath = (doctorId: number, extra = "") => `/print/commission-statement/${doctorId}?from=${FROM}&to=${TO}${extra}`;
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  /* وردية مغلقة: الدفعات الاصطناعية تحتاج ورديةً تُسند إليها، ولا يجوز أن نترك ورديةً
     مفتوحة أو نصطدم بوردية مفتوحة لملف اختبار آخر (وردية مفتوحة واحدة فقط). */
  const [shift] = await q<{ id: number }>(
    `INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at) VALUES ('cstmt', 'closed', 'cstmt', NOW()) RETURNING id`);
  shiftId = shift.id;
  const [s] = await q<{ id: number }>(
    `INSERT INTO parties (name, kind, commission_percent) VALUES ($1, 'doctor', 40) RETURNING id`, [`د. كشف اصطناعي ${stamp}`]);
  doctorS = s.id;
  const [b] = await q<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctorb'`);
  doctorB = b.party_id;
  const [supplier] = await q<{ id: number }>(
    `INSERT INTO parties (name, kind) VALUES ($1, 'supplier') RETURNING id`, [`مورّد ${stamp}`]);
  supplierId = supplier.id;

  const [ortho] = await q<{ id: number }>(`INSERT INTO services (name, category) VALUES ($1, 'ortho') RETURNING id`, [`تقويم ${stamp}`]);
  const [implant] = await q<{ id: number }>(`INSERT INTO services (name, category) VALUES ($1, 'implant') RETURNING id`, [`زراعة ${stamp}`]);
  const p1 = await patient(`مريض التقويم ${stamp}`);
  const p2 = await patient(`مريض الزراعة ${stamp}`);
  const p3 = await patient(`مريض بلا حالة ${stamp}`);
  const orthoCase = await caseWithPlanItem(p1, "orthodontics", ORTHO_CASE, ortho.id);
  const implantCase = await caseWithPlanItem(p2, "implantology", IMPLANT_CASE, implant.id);

  /* ٣٩ سطرًا تكفي لصفحاتٍ عدة: تقويم مدفوع كاملًا، وزراعة نصفها، وأعمال بلا حالة بلا دفع،
     وزراعة بالدولار — فالكشف يحمل عملتين لا تُجمعان. */
  for (let i = 0; i < 18; i += 1) {
    await work({ patientId: p1, doctorId: doctorS, day: 1 + (i % 27), amount: 10_000 + i * 7, serviceId: ortho.id, planItemId: orthoCase.planItemId, paid: 10_000 + i * 7 });
  }
  for (let i = 0; i < 12; i += 1) {
    await work({ patientId: p2, doctorId: doctorS, day: 2 + (i % 26), amount: 25_001 + i, serviceId: implant.id, planItemId: implantCase.planItemId, paid: 12_500 });
  }
  for (let i = 0; i < 6; i += 1) {
    await work({ patientId: p3, doctorId: doctorS, day: 3 + i, amount: 7_333 });
  }
  for (let i = 0; i < 3; i += 1) {
    await work({ patientId: p2, doctorId: doctorS, day: 10 + i, amount: 30_000, currency: "USD", serviceId: implant.id, planItemId: implantCase.planItemId, paid: 30_000 });
  }
  /* طبيبٌ آخر في الفترة نفسها — يجب ألّا يظهر مريضه في كشف غيره. */
  const other = await patient(OTHER_PATIENT);
  await work({ patientId: other, doctorId: doctorB, day: 5, amount: 40_000, paid: 40_000 });
  /* مصروف عمولةٍ حقيقي للطبيب في الفترة (سند صرف) — مصدر «المصروف له». */
  await q(
    `INSERT INTO expenses (voucher_number, category, party_id, shift_id, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, created_at)
     VALUES ($1, 'commission', $2, $3, $4, 'YER', 1, $4, 'YER', '2023-02-20 12:00+03')`,
    [`CS-EXP-${stamp}`, doctorS, shiftId, PAYOUT_YER]);

  /* ما قبل بداية الفترة (يناير): عملٌ محصَّل وسند صرف بكل عملة — يدخل الرصيد التراكمي
     حتى نهاية فبراير ولا يدخل نتيجة فبراير. */
  await work({ month: 1, patientId: p1, doctorId: doctorS, day: 10, amount: 20_000, serviceId: ortho.id, planItemId: orthoCase.planItemId, paid: 20_000 });
  await work({ month: 1, patientId: p2, doctorId: doctorS, day: 11, amount: 500, currency: "USD", serviceId: implant.id, planItemId: implantCase.planItemId, paid: 500 });
  await payout("2023-01-20 12:00+03", "YER", 5_000, 1);
  await payout("2023-01-21 12:00+03", "USD", 100, 530);

  /* مارس: حالةٌ منسّقها الطبيب ب، وفاتورة واحدة فيها بندان للطبيب المنفّذ (س) وبندٌ للطبيب ب. */
  const coordinatedPatient = await patient(COORDINATED_PATIENT);
  const coordinated = await caseWithPlanItem(coordinatedPatient, "orthodontics", COORDINATED_CASE, ortho.id, doctorB);
  coordinatedInvoice = await multiLineInvoice({ patientId: coordinatedPatient, at: "2023-03-07 10:00+03", items: [
    { doctorId: doctorS, amount: 12_000, serviceId: ortho.id, planItemId: coordinated.planItemId },
    { doctorId: doctorS, amount: 8_000, serviceId: implant.id, planItemId: coordinated.planItemId },
    { doctorId: doctorB, amount: 5_000, serviceId: ortho.id, planItemId: coordinated.planItemId },
  ] });

  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await db?.end();
});

describe("كشف العمولة المطبوع — الأرقام من الخادم", () => {
  it("كل سطور المحرّك مطبوعة (لا الصفحة الظاهرة وحدها)، مجمّعةً حسب الحالة بمجاميعها", async () => {
    const detail = await api<{ lines: ApiLine[] }>(`/api/finance/commissions?detail=1&from=${FROM}&to=${TO}&doctorId=${doctorS}`);
    expect(detail.lines).toHaveLength(39);
    const page = await openAs("admin", statementPath(doctorS));
    try {
      await page.locator("[data-statement-line]").first().waitFor({ timeout: 60_000 });
      expect(await page.locator("[data-statement-line]").count()).toBe(39);

      /* حالةٌ لكل مجموعة: التقويم، والزراعة، وأعمالٌ بلا حالة — لا خلط. */
      const groups = await page.locator("[data-case-group]").allInnerTexts();
      expect(groups.some((text) => text.includes(ORTHO_CASE))).toBe(true);
      expect(groups.some((text) => text.includes(IMPLANT_CASE))).toBe(true);
      expect(groups.some((text) => text.includes("بلا حالة"))).toBe(true);

      /* مجموع كل حالة بكل عملة = مجموع سطور المحرّك لتلك الحالة والعملة. */
      const subtotals = await page.locator("[data-case-subtotal]").evaluateAll((nodes) => nodes.map((node) => ({
        group: node.getAttribute("data-case-subtotal"),
        currency: node.getAttribute("data-currency"),
        earned: Number(node.getAttribute("data-earned")),
        accrued: Number(node.getAttribute("data-accrued")),
      })));
      const expected = new Map<string, { earned: number; accrued: number }>();
      for (const line of detail.lines) {
        const key = `${line.caseId !== null ? `case:${line.caseId}` : line.planId !== null ? `plan:${line.planId}` : "none"}|${line.currency}`;
        const entry = expected.get(key) ?? { earned: 0, accrued: 0 };
        entry.earned += line.earnedMinor;
        entry.accrued += line.accruedMinor;
        expected.set(key, entry);
      }
      expect(subtotals).toHaveLength(expected.size);
      for (const subtotal of subtotals) {
        expect(expected.get(`${subtotal.group}|${subtotal.currency}`)).toEqual({ earned: subtotal.earned, accrued: subtotal.accrued });
      }
    } finally {
      await page.context().close();
    }
  });

  it("أساس العمولة وقيمة العمل والمستحق تُعرض كما حسبها المحرّك — كل عملةٍ وحدها", async () => {
    const detail = await api<{ lines: ApiLine[] }>(`/api/finance/commissions?detail=1&from=${FROM}&to=${TO}&doctorId=${doctorS}`);
    const totals = await api<{ rows: ApiRow[] }>(`/api/finance/commissions?from=${FROM}&to=${TO}`);
    const page = await openAs("admin", statementPath(doctorS));
    try {
      await page.locator("[data-statement-line]").first().waitFor({ timeout: 60_000 });
      const shown = await page.locator("[data-statement-line]").evaluateAll((nodes) => nodes.map((node) => ({
        invoice: Number(node.getAttribute("data-invoice")),
        amount: Number(node.getAttribute("data-amount")),
        base: Number(node.getAttribute("data-base")),
        earned: Number(node.getAttribute("data-earned")),
        accrued: Number(node.getAttribute("data-accrued")),
      })));
      const byInvoice = new Map(detail.lines.map((line) => [line.invoiceId, line]));
      for (const row of shown) {
        const line = byInvoice.get(row.invoice)!;
        expect(row).toEqual({ invoice: line.invoiceId, amount: line.amountMinor, base: line.baseMinor, earned: line.earnedMinor, accrued: line.accruedMinor });
      }
      const header = await page.locator("[data-statement-table] thead").innerText();
      for (const label of ["قيمة العمل", "أساس العمولة", "النسبة", "على الفاتورة", "المستحق على المحصّل"]) expect(header).toContain(label);

      /* فصل العملات: ملخّصٌ لكل عملة، ولا ملخّص «إجمالي» يجمعها. */
      const currencies = await page.locator("[data-currency-summary]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-currency-summary")));
      expect(currencies.sort()).toEqual(["USD", "YER"]);
      for (const currency of ["YER", "USD"]) {
        const row = totals.rows.find((entry) => entry.doctorId === doctorS && entry.currency === currency)!;
        const summary = page.locator(`[data-currency-summary="${currency}"]`);
        expect(Number(await summary.getAttribute("data-accrued"))).toBe(row.accruedMinor);
        expect(Number(await summary.getAttribute("data-earned"))).toBe(row.earnedMinor);
        expect(Number(await summary.getAttribute("data-net-earned"))).toBe(row.netEarnedMinor);
        expect(Number(await summary.getAttribute("data-paid"))).toBe(row.paidMinor);
        expect(Number(await summary.getAttribute("data-period-due"))).toBe(row.dueMinor);
        expect(Number(await summary.getAttribute("data-balance"))).toBe(row.balanceMinor);
        const linesSum = detail.lines.filter((line) => line.currency === currency).reduce((sum, line) => sum + line.earnedMinor, 0);
        expect(linesSum).toBe(row.earnedMinor);
      }
      expect(Number(await page.locator('[data-currency-summary="YER"]').getAttribute("data-paid"))).toBe(PAYOUT_YER);
      expect(await page.locator("body").innerText()).not.toMatch(/الإجمالي العام|كل العملات/);
    } finally {
      await page.context().close();
    }
  });

  it("مرشّح التخصص: سطوره وحدها، ولا مصروف ولا رصيد يُنسبان إليه بلا مصدر", async () => {
    const detail = await api<{ lines: ApiLine[] }>(`/api/finance/commissions?detail=1&from=${FROM}&to=${TO}&doctorId=${doctorS}&specialty=implant`);
    const page = await openAs("admin", statementPath(doctorS, "&specialty=implant"));
    try {
      await page.locator("[data-statement-line]").first().waitFor({ timeout: 60_000 });
      expect(await page.locator("[data-statement-line]").count()).toBe(detail.lines.length);
      expect(await page.locator("[data-case-group]").allInnerTexts()).not.toContain(ORTHO_CASE);
      expect(await page.locator("[data-currency-summary] [data-paid-row]").count()).toBe(0);
      expect(await page.locator("[data-scope-note]").innerText()).toContain("التخصص");
    } finally {
      await page.context().close();
    }
  });
});

describe("كشف العمولة المطبوع — الصلاحيات", () => {
  it("جهةٌ ليست طبيبًا أو رقمٌ غير موجود: 404 لا كشفٌ فارغ", async () => {
    expect((await authedGet(statementPath(supplierId), h.sessions.admin)).status).toBe(404);
    expect((await authedGet(statementPath(999_999_999), h.sessions.admin)).status).toBe(404);
  });

  it("الطبيب لا يطبع كشف غيره، وكشفه لا يحمل مرضى غيره؛ الاستقبال والكاشير ممنوعان", async () => {
    const [user] = await q<{ permissions: string }>(`SELECT permissions FROM users WHERE username = 'secdoctora'`);
    const original = user.permissions;
    const permissions = JSON.parse(original) as Record<string, boolean>;
    await q(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [JSON.stringify({
      ...permissions, canViewOwnCommissions: true, canViewClinicRevenue: false, canViewClinicFinance: false, canViewOtherDoctorsAccounts: false,
    })]);
    try {
      const [a] = await q<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
      expect((await authedGet(statementPath(doctorS), h.sessions.doctorA)).status).toBe(404);
      expect((await authedGet(statementPath(doctorB), h.sessions.doctorA)).status).toBe(404);
      const own = await authedGet(statementPath(a.party_id), h.sessions.doctorA);
      expect(own.status).toBe(200);
      const html = await own.text();
      expect(html).not.toContain(OTHER_PATIENT);
      expect(html).not.toContain(ORTHO_CASE);
      expect((await authedGet(statementPath(doctorS), h.sessions.reception)).status).not.toBe(200);
      expect((await authedGet(statementPath(doctorS), h.sessions.cashier)).status).not.toBe(200);
    } finally {
      await q(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [original]);
    }
  });
});

describe("كشف العمولة المطبوع — الورق والشاشة", () => {
  it("A4 فعلية متعددة الصفحات: ترويسة المركز، أعمدة مكرّرة، ترقيم، بلا قصّ ولا تكرار سطر", async () => {
    await mkdir(ARTIFACTS, { recursive: true });
    const page = await openAs("admin", statementPath(doctorS));
    try {
      await page.locator("[data-statement-line]").first().waitFor({ timeout: 60_000 });
      await page.emulateMedia({ media: "print" });
      /* لا قصّ أفقي: الجدول داخل عرض الورقة في وسائط الطباعة. */
      const fit = await page.locator("[data-statement-table]").evaluate((table) => ({
        table: table.scrollWidth, sheet: (table.closest(".sheet") as HTMLElement).clientWidth,
        cellsOverflow: [...table.querySelectorAll("td, th")].filter((cell) => cell.scrollWidth > cell.clientWidth + 1).length,
      }));
      expect(fit.table).toBeLessThanOrEqual(fit.sheet + 1);
      expect(fit.cellsOverflow).toBe(0);

      const path = join(ARTIFACTS, "commission-statement-synthetic.pdf");
      const pdf = await page.pdf({ path, preferCSSPageSize: true, printBackground: true });
      await writeFile(path, pdf);
      const pages = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], { encoding: "utf8" })
        .split("\f").filter((text) => text.trim().length > 0);
      expect(pages.length, "fixture must exercise pagination").toBeGreaterThanOrEqual(2);
      const size = execFileSync("pdfinfo", [path], { encoding: "utf8" }).match(/Page size:\s+([\d.]+) x ([\d.]+)/)!;
      /* A4 أفقي: 842 × 595 نقطة. */
      expect(Math.round(Number(size[1]))).toBe(842);
      expect(Math.round(Number(size[2]))).toBe(595);
      pages.forEach((text, index) => {
        expect(text, `header row repeats on page ${index + 1}`).toContain("أساس العمولة");
        expect(text, `page number on page ${index + 1}`).toMatch(new RegExp(`${index + 1}\\s*/\\s*${pages.length}`));
      });
      /* ترويسة المركز من الإعدادات كما رُسمت — على الصفحة الأولى. */
      const clinicName = (await page.locator(".clinic-name").first().innerText()).trim();
      expect(clinicName.length).toBeGreaterThan(0);
      expect(pages[0]).toContain(clinicName.split(/\s+/)[0]);
      /* كل فاتورة مطبوعة مرةً واحدة: لا سطر مقصوص بين صفحتين ولا مكرّر. */
      const all = pages.join("\n");
      const numbers = await page.locator("[data-statement-line]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-invoice-number")!));
      for (const number of numbers) {
        expect(all.match(new RegExp(`${number}(?!\\d)`, "g"))?.length ?? 0, number).toBe(1);
      }
    } finally {
      await page.context().close();
    }
  });

  it("الشاشة بعرض 390 و1280: RTL، بلا تمرير أفقي للصفحة، ولقطات للمراجعة", async () => {
    for (const width of [390, 1280]) {
      const page = await openAs("admin", statementPath(doctorS), width);
      try {
        await page.locator("[data-statement-line]").first().waitFor({ timeout: 60_000 });
        expect(await page.locator(".sheet").getAttribute("dir")).toBe("rtl");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `commission-statement-${width}.png`), fullPage: width === 1280 });
      } finally {
        await page.context().close();
      }
    }
  });
});

describe("كشف العمولة المطبوع — الرصيد قبل الفترة والمنفّذ لا المنسّق", () => {
  it("نتيجة الفترة تختلف عن الرصيد التراكمي حتى نهايتها — لكل عملة، وكلاهما من المحرّك", async () => {
    const feb = await api<{ rows: ApiRow[] }>(`/api/finance/commissions?from=${FROM}&to=${TO}`);
    const jan = await api<{ rows: ApiRow[] }>(`/api/finance/commissions?from=2023-01-01&to=2023-01-31`);
    const page = await openAs("admin", statementPath(doctorS));
    try {
      await page.locator("[data-statement-line]").first().waitFor({ timeout: 60_000 });
      for (const currency of ["YER", "USD"]) {
        const before = jan.rows.find((row) => row.doctorId === doctorS && row.currency === currency)!;
        const row = feb.rows.find((entry) => entry.doctorId === doctorS && entry.currency === currency)!;
        /* نشاطٌ قبل بداية الفترة: عمولةٌ وصرف في يناير. */
        expect(before.earnedMinor, currency).toBeGreaterThan(0);
        expect(before.paidMinor, currency).toBeGreaterThan(0);
        /* الرصيد التراكمي حتى نهاية فبراير = ما حمله يناير + نتيجة فبراير — علاقة المحرّك نفسه. */
        expect(row.balanceMinor, currency).toBe(before.balanceMinor + row.dueMinor);
        expect(row.dueMinor, currency).not.toBe(row.balanceMinor);
        const summary = page.locator(`[data-currency-summary="${currency}"]`);
        expect(Number(await summary.getAttribute("data-period-due"))).toBe(row.dueMinor);
        expect(Number(await summary.getAttribute("data-balance"))).toBe(row.balanceMinor);
        const text = await summary.innerText();
        expect(text).toContain("نتيجة الفترة");
        expect(text).toContain(`حتى ${TO}`);
      }
    } finally {
      await page.context().close();
    }
  });

  it("المنفّذ لا المنسّق: بندا المنفّذ في فاتورة واحدة يظهران مرةً واحدة لكلٍّ، والإجماليات = المحرّك", async () => {
    const range = `from=${MARCH_FROM}&to=${MARCH_TO}`;
    const detailS = await api<{ lines: ApiLine[] }>(`/api/finance/commissions?detail=1&${range}&doctorId=${doctorS}`);
    const detailB = await api<{ lines: ApiLine[] }>(`/api/finance/commissions?detail=1&${range}&doctorId=${doctorB}`);
    const totals = await api<{ rows: ApiRow[] }>(`/api/finance/commissions?${range}`);
    expect(detailS.lines.filter((line) => line.invoiceId === coordinatedInvoice.invoiceId).map((line) => line.amountMinor).sort())
      .toEqual([12_000, 8_000].sort());
    expect(detailB.lines.filter((line) => line.invoiceId === coordinatedInvoice.invoiceId).map((line) => line.amountMinor))
      .toEqual([5_000]);

    const page = await openAs("admin", `/print/commission-statement/${doctorS}?${range}`);
    try {
      await page.locator("[data-statement-line]").first().waitFor({ timeout: 60_000 });
      const shown = await page.locator("[data-statement-line]").evaluateAll((nodes) => nodes.map((node) => ({
        invoice: Number(node.getAttribute("data-invoice")), amount: Number(node.getAttribute("data-amount")),
        earned: Number(node.getAttribute("data-earned")), accrued: Number(node.getAttribute("data-accrued")),
      })));
      /* لا تكرار ولا نقصان: سطور الكشف = سطور المحرّك للطبيب المنفّذ، وبند الطبيب ب ليس منها. */
      expect(shown).toHaveLength(detailS.lines.length);
      expect(shown.filter((line) => line.invoice === coordinatedInvoice.invoiceId).map((line) => line.amount).sort())
        .toEqual([12_000, 8_000].sort());
      const groups = await page.locator("[data-case-group]").allInnerTexts();
      expect(groups.filter((text) => text.includes(COORDINATED_CASE))).toHaveLength(1);
      const row = totals.rows.find((entry) => entry.doctorId === doctorS && entry.currency === "YER")!;
      expect(shown.reduce((sum, line) => sum + line.earned, 0)).toBe(row.earnedMinor);
      expect(shown.reduce((sum, line) => sum + line.accrued, 0)).toBe(row.accruedMinor);
      const summary = page.locator('[data-currency-summary="YER"]');
      expect(Number(await summary.getAttribute("data-earned"))).toBe(row.earnedMinor);
      expect(Number(await summary.getAttribute("data-accrued"))).toBe(row.accruedMinor);
    } finally {
      await page.context().close();
    }

    /* والمنسّق (الطبيب ب) لا تنتقل إليه عمولة المنفّذ: كشفه يحمل بنده وحده من الفاتورة. */
    const coordinatorPage = await openAs("admin", `/print/commission-statement/${doctorB}?${range}`);
    try {
      await coordinatorPage.locator("[data-statement-line]").first().waitFor({ timeout: 60_000 });
      const amounts = await coordinatorPage.locator(`[data-statement-line][data-invoice="${coordinatedInvoice.invoiceId}"]`)
        .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("data-amount"))));
      expect(amounts).toEqual([5_000]);
    } finally {
      await coordinatorPage.context().close();
    }
  });
});

describe("لوحة تفصيل العمولة — ملكية الطلبات وعقد الردّ ورابط الطباعة", () => {
  const panel = (page: Page) => page.locator("[data-commission-detail]");
  const toggle = (page: Page) => page.getByRole("button", { name: /تفصيل العمولة/ });
  const pick = (page: Page, label: string) => panel(page).locator("label", { hasText: label }).locator("select");
  const isDetail = (url: string) => new URL(url).searchParams.get("detail") === "1";

  async function setPeriod(page: Page, from: string, to: string) {
    await page.locator('input[type="date"]').first().fill(from);
    await page.locator('input[type="date"]').nth(1).fill(to);
  }

  /* الصفحة تُفتح على domcontentloaded: قد تصل الضغطة قبل أن يكتمل hydration فتضيع. نضغط حتى
     تؤكّد اللوحة نفسها أنها فُتحت (وهذا يثبت أنّ React حيّ)، ثم نضبط الفترة. */
  async function openPanel(width = 1280, who: "admin" | "doctorA" = "admin"): Promise<Page> {
    const page = await openAs(who, "/finance/commissions", width);
    await panel(page).waitFor({ timeout: 60_000 });
    await expect.poll(async () => {
      if (await panel(page).getAttribute("data-detail-state") === "closed") await toggle(page).click();
      return panel(page).getAttribute("data-detail-state");
    }, { timeout: 30_000, interval: 500 }).not.toBe("closed");
    await setPeriod(page, FROM, TO);
    await panel(page).getByText(OTHER_PATIENT).first().waitFor({ timeout: 60_000 });
    return page;
  }

  it("ردٌّ متأخر لطبيبٍ سابق لا يظهر تحت طبيبٍ اختير بعده، ولا تبقى سطورٌ قديمة أثناء التحميل", async () => {
    const page = await openPanel();
    try {
      await page.route("**/api/finance/commissions?*", async (route) => {
        const url = new URL(route.request().url());
        if (isDetail(url.href) && url.searchParams.get("doctorId") === String(doctorS)) await new Promise((resolve) => setTimeout(resolve, 2_000));
        await route.continue().catch(() => {});
      });
      await pick(page, "الطبيب").selectOption(String(doctorS));
      await page.waitForTimeout(300);
      expect(await panel(page).getByText(OTHER_PATIENT).count()).toBe(0);
      expect(await panel(page).getAttribute("data-detail-state")).toBe("loading");
      expect(await panel(page).locator("[data-print-link]").count()).toBe(0);
      await pick(page, "الطبيب").selectOption(String(doctorB));
      await panel(page).getByText(OTHER_PATIENT).first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2_500);
      expect(await panel(page).getByText(OTHER_PATIENT).count()).toBeGreaterThan(0);
      expect(await panel(page).getByText(`مريض التقويم ${stamp}`).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  it("إغلاق اللوحة أثناء طلبٍ معلّق ثم تغيير الفترة وإعادة الفتح: الردّ القديم يصل متأخرًا ولا يُعرض", async () => {
    const page = await openPanel();
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = 0;
      await page.route("**/api/finance/commissions?*", async (route) => {
        const url = new URL(route.request().url());
        if (isDetail(url.href) && url.searchParams.get("from") === FROM && url.searchParams.get("doctorId") === String(doctorS)) {
          held += 1;
          await gate;
        }
        await route.continue().catch(() => {});
      });
      await pick(page, "الطبيب").selectOption(String(doctorS));
      await expect.poll(() => held, { timeout: 10_000 }).toBe(1);
      await toggle(page).click();
      expect(await panel(page).getAttribute("data-detail-state")).toBe("closed");
      await setPeriod(page, MARCH_FROM, MARCH_TO);
      await toggle(page).click();
      await panel(page).getByText(COORDINATED_PATIENT).first().waitFor({ timeout: 30_000 });
      release();
      await page.waitForTimeout(1_500);
      expect(await panel(page).getByText(`مريض التقويم ${stamp}`).count()).toBe(0);
      expect(await panel(page).getByText(COORDINATED_PATIENT).count()).toBeGreaterThan(0);
      /* خيار المستخدم باقٍ، والرابط يتبع النطاق الجديد. */
      expect(await pick(page, "الطبيب").inputValue()).toBe(String(doctorS));
      expect(await panel(page).locator("[data-print-link]").getAttribute("href")).toContain(`from=${MARCH_FROM}`);

      /* وإعادة الفتح على المرشّحات نفسها لا تعرض النتيجة السابقة قبل تحميلٍ جديد. */
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.route("**/api/finance/commissions?*", async (route) => {
        if (isDetail(route.request().url())) await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue().catch(() => {});
      });
      await toggle(page).click();
      await toggle(page).click();
      await page.waitForTimeout(200);
      expect(await panel(page).getAttribute("data-detail-state")).toBe("loading");
      expect(await panel(page).getByText(COORDINATED_PATIENT).count()).toBe(0);
      await panel(page).getByText(COORDINATED_PATIENT).first().waitFor({ timeout: 30_000 });
    } finally {
      await page.context().close();
    }
  });

  it("نطاق أ ← ب ← أ وردودٌ بترتيبٍ عكسي: لا يظهر إلا ردّ الطلب الأخير", async () => {
    const page = await openPanel();
    try {
      let sRequests = 0;
      await page.route("**/api/finance/commissions?*", async (route) => {
        const url = new URL(route.request().url());
        if (isDetail(url.href)) {
          const doctor = url.searchParams.get("doctorId");
          if (doctor === String(doctorS)) {
            sRequests += 1;
            if (sRequests === 1) await new Promise((resolve) => setTimeout(resolve, 3_000));
          } else if (doctor === String(doctorB)) {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
          }
        }
        await route.continue().catch(() => {});
      });
      await pick(page, "الطبيب").selectOption(String(doctorS));
      await page.waitForTimeout(150);
      await pick(page, "الطبيب").selectOption(String(doctorB));
      await page.waitForTimeout(150);
      await pick(page, "الطبيب").selectOption(String(doctorS));
      await panel(page).getByText(`مريض التقويم ${stamp}`).first().waitFor({ timeout: 30_000 });
      /* ردّا أ الأول وب يصلان بعد ردّ أ الأخير — ولا يغيّران شيئًا. */
      await page.waitForTimeout(3_500);
      expect(sRequests).toBe(2);
      expect(await panel(page).getByText(OTHER_PATIENT).count()).toBe(0);
      expect(await panel(page).getByText(`مريض التقويم ${stamp}`).count()).toBeGreaterThan(0);
      expect(await panel(page).getAttribute("data-detail-state")).toBe("ready");
      expect(await panel(page).locator("[data-print-link]").getAttribute("href")).toContain(`/print/commission-statement/${doctorS}?`);
    } finally {
      await page.context().close();
    }
  });

  it("أ ناجحة ← ب معلّقة ← أ: لا تعود نتيجة أ القديمة جاهزة ولا رابطها حتى ينجح طلب أ الجديد", async () => {
    const page = await openPanel();
    try {
      /* أ ناجحة مسبقًا: سطور الطبيب س ورابط طباعته. */
      await pick(page, "الطبيب").selectOption(String(doctorS));
      await panel(page).locator("[data-print-link]").waitFor({ timeout: 30_000 });
      await panel(page).getByText(`مريض التقويم ${stamp}`).first().waitFor({ timeout: 30_000 });

      let releaseB: () => void = () => {};
      let releaseA: () => void = () => {};
      const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
      const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
      let aRequests = 0;
      await page.route("**/api/finance/commissions?*", async (route) => {
        const url = new URL(route.request().url());
        if (isDetail(url.href) && url.searchParams.get("doctorId") === String(doctorB)) await gateB;
        if (isDetail(url.href) && url.searchParams.get("doctorId") === String(doctorS)) {
          aRequests += 1;
          await gateA;
        }
        await route.continue().catch(() => {});
      });

      await pick(page, "الطبيب").selectOption(String(doctorB));
      await page.waitForTimeout(300);
      expect(await panel(page).getAttribute("data-detail-state")).toBe("loading");
      expect(await panel(page).locator("[data-print-link]").count()).toBe(0);

      /* العودة إلى أ: المفتاح يعود للقيم نفسها، لكنّ النتيجة القديمة لا تعود. */
      await pick(page, "الطبيب").selectOption(String(doctorS));
      await expect.poll(() => aRequests, { timeout: 10_000 }).toBe(1);
      await page.waitForTimeout(300);
      expect(await panel(page).getAttribute("data-detail-state")).toBe("loading");
      expect(await panel(page).getByText(`مريض التقويم ${stamp}`).count()).toBe(0);
      expect(await panel(page).locator("[data-print-link]").count()).toBe(0);
      expect(await panel(page).locator("[data-print-disabled]").innerText()).toContain("بعد اكتمال التحميل");

      /* ردّ ب المتأخر لا يغيّر شيئًا، ثم ينجح طلب أ الحالي وحده. */
      releaseB();
      await page.waitForTimeout(600);
      expect(await panel(page).getAttribute("data-detail-state")).toBe("loading");
      expect(await panel(page).getByText(OTHER_PATIENT).count()).toBe(0);
      releaseA();
      await panel(page).getByText(`مريض التقويم ${stamp}`).first().waitFor({ timeout: 30_000 });
      expect(await panel(page).getAttribute("data-detail-state")).toBe("ready");
      expect(await panel(page).locator("[data-print-link]").getAttribute("href")).toContain(`/print/commission-statement/${doctorS}?`);
    } finally {
      await page.context().close();
    }
  });

  it("سحب صلاحية «حسابات الأطباء الآخرين» يسحب البيانات المعروضة فورًا ويبطل الطلبات — والخادم يبقى الحَكَم", async () => {
    const [user] = await q<{ permissions: string; party_id: number }>(`SELECT permissions, party_id FROM users WHERE username = 'secdoctora'`);
    const original = user.permissions;
    const base = JSON.parse(original) as Record<string, boolean>;
    const grant = (others: boolean) => q(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [JSON.stringify({
      ...base, canViewOwnCommissions: true, canViewClinicRevenue: false, canViewClinicFinance: false, canViewOtherDoctorsAccounts: others,
    })]);
    await grant(true);
    let page: Page | null = null;
    try {
      /* الطبيب أ بصلاحية حسابات الآخرين: يرى سطور الجميع. */
      page = await openPanel(1280, "doctorA");
      await panel(page).getByText(`مريض التقويم ${stamp}`).first().waitFor({ timeout: 30_000 });
      expect(await pick(page, "الطبيب").count()).toBe(1);

      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/api/finance/commissions?*", async (route) => {
        if (isDetail(route.request().url())) await gate;
        await route.continue().catch(() => {});
      });

      /* سحب الصلاحية، ثم تحديث الجلسة في المتصفح كما يفعل أي `router.refresh()` في التطبيق. */
      await grant(false);
      await page.evaluate(() => (window as unknown as { next: { router: { refresh(): void } } }).next.router.refresh());
      await expect.poll(() => panel(page!).getByText(OTHER_PATIENT).count(), { timeout: 20_000 }).toBe(0);
      expect(await panel(page).getByText(`مريض التقويم ${stamp}`).count()).toBe(0);
      expect(await panel(page).getAttribute("data-detail-state")).toBe("loading");
      expect(await panel(page).locator("[data-print-link]").count()).toBe(0);
      /* قائمة الأطباء المبنية على الصلاحية القديمة سُحبت أيضًا. */
      expect(await panel(page).locator("option", { hasText: "د. كشف اصطناعي" }).count()).toBe(0);

      release();
      await expect.poll(() => panel(page!).getAttribute("data-detail-state"), { timeout: 30_000 }).toBe("ready");
      expect(await panel(page).getByText(OTHER_PATIENT).count()).toBe(0);
      expect(await panel(page).getByText(`مريض التقويم ${stamp}`).count()).toBe(0);
      expect(await pick(page, "الطبيب").count()).toBe(0);

      /* والتحقّق المستقل على الخادم باقٍ: لا تفصيل لغيره ولا كشف مطبوع لغيره. */
      const detail = await (await authedGet(`/api/finance/commissions?detail=1&from=${FROM}&to=${TO}&doctorId=${doctorS}`, h.sessions.doctorA)).json() as { lines: ApiLine[]; isPersonalOnly: boolean };
      expect(detail.isPersonalOnly).toBe(true);
      expect(detail.lines.every((line) => line.doctorId === user.party_id)).toBe(true);
      expect((await authedGet(statementPath(doctorS), h.sessions.doctorA)).status).toBe(404);
    } finally {
      await page?.context().close();
      await q(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [original]);
    }
  });

  it("401 و403 وردّ 200 ناقص: رسالةٌ عربية آمنة، لا سطور ولا أصفار ولا طباعة — ثم التعافي بإعادة المحاولة", async () => {
    const page = await openPanel();
    try {
      await pick(page, "الطبيب").selectOption(String(doctorS));
      await panel(page).locator("[data-print-link]").waitFor({ timeout: 30_000 });
      let mode: "403" | "partial" | "401" | "pass" = "403";
      await page.route("**/api/finance/commissions?*", (route) => {
        if (!isDetail(route.request().url()) || mode === "pass") return route.continue();
        if (mode === "403") return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "stack: secret-internal-detail" }) });
        if (mode === "401") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "token expired at node-17" }) });
        /* 200 بلا rows ولا unallocatedMaterials ولا serviceRateFindings. */
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ lines: [], isPersonalOnly: false }) });
      });
      const alert = panel(page).getByRole("alert");
      const retry = panel(page).getByRole("button", { name: "إعادة المحاولة" });
      const expectNothingShown = async () => {
        expect(await panel(page).getByText(`مريض التقويم ${stamp}`).count()).toBe(0);
        expect(await panel(page).getByText("لا سطور في هذه الفترة").count()).toBe(0);
        expect(await panel(page).locator("[data-print-link]").count()).toBe(0);
        expect(await panel(page).innerText()).not.toMatch(/secret-internal-detail|node-17|stack:/);
      };

      await pick(page, "العملة").selectOption("YER");
      await alert.filter({ hasText: "غير مصرّح لك بعرض تفصيل العمولات." }).waitFor({ timeout: 10_000 });
      await expectNothingShown();
      expect(await panel(page).locator("[data-print-disabled]").innerText()).toContain("لا صلاحية");
      expect(await pick(page, "العملة").inputValue()).toBe("YER");
      await panel(page).screenshot({ path: join(ARTIFACTS, "commission-panel-error-1280.png") });

      mode = "partial";
      await retry.click();
      await alert.filter({ hasText: "ردٌّ ناقص أو غير صالح" }).waitFor({ timeout: 10_000 });
      await expectNothingShown();
      expect(await panel(page).locator("[data-print-disabled]").innerText()).toContain("لا طباعة قبل تحميلٍ صحيح");

      mode = "401";
      await retry.click();
      await alert.filter({ hasText: "انتهت الجلسة" }).waitFor({ timeout: 10_000 });
      await expectNothingShown();

      mode = "pass";
      await retry.click();
      await panel(page).getByText(`مريض التقويم ${stamp}`).first().waitFor({ timeout: 30_000 });
      expect(await alert.count()).toBe(0);
      const href = await panel(page).locator("[data-print-link]").getAttribute("href");
      expect(href).toContain(`/print/commission-statement/${doctorS}?`);
      expect(href).toContain("currency=YER");
    } finally {
      await page.context().close();
    }
  });

  it("فشل المصدر (500) يُعلن ولا يصير «لا سطور» ولا يُبقي سطورًا قديمة", async () => {
    const page = await openPanel();
    try {
      await page.route("**/api/finance/commissions?*", (route) => isDetail(route.request().url())
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "تعذّر تحميل العمولات." }) })
        : route.continue());
      await pick(page, "العملة").selectOption("USD");
      await panel(page).getByRole("alert").filter({ hasText: "تعذّر تحميل تفصيل العمولة." }).waitFor({ timeout: 10_000 });
      expect(await panel(page).getByText(OTHER_PATIENT).count()).toBe(0);
      expect(await panel(page).getByText("لا سطور في هذه الفترة").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  it("اللوحة بعرض 390 و1280: نتيجة معتمدة ورابط طباعة مفعّل — لقطات للمراجعة", async () => {
    for (const width of [390, 1280]) {
      const page = await openPanel(width);
      try {
        await pick(page, "الطبيب").selectOption(String(doctorS));
        await panel(page).locator("[data-print-link]").waitFor({ timeout: 30_000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await panel(page).evaluate((element) => element.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: join(ARTIFACTS, `commission-panel-${width}.png`) });
      } finally {
        await page.context().close();
      }
    }
  });
});
