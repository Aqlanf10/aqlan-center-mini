/**
 * محرك التقارير — كل الحساب يجري هنا على الخادم.
 *
 * القاعدة المحاسبية التي يقوم عليها كله (وثيقة المتطلبات، البند ١٧):
 *
 *   رصيد المريض = الرصيد الافتتاحي + صافي الفواتير − الدفعات (والاسترداد يعكس)
 *
 * لا «قيمة الخطة ناقص المدفوع»: الخطة اتفاق قد يتغيّر، والفاتورة واقعة. وكل رقم
 * في هذه التقارير مشتق من حركات مسجّلة فعلًا — لا يُحذف منها شيء بصمت (الاسترداد
 * يُسجَّل حركة معاكسة لا محوًا).
 *
 * ولأعمار الديون وتصنيف التحصيل (جديد/سابق) نستخدم **FIFO**: الدفعة تُغطّي أقدم
 * دين أولًا — وهو العرف المحاسبي، وهو ما يفعله من يقبض المال على المكشوف.
 *
 * ملاحظة بنية: كل الحالة تُمرَّر داخل `ReportContext` — لا خزّانات على مستوى
 * الوحدة، لأن عملية Next واحدة تخدم طلبات متزامنة، وخزان مشترك يعني تقريرًا
 * يختلط ببيانات طلبٍ آخر بلا أثر في السجلات.
 */

import { getPool, ensureSchema, getSettings, listParties, listServices, CLINIC_TIME_ZONE } from "./db";
import { CATEGORY_LABEL } from "./services-catalog";
import { isCurrency, type Currency } from "./money";
import type {
  ReportFilters, ReportResult, ReportRow, KpiItem, ReportColumn,
  PeriodPreset, DebtMode, PatientStatusFilter, DebtStatusFilter,
  CurrencyFilter, CompareMode, ReportOptions,
} from "./reports-types";
import { PATIENT_STATUS_LABEL, PAYMENT_METHOD_LABEL } from "./reports-types";

// ─── حساب التواريخ بتوقيت العيادة ───────────────────────────────────────────

function clinicTodayISO(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TIME_ZONE }).format(now);
}

function toUTC(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function fromUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return fromUTC(toUTC(iso) + days * 86_400_000);
}

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return `${y + years}-${String(m).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function endOfMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

/** الأسبوع في اليمن يبدأ السبت. */
function startOfWeek(iso: string): string {
  const dow = new Date(Date.parse(`${iso}T12:00:00Z`)).getUTCDay(); // الأحد=0 … السبت=6
  const back = (dow + 1) % 7; // السبت → 0
  return addDays(iso, -back);
}

function startOfQuarter(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const q = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(q).padStart(2, "0")}-01`;
}

function endOfQuarter(iso: string): string {
  return addDays(addMonths(startOfQuarter(iso), 3), -1);
}

/** يقرأ الفترة ويحلّها إلى مدى فعلي. مصدَّر للاختبارات. */
export function resolvePeriod(
  preset: PeriodPreset,
  from?: string | null,
  to?: string | null,
  today: string = clinicTodayISO(),
): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "this_week":
      return { from: startOfWeek(today), to: today };
    case "this_month":
      return { from: startOfMonth(today), to: endOfMonth(today) };
    case "prev_month": {
      const pm = addMonths(startOfMonth(today), -1);
      return { from: pm, to: endOfMonth(pm) };
    }
    case "this_quarter":
      return { from: startOfQuarter(today), to: endOfQuarter(today) };
    case "this_year":
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case "prev_year": {
      const y = String(Number(today.slice(0, 4)) - 1);
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    case "custom": {
      const f = /^\d{4}-\d{2}-\d{2}$/.test(from ?? "") ? (from as string) : startOfMonth(today);
      const t = /^\d{4}-\d{2}-\d{2}$/.test(to ?? "") ? (to as string) : today;
      return f <= t ? { from: f, to: t } : { from: t, to: f };
    }
  }
}

/** فترة المقارنة: السابقة بالطول نفسه، أو نفس الفترة قبل سنة. */
function comparisonRange(from: string, to: string, mode: CompareMode): { from: string; to: string; label: string } | null {
  if (mode === "none") return null;
  if (mode === "prev_year") {
    return {
      from: addYears(from, -1),
      to: addYears(to, -1),
      label: `نفس الفترة قبل سنة (${addYears(from, -1)} → ${addYears(to, -1)})`,
    };
  }
  const lengthDays = Math.round((toUTC(to) - toUTC(from)) / 86_400_000);
  return {
    from: addDays(from, -(lengthDays + 1)),
    to: addDays(from, -1),
    label: `الفترة السابقة (${addDays(from, -(lengthDays + 1))} → ${addDays(from, -1)})`,
  };
}

const num = (value: string | number | null | undefined): number => Number(value ?? 0);

/**
 * تاريخ اليوم **كما تراه القاعدة نفسها** — هو المعيار الذي حُسبت به تواريخ الحركات.
 *
 * لماذا من القاعدة لا من Intl؟ لأن PGlite المحلي يتجاهل `AT TIME ZONE` (المكيّف في
 * db.ts يحذفها فيُحسب كل شيء بتوقيت UTC)، بينما Postgres الحقيقي يحترم توقيت
 * العيادة. ومن يحسب «اليوم» بطريقة غير التي حُسبت بها تواريخ الفواتير والدفعات
 * يرى تقرير اليوم فارغًا مع بيانات موجودة — بلا خطأ ظاهر.
 */
export async function dbTodayISO(): Promise<string> {
  await ensureSchema();
  const { rows } = await getPool().query<{ today: string }>(
    `SELECT (NOW() AT TIME ZONE $1)::date::text AS today`,
    [CLINIC_TIME_ZONE],
  );
  return rows[0]?.today ?? clinicTodayISO();
}

function monthName(month: number): string {
  return [
    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
    "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
  ][month - 1] ?? "—";
}

function formatArabicDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// ─── تحميل حركات المرضى (الأساس لكل تقارير المديونية) ────────────────────────

interface MovementInvoice {
  id: number; date: string; totalMinor: number; discountMinor: number; netMinor: number;
  planId: number | null; categories: string[]; doctorIds: number[]; items: string[];
}

interface MovementPayment {
  id: number; date: string; kind: string; amountMinor: number; currency: Currency;
  baseMinor: number; method: string; invoiceId: number | null; planId: number | null;
  createdBy: string | null; note: string | null;
}

interface MovementPlan {
  id: number; title: string; totalMinor: number; status: string; startDate: string;
  categories: string[]; paidMinor: number;
}

interface PatientMovement {
  patientId: number; patientNumber: string; name: string; phone: string | null;
  createdDate: string | null; lastVisitDate: string | null;
  status: keyof typeof PATIENT_STATUS_LABEL;
  opening: { date: string; minor: number } | null;
  invoices: MovementInvoice[];
  payments: MovementPayment[];
  plans: MovementPlan[];
  visitDoctorIds: number[];
}

async function loadMovements(opts: {
  patientId?: number | null;
  patientStatus?: PatientStatusFilter;
}): Promise<PatientMovement[]> {
  await ensureSchema();
  const pool = getPool();

  // حالة المريض مشتقّة: آخر خطة علاج، فإن لم توجد فحداثة آخر زيارة.
  const statusExpr = `
    COALESCE(
      (SELECT tp.status FROM treatment_plans tp
        WHERE tp.patient_id = p.id ORDER BY tp.start_date DESC, tp.id DESC LIMIT 1),
      CASE WHEN (SELECT MAX(v.arrived_at) FROM visits v WHERE v.patient_id = p.id) > NOW() - INTERVAL '180 days'
        THEN 'active' ELSE 'unknown' END
    )`;

  const patientsResult = await pool.query<{
    id: number; patient_number: string; full_name: string; phone: string | null;
    created_date: string | null; last_visit: string | null; status: string;
  }>(
    `SELECT p.id, p.patient_number, p.full_name, p.phone,
            (p.created_at AT TIME ZONE $1)::date::text AS created_date,
            (SELECT MAX((v.arrived_at AT TIME ZONE $1)::date)::text FROM visits v WHERE v.patient_id = p.id) AS last_visit,
            (${statusExpr}) AS status
       FROM patients p
      WHERE ($2::int IS NULL OR p.id = $2::int)
        AND ($3::text IS NULL OR (${statusExpr}) = $3::text)
      ORDER BY p.id`,
    [CLINIC_TIME_ZONE, opts.patientId ?? null, opts.patientStatus && opts.patientStatus !== "all" ? opts.patientStatus : null],
  );

  if (patientsResult.rows.length === 0) return [];
  const ids = patientsResult.rows.map((row) => row.id);

  const [invoicesRes, paymentsRes, openingRes, plansRes, visitDoctorsRes] = await Promise.all([
    pool.query<{
      id: number; patient_id: number; date: string; total: string; discount: string; plan_id: number | null;
      categories: string[] | null; doctor_ids: number[] | null; items: string[] | null;
    }>(
      `SELECT i.id, i.patient_id, (i.created_at AT TIME ZONE $1)::date::text AS date,
              i.total_minor::text AS total, i.discount_minor::text AS discount, i.plan_id,
              (SELECT COALESCE(json_agg(DISTINCT s.category) FILTER (WHERE s.category IS NOT NULL), '[]'::json)
                 FROM invoice_items it LEFT JOIN services s ON s.id = it.service_id
                WHERE it.invoice_id = i.id) AS categories,
              (SELECT COALESCE(json_agg(DISTINCT it.doctor_id) FILTER (WHERE it.doctor_id IS NOT NULL), '[]'::json)
                 FROM invoice_items it WHERE it.invoice_id = i.id) AS doctor_ids,
              (SELECT COALESCE(json_agg(DISTINCT it.description) FILTER (WHERE it.description IS NOT NULL), '[]'::json)
                 FROM invoice_items it WHERE it.invoice_id = i.id) AS items
         FROM invoices i
        WHERE i.status <> 'cancelled' AND i.patient_id = ANY($2::int[])`,
      [CLINIC_TIME_ZONE, ids],
    ),
    pool.query<{
      id: number; patient_id: number; date: string; kind: string; amount: string; currency: string;
      base: string; method: string; invoice_id: number | null; plan_id: number | null;
      created_by: string | null; note: string | null;
    }>(
      `SELECT id, patient_id, (created_at AT TIME ZONE $1)::date::text AS date, kind,
              amount_minor::text AS amount, currency, base_amount_minor::text AS base,
              method, invoice_id, plan_id, created_by, note
         FROM payments WHERE patient_id = ANY($2::int[])`,
      [CLINIC_TIME_ZONE, ids],
    ),
    pool.query<{ patient_id: number; as_of: string; amount: string }>(
      `SELECT patient_id, as_of_date::text AS as_of, amount_minor::text AS amount
         FROM patient_opening_balances WHERE patient_id = ANY($1::int[])`,
      [ids],
    ),
    pool.query<{
      id: number; patient_id: number; title: string; total: string; status: string;
      start_date: string; categories: string[] | null;
    }>(
      `SELECT tp.id, tp.patient_id, tp.title, tp.total_minor::text AS total, tp.status,
              tp.start_date::text AS start_date,
              (SELECT COALESCE(json_agg(DISTINCT pi.category) FILTER (WHERE pi.category IS NOT NULL), '[]'::json)
                 FROM plan_items pi WHERE pi.plan_id = tp.id) AS categories
         FROM treatment_plans tp WHERE tp.patient_id = ANY($1::int[])`,
      [ids],
    ),
    pool.query<{ patient_id: number; doctor_id: number }>(
      `SELECT DISTINCT patient_id, doctor_id FROM visits
        WHERE doctor_id IS NOT NULL AND patient_id = ANY($1::int[])`,
      [ids],
    ),
  ]);

  const byId = new Map<number, PatientMovement>();
  for (const row of patientsResult.rows) {
    byId.set(row.id, {
      patientId: row.id,
      patientNumber: row.patient_number,
      name: row.full_name,
      phone: row.phone,
      createdDate: row.created_date,
      lastVisitDate: row.last_visit,
      status: (PATIENT_STATUS_LABEL[row.status] ? row.status : "unknown") as keyof typeof PATIENT_STATUS_LABEL,
      opening: null,
      invoices: [],
      payments: [],
      plans: [],
      visitDoctorIds: [],
    });
  }

  for (const row of invoicesRes.rows) {
    byId.get(row.patient_id)?.invoices.push({
      id: row.id,
      date: row.date,
      totalMinor: num(row.total),
      discountMinor: num(row.discount),
      netMinor: Math.max(0, num(row.total) - num(row.discount)),
      planId: row.plan_id,
      categories: row.categories ?? [],
      doctorIds: row.doctor_ids ?? [],
      items: row.items ?? [],
    });
  }
  for (const row of paymentsRes.rows) {
    byId.get(row.patient_id)?.payments.push({
      id: row.id,
      date: row.date,
      kind: row.kind,
      amountMinor: num(row.amount),
      currency: (isCurrency(row.currency) ? row.currency : "YER"),
      baseMinor: num(row.base),
      method: row.method,
      invoiceId: row.invoice_id,
      planId: row.plan_id,
      createdBy: row.created_by,
      note: row.note,
    });
  }
  for (const row of openingRes.rows) {
    const patient = byId.get(row.patient_id);
    if (patient) patient.opening = { date: row.as_of, minor: num(row.amount) };
  }
  for (const row of plansRes.rows) {
    byId.get(row.patient_id)?.plans.push({
      id: row.id,
      title: row.title,
      totalMinor: num(row.total),
      status: row.status,
      startDate: row.start_date,
      categories: row.categories ?? [],
      paidMinor: 0,
    });
  }
  for (const row of visitDoctorsRes.rows) {
    byId.get(row.patient_id)?.visitDoctorIds.push(row.doctor_id);
  }

  // مدفوعات الخطة: الدفعة المرتبطة بالخطة مباشرة أو بفاتورة من الخطة.
  for (const patient of byId.values()) {
    const planById = new Map(patient.plans.map((plan) => [plan.id, plan]));
    for (const payment of patient.payments) {
      let targetPlanId = payment.planId;
      if (targetPlanId == null && payment.invoiceId != null) {
        targetPlanId = patient.invoices.find((inv) => inv.id === payment.invoiceId)?.planId ?? null;
      }
      if (targetPlanId != null) {
        const plan = planById.get(targetPlanId);
        if (plan) plan.paidMinor += payment.kind === "refund" ? -payment.baseMinor : payment.baseMinor;
      }
    }
    // ترتيب زمني — FIFO يفترضه.
    patient.invoices.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    patient.payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  }

  return [...byId.values()];
}

// ─── حسابات الأرصدة (المنطق الخالص — قابل للاختبار) ─────────────────────────

/** الرصيد بتاريخ: الافتتاحي (إن كان سابقًا) + الفواتير حتى التاريخ − الدفعات. */
export function balanceAt(m: {
  opening: { date: string; minor: number } | null;
  invoices: { date: string; netMinor: number }[];
  payments: { date: string; baseMinor: number; kind: string }[];
}, date: string): number {
  let balance = 0;
  if (m.opening && m.opening.date <= date) balance += m.opening.minor;
  for (const invoice of m.invoices) if (invoice.date <= date) balance += invoice.netMinor;
  for (const payment of m.payments) {
    if (payment.date <= date) balance -= payment.kind === "refund" ? -payment.baseMinor : payment.baseMinor;
  }
  return balance;
}

/** أقدم دين غير مغطّى حتى تاريخه (FIFO) وعمره بالأيام. */
export function oldestUnpaid(
  m: {
    opening: { date: string; minor: number } | null;
    invoices: { date: string; netMinor: number }[];
    payments: { date: string; baseMinor: number; kind: string }[];
  },
  asOf: string,
): { date: string | null; ageDays: number } {
  const paidUpTo = m.payments
    .filter((p) => p.date <= asOf)
    .reduce((sum, p) => sum + (p.kind === "refund" ? -p.baseMinor : p.baseMinor), 0);

  const debts: { date: string; amount: number }[] = [];
  if (m.opening && m.opening.date <= asOf && m.opening.minor > 0) {
    debts.push({ date: m.opening.date, amount: m.opening.minor });
  }
  for (const invoice of m.invoices) {
    if (invoice.date <= asOf && invoice.netMinor > 0) debts.push({ date: invoice.date, amount: invoice.netMinor });
  }
  debts.sort((a, b) => (a.date < b.date ? -1 : 1));

  let cumulative = 0;
  for (const debt of debts) {
    cumulative += debt.amount;
    if (cumulative > paidUpTo) {
      return {
        date: debt.date,
        ageDays: Math.max(0, Math.round((toUTC(asOf) - toUTC(debt.date)) / 86_400_000)),
      };
    }
  }
  return { date: null, ageDays: 0 };
}

/**
 * تصنيف دفعات الفترة (FIFO): ما يغطّي رصيدًا سابقًا لبداية الفترة = تحصيل مديونية
 * سابقة، وما زيده = تحصيل جديد.
 */
export function classifyPayments(
  m: {
    opening: { date: string; minor: number } | null;
    invoices: { date: string; netMinor: number }[];
    payments: { date: string; baseMinor: number; kind: string }[];
  },
  from: string,
  to: string,
): { oldMinor: number; newMinor: number } {
  const balanceAtStart = Math.max(0, balanceAt(m, addDays(from, -1)));
  let remainingOld = balanceAtStart;
  let oldMinor = 0;
  let newMinor = 0;
  for (const payment of m.payments) {
    if (payment.date < from || payment.date > to) continue;
    const signed = payment.kind === "refund" ? -payment.baseMinor : payment.baseMinor;
    if (signed >= 0) {
      const oldPart = Math.min(signed, Math.max(0, remainingOld));
      remainingOld -= oldPart;
      oldMinor += oldPart;
      newMinor += signed - oldPart;
    } else {
      // الاسترداد يُخصم من الأحدث أولًا.
      newMinor += signed;
      if (newMinor < 0) {
        oldMinor += newMinor;
        newMinor = 0;
      }
    }
  }
  return { oldMinor, newMinor: Math.max(0, newMinor) };
}

// ─── سياق التقرير: كل الحالة تمرّ هنا ────────────────────────────────────────

interface ExpenseEntry { date: string; minor: number; category: string; payee: string | null }

interface ReportContext {
  filters: ReportFilters;
  base: Currency;
  doctors: Map<number, string>;
  commissions: Map<number, number>;
  expenses: ExpenseEntry[];
  movements: PatientMovement[];
}

async function loadContext(filters: ReportFilters, needMovements: boolean): Promise<ReportContext> {
  const [settings, doctorParties] = await Promise.all([getSettings(), listParties("doctor")]);
  const base = isCurrency(settings["finance.base_currency"]) ? settings["finance.base_currency"] : "YER";
  const doctors = new Map(doctorParties.map((party) => [party.id, party.name]));
  const commissions = new Map(doctorParties.map((party) => [party.id, party.commissionPercent]));

  const pool = getPool();
  await ensureSchema();
  const expensesRes = await pool.query<{ date: string; base: string; category: string; payee: string | null }>(
    `SELECT (created_at AT TIME ZONE $1)::date::text AS date,
            base_amount_minor::text AS base, category, payee_text AS payee
       FROM expenses
      WHERE (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
    [CLINIC_TIME_ZONE, filters.from, filters.to],
  );
  const expenses: ExpenseEntry[] = expensesRes.rows.map((row) => ({
    date: row.date, minor: num(row.base), category: row.category, payee: row.payee,
  }));

  const movements = needMovements
    ? await loadMovements({ patientId: filters.patientId, patientStatus: filters.patientStatus })
    : [];

  return { filters, base, doctors, commissions, expenses, movements };
}

/** يبني التقرير كاملًا وفق نوعه وفلاتره. */
export async function buildReport(report: string, filters: ReportFilters): Promise<ReportResult> {
  const needsMovements = [
    "daily", "monthly", "annual", "debt", "aging",
    "specialty", "doctor", "collections", "services", "patients", "patient-statement",
  ].includes(report);

  const ctx = await loadContext(filters, needsMovements);

  switch (report) {
    case "daily": return dailyReport(ctx);
    case "monthly": return monthlyReport(ctx);
    case "annual": return annualReport(ctx);
    case "debt": return debtReport(ctx);
    case "aging": return agingReport(ctx);
    case "specialty": return specialtyReport(ctx);
    case "doctor": return doctorReport(ctx);
    case "collections": return collectionsReport(ctx);
    case "services": return servicesReport(ctx);
    case "patients": return patientsReport(ctx);
    case "patient-statement": return patientStatementReport(ctx);
    default: throw new Error("نوع تقرير غير معروف.");
  }
}

// ─── مساعدات النتائج ────────────────────────────────────────────────────────

function moneyKpi(key: string, label: string, minor: number, base: Currency, tone?: KpiItem["tone"], hint?: string): KpiItem {
  return { key, label, minor, currency: base, tone, hint };
}

function countKpi(key: string, label: string, count: number, tone?: KpiItem["tone"], hint?: string): KpiItem {
  return { key, label, count, tone, hint };
}

function filtersLabelOf(filters: ReportFilters, doctors: Map<number, string>): string {
  const parts: string[] = ["الفرع: الرئيسي"];
  if (filters.specialty) parts.push(`التخصص: ${CATEGORY_LABEL[filters.specialty] ?? filters.specialty}`);
  if (filters.doctorId) parts.push(`الطبيب: ${doctors.get(filters.doctorId) ?? filters.doctorId}`);
  if (filters.patientId) parts.push("مريض محدد");
  if (filters.serviceId) parts.push("خدمة محددة");
  if (filters.currency !== "all") parts.push(`العملة: ${filters.currency}`);
  if (filters.patientStatus !== "all") parts.push(`حالة المريض: ${PATIENT_STATUS_LABEL[filters.patientStatus]}`);
  if (filters.debtStatus !== "all") {
    parts.push(`حالة المديونية: ${filters.debtStatus === "indebted" ? "عليه مديونية" : filters.debtStatus === "settled" ? "مسدّد" : "متأخر"}`);
  }
  if (filters.method) parts.push(`طريقة الدفع: ${PAYMENT_METHOD_LABEL[filters.method] ?? filters.method}`);
  if (filters.receivedBy) parts.push(`المستلِم: ${filters.receivedBy}`);
  return parts.join(" · ");
}

function patientHasSpecialty(m: PatientMovement, specialty: string): boolean {
  return m.invoices.some((inv) => inv.categories.includes(specialty))
    || m.plans.some((plan) => plan.categories.includes(specialty));
}

function patientHasDoctor(m: PatientMovement, doctorId: number): boolean {
  return m.invoices.some((inv) => inv.doctorIds.includes(doctorId))
    || m.visitDoctorIds.includes(doctorId);
}

function debtStatusOf(m: PatientMovement, asOf: string): DebtStatusFilter {
  const balance = balanceAt(m, asOf);
  if (balance <= 0) return "settled";
  return oldestUnpaid(m, asOf).ageDays >= 30 ? "overdue" : "indebted";
}

interface DebtRow {
  movement: PatientMovement;
  balanceMinor: number;
  oldestDate: string | null;
  ageDays: number;
  lastPayment: { date: string; minor: number } | null;
}

/** أرصدة المرضى بعد الفلاتر الجانبية — أساس المديونية والعمر والتجميعات. */
function filteredDebtRows(ctx: ReportContext, asOf: string): DebtRow[] {
  const { filters } = ctx;
  const rows: DebtRow[] = [];
  for (const patient of ctx.movements) {
    if (filters.patientId && patient.patientId !== filters.patientId) continue;
    if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;

    const balance = balanceAt(patient, asOf);
    const status = debtStatusOf(patient, asOf);
    if (filters.debtStatus !== "all" && filters.debtStatus !== status) continue;

    const oldest = oldestUnpaid(patient, asOf);
    const payments = patient.payments.filter((p) => p.date <= asOf && p.kind !== "refund");
    const last = payments.length > 0 ? payments[payments.length - 1] : null;

    rows.push({
      movement: patient,
      balanceMinor: balance,
      oldestDate: oldest.date,
      ageDays: oldest.ageDays,
      lastPayment: last ? { date: last.date, minor: last.baseMinor } : null,
    });
  }
  return rows;
}

function pickPlan(patient: PatientMovement, specialty: string | null): MovementPlan | null {
  if (patient.plans.length === 0) return null;
  if (specialty) {
    const match = patient.plans.find((plan) => plan.categories.includes(specialty));
    if (match) return match;
  }
  return patient.plans[patient.plans.length - 1];
}

function mainDoctorName(patient: PatientMovement, doctors: Map<number, string>): string {
  const counts = new Map<number, number>();
  for (const invoice of patient.invoices) {
    for (const doctorId of invoice.doctorIds) {
      counts.set(doctorId, (counts.get(doctorId) ?? 0) + 1);
    }
  }
  let bestId: number | null = null;
  let bestCount = 0;
  for (const [doctorId, count] of counts) {
    if (count > bestCount) { bestId = doctorId; bestCount = count; }
  }
  if (bestId == null && patient.visitDoctorIds.length > 0) bestId = patient.visitDoctorIds[0];
  return bestId != null ? (doctors.get(bestId) ?? "—") : "—";
}

function patientSpecialtyLabel(patient: PatientMovement): string {
  const categories = new Set<string>();
  for (const invoice of patient.invoices) for (const category of invoice.categories) categories.add(category);
  for (const plan of patient.plans) for (const category of plan.categories) categories.add(category);
  return categories.size > 0 ? [...categories].map((c) => CATEGORY_LABEL[c] ?? c).join("، ") : "عام";
}

// ─── التقرير اليومي ──────────────────────────────────────────────────────────

function dailyReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors, expenses } = ctx;
  const { from, to } = filters;

  let visits = 0;
  let newPatients = 0;
  let servicesCount = 0;
  let invoicedMinor = 0;
  let invoicesCount = 0;
  let collectedMinor = 0;
  let oldDebtCollected = 0;
  const bySpecialty = new Map<string, number>();
  const rows: ReportRow[] = [];

  for (const patient of ctx.movements) {
    if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;

    if (patient.createdDate && patient.createdDate >= from && patient.createdDate <= to) newPatients++;
    if (patient.lastVisitDate && patient.lastVisitDate >= from && patient.lastVisitDate <= to) visits++;

    const dayInvoices = patient.invoices.filter((inv) => inv.date >= from && inv.date <= to);
    const dayPayments = patient.payments.filter((p) => p.date >= from && p.date <= to);
    const classified = classifyPayments(patient, from, to);
    oldDebtCollected += classified.oldMinor;

    let patientDayPaid = 0;
    for (const payment of dayPayments) {
      patientDayPaid += payment.kind === "refund" ? -payment.baseMinor : payment.baseMinor;
    }
    collectedMinor += patientDayPaid;

    let invoicedToday = 0;
    for (const invoice of dayInvoices) {
      invoicedToday += invoice.netMinor;
      invoicesCount++;
      servicesCount += invoice.items.length;
      for (const category of invoice.categories) {
        bySpecialty.set(category, (bySpecialty.get(category) ?? 0) + 1);
      }
    }
    invoicedMinor += invoicedToday;

    if (dayInvoices.length > 0) {
      for (const invoice of dayInvoices) {
        const doctorId = invoice.doctorIds[0] ?? null;
        rows.push({
          patientId: patient.patientId,
          patientName: patient.name,
          patientNumber: patient.patientNumber,
          doctorName: doctorId ? (doctors.get(doctorId) ?? "—") : "—",
          specialtyLabel: invoice.categories.length
            ? invoice.categories.map((c) => CATEGORY_LABEL[c] ?? c).join("، ")
            : "عام",
          serviceNames: invoice.items.join("، ") || "—",
          totalMinor: invoice.netMinor,
          discountMinor: invoice.discountMinor,
          paidMinor: patientDayPaid,
          remainingMinor: Math.max(0, balanceAt(patient, to)),
        });
        patientDayPaid = 0; // تُنسب الدفعة لأول فاتورة باليوم — إجماليات اليوم تبقى صحيحة.
      }
    } else if (dayPayments.length > 0) {
      rows.push({
        patientId: patient.patientId,
        patientName: patient.name,
        patientNumber: patient.patientNumber,
        doctorName: "—",
        specialtyLabel: "تحصيل",
        serviceNames: "تحصيل مديونية سابقة",
        totalMinor: 0,
        discountMinor: 0,
        paidMinor: patientDayPaid,
        remainingMinor: Math.max(0, balanceAt(patient, to)),
      });
    }
  }

  const expensesMinor = expenses.reduce((sum, e) => sum + e.minor, 0);
  const newCollectedMinor = Math.max(0, collectedMinor - oldDebtCollected);
  const newDeferredMinor = Math.max(0, invoicedMinor - newCollectedMinor);

  const specialtyKpis: KpiItem[] = [...bySpecialty.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([code, count]) => countKpi(`sp-${code}`, `حالات ${CATEGORY_LABEL[code] ?? code}`, count, "calm"));

  return {
    report: "daily",
    title: "التقرير اليومي",
    subtitle: `يوم ${formatArabicDate(from)}`,
    periodLabel: formatArabicDate(from),
    from, to, baseCurrency: base,
    kpis: [
      countKpi("visits", "المرضى المراجعون", visits),
      countKpi("new", "مرضى جدد", newPatients, "good"),
      countKpi("services", "خدمات مسجلة", servicesCount),
      countKpi("invoices", "فواتير", invoicesCount),
      moneyKpi("invoiced", "قيمة الفواتير", invoicedMinor, base),
      moneyKpi("collected", "المحصّل", collectedMinor, base, "good"),
      moneyKpi("deferred", "آجل جديد (صافي)", newDeferredMinor, base, "warn"),
      moneyKpi("oldDebt", "تحصيل مديونيات سابقة", oldDebtCollected, base, "info"),
      moneyKpi("expenses", "المصروفات", expensesMinor, base, "bad"),
      moneyKpi("net", "صافي التدفق النقدي", collectedMinor - expensesMinor, base, collectedMinor - expensesMinor >= 0 ? "good" : "bad"),
      ...specialtyKpis,
    ],
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "doctorName", label: "الطبيب" },
      { key: "specialtyLabel", label: "التخصص" },
      { key: "serviceNames", label: "الخدمة" },
      { key: "totalMinor", label: "قيمة الخدمة", type: "money" },
      { key: "discountMinor", label: "الخصم", type: "money" },
      { key: "paidMinor", label: "المدفوع", type: "money" },
      { key: "remainingMinor", label: "المتبقي", type: "money" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "«المتبقي» هو رصيد المريض الكلي بتاريخ التقرير — لا متبقي الفاتورة وحدها.",
      "دفعات اليوم تُصنَّف FIFO: ما يغطّي رصيدًا سابقًا يظهر في «تحصيل مديونيات سابقة».",
    ],
  };
}

// ─── ملخص فترة (يخدم الشهري والسنوي) ────────────────────────────────────────

function periodSummary(ctx: ReportContext, from: string, to: string) {
  const { filters, expenses } = ctx;
  let patients = 0;
  let newPatients = 0;
  let visits = 0;
  let invoicedMinor = 0;
  let collectedMinor = 0;
  let oldDebtMinor = 0;
  const topServices = new Map<string, { name: string; count: number; totalMinor: number }>();

  for (const patient of ctx.movements) {
    if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;

    const periodInvoices = patient.invoices.filter((inv) => inv.date >= from && inv.date <= to);
    const periodPayments = patient.payments.filter((p) => p.date >= from && p.date <= to);

    let active = false;
    if (patient.createdDate && patient.createdDate >= from && patient.createdDate <= to) { newPatients++; active = true; }
    if (patient.lastVisitDate && patient.lastVisitDate >= from && patient.lastVisitDate <= to) { visits++; active = true; }
    if (periodInvoices.length > 0 || periodPayments.length > 0) active = true;
    if (active) patients++;

    for (const invoice of periodInvoices) {
      invoicedMinor += invoice.netMinor;
      const perItem = invoice.items.length > 0 ? Math.round(invoice.netMinor / invoice.items.length) : 0;
      for (const item of invoice.items) {
        const entry = topServices.get(item) ?? { name: item, count: 0, totalMinor: 0 };
        entry.count++;
        entry.totalMinor += perItem;
        topServices.set(item, entry);
      }
    }
    for (const payment of periodPayments) {
      collectedMinor += payment.kind === "refund" ? -payment.baseMinor : payment.baseMinor;
    }
    oldDebtMinor += classifyPayments(patient, from, to).oldMinor;
  }

  const newDebtMinor = Math.max(0, invoicedMinor - Math.max(0, collectedMinor - oldDebtMinor));
  const outstandingEnd = filteredDebtRows(ctx, to).reduce((sum, row) => sum + Math.max(0, row.balanceMinor), 0);
  const expensesMinor = expenses.filter((e) => e.date >= from && e.date <= to).reduce((sum, e) => sum + e.minor, 0);

  return {
    patients, newPatients, visits, invoicedMinor, collectedMinor,
    oldDebtMinor, newDebtMinor, outstandingEnd, expensesMinor,
    topServices: [...topServices.values()].sort((a, b) => b.totalMinor - a.totalMinor).slice(0, 10),
  };
}

// ─── التقرير الشهري (مع المقارنة) ────────────────────────────────────────────

function monthlyReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;
  const summary = periodSummary(ctx, from, to);

  const kpis: KpiItem[] = [
    countKpi("patients", "إجمالي المرضى", summary.patients),
    countKpi("new", "مرضى جدد", summary.newPatients, "good"),
    countKpi("visits", "الزيارات", summary.visits),
    moneyKpi("invoiced", "قيمة الخدمات", summary.invoicedMinor, base),
    moneyKpi("collected", "التحصيل", summary.collectedMinor, base, "good"),
    moneyKpi("newDebt", "مديونية جديدة (صافي)", summary.newDebtMinor, base, "warn"),
    moneyKpi("oldDebt", "تحصيل ديون قديمة", summary.oldDebtMinor, base, "info"),
    moneyKpi("expenses", "المصروفات", summary.expensesMinor, base, "bad"),
    moneyKpi("outstanding", "المستحقات بنهاية الفترة", summary.outstandingEnd, base, "warn"),
    moneyKpi("net", "صافي الإيراد", summary.invoicedMinor - summary.expensesMinor, base, "info",
      "قيمة الخدمات المسجلة ناقص المصروفات — أساس الاستحقاق لا الصندوق"),
  ];

  let comparison: ReportResult["comparison"];
  const compare = comparisonRange(from, to, filters.compare);
  if (compare) {
    const prev = periodSummary(ctx, compare.from, compare.to);
    const entry = (label: string, current: number, previous: number) => ({
      label,
      currentMinor: current,
      previousMinor: previous,
      changePercent: previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10,
    });
    comparison = {
      title: compare.label,
      entries: [
        entry("التحصيل", summary.collectedMinor, prev.collectedMinor),
        entry("قيمة الخدمات", summary.invoicedMinor, prev.invoicedMinor),
        entry("المصروفات", summary.expensesMinor, prev.expensesMinor),
        entry("المستحقات", summary.outstandingEnd, prev.outstandingEnd),
      ],
    };
  }

  return {
    report: "monthly",
    title: "التقرير الشهري",
    subtitle: `${monthName(Number(from.slice(5, 7)))} ${from.slice(0, 4)}`,
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis,
    comparison,
    columns: [
      { key: "serviceName", label: "أكثر الخدمات" },
      { key: "count", label: "العدد", type: "count" },
      { key: "totalMinor", label: "القيمة", type: "money" },
    ],
    rows: summary.topServices.map((service) => ({
      serviceName: service.name,
      count: service.count,
      totalMinor: service.totalMinor,
    })),
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: ["«صافي الإيراد» على أساس الاستحقاق: الإيراد من الفواتير لا من القبض، والمصروف عند نشوئه."],
  };
}

// ─── التقرير السنوي ──────────────────────────────────────────────────────────

function annualReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;
  const year = Number(from.slice(0, 4));

  const monthlyRows: ReportRow[] = [];
  const bars: { label: string; minor: number }[] = [];
  let totalCollected = 0;
  let totalInvoiced = 0;
  let totalExpenses = 0;
  let totalNewPatients = 0;
  let bestMonth = { month: 0, minor: 0 };
  const yearPatients = new Set<number>();

  for (let month = 1; month <= 12; month++) {
    const mFrom = `${from.slice(0, 4)}-${String(month).padStart(2, "0")}-01`;
    const mTo = endOfMonth(mFrom);
    if (mFrom > to) break;
    if (mTo < from) continue;

    const summary = periodSummary(ctx, mFrom, mTo);
    totalCollected += summary.collectedMinor;
    totalInvoiced += summary.invoicedMinor;
    totalExpenses += summary.expensesMinor;
    totalNewPatients += summary.newPatients;
    if (summary.collectedMinor > bestMonth.minor) bestMonth = { month, minor: summary.collectedMinor };

    for (const patient of ctx.movements) {
      const active = (patient.createdDate && patient.createdDate >= mFrom && patient.createdDate <= mTo)
        || patient.invoices.some((inv) => inv.date >= mFrom && inv.date <= mTo)
        || patient.payments.some((p) => p.date >= mFrom && p.date <= mTo);
      if (active) yearPatients.add(patient.patientId);
    }

    monthlyRows.push({
      monthLabel: monthName(month),
      patients: summary.patients,
      services: summary.visits,
      servicesMinor: summary.invoicedMinor,
      collectedMinor: summary.collectedMinor,
      debtMinor: summary.newDebtMinor,
      expensesMinor: summary.expensesMinor,
      outstandingMinor: summary.outstandingEnd,
    });
    bars.push({ label: monthName(month), minor: summary.collectedMinor });
  }

  const outstandingEnd = filteredDebtRows(ctx, to).reduce((sum, row) => sum + Math.max(0, row.balanceMinor), 0);
  const topSpecialty = topSpecialtyOf(ctx, from, to);
  const monthsCounted = monthlyRows.length || 1;

  return {
    report: "annual",
    title: "التقرير السنوي",
    subtitle: `سنة ${year}`,
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      moneyKpi("revenue", "إجمالي إيرادات السنة", totalInvoiced, base),
      moneyKpi("collected", "إجمالي التحصيل", totalCollected, base, "good"),
      moneyKpi("debt", "إجمالي المديونية (نهاية السنة)", outstandingEnd, base, "warn"),
      moneyKpi("expenses", "إجمالي المصروفات", totalExpenses, base, "bad"),
      countKpi("patients", "مرضى السنة", yearPatients.size),
      countKpi("new", "مرضى جدد", totalNewPatients, "good"),
      moneyKpi("avgMonthly", "متوسط التحصيل الشهري", Math.round(totalCollected / monthsCounted), base, "info"),
      { key: "best", label: "أعلى شهر تحصيل", text: bestMonth.month ? monthName(bestMonth.month) : "—" },
      { key: "topSpecialty", label: "أعلى تخصص إيرادًا", text: topSpecialty },
    ],
    monthly: {
      columns: [
        { key: "monthLabel", label: "الشهر" },
        { key: "patients", label: "المرضى", type: "count" },
        { key: "services", label: "الخدمات", type: "count" },
        { key: "servicesMinor", label: "قيمة الخدمات", type: "money" },
        { key: "collectedMinor", label: "المحصّل", type: "money" },
        { key: "debtMinor", label: "المديونية", type: "money" },
        { key: "expensesMinor", label: "المصروفات", type: "money" },
        { key: "outstandingMinor", label: "مديونية آخر الشهر", type: "money" },
      ],
      rows: monthlyRows,
      barKey: "collectedMinor",
    },
    bars,
    filtersLabel: filtersLabelOf(filters, doctors),
  };
}

function topSpecialtyOf(ctx: ReportContext, from: string, to: string): string {
  const totals = new Map<string, number>();
  for (const patient of ctx.movements) {
    for (const invoice of patient.invoices) {
      if (invoice.date < from || invoice.date > to) continue;
      for (const category of invoice.categories) {
        totals.set(category, (totals.get(category) ?? 0) + invoice.netMinor);
      }
    }
  }
  let best = "";
  let bestValue = 0;
  for (const [category, value] of totals) {
    if (value > bestValue) { best = CATEGORY_LABEL[category] ?? category; bestValue = value; }
  }
  return best || "—";
}

// ─── تقارير المديونية ────────────────────────────────────────────────────────

function debtReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const mode: DebtMode = filters.debtMode;

  if (mode === "movement") return debtMovementReport(ctx);
  if (mode === "collected") return collectionsReport(ctx, "debt");

  if (mode === "accrued") {
    // الديون الناشئة: فواتير الفترة − دفعات الفترة، على مستوى المريض.
    const rows: ReportRow[] = [];
    let totalAccrued = 0;
    let totalBilled = 0;
    let totalPaid = 0;
    for (const patient of ctx.movements) {
      if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
      if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;
      const billed = patient.invoices
        .filter((inv) => inv.date >= filters.from && inv.date <= filters.to)
        .reduce((sum, inv) => sum + inv.netMinor, 0);
      const paid = patient.payments
        .filter((p) => p.date >= filters.from && p.date <= filters.to)
        .reduce((sum, p) => sum + (p.kind === "refund" ? -p.baseMinor : p.baseMinor), 0);
      const accrued = billed - paid;
      if (billed === 0 && paid === 0) continue;
      if (filters.debtStatus === "indebted" && accrued <= 0) continue;
      if (filters.debtStatus === "settled" && accrued !== 0) continue;
      totalAccrued += accrued;
      totalBilled += billed;
      totalPaid += paid;
      const plan = pickPlan(patient, filters.specialty);
      rows.push({
        patientId: patient.patientId,
        patientName: patient.name,
        patientNumber: patient.patientNumber,
        doctorName: mainDoctorName(patient, doctors),
        specialtyLabel: patientSpecialtyLabel(patient),
        planStart: plan ? formatArabicDate(plan.startDate) : "—",
        planTitle: plan?.title ?? "—",
        planTotalMinor: plan?.totalMinor ?? 0,
        billedMinor: billed,
        paidMinor: paid,
        accruedMinor: accrued,
        balanceMinor: Math.max(0, balanceAt(patient, filters.to)),
      });
    }
    rows.sort((a, b) => Number(b.accruedMinor) - Number(a.accruedMinor));
    return {
      report: "debt",
      title: "المديونية الناشئة خلال الفترة",
      subtitle: "الديون الناتجة عن خدمات تمّت خلال الفترة",
      periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
      from: filters.from, to: filters.to, baseCurrency: base,
      kpis: [
        moneyKpi("accrued", "صافي المديونية الناشئة", totalAccrued, base, totalAccrued > 0 ? "warn" : "good"),
        moneyKpi("billed", "فواتير الفترة", totalBilled, base),
        moneyKpi("paid", "دفعات الفترة", totalPaid, base, "info"),
      ],
      columns: [
        { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
        { key: "patientNumber", label: "رقم الملف" },
        { key: "doctorName", label: "الطبيب" },
        { key: "specialtyLabel", label: "التخصص" },
        { key: "planStart", label: "بداية العلاج" },
        { key: "planTitle", label: "الخطة" },
        { key: "planTotalMinor", label: "إجمالي الخطة", type: "money" },
        { key: "billedMinor", label: "فواتير الفترة", type: "money" },
        { key: "paidMinor", label: "مدفوع الفترة", type: "money" },
        { key: "accruedMinor", label: "الناشئة", type: "money" },
        { key: "balanceMinor", label: "رصيده الكلي", type: "money" },
      ],
      rows,
      filtersLabel: filtersLabelOf(filters, doctors),
      notes: ["«الناشئة» = فواتير الفترة − دفعات الفترة. سالبها يعني أن المريض دفع أكثر مما فوّتره خلالها."],
    };
  }

  // الوضع الافتراضي: الرصيد المستحق في نهاية الفترة.
  const asOf = filters.to;
  const rows: ReportRow[] = [];
  let totalDue = 0;
  for (const row of filteredDebtRows(ctx, asOf)) {
    if (row.balanceMinor <= 0) continue;
    totalDue += row.balanceMinor;
    const patient = row.movement;
    const plan = pickPlan(patient, filters.specialty);
    rows.push({
      patientId: patient.patientId,
      patientName: patient.name,
      patientNumber: patient.patientNumber,
      phone: patient.phone ?? "—",
      doctorName: mainDoctorName(patient, doctors),
      specialtyLabel: patientSpecialtyLabel(patient),
      statusLabel: PATIENT_STATUS_LABEL[patient.status],
      planStart: plan ? formatArabicDate(plan.startDate) : "—",
      planTitle: plan?.title ?? "—",
      planTotalMinor: plan?.totalMinor ?? 0,
      planPaidMinor: plan?.paidMinor ?? 0,
      billedMinor: patient.invoices.reduce((sum, inv) => sum + inv.netMinor, 0) + (patient.opening?.minor ?? 0),
      paidMinor: patient.payments.reduce((sum, p) => sum + (p.kind === "refund" ? -p.baseMinor : p.baseMinor), 0),
      balanceMinor: row.balanceMinor,
      lastPaymentDate: row.lastPayment ? formatArabicDate(row.lastPayment.date) : "—",
      ageDays: row.ageDays,
      oldestDate: row.oldestDate ? formatArabicDate(row.oldestDate) : "—",
    });
  }
  rows.sort((a, b) => Number(b.balanceMinor) - Number(a.balanceMinor));

  return {
    report: "debt",
    title: "المديونية المستحقة",
    subtitle: "أرصدة المرضى بتاريخ نهاية الفترة — من حركات الحساب المسجّلة",
    periodLabel: `كما في ${formatArabicDate(asOf)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      moneyKpi("total", "إجمالي المديونية", totalDue, base, "warn"),
      countKpi("count", "عدد المدينين", rows.length),
      moneyKpi("avg", "متوسط المديونية", rows.length ? Math.round(totalDue / rows.length) : 0, base, "info"),
    ],
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "phone", label: "الهاتف" },
      { key: "doctorName", label: "الطبيب" },
      { key: "specialtyLabel", label: "التخصص" },
      { key: "statusLabel", label: "حالة المريض" },
      { key: "planStart", label: "بداية العلاج" },
      { key: "planTitle", label: "الخطة" },
      { key: "planTotalMinor", label: "إجمالي الخطة", type: "money" },
      { key: "planPaidMinor", label: "مدفوع الخطة", type: "money" },
      { key: "billedMinor", label: "إجمالي المفوتر", type: "money" },
      { key: "paidMinor", label: "إجمالي المدفوع", type: "money" },
      { key: "balanceMinor", label: "المتبقي", type: "money" },
      { key: "lastPaymentDate", label: "آخر دفعة" },
      { key: "ageDays", label: "أيام التأخير", type: "count" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "الرصيد = الافتتاحي + صافي الفواتير − الدفعات (+ الاستردادات) — لا «قيمة الخطة ناقص المدفوع».",
      "اضغط اسم المريض لفتح كشف حسابه.",
    ],
  };
}

/** حركة المديونية الشهرية (الوضع الرابع) — رصيد أول الشهر → آخره. */
function debtMovementReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const year = Number(filters.from.slice(0, 4));
  const monthlyRows: ReportRow[] = [];
  const bars: { label: string; minor: number }[] = [];

  for (let month = 1; month <= 12; month++) {
    const mFrom = `${year}-${String(month).padStart(2, "0")}-01`;
    const mTo = endOfMonth(mFrom);
    if (mFrom > filters.to) break;
    if (mTo < filters.from) continue;

    let newDebt = 0;
    let collected = 0;
    let refunds = 0;
    for (const patient of ctx.movements) {
      if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
      if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;
      for (const invoice of patient.invoices) {
        if (invoice.date >= mFrom && invoice.date <= mTo) newDebt += invoice.netMinor;
      }
      for (const payment of patient.payments) {
        if (payment.date < mFrom || payment.date > mTo) continue;
        if (payment.kind === "refund") refunds += payment.baseMinor;
        else collected += payment.baseMinor;
      }
    }
    const opening = balanceAsOf(ctx, addDays(mFrom, -1));
    const closing = balanceAsOf(ctx, mTo);

    monthlyRows.push({
      monthLabel: monthName(month),
      openingMinor: opening,
      newDebtMinor: newDebt,
      collectedMinor: collected,
      adjustmentsMinor: refunds,
      closingMinor: closing,
    });
    bars.push({ label: monthName(month), minor: closing });
  }

  const openingYear = balanceAsOf(ctx, addDays(filters.from, -1));
  const closingYear = balanceAsOf(ctx, filters.to);

  return {
    report: "debt",
    title: "حركة المديونية الكاملة",
    subtitle: `سنة ${year} — رصيد أول المدة، ديون جديدة، تحصيل، تسويات، رصيد آخرها`,
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      moneyKpi("opening", "مديونية أول الفترة", openingYear, base),
      { key: "new", label: "ديون جديدة", minor: monthlyRows.reduce((s, r) => s + Number(r.newDebtMinor), 0), currency: base, tone: "warn" },
      { key: "collected", label: "تحصيل ديون", minor: monthlyRows.reduce((s, r) => s + Number(r.collectedMinor), 0), currency: base, tone: "good" },
      { key: "adj", label: "تسويات (استردادات)", minor: monthlyRows.reduce((s, r) => s + Number(r.adjustmentsMinor), 0), currency: base, tone: "bad" },
      moneyKpi("closing", "مديونية آخر الفترة", closingYear, base, "warn"),
    ],
    monthly: {
      columns: [
        { key: "monthLabel", label: "الشهر" },
        { key: "openingMinor", label: "مديونية أول الشهر", type: "money" },
        { key: "newDebtMinor", label: "ديون جديدة", type: "money" },
        { key: "collectedMinor", label: "تحصيل ديون", type: "money" },
        { key: "adjustmentsMinor", label: "تسويات", type: "money" },
        { key: "closingMinor", label: "مديونية آخر الشهر", type: "money" },
      ],
      rows: monthlyRows,
      barKey: "closingMinor",
    },
    bars,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "رصيد أول الشهر = رصيد آخر اليوم الذي قبله (لا مجموع مستقل) — فلا يفترق الميزان.",
      "«التسويات» هنا = الاستردادات؛ قيود التسوية اليدوية على ذمم المرضى تُقرأ من دفتر اليومية.",
    ],
  };
}

/** مجموع أرصدة المرضى (الموجبة فقط) بتاريخ معيّن. */
function balanceAsOf(ctx: ReportContext, date: string): number {
  return ctx.movements.reduce((sum, patient) => sum + Math.max(0, balanceAt(patient, date)), 0);
}

// ─── تقرير أعمار الديون (Aging) ──────────────────────────────────────────────

const AGING_BUCKETS: { key: string; label: string; min: number; max: number }[] = [
  { key: "b0", label: "حالي (٠–٣٠)", min: 0, max: 30 },
  { key: "b31", label: "٣١–٦٠", min: 31, max: 60 },
  { key: "b61", label: "٦١–٩٠", min: 61, max: 90 },
  { key: "b91", label: "٩١–١٨٠", min: 91, max: 180 },
  { key: "b181", label: "أكثر من ١٨٠", min: 181, max: Number.MAX_SAFE_INTEGER },
];

function agingReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const asOf = filters.to;
  const rows: ReportRow[] = [];
  const bucketTotals = AGING_BUCKETS.map(() => 0);
  let total = 0;

  for (const row of filteredDebtRows(ctx, asOf)) {
    if (row.balanceMinor <= 0) continue;
    total += row.balanceMinor;
    const bucketIndex = AGING_BUCKETS.findIndex((b) => row.ageDays >= b.min && row.ageDays <= b.max);
    if (bucketIndex >= 0) bucketTotals[bucketIndex] += row.balanceMinor;
    const cells: Record<string, number> = {};
    for (const bucket of AGING_BUCKETS) cells[bucket.key] = 0;
    if (bucketIndex >= 0) cells[AGING_BUCKETS[bucketIndex].key] = row.balanceMinor;

    const patient = row.movement;
    rows.push({
      patientId: patient.patientId,
      patientName: patient.name,
      patientNumber: patient.patientNumber,
      phone: patient.phone ?? "—",
      specialtyLabel: patientSpecialtyLabel(patient),
      statusLabel: PATIENT_STATUS_LABEL[patient.status],
      balanceMinor: row.balanceMinor,
      ...cells,
      ageDays: row.ageDays,
      oldestDate: row.oldestDate ? formatArabicDate(row.oldestDate) : "—",
    });
  }
  rows.sort((a, b) => Number(b.ageDays) - Number(a.ageDays));

  const kpis: KpiItem[] = [moneyKpi("total", "إجمالي المديونية", total, base, "warn")];
  for (let i = 0; i < AGING_BUCKETS.length; i++) {
    kpis.push(moneyKpi(AGING_BUCKETS[i].key, AGING_BUCKETS[i].label, bucketTotals[i], base, i >= 3 ? "bad" : i >= 2 ? "warn" : "calm"));
  }

  return {
    report: "aging",
    title: "أعمار الديون",
    subtitle: "توزيع المديونية على أعمارها — من عمر أقدم دين غير مغطّى (FIFO)",
    periodLabel: `كما في ${formatArabicDate(asOf)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis,
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "phone", label: "الهاتف" },
      { key: "specialtyLabel", label: "التخصص" },
      { key: "statusLabel", label: "حالة المريض" },
      { key: "balanceMinor", label: "الرصيد", type: "money" },
      { key: "b0", label: "٠–٣٠", type: "money" },
      { key: "b31", label: "٣١–٦٠", type: "money" },
      { key: "b61", label: "٦١–٩٠", type: "money" },
      { key: "b91", label: "٩١–١٨٠", type: "money" },
      { key: "b181", label: "+١٨٠", type: "money" },
      { key: "ageDays", label: "أيام التأخير", type: "count" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: ["رصيد المريض كله يقع في فترة عمر أقدم دين غير مغطّى — العرف المحاسبي في أعمار الديون."],
  };
}

// ─── التقرير حسب التخصص ──────────────────────────────────────────────────────

function specialtyReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const selected = filters.specialty;

  if (!selected) {
    const rows: ReportRow[] = [];
    for (const [code, label] of Object.entries(CATEGORY_LABEL)) {
      const sub = specialtyStats(ctx, code);
      if (sub.patients === 0 && sub.collectedMinor === 0 && sub.plansValue === 0) continue;
      rows.push({
        specialtyCode: code,
        specialtyLabel: label,
        patients: sub.patients,
        activePatients: sub.activePatients,
        newPatients: sub.newPatients,
        plansValueMinor: sub.plansValue,
        collectedMinor: sub.collectedMinor,
        debtMinor: sub.debtMinor,
        avgDebtMinor: sub.patients ? Math.round(sub.debtMinor / sub.patients) : 0,
        completedPlans: sub.completedPlans,
        stoppedPlans: sub.stoppedPlans,
      });
    }
    rows.sort((a, b) => Number(b.collectedMinor) - Number(a.collectedMinor));
    const totalDebt = rows.reduce((sum, row) => sum + Number(row.debtMinor), 0);

    return {
      report: "specialty",
      title: "التقرير حسب التخصص",
      subtitle: "نشاط كل تخصص وما له من تحصيل ومديونية",
      periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
      from: filters.from, to: filters.to, baseCurrency: base,
      kpis: [
        countKpi("specialties", "تخصصات نشطة", rows.length),
        moneyKpi("debt", "إجمالي مديونية مرضى التخصصات", totalDebt, base, "warn",
          "مريضٌ في تخصصين يظهر في كلٍّ منهما — المجموع هنا بلا تكرار: مجموع أرصدة المرضى"),
      ],
      columns: [
        { key: "specialtyLabel", label: "التخصص" },
        { key: "patients", label: "المرضى", type: "count" },
        { key: "activePatients", label: "نشطون", type: "count" },
        { key: "newPatients", label: "جدد", type: "count" },
        { key: "plansValueMinor", label: "قيمة الخطط", type: "money" },
        { key: "collectedMinor", label: "التحصيل", type: "money" },
        { key: "debtMinor", label: "المديونية", type: "money" },
        { key: "avgDebtMinor", label: "متوسط مديونية المريض", type: "money" },
        { key: "completedPlans", label: "خطط منتهية", type: "count" },
        { key: "stoppedPlans", label: "خطط متوقفة", type: "count" },
      ],
      rows,
      filtersLabel: filtersLabelOf(filters, doctors),
      notes: ["اضغط اسم التخصص لعرض مرضاه في تقرير المديونية."],
    };
  }

  // تخصص واحد: إحصاءاته + مرضاه.
  const sub = specialtyStats(ctx, selected);
  const patientRows: ReportRow[] = ctx.movements
    .filter((patient) => patientHasSpecialty(patient, selected))
    .map((patient) => ({
      patientId: patient.patientId,
      patientName: patient.name,
      patientNumber: patient.patientNumber,
      statusLabel: PATIENT_STATUS_LABEL[patient.status],
      balanceMinor: Math.max(0, balanceAt(patient, filters.to)),
      ageDays: oldestUnpaid(patient, filters.to).ageDays,
    }));
  patientRows.sort((a, b) => Number(b.balanceMinor) - Number(a.balanceMinor));

  return {
    report: "specialty",
    title: `تقرير تخصص ${CATEGORY_LABEL[selected] ?? selected}`,
    subtitle: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("patients", "المرضى", sub.patients),
      countKpi("active", "نشطون", sub.activePatients, "good"),
      countKpi("new", "جدد بالفترة", sub.newPatients, "info"),
      moneyKpi("plans", "قيمة خطط العلاج", sub.plansValue, base),
      moneyKpi("collected", "التحصيل", sub.collectedMinor, base, "good"),
      moneyKpi("debt", "المديونية", sub.debtMinor, base, "warn"),
      moneyKpi("avgDebt", "متوسط مديونية المريض", sub.patients ? Math.round(sub.debtMinor / sub.patients) : 0, base),
      countKpi("completed", "حالات انتهت", sub.completedPlans),
      countKpi("stopped", "حالات متوقفة", sub.stoppedPlans, "bad"),
    ],
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "statusLabel", label: "الحالة" },
      { key: "balanceMinor", label: "الرصيد", type: "money" },
      { key: "ageDays", label: "أيام التأخير", type: "count" },
    ],
    rows: patientRows,
    filtersLabel: filtersLabelOf(filters, doctors),
  };
}

function specialtyStats(ctx: ReportContext, code: string) {
  const { filters } = ctx;
  let patients = 0;
  let activePatients = 0;
  let newPatients = 0;
  let plansValue = 0;
  let collectedMinor = 0;
  let debtMinor = 0;
  let completedPlans = 0;
  let stoppedPlans = 0;

  for (const patient of ctx.movements) {
    if (!patientHasSpecialty(patient, code)) continue;
    patients++;
    if (patient.status === "active") activePatients++;
    if (patient.createdDate && patient.createdDate >= filters.from && patient.createdDate <= filters.to) newPatients++;
    for (const plan of patient.plans) {
      if (plan.categories.includes(code)) {
        plansValue += plan.totalMinor;
        if (plan.status === "completed") completedPlans++;
        if (plan.status === "stopped") stoppedPlans++;
      }
    }
    for (const payment of patient.payments) {
      if (payment.date >= filters.from && payment.date <= filters.to) {
        collectedMinor += payment.kind === "refund" ? -payment.baseMinor : payment.baseMinor;
      }
    }
    debtMinor += Math.max(0, balanceAt(patient, filters.to));
  }
  return { patients, activePatients, newPatients, plansValue, collectedMinor, debtMinor, completedPlans, stoppedPlans };
}

// ─── التقرير حسب الطبيب ──────────────────────────────────────────────────────

function doctorReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors, commissions } = ctx;
  const rows: ReportRow[] = [];

  for (const [doctorId, doctorName] of doctors) {
    if (filters.doctorId && doctorId !== filters.doctorId) continue;
    let patientCount = 0;
    let newPatients = 0;
    let procedures = 0;
    let workMinor = 0;
    let collectedMinor = 0;
    let debtMinor = 0;

    for (const patient of ctx.movements) {
      if (!patientHasDoctor(patient, doctorId)) continue;
      patientCount++;
      if (patient.createdDate && patient.createdDate >= filters.from && patient.createdDate <= filters.to) newPatients++;
      for (const invoice of patient.invoices) {
        if (invoice.date < filters.from || invoice.date > filters.to) continue;
        if (invoice.doctorIds.includes(doctorId)) {
          procedures += invoice.items.length;
          workMinor += invoice.netMinor;
        }
      }
      for (const payment of patient.payments) {
        if (payment.date < filters.from || payment.date > filters.to) continue;
        collectedMinor += payment.kind === "refund" ? -payment.baseMinor : payment.baseMinor;
      }
      debtMinor += Math.max(0, balanceAt(patient, filters.to));
    }
    if (patientCount === 0 && procedures === 0) continue;

    const commission = commissions.get(doctorId) ?? 0;
    const duesMinor = Math.round(workMinor * commission / 100);

    rows.push({
      doctorId,
      doctorName,
      patients: patientCount,
      newPatients,
      procedures,
      workMinor,
      collectedMinor,
      debtMinor,
      commissionPercent: commission,
      duesMinor,
    });
  }
  rows.sort((a, b) => Number(b.workMinor) - Number(a.workMinor));

  return {
    report: "doctor",
    title: "التقرير حسب الطبيب",
    subtitle: "إنتاجية كل طبيب وتحصيل مرضاه ومستحقاته — للصلاحية المالية فقط",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("doctors", "أطباء نشطون", rows.length),
      moneyKpi("work", "قيمة الأعمال", rows.reduce((s, r) => s + Number(r.workMinor), 0), base),
      moneyKpi("collected", "تحصيل مرضاهم", rows.reduce((s, r) => s + Number(r.collectedMinor), 0), base, "good"),
      moneyKpi("dues", "مستحقات الأطباء (عمولات)", rows.reduce((s, r) => s + Number(r.duesMinor), 0), base, "info",
        "قيمة أعمال الطبيب × نسبة عمولته المسجلة في ملف الجهة"),
    ],
    columns: [
      { key: "doctorName", label: "الطبيب" },
      { key: "patients", label: "مرضاه", type: "count" },
      { key: "newPatients", label: "جدد", type: "count" },
      { key: "procedures", label: "إجراءاته", type: "count" },
      { key: "workMinor", label: "قيمة أعماله", type: "money" },
      { key: "collectedMinor", label: "المحصّل من مرضاه", type: "money" },
      { key: "debtMinor", label: "مديونية مرضاه", type: "money" },
      { key: "commissionPercent", label: "نسبة العمولة", type: "percent" },
      { key: "duesMinor", label: "مستحق الطبيب", type: "money" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: ["«قيمة أعماله» من بنود الفواتير المسجلة باسمه على مستوى البند — فاتورة بطبيبين تُحتسب لكلٍّ على عمله."],
  };
}

// ─── تقرير التحصيل ──────────────────────────────────────────────────────────

function collectionsReport(ctx: ReportContext, caller = "collections"): ReportResult {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;

  let newMinor = 0;
  let oldMinor = 0;
  let refundsMinor = 0;
  const byCurrency: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };
  const rows: ReportRow[] = [];

  for (const patient of ctx.movements) {
    if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;

    const classified = classifyPayments(patient, from, to);
    oldMinor += classified.oldMinor;
    newMinor += classified.newMinor;

    for (const payment of patient.payments) {
      if (payment.date < from || payment.date > to) continue;
      if (filters.currency !== "all" && payment.currency !== filters.currency) continue;
      if (filters.method && payment.method !== filters.method) continue;
      if (filters.receivedBy && payment.createdBy !== filters.receivedBy) continue;

      const signed = payment.kind === "refund" ? -payment.baseMinor : payment.baseMinor;
      if (payment.kind === "refund") refundsMinor += payment.baseMinor;
      byCurrency[payment.currency] += payment.kind === "refund" ? -payment.amountMinor : payment.amountMinor;

      rows.push({
        date: formatArabicDate(payment.date),
        patientId: patient.patientId,
        patientName: patient.name,
        patientNumber: patient.patientNumber,
        kindLabel: payment.kind === "refund" ? "استرداد" : "قبض",
        amountText: `${payment.amountMinor} ${payment.currency}`,
        baseMinor: signed,
        methodLabel: PAYMENT_METHOD_LABEL[payment.method] ?? payment.method,
        receiver: payment.createdBy ?? "—",
        note: payment.note ?? "",
      });
    }
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const kpis: KpiItem[] = [
    moneyKpi("total", "إجمالي التحصيل", newMinor + oldMinor, base, "good"),
    moneyKpi("new", "تحصيل جديد", newMinor, base, "info", "ما غطّى خدمات الفترة نفسها"),
    moneyKpi("old", "تحصيل مديونية سابقة", oldMinor, base, "warn", "ما غطّى أرصدةً سابقة لبداية الفترة (FIFO)"),
    moneyKpi("refunds", "استردادات", refundsMinor, base, "bad"),
  ];
  for (const [currency, amount] of Object.entries(byCurrency)) {
    if (amount === 0) continue;
    kpis.push({ key: `cur-${currency}`, label: `${currency} (فعلي)`, count: amount, tone: "calm", hint: "مجموع ما قُبض بعملته كما دخل الدرج" });
  }

  return {
    report: caller === "debt" ? "debt" : "collections",
    title: caller === "debt" ? "تحصيل المديونيات خلال الفترة" : "تقرير التحصيل",
    subtitle: "قيمة الخدمات ≠ التحصيل الفعلي — هنا التحصيل وحده، مفصولًا جديدًا عن سابق",
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis,
    columns: [
      { key: "date", label: "التاريخ" },
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "kindLabel", label: "النوع" },
      { key: "amountText", label: "المبلغ (بعملته)" },
      { key: "baseMinor", label: "المكافئ بالأساس", type: "money" },
      { key: "methodLabel", label: "طريقة الدفع" },
      { key: "receiver", label: "المستلِم" },
      { key: "note", label: "ملاحظة" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "تصنيف جديد/سابق على FIFO: الدفعة تُغطّي أقدم رصيد أولًا.",
      "أرقام العملات «الفعليّة» بالوحدات الكبرى كما قُبضت — لا تُجمع عملات في رقم واحد.",
    ],
  };
}

// ─── تقارير الخدمات والإجراءات ──────────────────────────────────────────────

function servicesReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const totals = new Map<string, { name: string; count: number; totalMinor: number; patients: Set<number> }>();

  for (const patient of ctx.movements) {
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;
    for (const invoice of patient.invoices) {
      if (invoice.date < filters.from || invoice.date > filters.to) continue;
      if (filters.specialty && !invoice.categories.includes(filters.specialty)) continue;
      const perItem = invoice.items.length > 0 ? Math.round(invoice.netMinor / invoice.items.length) : 0;
      for (const item of invoice.items) {
        const entry = totals.get(item) ?? { name: item, count: 0, totalMinor: 0, patients: new Set<number>() };
        entry.count++;
        entry.totalMinor += perItem;
        entry.patients.add(patient.patientId);
        totals.set(item, entry);
      }
    }
  }

  const rows: ReportRow[] = [...totals.values()]
    .map((entry) => ({
      serviceName: entry.name,
      count: entry.count,
      patients: entry.patients.size,
      totalMinor: entry.totalMinor,
    }))
    .sort((a, b) => Number(b.totalMinor) - Number(a.totalMinor));

  return {
    report: "services",
    title: "تقارير الخدمات والإجراءات",
    subtitle: "ما أُنجز فعلًا من خدمات خلال الفترة وقيمته",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("services", "خدمات مسجلة", rows.reduce((s, r) => s + Number(r.count), 0)),
      moneyKpi("value", "قيمة الخدمات", rows.reduce((s, r) => s + Number(r.totalMinor), 0), base),
    ],
    columns: [
      { key: "serviceName", label: "الخدمة" },
      { key: "count", label: "العدد", type: "count" },
      { key: "patients", label: "المرضى", type: "count" },
      { key: "totalMinor", label: "القيمة", type: "money" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
  };
}

// ─── تقارير المرضى ──────────────────────────────────────────────────────────

function patientsReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const rows: ReportRow[] = [];

  for (const patient of ctx.movements) {
    if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;
    if (!patient.createdDate || patient.createdDate < filters.from || patient.createdDate > filters.to) continue;

    const billed = patient.invoices.reduce((sum, inv) => sum + inv.netMinor, 0);
    const paid = patient.payments.reduce((sum, p) => sum + (p.kind === "refund" ? -p.baseMinor : p.baseMinor), 0);
    rows.push({
      patientId: patient.patientId,
      patientName: patient.name,
      patientNumber: patient.patientNumber,
      phone: patient.phone ?? "—",
      createdDate: formatArabicDate(patient.createdDate),
      statusLabel: PATIENT_STATUS_LABEL[patient.status],
      billedMinor: billed,
      paidMinor: paid,
      balanceMinor: Math.max(0, (patient.opening?.minor ?? 0) + billed - paid),
    });
  }
  rows.sort((a, b) => String(b.createdDate).localeCompare(String(a.createdDate)));

  return {
    report: "patients",
    title: "تقارير المرضى",
    subtitle: "المرضى الجدد خلال الفترة وقيمة تعاملهم",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("new", "مرضى جدد", rows.length, "good"),
      moneyKpi("billed", "قيمة تعاملهم", rows.reduce((s, r) => s + Number(r.billedMinor), 0), base),
      moneyKpi("balance", "أرصدتهم الآن", rows.reduce((s, r) => s + Number(r.balanceMinor), 0), base, "warn"),
    ],
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "phone", label: "الهاتف" },
      { key: "createdDate", label: "تاريخ التسجيل" },
      { key: "statusLabel", label: "الحالة" },
      { key: "billedMinor", label: "قيمة التعامل", type: "money" },
      { key: "paidMinor", label: "المدفوع", type: "money" },
      { key: "balanceMinor", label: "الرصيد", type: "money" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
  };
}

// ─── كشف حساب مريض (داخل المركز) ─────────────────────────────────────────────

function patientStatementReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const patient = ctx.movements.find((p) => p.patientId === filters.patientId);
  if (!patient) throw new Error("المريض غير موجود.");

  const gross = patient.invoices.reduce((sum, inv) => sum + inv.totalMinor, 0);
  const billed = patient.invoices.reduce((sum, inv) => sum + inv.netMinor, 0);
  const discounts = gross - billed;
  const paid = patient.payments.filter((p) => p.kind !== "refund").reduce((sum, p) => sum + p.baseMinor, 0);
  const refunds = patient.payments.filter((p) => p.kind === "refund").reduce((sum, p) => sum + p.baseMinor, 0);
  const balance = (patient.opening?.minor ?? 0) + billed - paid + refunds;
  const lastPayment = patient.payments.filter((p) => p.kind !== "refund").pop() ?? null;

  // كشف الحساب: مدين/دائن/رصيد جارٍ.
  const events: { date: string; description: string; debit: number; credit: number }[] = [];
  if (patient.opening) {
    events.push({ date: patient.opening.date, description: "رصيد افتتاحي (قبل تشغيل النظام)", debit: patient.opening.minor, credit: 0 });
  }
  for (const invoice of patient.invoices) {
    events.push({
      date: invoice.date,
      description: invoice.items.length > 0 ? invoice.items.join("، ") : `فاتورة #${invoice.id}`,
      debit: invoice.netMinor,
      credit: 0,
    });
  }
  for (const payment of patient.payments) {
    if (payment.kind === "refund") {
      events.push({ date: payment.date, description: `استرداد ${payment.amountMinor} ${payment.currency}`, debit: payment.baseMinor, credit: 0 });
    } else {
      events.push({
        date: payment.date,
        description: `دفعة ${payment.amountMinor} ${payment.currency}${payment.method === "transfer" ? " (حوالة)" : ""}`,
        debit: 0,
        credit: payment.baseMinor,
      });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.description.localeCompare(b.description)));

  let running = 0;
  const ledgerRows: ReportRow[] = events.map((event) => {
    running += event.debit - event.credit;
    return {
      date: formatArabicDate(event.date),
      description: event.description,
      debitMinor: event.debit,
      creditMinor: event.credit,
      balanceMinor: running,
    };
  });

  return {
    report: "patient-statement",
    title: "كشف حساب المريض",
    subtitle: `${patient.name} — ملف ${patient.patientNumber}${patient.phone ? ` — ${patient.phone}` : ""}`,
    periodLabel: `من فتح الملف حتى ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      moneyKpi("treatment", "إجمالي قيمة العلاج", gross, base),
      moneyKpi("discounts", "إجمالي الخصومات", discounts, base, "info"),
      moneyKpi("paid", "إجمالي ما دُفع", paid, base, "good"),
      moneyKpi("refunds", "المرتجعات", refunds, base, "bad"),
      moneyKpi("balance", "الرصيد المتبقي", balance, base, balance > 0 ? "warn" : "good"),
      { key: "lastPayment", label: "آخر دفعة", text: lastPayment ? formatArabicDate(lastPayment.date) : "—" },
      { key: "lastVisit", label: "آخر زيارة", text: patient.lastVisitDate ? formatArabicDate(patient.lastVisitDate) : "—" },
    ],
    columns: [
      { key: "date", label: "التاريخ" },
      { key: "description", label: "البيان" },
      { key: "debitMinor", label: "مدين", type: "money" },
      { key: "creditMinor", label: "دائن", type: "money" },
      { key: "balanceMinor", label: "الرصيد", type: "money" },
    ],
    rows: ledgerRows,
    actions: [
      { label: "نسخة الطباعة الرسمية", href: `/print/statement/${patient.patientId}` },
      { label: "ملف المريض الكامل", href: `/patients/${patient.patientId}` },
    ],
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: ["الرصيد = الافتتاحي + صافي الفواتير − الدفعات + الاستردادات. الخصم داخل صافي الفاتورة."],
  };
}

// ─── خيارات الفلاتر ─────────────────────────────────────────────────────────

export async function reportOptions(): Promise<ReportOptions> {
  const [doctors, services, settings] = await Promise.all([
    listParties("doctor"),
    listServices(),
    getSettings(),
  ]);
  await ensureSchema();
  const receiversRes = await getPool().query<{ receiver: string | null }>(
    `SELECT DISTINCT created_by AS receiver FROM payments WHERE created_by IS NOT NULL ORDER BY created_by`,
  );
  return {
    doctors: doctors.map((party) => ({ id: party.id, name: party.name })),
    specialties: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label })),
    services: services.map((service) => ({ id: service.id, name: service.name })),
    methods: Object.entries(PAYMENT_METHOD_LABEL).map(([value, label]) => ({ value, label })),
    receivers: receiversRes.rows.map((row) => row.receiver ?? "").filter(Boolean),
    baseCurrency: isCurrency(settings["finance.base_currency"]) ? settings["finance.base_currency"] : "YER",
    clinicName: String(settings["clinic.name"] ?? "مركز الأسنان"),
  };
}

// ─── تحويل معاملات الطلب إلى فلاتر ──────────────────────────────────────────

export function parseFilters(params: URLSearchParams, today?: string): ReportFilters {
  const presetRaw = params.get("preset") ?? "this_month";
  const preset = (["today", "yesterday", "this_week", "this_month", "prev_month", "this_quarter", "this_year", "prev_year", "custom"] as const)
    .includes(presetRaw as PeriodPreset) ? (presetRaw as PeriodPreset) : "this_month";
  const { from, to } = resolvePeriod(preset, params.get("from"), params.get("to"), today);

  const doctorIdRaw = params.get("doctorId");
  const doctorId = doctorIdRaw && /^\d+$/.test(doctorIdRaw) && Number(doctorIdRaw) > 0 ? Number(doctorIdRaw) : null;
  const patientIdRaw = params.get("patientId");
  const patientId = patientIdRaw && /^\d+$/.test(patientIdRaw) && Number(patientIdRaw) > 0 ? Number(patientIdRaw) : null;
  const serviceIdRaw = params.get("serviceId");
  const serviceId = serviceIdRaw && /^\d+$/.test(serviceIdRaw) && Number(serviceIdRaw) > 0 ? Number(serviceIdRaw) : null;

  const debtModeRaw = params.get("debtMode") ?? "outstanding";
  const debtMode = (["outstanding", "accrued", "collected", "movement"] as const).includes(debtModeRaw as DebtMode)
    ? (debtModeRaw as DebtMode) : "outstanding";

  const patientStatusRaw = params.get("patientStatus") ?? "all";
  const patientStatus = (["all", "active", "completed", "stopped"] as const).includes(patientStatusRaw as PatientStatusFilter)
    ? (patientStatusRaw as PatientStatusFilter) : "all";

  const debtStatusRaw = params.get("debtStatus") ?? "all";
  const debtStatus = (["all", "indebted", "settled", "overdue"] as const).includes(debtStatusRaw as DebtStatusFilter)
    ? (debtStatusRaw as DebtStatusFilter) : "all";

  const currencyRaw = params.get("currency") ?? "all";
  const currency: CurrencyFilter = (["all", "YER", "SAR", "USD"] as const).includes(currencyRaw as CurrencyFilter)
    ? (currencyRaw as CurrencyFilter) : "all";

  const compareRaw = params.get("compare") ?? "none";
  const compare = (["none", "prev_period", "prev_year"] as const).includes(compareRaw as CompareMode)
    ? (compareRaw as CompareMode) : "none";

  return {
    preset, from, to,
    specialty: params.get("specialty") || null,
    doctorId, patientId, serviceId,
    currency, patientStatus, debtStatus, debtMode, compare,
    method: params.get("method") || null,
    receivedBy: params.get("receivedBy") || null,
  };
}
