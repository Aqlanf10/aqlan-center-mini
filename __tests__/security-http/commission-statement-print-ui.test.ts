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
  serviceId?: number; planItemId?: number; paid?: number;
}): Promise<number> {
  seq += 1;
  const at = `2023-02-${String(input.day).padStart(2, "0")} 10:00+03`;
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

async function caseWithPlanItem(patientId: number, specialty: string, title: string, serviceId: number) {
  const [kase] = await q<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, $2, $3, 'test') RETURNING id`,
    [patientId, specialty, title]);
  const [plan] = await q<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, $2, 0) RETURNING id`, [patientId, `خطة ${title}`]);
  const [item] = await q<{ id: number }>(
    `INSERT INTO plan_items (plan_id, service_id, service_name, quantity, unit_price_minor, case_id)
     VALUES ($1, $2, 'بند', 1, 0, $3) RETURNING id`, [plan.id, serviceId, kase.id]);
  return { caseId: kase.id, planItemId: item.id };
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
  const [shift] = await q<{ id: number }>(`INSERT INTO cashier_shifts (opened_by) VALUES ('cstmt') RETURNING id`);
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

describe("لوحة تفصيل العمولة — المرشّحات أثناء التحميل والفشل", () => {
  async function openPanel(): Promise<Page> {
    const page = await openAs("admin", "/finance/commissions");
    await page.locator('input[type="date"]').first().fill(FROM);
    await page.locator('input[type="date"]').nth(1).fill(TO);
    await page.getByRole("button", { name: /تفصيل العمولة/ }).click();
    await page.getByText(OTHER_PATIENT).first().waitFor({ timeout: 60_000 });
    return page;
  }

  it("ردٌّ متأخر لطبيبٍ سابق لا يظهر تحت طبيبٍ اختير بعده", async () => {
    const page = await openPanel();
    try {
      await page.route("**/api/finance/commissions?*", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("doctorId") === String(doctorS)) await new Promise((resolve) => setTimeout(resolve, 2_000));
        await route.continue();
      });
      const select = page.locator("label", { hasText: "الطبيب" }).locator("select");
      await select.selectOption(String(doctorS));
      /* أثناء التحميل لا تبقى سطور «كل الأطباء» معروضةً تحت الطبيب الجديد. */
      await page.waitForTimeout(300);
      expect(await page.getByText(OTHER_PATIENT).count()).toBe(0);
      await select.selectOption(String(doctorB));
      await page.getByText(OTHER_PATIENT).first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2_500);
      expect(await page.getByText(OTHER_PATIENT).count()).toBeGreaterThan(0);
      expect(await page.getByText(`مريض التقويم ${stamp}`).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  it("فشل المصدر يُعلن ولا يصير «لا سطور» ولا يُبقي سطورًا قديمة", async () => {
    const page = await openPanel();
    try {
      await page.route("**/api/finance/commissions?*", (route) => route.fulfill({
        status: 500, contentType: "application/json", body: JSON.stringify({ message: "تعذّر تحميل العمولات." }),
      }));
      await page.locator("label", { hasText: "العملة" }).locator("select").selectOption("USD");
      await page.getByRole("alert").filter({ hasText: "تعذّر تحميل العمولات." }).waitFor({ timeout: 10_000 });
      expect(await page.getByText(OTHER_PATIENT).count()).toBe(0);
      expect(await page.getByText("لا سطور في هذه الفترة").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });
});
