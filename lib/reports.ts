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

import { getPool, ensureSchema, getSettings, listParties, listServices, commissionReport, listOpenPastAppointments, listMissedAppointments, listLapsedPatients, CLINIC_TIME_ZONE, type CommissionRow } from "./db";
import { CATEGORY_LABEL } from "./services-catalog";
import { CURRENCIES, formatMoney, isCurrency, requireCurrency, settlementTargetCurrency, settlePaymentMinor, FinancialCurrencyIntegrityError, type Currency, type DocumentCurrencyRef, CLINIC_BASE_CURRENCY } from "./money";
import type {
  ReportFilters, ReportResult, ReportRow, KpiItem, ReportColumn,
  PeriodPreset, DebtMode, PatientStatusFilter, DebtStatusFilter,
  CurrencyFilter, CompareMode, ReportOptions,
} from "./reports-types";
import { PATIENT_STATUS_LABEL, PAYMENT_METHOD_LABEL, COMMON_COLUMNS } from "./reports-types";

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

/**
 * (P-01/D-1) فاتورةٌ تعرف عملتها — `base_currency` تُقرأ من الصف نفسه وتسري معه
 * إلى كل مجمِّعٍ بعده. لا تُجمع فاتورتان بعملتين في رقمٍ واحد أبدًا.
 */
interface MovementInvoice {
  id: number; date: string; totalMinor: number; discountMinor: number; netMinor: number;
  currency: Currency; planId: number | null; categories: string[]; doctorIds: number[]; items: string[];
  /** (تقارير R1) بنود الفاتورة كما هي — الكمية والقيمة والطبيب والخدمة لكل بند. `netMinor`
   * نصيب البند من صافي الفاتورة بعد الخصم (توزيعٌ تناسبي بالباقي الأكبر). */
  lines: MovementLine[];
}

interface MovementLine {
  serviceId: number | null; description: string; quantity: number;
  totalMinor: number; netMinor: number; doctorId: number | null; category: string | null;
}

/**
 * (تقارير R1) زيارةٌ من سجل الزيارات نفسه — مصدر حقيقة «من زار المركز».
 * كانت الأعداد تُشتق من «تاريخ آخر زيارة» للمريض فتضيع كل زيارةٍ قبلها.
 */
export interface ReportVisit {
  id: number;
  patientId: number | null;
  patientName: string;
  patientNumber: string | null;
  phone: string | null;
  date: string;
  arrivedAt: string;
  calledAt: string | null;
  seatedAt: string | null;
  finishedAt: string | null;
  status: string;
  doctorId: number | null;
  invoiceId: number | null;
  appointmentId: number | null;
  chair: number | null;
  /** أول زيارة مسجّلة لهذا المريض (مراجعٌ جديد). */
  firstVisit: boolean;
}

/**
 * (P-01/D-1) دفعةٌ تحمل هدف تسويتها (عقد money.ts): عملة فاتورتها، أو عملة
 * خطتها للدفعة المقدَّمة قبل الفوترة، أو الأساس لمن لا فاتورة له ولا خطة.
 * `settlementMinor` قيمةُ تسويتها بدلوها: بمبلغها إن كانت بعملة الدلو، وبمكافئها
 * المسجَّل بسعر يومها إن كانت بعملة أخرى عن فاتورةٍ أساسية — العقد القائم نفسه.
 */
interface MovementPayment {
  id: number; date: string; kind: string; amountMinor: number; currency: Currency;
  baseMinor: number; method: string; invoiceId: number | null; planId: number | null;
  settlementCurrency: Currency; settlementMinor: number;
  createdBy: string | null; note: string | null;
}

/** (P-01/D-1) خطةٌ تعرف عملة اتفاقها — قيمتها بعملتها لا بعملة الدفاتر. */
interface MovementPlan {
  id: number; title: string; totalMinor: number; currency: Currency; status: string; startDate: string;
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

  const [
    invoicesRes, paymentsRes, openingRes, plansRes, invoiceCurrenciesRes, visitDoctorsRes, linesRes,
  ] = await Promise.all([
    // (P-01/D-1) عملة الفاتورة تُقرأ مع صفّها — أساس كل تجميع لاحق.
    pool.query<{
      id: number; patient_id: number; date: string; total: string; discount: string;
      base_currency: string; plan_id: number | null;
      categories: string[] | null; doctor_ids: number[] | null; items: string[] | null;
    }>(
      `SELECT i.id, i.patient_id, (i.created_at AT TIME ZONE $1)::date::text AS date,
              i.total_minor::text AS total, i.discount_minor::text AS discount, i.base_currency, i.plan_id,
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
    // (P-01/D-1) عملة اتفاق الخطة مع صفّها — قيمة الخطة بعملتها.
    pool.query<{
      id: number; patient_id: number; title: string; total: string; base_currency: string;
      status: string; start_date: string; categories: string[] | null;
    }>(
      `SELECT tp.id, tp.patient_id, tp.title, tp.total_minor::text AS total,
              tp.base_currency, tp.status,
              tp.start_date::text AS start_date,
              (SELECT COALESCE(json_agg(DISTINCT pi.category) FILTER (WHERE pi.category IS NOT NULL), '[]'::json)
                 FROM plan_items pi WHERE pi.plan_id = tp.id) AS categories
         FROM treatment_plans tp WHERE tp.patient_id = ANY($1::int[])`,
      [ids],
    ),
    /* (المراجعة النهائية ٢) الخريطة المرجعية الشاملة لعملة كل فاتورة —
     * الملغاة معها ومع مالكها: الدفعة واقعة تاريخية، وهدف تسويتها عملة
     * فاتورتها وإن أُلغيت لاحقًا. والمرجع الذي لا تحلّه هذه الخريطة هو
     * فساد الربط الحقيقي. (المراجعة النهائية للمال ٢) المالك يُقرأ مع
     * العملة: مرجع مريضٍ آخر داخل النطاق ربطٌ عابر يُقال لا يُستعار. */
    pool.query<{ id: number; patient_id: number; base_currency: string }>(
      `SELECT id, patient_id, base_currency FROM invoices WHERE patient_id = ANY($1::int[])`,
      [ids],
    ),
    pool.query<{ patient_id: number; doctor_id: number }>(
      `SELECT DISTINCT patient_id, doctor_id FROM visits
        WHERE doctor_id IS NOT NULL AND patient_id = ANY($1::int[])`,
      [ids],
    ),
    // (تقارير R1) بنود الفواتير — الكمية والقيمة والطبيب والخدمة لكل بند.
    pool.query<{
      invoice_id: number; service_id: number | null; description: string; quantity: string;
      total_minor: string; doctor_id: number | null; category: string | null;
    }>(
      `SELECT it.invoice_id, it.service_id, it.description, it.quantity::text AS quantity,
              it.total_minor::text AS total_minor, it.doctor_id, s.category
         FROM invoice_items it
         JOIN invoices i ON i.id = it.invoice_id
         LEFT JOIN services s ON s.id = it.service_id
        WHERE i.status <> 'cancelled' AND i.patient_id = ANY($1::int[])
        ORDER BY it.invoice_id, it.id`,
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
      // (P-01 owner review — تصحيح ٣) عملة الفاتورة تُتحقَّق — fail-closed:
      // المجهولة ترفع التقرير ولا تُوسَم أساسًا فتمزج الأرصدة.
      currency: requireCurrency(row.base_currency, "فاتورة", row.id),
      planId: row.plan_id,
      categories: row.categories ?? [],
      doctorIds: row.doctor_ids ?? [],
      items: row.items ?? [],
      lines: [],
    });
  }
  {
    const invoiceById = new Map<number, MovementInvoice>();
    for (const patient of byId.values()) for (const invoice of patient.invoices) invoiceById.set(invoice.id, invoice);
    for (const row of linesRes.rows) {
      invoiceById.get(row.invoice_id)?.lines.push({
        serviceId: row.service_id,
        description: row.description,
        quantity: Math.max(0, Number(row.quantity) || 0),
        totalMinor: num(row.total_minor),
        netMinor: 0,
        doctorId: row.doctor_id,
        category: row.category,
      });
    }
    for (const invoice of invoiceById.values()) allocateLineNet(invoice);
  }
  for (const row of paymentsRes.rows) {
    byId.get(row.patient_id)?.payments.push({
      id: row.id,
      date: row.date,
      kind: row.kind,
      amountMinor: num(row.amount),
      // (P-01 owner review — تصحيح ٣) عملة الدفعة تُتحقَّق — fail-closed.
      currency: requireCurrency(row.currency, "دفعة", row.id),
      baseMinor: num(row.base),
      method: row.method,
      invoiceId: row.invoice_id,
      planId: row.plan_id,
      // (P-01/D-1) هدف التسوية يُحسب هنا مرة واحدة (عقد money.ts): عملة فاتورتها
      // أو خطتها أو الأساس، والقيمة بمبلغها إن وافقت الدلو وبمكافئها المسجَّل وإلا.
      settlementCurrency: "YER",
      settlementMinor: 0,
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
      // (P-01 owner review — تصحيح ٣) عملة الخطة تُتحقَّق — fail-closed.
      currency: requireCurrency(row.base_currency, "خطة علاج", row.id),
      status: row.status,
      startDate: row.start_date,
      categories: row.categories ?? [],
      paidMinor: 0,
    });
  }
  for (const row of visitDoctorsRes.rows) {
    byId.get(row.patient_id)?.visitDoctorIds.push(row.doctor_id);
  }

  // (P-01/D-1) أهداف التسوية: خرائط عملة الفواتير والخطط لكل مريض، ثم توقيع كل
  // دفعة بدلوها وقيمة تسويتها — قبل أي تجميع، لا داخله.
  // (P-01 owner review — تصحيح ٣) المرجع الضائع يُقال ولا يُفترض أساسًا: الدفعة
  // المرتبطة بفاتورةٍ أو خطةٍ لا تُوجد في حركات مريضها = فسادُ ربطٍ يرفع خطأ
  // سلامةٍ مالية، لا تسويةٌ صامتة بدلو الأساس.
  /* (المراجعة النهائية ٢) الخريطة المرجعية الشاملة — الملغاة معها — هي مرجع
   * حلّ عملة الفاتورة المربوطة: الدفعة واقعة تاريخية تسوّي دلو عملة فاتورتها
   * وإن أُلغيت لاحقًا (المحركات المالية كلها على هذا العقد). وما لا تحلّه
   * الخريطة هو فساد الربط الحقيقي فيُقال (fail-closed). (المراجعة النهائية
   * للمال ٢) والمرجع يحمل مالكه: الخريطة عبر مجموعة مرضى فالملكية شرط. */
  const authoritativeInvoiceRefById = new Map<number, DocumentCurrencyRef>();
  for (const row of invoiceCurrenciesRes.rows) {
    authoritativeInvoiceRefById.set(row.id, {
      patientId: row.patient_id,
      currency: requireCurrency(row.base_currency, "فاتورة", row.id),
    });
  }

  for (const patient of byId.values()) {
    const planById = new Map(patient.plans.map((plan) => [plan.id, plan]));
    for (const payment of patient.payments) {
      let target: Currency;
      if (payment.invoiceId != null) {
        const invoiceRef = authoritativeInvoiceRefById.get(payment.invoiceId);
        if (invoiceRef === undefined) {
          throw new FinancialCurrencyIntegrityError(
            "دفعة مرتبطة بفاتورة لا تُحلّ عملتها",
            `#${payment.id} → فاتورة #${payment.invoiceId}`,
            "مرجع غير محلول",
          );
        }
        /* (المراجعة النهائية للمال ٢) ملكية المرجع شرطٌ لا مجرد وجوده في
         * نطاق التقرير: فاتورة مريضٍ آخر داخل النطاق تُقال ربطًا عابرًا، ولا
         * يُستعار هدفها لتسوية دفعة غيرها. */
        if (invoiceRef.patientId !== patient.patientId) {
          throw new FinancialCurrencyIntegrityError(
            "دفعة مرتبطة بفاتورة مريضٍ آخر",
            `#${payment.id} → فاتورة #${payment.invoiceId} (لمريض #${invoiceRef.patientId})`,
            "مرجع عابر للمرضى",
          );
        }
        target = invoiceRef.currency;
      } else if (payment.planId != null) {
        /* خريطة الخطط من حركات مريض الدفعة وحده (planById أعلاه) — فالمرجع
         * العابر للمرضى لا يُحلّ أصلًا وفساد الربط يُقال. */
        const plan = planById.get(payment.planId);
        if (!plan) {
          throw new FinancialCurrencyIntegrityError(
            "دفعة مقيدة على خطة ليست من حركات مريضها",
            `#${payment.id} → خطة #${payment.planId}`,
            "مرجع ضائع",
          );
        }
        target = plan.currency;
      } else {
        target = settlementTargetCurrency(
          { kind: payment.kind, currency: payment.currency },
          null,
        );
      }
      payment.settlementCurrency = target;
      /* (المراجعة النهائية للمال ٣) قاعدة التسوية الواحدة: بمبلغها بعملة
       * الهدف، وبمكافئها الأساسي المسجَّل إن كان الهدف الأساس — والعابر بين
       * أجنبيين لا سعر تاريخيًّا يحوّله فيُقال (fail-closed). */
      payment.settlementMinor = settlePaymentMinor(
        { amountMinor: payment.amountMinor, currency: payment.currency, baseAmountMinor: payment.baseMinor, id: payment.id },
        target,
      );
    }
  }

  // مدفوعات الخطة: الدفعة المرتبطة بالخطة مباشرة أو بفاتورة من الخطة — بعملة
  // الخطة نفسها (P-01/D-1): تقدُّم الخطة يُقاس بعملة اتفاقها لا بمكافئ الدفاتر.
  for (const patient of byId.values()) {
    const planById = new Map(patient.plans.map((plan) => [plan.id, plan]));
    for (const payment of patient.payments) {
      let targetPlanId = payment.planId;
      if (targetPlanId == null && payment.invoiceId != null) {
        targetPlanId = patient.invoices.find((inv) => inv.id === payment.invoiceId)?.planId ?? null;
      }
      if (targetPlanId != null) {
        const plan = planById.get(targetPlanId);
        if (plan) {
          const inPlanCurrency = payment.settlementCurrency === plan.currency
            ? payment.settlementMinor
            : 0;
          plan.paidMinor += payment.kind === "refund" ? -inPlanCurrency : inPlanCurrency;
        }
      }
    }
    // ترتيب زمني — FIFO يفترضه.
    patient.invoices.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    patient.payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  }

  return [...byId.values()];
}

// ─── حسابات الأرصدة (المنطق الخالص — قابل للاختبار) ─────────────────────────

/**
 * (P-01/D-1) حركةٌ مالية موسومة بالعملة — كل حساب رصيدٍ بعدها بعملة على حدة.
 *
 * الفاتورة بعملتها (لا سعر صرف لها)، والدفعة بدلو تسويتها (بمبلغها إن وافقت
 * وبمكافئها المسجَّل بسعر يومها إن خالفت فاتورةً أساسية)، والافتتاحي بدلو
 * العملة الأساسية وحده. لا يجمع الرصيد بين الدلاء أبدًا.
 */
export interface CurrencyAwareMovement {
  opening: { date: string; minor: number } | null;
  invoices: { date: string; netMinor: number; currency: Currency }[];
  payments: { date: string; settlementCurrency: Currency; settlementMinor: number; kind: string }[];
}

/**
 * (تقارير R1) صافي الفاتورة موزَّعًا على بنودها بنسبة قيمها (الباقي الأكبر) — فمجموع
 * أنصبة البنود = صافي الفاتورة حرفيًّا، ولا يُقسَم على عدد الأوصاف المختلفة كما كان.
 */
function allocateLineNet(invoice: MovementInvoice): void {
  const gross = invoice.lines.reduce((sum, line) => sum + Math.max(0, line.totalMinor), 0);
  if (gross <= 0) {
    for (const line of invoice.lines) line.netMinor = 0;
    return;
  }
  let assigned = 0;
  const parts = invoice.lines.map((line, index) => {
    const exact = (Math.max(0, line.totalMinor) * invoice.netMinor) / gross;
    const floor = Math.floor(exact);
    assigned += floor;
    return { index, floor, remainder: exact - floor };
  });
  let left = invoice.netMinor - assigned;
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left <= 0) break;
    part.floor += 1;
    left -= 1;
  }
  for (const part of parts) invoice.lines[part.index].netMinor = part.floor;
}

function emptyCurrencyRecord(): Record<Currency, number> {
  return { YER: 0, SAR: 0, USD: 0 };
}

/** تسوية الدفعة بمبلغها الموقَّع داخل دلوها. */
function signedSettlement(payment: CurrencyAwareMovement["payments"][number]): number {
  return payment.kind === "refund" ? -payment.settlementMinor : payment.settlementMinor;
}

/* ─── (P-01 owner review — تصحيح ١) نماذج القراءة المالية للوحة التنفيذية ─────
 *
 * الدفاتر المشتقة (journalEntries) تقيد أرجل الفواتير بعملتها الخام وأرجل
 * الدفعات بمكافئها الأساسي، فرصيد الإيراد أو الذمم منها رقمٌ ممزوج لا معنى
 * مالي له (TD-REG-028 يبقى مفتوحًا لإعادة تمثيل الدفتر نفسه). حتى ذلك التصميم
 * العميق تقرأ غرفة القيادة الفواتير والذمم من **مراجعها القانونية لكل عملة** —
 * نفس حركات هذا المحرك ونفس عقود التسوية، لا استعلامًا موازيًا ولا إعادة اشتقاق:
 *
 *  - الفواتير لكل عملة: من حركات الفواتير بعملة كل فاتورة (خصمٌ محدود بصافيها
 *    كما في قيد الفاتورة نفسه).
 *  - الذمم لكل عملة: مجموع أرصدة المرضى بدلائل عملاتهم حتى نهاية الفترة —
 *    نفس دالة الرصيد التي تخدم تقارير المديونية.
 * والصندوق والدفعات والمصروفات تبقى بمحاسبة المكافئ الأساسي المسجَّل كما كانت:
 * قيودها أساسيةٌ خالصة فلا مزج فيها أصلًا.
 */
export interface ExecutiveBillingRow {
  currency: Currency;
  /** إجمالي الفواتير قبل الخصم — بعملة الفاتورة. */
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
}

export interface ExecutiveReceivableRow {
  currency: Currency;
  /** صافي ما على المرضى بعملتهم حتى نهاية الفترة — من مرجع الأرصدة القانوني. */
  dueMinor: number;
}

export async function executiveFinancialReadModels(
  from: string,
  to: string,
): Promise<{
  billingByCurrency: ExecutiveBillingRow[];
  receivableByCurrency: ExecutiveReceivableRow[];
}> {
  const movements = await loadMovements({});
  const gross = emptyCurrencyRecord();
  const discount = emptyCurrencyRecord();
  const net = emptyCurrencyRecord();
  const receivable = emptyCurrencyRecord();

  for (const patient of movements) {
    for (const invoice of patient.invoices) {
      if (invoice.date < from || invoice.date > to) continue;
      gross[invoice.currency] += invoice.totalMinor;
      const clamped = Math.min(Math.max(0, invoice.discountMinor), invoice.totalMinor);
      discount[invoice.currency] += clamped;
      net[invoice.currency] += invoice.totalMinor - clamped;
    }
    const balances = balancesByCurrencyAt(patient, to);
    for (const currency of CURRENCIES) {
      receivable[currency] += balances[currency];
    }
  }

  const billingByCurrency: ExecutiveBillingRow[] = [];
  const receivableByCurrency: ExecutiveReceivableRow[] = [];
  for (const currency of CURRENCIES) {
    if (gross[currency] !== 0 || discount[currency] !== 0) {
      billingByCurrency.push({
        currency,
        grossMinor: gross[currency],
        discountMinor: discount[currency],
        netMinor: net[currency],
      });
    }
    if (receivable[currency] !== 0) {
      receivableByCurrency.push({ currency, dueMinor: receivable[currency] });
    }
  }
  return { billingByCurrency, receivableByCurrency };
}

/** الرصيد بتاريخٍ لكل عملة على حدة: الافتتاحي (أساس) + فواتير الدلو − تسوياته. */
export function balancesByCurrencyAt(m: CurrencyAwareMovement, date: string): Record<Currency, number> {
  const balances = emptyCurrencyRecord();
  if (m.opening && m.opening.date <= date) balances[CLINIC_BASE_CURRENCY] += m.opening.minor;
  for (const invoice of m.invoices) {
    if (invoice.date <= date) balances[invoice.currency] += invoice.netMinor;
  }
  for (const payment of m.payments) {
    if (payment.date <= date) balances[payment.settlementCurrency] -= signedSettlement(payment);
  }
  return balances;
}

/** أقدم دين غير مغطّى حتى تاريخه (FIFO داخل كل دلو) وعمره بالأيام. */
export function oldestUnpaidByCurrency(
  m: CurrencyAwareMovement,
  asOf: string,
): Record<Currency, { date: string | null; ageDays: number }> {
  const result = {} as Record<Currency, { date: string | null; ageDays: number }>;
  for (const currency of CURRENCIES) {
    const paidUpTo = m.payments
      .filter((p) => p.date <= asOf && p.settlementCurrency === currency)
      .reduce((sum, p) => sum + signedSettlement(p), 0);

    const debts: { date: string; amount: number }[] = [];
    if (currency === CLINIC_BASE_CURRENCY && m.opening && m.opening.date <= asOf && m.opening.minor > 0) {
      debts.push({ date: m.opening.date, amount: m.opening.minor });
    }
    for (const invoice of m.invoices) {
      if (invoice.currency === currency && invoice.date <= asOf && invoice.netMinor > 0) {
        debts.push({ date: invoice.date, amount: invoice.netMinor });
      }
    }
    debts.sort((a, b) => (a.date < b.date ? -1 : 1));

    let cumulative = 0;
    let oldest: string | null = null;
    for (const debt of debts) {
      cumulative += debt.amount;
      if (cumulative > paidUpTo) {
        oldest = debt.date;
        break;
      }
    }
    result[currency] = {
      date: oldest,
      ageDays: oldest ? Math.max(0, Math.round((toUTC(asOf) - toUTC(oldest)) / 86_400_000)) : 0,
    };
  }
  return result;
}

/**
 * تصنيف دفعات الفترة (FIFO داخل كل دلو): ما يغطّي رصيدًا سابقًا لبداية الفترة
 * = تحصيل مديونية سابقة، وما زيده = تحصيل جديد — لكل عملة على حدة.
 */
export function classifyPaymentsByCurrency(
  m: CurrencyAwareMovement,
  from: string,
  to: string,
): Record<Currency, { oldMinor: number; newMinor: number }> {
  const balancesAtStartByCurrency = balancesByCurrencyAt(m, addDays(from, -1));
  const result = {} as Record<Currency, { oldMinor: number; newMinor: number }>;
  for (const currency of CURRENCIES) {
    let remainingOld = Math.max(0, balancesAtStartByCurrency[currency]);
    let oldMinor = 0;
    let newMinor = 0;
    for (const payment of m.payments) {
      if (payment.date < from || payment.date > to) continue;
      if (payment.settlementCurrency !== currency) continue;
      const signed = signedSettlement(payment);
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
    result[currency] = { oldMinor, newMinor: Math.max(0, newMinor) };
  }
  return result;
}

// ─── العرض الأحادي القديم: دلو العملة الأساسية وحده ─────────────────────────
// (P-01/D-1) بقيت للتوافق — رصيد الأساس فقط، لا مزج. أي رقمٍ آخر يحتاج عملات
// المريض كلها يقرأ النسخ الموسومة أعلاه.

/** الرصيد بتاريخ: الافتتاحي (إن كان سابقًا) + فواتير الأساس حتى التاريخ − تسويات الأساس. */
export function balanceAt(m: {
  opening: { date: string; minor: number } | null;
  invoices: { date: string; netMinor: number; currency?: Currency }[];
  payments: { date: string; baseMinor: number; kind: string; settlementCurrency?: Currency; settlementMinor?: number }[];
}, date: string): number {
  let balance = 0;
  if (m.opening && m.opening.date <= date) balance += m.opening.minor;
  for (const invoice of m.invoices) {
    if (invoice.date <= date && (invoice.currency ?? CLINIC_BASE_CURRENCY) === CLINIC_BASE_CURRENCY) {
      balance += invoice.netMinor;
    }
  }
  for (const payment of m.payments) {
    if (payment.date <= date) {
      const settlesBase = payment.settlementCurrency
        ? payment.settlementCurrency === CLINIC_BASE_CURRENCY
        : true; // بلا هدفٍ محسوب: مكافئ الأساس المسجَّل — عقد الدفعات القائم.
      if (settlesBase) {
        const value = payment.settlementMinor ?? payment.baseMinor;
        balance -= payment.kind === "refund" ? -value : value;
      }
    }
  }
  return balance;
}

/** أقدم دين غير مغطّى (FIFO) بدلو العملة الأساسية وحده. */
export function oldestUnpaid(
  m: {
    opening: { date: string; minor: number } | null;
    invoices: { date: string; netMinor: number; currency?: Currency }[];
    payments: { date: string; baseMinor: number; kind: string; settlementCurrency?: Currency; settlementMinor?: number }[];
  },
  asOf: string,
): { date: string | null; ageDays: number } {
  return oldestUnpaidByCurrency(toCurrencyAware(m, asOf), asOf)[CLINIC_BASE_CURRENCY];
}

/** تصنيف دفعات الفترة (FIFO) بدلو العملة الأساسية وحده. */
export function classifyPayments(
  m: {
    opening: { date: string; minor: number } | null;
    invoices: { date: string; netMinor: number; currency?: Currency }[];
    payments: { date: string; baseMinor: number; kind: string; settlementCurrency?: Currency; settlementMinor?: number }[];
  },
  from: string,
  to: string,
): { oldMinor: number; newMinor: number } {
  const byCurrency = classifyPaymentsByCurrency(toCurrencyAware(m, to), from, to);
  return byCurrency[CLINIC_BASE_CURRENCY];
}

/** تحويل الشكل الأحادي القديم إلى حركةٍ موسومة بالعملة.
 *
 * (P-01 owner review — تصحيح ٣) الغائب legacy أساسٌ بالعقد القديم — أما الموجودُ
 * الفاسد فخطأ سلامةٍ يُقال: لا تمرّ عملةٌ نصيةٌ غير معروفة إلى الأرصدة بصمت.
 */
function toCurrencyAware(
  m: {
    opening: { date: string; minor: number } | null;
    invoices: { date: string; netMinor: number; currency?: Currency }[];
    payments: { date: string; baseMinor: number; kind: string; settlementCurrency?: Currency; settlementMinor?: number }[];
  },
  _asOf: string,
): CurrencyAwareMovement {
  return {
    opening: m.opening,
    invoices: m.invoices.map((invoice) => ({
      date: invoice.date,
      netMinor: invoice.netMinor,
      currency: requireCurrency(invoice.currency ?? CLINIC_BASE_CURRENCY, "حركة فاتورة (شكل قديم)", invoice.date),
    })),
    payments: m.payments.map((payment) => ({
      date: payment.date,
      kind: payment.kind,
      settlementCurrency: requireCurrency(
        payment.settlementCurrency ?? CLINIC_BASE_CURRENCY,
        "حركة دفعة (شكل قديم)",
        payment.date,
      ),
      settlementMinor: payment.settlementMinor ?? payment.baseMinor,
    })),
  };
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
  /** (تقارير R1) سجل الزيارات حتى نهاية المدى — مصدر أعداد الزيارات وتقريرها. */
  visits: ReportVisit[];
  /** (P0-1) مخرجات محرّك العمولات نفسه للمدى — لتقرير الطبيب وحده. */
  commissionRows?: CommissionRow[];
}

async function loadContext(filters: ReportFilters, needMovements: boolean): Promise<ReportContext> {
  const doctorParties = await listParties("doctor");
  // (TD-05) الأساس دستوري من الكود — التقارير كلها تعرض مكافئاتها به.
  const base = CLINIC_BASE_CURRENCY;
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
  const visits = needMovements ? await loadVisits(filters) : [];

  return { filters, base, doctors, commissions, expenses, movements, visits };
}

/**
 * (تقارير R1) سجل الزيارات حتى نهاية المدى (والمقارنة قد ترجع قبله) — بتاريخ العيادة
 * المحلي، مع «أول زيارة للمريض» من السجل كله لا من المدى.
 */
async function loadVisits(filters: ReportFilters): Promise<ReportVisit[]> {
  const { rows } = await getPool().query<{
    id: number; patient_id: number | null; patient_name: string; patient_number: string | null;
    phone: string | null; date: string; arrived_at: Date; called_at: Date | null; seated_at: Date | null;
    finished_at: Date | null; status: string; doctor_id: number | null; invoice_id: number | null;
    appointment_id: number | null; chair: number | null; first_visit: boolean;
  }>(
    `SELECT v.id, v.patient_id, COALESCE(p.full_name, v.patient_name) AS patient_name,
            p.patient_number, COALESCE(p.phone, v.patient_phone) AS phone,
            (v.arrived_at AT TIME ZONE $1)::date::text AS date,
            v.arrived_at, v.called_at, v.seated_at, v.finished_at, v.status, v.doctor_id,
            v.invoice_id, v.appointment_id, v.chair,
            (v.patient_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM visits earlier
                WHERE earlier.patient_id = v.patient_id
                  AND (earlier.arrived_at < v.arrived_at OR (earlier.arrived_at = v.arrived_at AND earlier.id < v.id))
            )) AS first_visit
       FROM visits v
       LEFT JOIN patients p ON p.id = v.patient_id
      WHERE (v.arrived_at AT TIME ZONE $1)::date <= $2::date
        AND ($3::int IS NULL OR v.patient_id = $3::int)
      ORDER BY v.arrived_at, v.id`,
    [CLINIC_TIME_ZONE, filters.to, filters.patientId ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    patientId: row.patient_id,
    patientName: row.patient_name,
    patientNumber: row.patient_number,
    phone: row.phone,
    date: row.date,
    arrivedAt: row.arrived_at.toISOString(),
    calledAt: row.called_at ? row.called_at.toISOString() : null,
    seatedAt: row.seated_at ? row.seated_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    status: row.status,
    doctorId: row.doctor_id,
    invoiceId: row.invoice_id,
    appointmentId: row.appointment_id,
    chair: row.chair,
    firstVisit: row.first_visit,
  }));
}

/** يبني التقرير كاملًا وفق نوعه وفلاتره. */
export async function buildReport(report: string, filters: ReportFilters): Promise<ReportResult> {
  const needsMovements = [
    "daily", "monthly", "annual", "debt", "aging",
    "specialty", "doctor", "collections", "services", "patients", "patient-statement", "visits",
  ].includes(report);

  const ctx = await loadContext(filters, needsMovements);
  /* (P0-1) «مستحق الطبيب» في تقرير الطبيب يأتي من محرّك العمولات الواحد (التحصيل
     الفعلي، خصم المختبر، النسبة السارية وقت التحصيل) — لا من صيغةٍ ثانية كانت تضرب
     قيمة الفاتورة كاملةً في نسبة اليوم فتناقض شاشة العمولات. */
  if (report === "doctor" || report === "doctor-commission") {
    ctx.commissionRows = await commissionReport(filters.from, filters.to);
  }

  switch (report) {
    case "daily": return dailyReport(ctx);
    case "monthly": return monthlyReport(ctx);
    case "annual": return annualReport(ctx);
    case "debt": return debtReport(ctx);
    case "aging": return agingReport(ctx);
    case "specialty": return specialtyReport(ctx);
    case "doctor": return doctorReport(ctx);
    case "doctor-commission": return doctorCommissionStatementReport(ctx);
    case "collections": return collectionsReport(ctx);
    case "services": return servicesReport(ctx);
    case "visits": return visitsReport(ctx);
    case "appointments": return appointmentsReport(ctx);
    case "treatment-plans": return treatmentPlansReport(ctx);
    case "lab": return labReport(ctx);
    case "inventory": return inventoryReport(ctx);
    case "suppliers": return suppliersReport(ctx);
    case "recall": return recallReport(ctx);
    case "patients": return patientsReport(ctx);
    case "patient-statement": return patientStatementReport(ctx);
    default: throw new ReportInputError("نوع تقرير غير معروف.");
  }
}

// ─── مساعدات النتائج ────────────────────────────────────────────────────────

function moneyKpi(key: string, label: string, minor: number, base: Currency, tone?: KpiItem["tone"], hint?: string): KpiItem {
  return { key, label, minor, currency: base, tone, hint };
}

/**
 * (P-01/D-1) بطاقات مالية بكل عملة على حدة — الأساس أولًا بمفتاحه التاريخي
 * (`invoiced` مثلًا — توافقًا مع ما يقرأه verify-reports والشاشات)، ثم لكل عملة
 * اتفاقٍ نشطة بطاقة موسومة بمفتاحٍ يحمل العملة (`invoiced-SAR`) وبعملتها
 * نفسها في الرمز. لا تجميع ولا مقارنة عبر العملات.
 */
function moneyKpis(
  key: string,
  label: string,
  byCurrency: Record<Currency, number>,
  tone?: KpiItem["tone"],
  hint?: string,
): KpiItem[] {
  const kpis: KpiItem[] = [];
  for (const currency of CURRENCIES) {
    const value = byCurrency[currency];
    if (currency !== CLINIC_BASE_CURRENCY && value === 0) continue;
    kpis.push({
      key: currency === CLINIC_BASE_CURRENCY ? key : `${key}-${currency}`,
      label: currency === CLINIC_BASE_CURRENCY ? label : `${label} (${currency})`,
      minor: value,
      currency,
      tone,
      hint,
    });
  }
  return kpis;
}

/** جمع سجلَّي عملات بالجمع داخل الدلو نفسه فقط. */
function addCurrencyRecords(a: Record<Currency, number>, b: Record<Currency, number>): Record<Currency, number> {
  const result = emptyCurrencyRecord();
  for (const currency of CURRENCIES) result[currency] = a[currency] + b[currency];
  return result;
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

/** (P-01/D-1) حالة المديونية داخل دلوٍ بعينه — لا يطفئ رصيدُ عملةٍ حالةَ أخرى. */
/**
 * (تقارير R1) زيارات السجل داخل مدى وفلاتر التقرير. الطبيب بطبيب الزيارة نفسها لا
 * بعلاقة المريض التاريخية؛ والتخصص وحالة المريض بفلاتر المريض كما في بقية التقارير؛
 * والخدمة ببنود فاتورة الزيارة.
 */
function visitsInRange(ctx: ReportContext, from: string, to: string): ReportVisit[] {
  const { filters } = ctx;
  const byPatient = movementIndex(ctx);
  const invoiceById = invoiceIndex(ctx);
  const statusFiltered = filters.patientStatus && filters.patientStatus !== "all";
  return ctx.visits.filter((visit) => {
    if (visit.date < from || visit.date > to) return false;
    if (filters.doctorId && visit.doctorId !== filters.doctorId) return false;
    const patient = visit.patientId !== null ? byPatient.get(visit.patientId) : undefined;
    if ((filters.specialty || statusFiltered) && !patient) return false;
    if (filters.specialty && patient && !patientHasSpecialty(patient, filters.specialty)) return false;
    if (filters.serviceId) {
      const invoice = visit.invoiceId !== null ? invoiceById.get(visit.invoiceId) : undefined;
      if (!invoice || !invoice.lines.some((line) => line.serviceId === filters.serviceId)) return false;
    }
    return true;
  });
}

const movementIndexCache = new WeakMap<ReportContext, Map<number, PatientMovement>>();
function movementIndex(ctx: ReportContext): Map<number, PatientMovement> {
  let index = movementIndexCache.get(ctx);
  if (!index) {
    index = new Map(ctx.movements.map((movement) => [movement.patientId, movement]));
    movementIndexCache.set(ctx, index);
  }
  return index;
}

const invoiceIndexCache = new WeakMap<ReportContext, Map<number, MovementInvoice>>();
function invoiceIndex(ctx: ReportContext): Map<number, MovementInvoice> {
  let index = invoiceIndexCache.get(ctx);
  if (!index) {
    index = new Map();
    for (const movement of ctx.movements) for (const invoice of movement.invoices) index.set(invoice.id, invoice);
    invoiceIndexCache.set(ctx, index);
  }
  return index;
}

/** (تقارير R1) عدد الخدمات المنجزة = مجموع كميات بنود الفاتورة (لا عدد الأوصاف المختلفة). */
function invoiceServiceUnits(invoice: MovementInvoice, serviceId: number | null): number {
  return invoice.lines
    .filter((line) => serviceId === null || line.serviceId === serviceId)
    .reduce((sum, line) => sum + line.quantity, 0);
}

function debtStatusOfBucket(m: PatientMovement, currency: Currency, asOf: string): DebtStatusFilter {
  const balances = balancesByCurrencyAt(m, asOf);
  if (balances[currency] <= 0) return "settled";
  return oldestUnpaidByCurrency(m, asOf)[currency].ageDays >= 30 ? "overdue" : "indebted";
}

/**
 * (P-01/D-1) صف مديونية = مريض × دلو عملة. المريض باتفاقين بعملتين صفّان،
 * كلٌّ برصيده وعمره، ولا يُجمَع بينها.
 */
interface DebtBucketRow {
  movement: PatientMovement;
  currency: Currency;
  balanceMinor: number;
  oldestDate: string | null;
  ageDays: number;
  lastPayment: { date: string; minor: number } | null;
}

/** أرصدة المرضى بعد الفلاتر الجانبية — أساس المديونية والعمر والتجميعات، بكل دلو. */
function filteredDebtRows(ctx: ReportContext, asOf: string): DebtBucketRow[] {
  const { filters } = ctx;
  const rows: DebtBucketRow[] = [];
  for (const patient of ctx.movements) {
    if (filters.patientId && patient.patientId !== filters.patientId) continue;
    if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;

    const balances = balancesByCurrencyAt(patient, asOf);
    const oldest = oldestUnpaidByCurrency(patient, asOf);
    const payments = patient.payments.filter((p) => p.date <= asOf && p.kind !== "refund");

    for (const currency of CURRENCIES) {
      const bucketBalance = balances[currency];
      if (bucketBalance === 0) continue;
      const status = debtStatusOfBucket(patient, currency, asOf);
      if (filters.debtStatus !== "all" && filters.debtStatus !== status) continue;

      const bucketPayments = payments.filter((p) => p.settlementCurrency === currency);
      const last = bucketPayments.length > 0 ? bucketPayments[bucketPayments.length - 1] : null;

      rows.push({
        movement: patient,
        currency,
        balanceMinor: bucketBalance,
        oldestDate: oldest[currency].date,
        ageDays: oldest[currency].ageDays,
        lastPayment: last ? { date: last.date, minor: last.settlementMinor } : null,
      });
    }
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
  let invoicesCount = 0;
  // (P-01/D-1) كل رقمٍ مالي بالعملات على حدة — لا يجوز جمعها في رقمٍ واحد.
  let invoicedByCurrency = emptyCurrencyRecord();
  let collectedByCurrency = emptyCurrencyRecord();
  let oldDebtByCurrency = emptyCurrencyRecord();
  const bySpecialty = new Map<string, number>();
  const rows: ReportRow[] = [];

  for (const patient of ctx.movements) {
    if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;

    if (patient.createdDate && patient.createdDate >= from && patient.createdDate <= to) newPatients++;

    const dayInvoices = patient.invoices.filter((inv) => inv.date >= from && inv.date <= to);
    const dayPayments = patient.payments.filter((p) => p.date >= from && p.date <= to);
    const classified = classifyPaymentsByCurrency(patient, from, to);
    const oldDebtToday = emptyCurrencyRecord();
    for (const currency of CURRENCIES) oldDebtToday[currency] = classified[currency].oldMinor;
    oldDebtByCurrency = addCurrencyRecords(oldDebtByCurrency, oldDebtToday);

    // تسويات اليوم بدلوها — لكل عملة ما سُدِّد من دلوها فقط.
    const dayPaidByCurrency = emptyCurrencyRecord();
    for (const payment of dayPayments) {
      dayPaidByCurrency[payment.settlementCurrency] += payment.kind === "refund"
        ? -payment.settlementMinor
        : payment.settlementMinor;
    }
    collectedByCurrency = addCurrencyRecords(collectedByCurrency, dayPaidByCurrency);

    const dayInvoicedByCurrency = emptyCurrencyRecord();
    for (const invoice of dayInvoices) {
      dayInvoicedByCurrency[invoice.currency] += invoice.netMinor;
      invoicesCount++;
      servicesCount += invoiceServiceUnits(invoice, filters.serviceId);
      for (const category of invoice.categories) {
        bySpecialty.set(category, (bySpecialty.get(category) ?? 0) + 1);
      }
    }
    invoicedByCurrency = addCurrencyRecords(invoicedByCurrency, dayInvoicedByCurrency);

    const balancesAtEnd = balancesByCurrencyAt(patient, to);
    const dayInvoicesByCurrency = new Map<Currency, MovementInvoice[]>();
    for (const invoice of dayInvoices) {
      const list = dayInvoicesByCurrency.get(invoice.currency) ?? [];
      list.push(invoice);
      dayInvoicesByCurrency.set(invoice.currency, list);
    }

    if (dayInvoices.length > 0) {
      for (const [currency, invoiceList] of dayInvoicesByCurrency) {
        let paidForBucket = dayPaidByCurrency[currency];
        for (const invoice of invoiceList) {
          const doctorId = invoice.doctorIds[0] ?? null;
          rows.push({
            patientId: patient.patientId,
            patientName: patient.name,
            patientNumber: patient.patientNumber,
            currency,
            doctorName: doctorId ? (doctors.get(doctorId) ?? "—") : "—",
            specialtyLabel: invoice.categories.length
              ? invoice.categories.map((c) => CATEGORY_LABEL[c] ?? c).join("، ")
              : "عام",
            serviceNames: invoice.items.join("، ") || "—",
            totalMinor: invoice.netMinor,
            discountMinor: invoice.discountMinor,
            paidMinor: paidForBucket,
            remainingMinor: Math.max(0, balancesAtEnd[currency]),
          });
          paidForBucket = 0; // تُنسب تسويات الدلو لأول فاتورة به — إجماليات اليوم تبقى صحيحة.
        }
      }
    } else {
      // لا فواتير اليوم: تسويات كل دلوٍ نشط سطر «تحصيل» بعملته.
      for (const currency of CURRENCIES) {
        if (dayPaidByCurrency[currency] === 0) continue;
        rows.push({
          patientId: patient.patientId,
          patientName: patient.name,
          patientNumber: patient.patientNumber,
          currency,
          doctorName: "—",
          specialtyLabel: "تحصيل",
          serviceNames: "تحصيل مديونية سابقة",
          totalMinor: 0,
          discountMinor: 0,
          paidMinor: dayPaidByCurrency[currency],
          remainingMinor: Math.max(0, balancesAtEnd[currency]),
        });
      }
    }
  }

  // (تقارير R1) الزيارات من سجل الزيارات نفسه — كل زيارةٍ في المدى، لا «آخر زيارة».
  const periodVisits = visitsInRange(ctx, from, to);
  visits = periodVisits.length;
  const visitedPatients = new Set(periodVisits.map((visit) => visit.patientId ?? -visit.id)).size;
  const expensesMinor = expenses.reduce((sum, e) => sum + e.minor, 0);
  // الآجل الجديد داخل كل دلو: ما فُوتر به اليوم ولم يسدَّد منه (سوى ما غطّى
  // رصيدًا سابقًا) — بلا اقتراضٍ بين الدلاء.
  const newDeferredByCurrency = emptyCurrencyRecord();
  for (const currency of CURRENCIES) {
    const newCollected = Math.max(0, collectedByCurrency[currency] - oldDebtByCurrency[currency]);
    newDeferredByCurrency[currency] = Math.max(0, invoicedByCurrency[currency] - newCollected);
  }

  const specialtyKpis: KpiItem[] = [...bySpecialty.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([code, count]) => countKpi(`sp-${code}`, `حالات ${CATEGORY_LABEL[code] ?? code}`, count, "calm"));

  const singleDay = from === to;
  return {
    report: "daily",
    title: singleDay ? "التقرير اليومي" : "التقرير التشغيلي للفترة",
    subtitle: singleDay ? `يوم ${formatArabicDate(from)}` : `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    periodLabel: singleDay ? formatArabicDate(from) : `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      countKpi("visits", "الزيارات", visits),
      countKpi("visitedPatients", "المرضى المراجعون", visitedPatients),
      countKpi("new", "مرضى جدد", newPatients, "good"),
      countKpi("services", "خدمات مسجلة", servicesCount),
      countKpi("invoices", "فواتير", invoicesCount),
      ...moneyKpis("invoiced", "قيمة الفواتير", invoicedByCurrency),
      ...moneyKpis("collected", "المحصّل", collectedByCurrency, "good"),
      ...moneyKpis("deferred", "آجل جديد (صافي)", newDeferredByCurrency, "warn"),
      ...moneyKpis("oldDebt", "تحصيل مديونيات سابقة", oldDebtByCurrency, "info"),
      moneyKpi("expenses", "المصروفات", expensesMinor, base, "bad"),
      moneyKpi("net", "صافي التدفق النقدي (الأساس)", collectedByCurrency[base] - expensesMinor, base, collectedByCurrency[base] - expensesMinor >= 0 ? "good" : "bad"),
      ...specialtyKpis,
    ],
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "doctorName", label: "الطبيب" },
      { key: "specialtyLabel", label: "التخصص" },
      { key: "serviceNames", label: "الخدمة" },
      { key: "currency", label: "العملة" },
      { key: "totalMinor", label: "قيمة الخدمة", type: "money", currencyKey: "currency" },
      { key: "discountMinor", label: "الخصم", type: "money", currencyKey: "currency" },
      { key: "paidMinor", label: "المدفوع", type: "money", currencyKey: "currency" },
      { key: "remainingMinor", label: "المتبقي", type: "money", currencyKey: "currency" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "«المتبقي» هو رصيد المريض بدلو عملة الصف بتاريخ التقرير — لا متبقي الفاتورة وحدها.",
      "دفعات اليوم تُصنَّف FIFO داخل كل عملة: ما يغطّي رصيدًا سابقًا يظهر في «تحصيل مديونيات سابقة».",
      "كل عملة ببطاقتها ودلوها — لا يُجمع بين عملاتٍ ولا يقترض دلوٌ من آخر.",
    ],
  };
}

// ─── ملخص فترة (يخدم الشهري والسنوي) ────────────────────────────────────────

/**
 * (P-01/D-1) ملخص الفترة بالعملات — كل رقمٍ مالي سجلٌّ بثلاثة دلاء، والخدمات
 * تُرتَّب وتُجمَع داخل عملتها. لا يوجد هنا رقمٌ ماليٌّ واحد عبر العملات.
 */
function periodSummary(ctx: ReportContext, from: string, to: string) {
  const { filters, expenses } = ctx;
  let patients = 0;
  let newPatients = 0;
  let services = 0;
  const invoicedByCurrency = emptyCurrencyRecord();
  // (تقارير R1) الزيارات من سجلها — وكل مريضٍ زار في الفترة نشطٌ فيها.
  const periodVisits = visitsInRange(ctx, from, to);
  const visits = periodVisits.length;
  const visitedIds = new Set(periodVisits.map((visit) => visit.patientId).filter((id): id is number => id !== null));
  const collectedByCurrency = emptyCurrencyRecord();
  const oldDebtByCurrency = emptyCurrencyRecord();
  const topServices = new Map<string, { name: string; currency: Currency; count: number; totalMinor: number }>();

  for (const patient of ctx.movements) {
    if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;

    const periodInvoices = patient.invoices.filter((inv) => inv.date >= from && inv.date <= to);
    const periodPayments = patient.payments.filter((p) => p.date >= from && p.date <= to);

    let active = false;
    if (patient.createdDate && patient.createdDate >= from && patient.createdDate <= to) { newPatients++; active = true; }
    if (visitedIds.has(patient.patientId)) active = true;
    if (periodInvoices.length > 0 || periodPayments.length > 0) active = true;
    if (active) patients++;

    for (const invoice of periodInvoices) {
      invoicedByCurrency[invoice.currency] += invoice.netMinor;
      services += invoiceServiceUnits(invoice, filters.serviceId);
      // (P-01/D-1) نصيب البند من الفاتورة بعملة الفاتورة نفسها — لا بعملة الدفاتر.
      const perItem = invoice.items.length > 0 ? Math.round(invoice.netMinor / invoice.items.length) : 0;
      for (const item of invoice.items) {
        const key = `${item}::${invoice.currency}`;
        const entry = topServices.get(key) ?? { name: item, currency: invoice.currency, count: 0, totalMinor: 0 };
        entry.count++;
        entry.totalMinor += perItem;
        topServices.set(key, entry);
      }
    }
    for (const payment of periodPayments) {
      collectedByCurrency[payment.settlementCurrency] += payment.kind === "refund"
        ? -payment.settlementMinor
        : payment.settlementMinor;
    }
    const classified = classifyPaymentsByCurrency(patient, from, to);
    for (const currency of CURRENCIES) oldDebtByCurrency[currency] += classified[currency].oldMinor;
  }

  // المديونية الجديدة داخل كل دلو على حدة.
  const newDebtByCurrency = emptyCurrencyRecord();
  for (const currency of CURRENCIES) {
    const newCollected = Math.max(0, collectedByCurrency[currency] - oldDebtByCurrency[currency]);
    newDebtByCurrency[currency] = Math.max(0, invoicedByCurrency[currency] - newCollected);
  }

  // المستحقات بنهاية الفترة: موجب كل دلوٍ على حدة.
  const outstandingEnd = emptyCurrencyRecord();
  for (const row of filteredDebtRows(ctx, to)) {
    outstandingEnd[row.currency] += Math.max(0, row.balanceMinor);
  }
  const expensesMinor = expenses.filter((e) => e.date >= from && e.date <= to).reduce((sum, e) => sum + e.minor, 0);

  // (P-01/D-1) أكثر الخدمات داخل كل عملة: ترتيبًا داخليًّا وعشرة لكل دلو.
  const topServicesList = [...topServices.values()].sort((a, b) => {
    if (a.currency !== b.currency) {
      return CURRENCIES.indexOf(a.currency) - CURRENCIES.indexOf(b.currency);
    }
    return b.totalMinor - a.totalMinor;
  });
  const topServicesByCurrency = new Map<Currency, typeof topServicesList>();
  for (const entry of topServicesList) {
    const list = topServicesByCurrency.get(entry.currency) ?? [];
    if (list.length < 10) list.push(entry);
    topServicesByCurrency.set(entry.currency, list);
  }
  const topServicesSliced: typeof topServicesList = [];
  for (const currency of CURRENCIES) {
    topServicesSliced.push(...(topServicesByCurrency.get(currency) ?? []));
  }

  // زائرٌ بلا ملفٍ مالي (تصفية الحالة أسقطته من الحركات) لا يُعدّ مريضًا نشطًا مرتين.
  const byPatient = movementIndex(ctx);
  for (const id of visitedIds) {
    if (!byPatient.has(id)) patients++;
  }
  return {
    patients, newPatients, visits, services, invoicedByCurrency, collectedByCurrency,
    oldDebtByCurrency, newDebtByCurrency, outstandingEnd, expensesMinor,
    topServices: topServicesSliced,
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
    ...moneyKpis("invoiced", "قيمة الخدمات", summary.invoicedByCurrency),
    ...moneyKpis("collected", "التحصيل", summary.collectedByCurrency, "good"),
    ...moneyKpis("newDebt", "مديونية جديدة (صافي)", summary.newDebtByCurrency, "warn"),
    ...moneyKpis("oldDebt", "تحصيل ديون قديمة", summary.oldDebtByCurrency, "info"),
    moneyKpi("expenses", "المصروفات", summary.expensesMinor, base, "bad"),
    ...moneyKpis("outstanding", "المستحقات بنهاية الفترة", summary.outstandingEnd, "warn"),
    // (P-01/D-1) الصافي بالأساس وحده: المصروف بعملة الأساس فلا يُطرح من فواتير
    // عملةٍ أخرى — ذلك طرحٌ عابرٌ للعملات محظور.
    moneyKpi("net", "صافي الإيراد (الأساس)", summary.invoicedByCurrency[base] - summary.expensesMinor, base, "info",
      "قيمة الخدمات المسجلة بالأساس ناقص المصروفات — أساس الاستحقاق لا الصندوق"),
  ];

  let comparison: ReportResult["comparison"];
  const compare = comparisonRange(from, to, filters.compare);
  if (compare) {
    const prev = periodSummary(ctx, compare.from, compare.to);
    // (P-01/D-1) المقارنة داخل كل عملة — لا تُطرح عملةٌ من عملة.
    const entry = (label: string, currentByCurrency: Record<Currency, number>, previousByCurrency: Record<Currency, number>) => {
      const entries: NonNullable<ReportResult["comparison"]>["entries"] = [];
      for (const currency of CURRENCIES) {
        const current = currentByCurrency[currency];
        const previous = previousByCurrency[currency];
        if (currency !== CLINIC_BASE_CURRENCY && current === 0 && previous === 0) continue;
        entries.push({
          label: currency === CLINIC_BASE_CURRENCY ? label : `${label} (${currency})`,
          currentMinor: current,
          previousMinor: previous,
          currency,
          changePercent: previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10,
        });
      }
      return entries;
    };
    comparison = {
      title: compare.label,
      entries: [
        ...entry("التحصيل", summary.collectedByCurrency, prev.collectedByCurrency),
        ...entry("قيمة الخدمات", summary.invoicedByCurrency, prev.invoicedByCurrency),
        ...entry("المصروفات", { YER: summary.expensesMinor, SAR: 0, USD: 0 }, { YER: prev.expensesMinor, SAR: 0, USD: 0 }),
        ...entry("المستحقات", summary.outstandingEnd, prev.outstandingEnd),
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
      { key: "currency", label: "العملة" },
      { key: "totalMinor", label: "القيمة", type: "money", currencyKey: "currency" },
    ],
    rows: summary.topServices.map((service) => ({
      serviceName: service.name,
      count: service.count,
      currency: service.currency,
      totalMinor: service.totalMinor,
    })),
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "«صافي الإيراد» على أساس الاستحقاق: الإيراد من الفواتير بعملتها، والمصروف بالأساس عند نشوئه.",
      "أكثر الخدمات مرتَّب داخل كل عملة — الخدمة نفسها بعملتين سطران بعملتيهما.",
    ],
  };
}

// ─── التقرير السنوي ──────────────────────────────────────────────────────────

function annualReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;
  const year = Number(from.slice(0, 4));

  const monthlyRows: ReportRow[] = [];
  // (P-01/D-1) الأشرطة بدلو العملة الأساسية وحده — معنونة بذلك؛ بقية الدلاء في الجدول.
  const bars: { label: string; minor: number }[] = [];
  let totalCollectedByCurrency = emptyCurrencyRecord();
  let totalInvoicedByCurrency = emptyCurrencyRecord();
  let totalExpenses = 0;
  let totalNewPatients = 0;
  const bestMonthByCurrency = new Map<Currency, { month: number; minor: number }>();
  const yearPatients = new Set<number>();

  for (let month = 1; month <= 12; month++) {
    const mFrom = `${from.slice(0, 4)}-${String(month).padStart(2, "0")}-01`;
    const mTo = endOfMonth(mFrom);
    if (mFrom > to) break;
    if (mTo < from) continue;

    const summary = periodSummary(ctx, mFrom, mTo);
    totalCollectedByCurrency = addCurrencyRecords(totalCollectedByCurrency, summary.collectedByCurrency);
    totalInvoicedByCurrency = addCurrencyRecords(totalInvoicedByCurrency, summary.invoicedByCurrency);
    totalExpenses += summary.expensesMinor;
    totalNewPatients += summary.newPatients;
    for (const currency of CURRENCIES) {
      const best = bestMonthByCurrency.get(currency);
      if (summary.collectedByCurrency[currency] > (best?.minor ?? 0)) {
        bestMonthByCurrency.set(currency, { month, minor: summary.collectedByCurrency[currency] });
      }
    }

    for (const patient of ctx.movements) {
      const active = (patient.createdDate && patient.createdDate >= mFrom && patient.createdDate <= mTo)
        || patient.invoices.some((inv) => inv.date >= mFrom && inv.date <= mTo)
        || patient.payments.some((p) => p.date >= mFrom && p.date <= mTo);
      if (active) yearPatients.add(patient.patientId);
    }
    // (تقارير R1) من زار في الشهر نشطٌ فيه وإن لم تكن له حركة مالية.
    for (const visit of visitsInRange(ctx, mFrom, mTo)) {
      if (visit.patientId !== null) yearPatients.add(visit.patientId);
    }

    // (P-01/D-1) صفٌّ لكل (شهر × عملة نشطة) — لا عمود مالي واحد يمزج الدلاء.
    const monthActivity = new Map<Currency, {
      invoiced: number; collected: number; newDebt: number; outstanding: number;
    }>();
    for (const currency of CURRENCIES) {
      const invoiced = summary.invoicedByCurrency[currency];
      const collected = summary.collectedByCurrency[currency];
      if (invoiced === 0 && collected === 0 && summary.outstandingEnd[currency] === 0) continue;
      monthActivity.set(currency, {
        invoiced, collected,
        newDebt: summary.newDebtByCurrency[currency],
        outstanding: summary.outstandingEnd[currency],
      });
    }
    // شهرٌ فيه زيارات أو مرضى بلا حركة مالية يبقى له صفّ (بعملة الأساس، أصفار مالية).
    if (monthActivity.size === 0 && (summary.visits > 0 || summary.patients > 0 || summary.services > 0)) {
      monthActivity.set(base, { invoiced: 0, collected: 0, newDebt: 0, outstanding: 0 });
    }
    for (const [currency, activity] of monthActivity) {
      monthlyRows.push({
        monthLabel: monthName(month),
        currency,
        patients: summary.patients,
        visits: summary.visits,
        // (تقارير R1) كان هذا العمود يعرض عدد الزيارات تحت عنوان «الخدمات».
        services: summary.services,
        servicesMinor: activity.invoiced,
        collectedMinor: activity.collected,
        debtMinor: activity.newDebt,
        expensesMinor: currency === base ? summary.expensesMinor : 0,
        outstandingMinor: activity.outstanding,
      });
    }
    bars.push({ label: monthName(month), minor: summary.collectedByCurrency[base] });
  }

  const outstandingEnd = emptyCurrencyRecord();
  for (const row of filteredDebtRows(ctx, to)) {
    outstandingEnd[row.currency] += Math.max(0, row.balanceMinor);
  }
  const topSpecialty = topSpecialtyOf(ctx, from, to);
  const bestMonthBase = bestMonthByCurrency.get(base);
  const avgMonthlyByCurrency = emptyCurrencyRecord();
  for (const currency of CURRENCIES) {
    const monthsWithCurrency = monthlyRows.filter((row) => row.currency === currency).length || 1;
    avgMonthlyByCurrency[currency] = Math.round(totalCollectedByCurrency[currency] / monthsWithCurrency);
  }

  return {
    report: "annual",
    title: "التقرير السنوي",
    subtitle: `سنة ${year}`,
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      ...moneyKpis("revenue", "إجمالي إيرادات السنة", totalInvoicedByCurrency),
      ...moneyKpis("collected", "إجمالي التحصيل", totalCollectedByCurrency, "good"),
      ...moneyKpis("debt", "إجمالي المديونية (نهاية السنة)", outstandingEnd, "warn"),
      moneyKpi("expenses", "إجمالي المصروفات", totalExpenses, base, "bad"),
      countKpi("patients", "مرضى السنة", yearPatients.size),
      countKpi("new", "مرضى جدد", totalNewPatients, "good"),
      ...moneyKpis("avgMonthly", "متوسط التحصيل الشهري", avgMonthlyByCurrency, "info"),
      { key: "best", label: "أعلى شهر تحصيل (الأساس)", text: bestMonthBase?.month ? monthName(bestMonthBase.month) : "—" },
      { key: "topSpecialty", label: "أعلى تخصص إيرادًا", text: topSpecialty },
    ],
    monthly: {
      columns: [
        { key: "monthLabel", label: "الشهر" },
        { key: "currency", label: "العملة" },
        { key: "patients", label: "المرضى", type: "count" },
        { key: "visits", label: "الزيارات", type: "count" },
        { key: "services", label: "الخدمات", type: "count" },
        { key: "servicesMinor", label: "قيمة الخدمات", type: "money", currencyKey: "currency" },
        { key: "collectedMinor", label: "المحصّل", type: "money", currencyKey: "currency" },
        { key: "debtMinor", label: "المديونية", type: "money", currencyKey: "currency" },
        { key: "expensesMinor", label: "المصروفات", type: "money", currencyKey: "currency" },
        { key: "outstandingMinor", label: "مديونية آخر الشهر", type: "money", currencyKey: "currency" },
      ],
      rows: monthlyRows,
      barKey: "collectedMinor",
    },
    bars,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "(P-01) كل شهرٍ بصفوفٍ لعملاته النشطة — لا يُجمع شهرٌ عملاته في رقمٍ واحد.",
      "الأشرطة البيانية بدلو العملة الأساسية وحده؛ تفصيل بقية العملات في الجدول.",
    ],
  };
}

function topSpecialtyOf(ctx: ReportContext, from: string, to: string): string {
  // (P-01/D-1) أعلى تخصص داخل كل عملة على حدة — والنص يعرض الأعلى بالأساس
  // أولًا ثم أعلى كل عملةٍ أخرى نشطة. لا مقارنة بين عملاتٍ بوحداتها الصغرى.
  const totalsByCurrency = new Map<Currency, Map<string, number>>();
  for (const patient of ctx.movements) {
    for (const invoice of patient.invoices) {
      if (invoice.date < from || invoice.date > to) continue;
      const totals = totalsByCurrency.get(invoice.currency) ?? new Map<string, number>();
      for (const category of invoice.categories) {
        totals.set(category, (totals.get(category) ?? 0) + invoice.netMinor);
      }
      totalsByCurrency.set(invoice.currency, totals);
    }
  }
  const topPerCurrency: { currency: Currency; label: string }[] = [];
  for (const currency of CURRENCIES) {
    const totals = totalsByCurrency.get(currency);
    if (!totals) continue;
    let best = "";
    let bestValue = 0;
    for (const [category, value] of totals) {
      if (value > bestValue) { best = CATEGORY_LABEL[category] ?? category; bestValue = value; }
    }
    if (best && bestValue > 0) {
      topPerCurrency.push({ currency, label: best });
    }
  }
  if (topPerCurrency.length === 0) return "—";
  return topPerCurrency
    .map((entry) => entry.currency === CLINIC_BASE_CURRENCY ? entry.label : `${entry.label} (${entry.currency})`)
    .join(" · ");
}

// ─── تقارير المديونية ────────────────────────────────────────────────────────

function debtReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const mode: DebtMode = filters.debtMode;

  if (mode === "movement") return debtMovementReport(ctx);
  if (mode === "collected") return collectionsReport(ctx, "debt");

  if (mode === "accrued") {
    // الديون الناشئة: فواتير الفترة − دفعات الفترة، على مستوى (المريض × العملة).
    const rows: ReportRow[] = [];
    const totalAccruedByCurrency = emptyCurrencyRecord();
    const totalBilledByCurrency = emptyCurrencyRecord();
    const totalPaidByCurrency = emptyCurrencyRecord();
    for (const patient of ctx.movements) {
      if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
      if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;
      const periodInvoices = patient.invoices
        .filter((inv) => inv.date >= filters.from && inv.date <= filters.to);
      const periodPayments = patient.payments
        .filter((p) => p.date >= filters.from && p.date <= filters.to);
      if (periodInvoices.length === 0 && periodPayments.length === 0) continue;

      const balancesAtEnd = balancesByCurrencyAt(patient, filters.to);
      const activityByCurrency = new Map<Currency, { billed: number; paid: number }>();
      for (const invoice of periodInvoices) {
        const entry = activityByCurrency.get(invoice.currency) ?? { billed: 0, paid: 0 };
        entry.billed += invoice.netMinor;
        activityByCurrency.set(invoice.currency, entry);
      }
      for (const payment of periodPayments) {
        const entry = activityByCurrency.get(payment.settlementCurrency) ?? { billed: 0, paid: 0 };
        entry.paid += payment.kind === "refund" ? -payment.settlementMinor : payment.settlementMinor;
        activityByCurrency.set(payment.settlementCurrency, entry);
      }

      const plan = pickPlan(patient, filters.specialty);
      for (const [currency, activity] of activityByCurrency) {
        if (activity.billed === 0 && activity.paid === 0) continue;
        // (P-01/D-1) الناشئة داخل الدلو: فواتير العملة − تسوياتها — لا يُقترض من دلوٍ آخر.
        const accrued = activity.billed - activity.paid;
        if (filters.debtStatus === "indebted" && accrued <= 0) continue;
        if (filters.debtStatus === "settled" && accrued !== 0) continue;
        totalAccruedByCurrency[currency] += accrued;
        totalBilledByCurrency[currency] += activity.billed;
        totalPaidByCurrency[currency] += activity.paid;
        rows.push({
          patientId: patient.patientId,
          patientName: patient.name,
          patientNumber: patient.patientNumber,
          currency,
          doctorName: mainDoctorName(patient, doctors),
          specialtyLabel: patientSpecialtyLabel(patient),
          planStart: plan ? formatArabicDate(plan.startDate) : "—",
          planTitle: plan?.title ?? "—",
          planCurrency: plan ? plan.currency : currency,
          planTotalMinor: plan?.totalMinor ?? 0,
          billedMinor: activity.billed,
          paidMinor: activity.paid,
          accruedMinor: accrued,
          balanceMinor: Math.max(0, balancesAtEnd[currency]),
        });
      }
    }
    // (P-01/D-1) الترتيب داخل العملة ثم العملات بترتيب الدلاء — لا مزج.
    rows.sort((a, b) => {
      const currencyOrder = CURRENCIES.indexOf(a.currency as Currency) - CURRENCIES.indexOf(b.currency as Currency);
      if (currencyOrder !== 0) return currencyOrder;
      return Number(b.accruedMinor) - Number(a.accruedMinor);
    });
    return {
      report: "debt",
      title: "المديونية الناشئة خلال الفترة",
      subtitle: "الديون الناتجة عن خدمات تمّت خلال الفترة — لكل عملة دلوها",
      periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
      from: filters.from, to: filters.to, baseCurrency: base,
      kpis: [
        ...moneyKpis("accrued", "صافي المديونية الناشئة", totalAccruedByCurrency, totalAccruedByCurrency[base] > 0 ? "warn" : "good"),
        ...moneyKpis("billed", "فواتير الفترة", totalBilledByCurrency),
        ...moneyKpis("paid", "دفعات الفترة", totalPaidByCurrency, "info"),
      ],
      columns: [
        { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
        { key: "patientNumber", label: "رقم الملف" },
        { key: "currency", label: "العملة" },
        { key: "doctorName", label: "الطبيب" },
        { key: "specialtyLabel", label: "التخصص" },
        { key: "planStart", label: "بداية العلاج" },
        { key: "planTitle", label: "الخطة" },
        { key: "planCurrency", label: "عملة الخطة" },
        { key: "planTotalMinor", label: "إجمالي الخطة", type: "money", currencyKey: "planCurrency" },
        { key: "billedMinor", label: "فواتير الفترة", type: "money", currencyKey: "currency" },
        { key: "paidMinor", label: "مدفوع الفترة", type: "money", currencyKey: "currency" },
        { key: "accruedMinor", label: "الناشئة", type: "money", currencyKey: "currency" },
        { key: "balanceMinor", label: "رصيده الكلي", type: "money", currencyKey: "currency" },
      ],
      rows,
      filtersLabel: filtersLabelOf(filters, doctors),
      notes: [
        "«الناشئة» = فواتير العملة − تسوياتها داخل دلوها. سالبها يعني أن المريض دفع أكثر مما فوّتره خلالها.",
        "المريض باتفاقين بعملتين يظهر سطرين — كلٌّ بعملته، ولا يُقترض دلوٌ من آخر.",
      ],
    };
  }

  // الوضع الافتراضي: الرصيد المستحق في نهاية الفترة — صفٌّ لكل (مريض × عملة).
  const asOf = filters.to;
  const rows: ReportRow[] = [];
  const totalDueByCurrency = emptyCurrencyRecord();
  for (const row of filteredDebtRows(ctx, asOf)) {
    if (row.balanceMinor <= 0) continue;
    const patient = row.movement;
    const currency = row.currency;
    const plan = pickPlan(patient, filters.specialty);
    totalDueByCurrency[currency] += row.balanceMinor;
    // (P-01/D-1) مفوتر الدلو = فواتير عملته (+ الافتتاحي بالأساس وحده)؛
    // محصّله = تسويات دلوها — كلٌّ داخل عملته، لا يُقترض من دلوٍ آخر.
    const billedMinor = patient.invoices
      .filter((inv) => inv.currency === currency)
      .reduce((sum, inv) => sum + inv.netMinor, 0)
      + (currency === CLINIC_BASE_CURRENCY ? (patient.opening?.minor ?? 0) : 0);
    const paidMinor = patient.payments
      .filter((p) => p.settlementCurrency === currency)
      .reduce((sum, p) => sum + (p.kind === "refund" ? -p.settlementMinor : p.settlementMinor), 0);
    rows.push({
      patientId: patient.patientId,
      patientName: patient.name,
      patientNumber: patient.patientNumber,
      phone: patient.phone ?? "—",
      currency,
      doctorName: mainDoctorName(patient, doctors),
      specialtyLabel: patientSpecialtyLabel(patient),
      statusLabel: PATIENT_STATUS_LABEL[patient.status],
      planStart: plan ? formatArabicDate(plan.startDate) : "—",
      planTitle: plan?.title ?? "—",
      planCurrency: plan ? plan.currency : currency,
      planTotalMinor: plan?.totalMinor ?? 0,
      planPaidMinor: plan?.paidMinor ?? 0,
      billedMinor,
      paidMinor,
      balanceMinor: row.balanceMinor,
      lastPaymentDate: row.lastPayment ? formatArabicDate(row.lastPayment.date) : "—",
      ageDays: row.ageDays,
      oldestDate: row.oldestDate ? formatArabicDate(row.oldestDate) : "—",
    });
  }
  // (P-01/D-1) الترتيب داخل كل عملة (الأكبر رصيدًا بدلوها) — العملات بترتيب الدلاء.
  rows.sort((a, b) => {
    const currencyOrder = CURRENCIES.indexOf(a.currency as Currency) - CURRENCIES.indexOf(b.currency as Currency);
    if (currencyOrder !== 0) return currencyOrder;
    return Number(b.balanceMinor) - Number(a.balanceMinor);
  });

  const debtRowCounts = emptyCurrencyRecord();
  for (const row of rows) {
    const currency = CURRENCIES.find((candidate) => candidate === row.currency) ?? base;
    debtRowCounts[currency] += 1;
  }
  const avgByCurrency = emptyCurrencyRecord();
  for (const currency of CURRENCIES) {
    const count = debtRowCounts[currency];
    avgByCurrency[currency] = count > 0 ? Math.round(totalDueByCurrency[currency] / count) : 0;
  }

  return {
    report: "debt",
    title: "المديونية المستحقة",
    subtitle: "أرصدة المرضى بتاريخ نهاية الفترة — من حركات الحساب المسجّلة، بكل عملة دلوها",
    periodLabel: `كما في ${formatArabicDate(asOf)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      ...moneyKpis("total", "إجمالي المديونية", totalDueByCurrency, "warn"),
      countKpi("count", "عدد صفوف المديونية", rows.length),
      ...moneyKpis("avg", "متوسط المديونية", avgByCurrency, "info"),
    ],
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "phone", label: "الهاتف" },
      { key: "currency", label: "العملة" },
      { key: "doctorName", label: "الطبيب" },
      { key: "specialtyLabel", label: "التخصص" },
      { key: "statusLabel", label: "حالة المريض" },
      { key: "planStart", label: "بداية العلاج" },
      { key: "planTitle", label: "الخطة" },
      { key: "planCurrency", label: "عملة الخطة" },
      { key: "planTotalMinor", label: "إجمالي الخطة", type: "money", currencyKey: "planCurrency" },
      { key: "planPaidMinor", label: "مدفوع الخطة", type: "money", currencyKey: "planCurrency" },
      { key: "billedMinor", label: "إجمالي المفوتر", type: "money", currencyKey: "currency" },
      { key: "paidMinor", label: "إجمالي المدفوع", type: "money", currencyKey: "currency" },
      { key: "balanceMinor", label: "المتبقي", type: "money", currencyKey: "currency" },
      { key: "lastPaymentDate", label: "آخر دفعة" },
      { key: "ageDays", label: "أيام التأخير", type: "count" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "الرصيد = الافتتاحي (بالأساس) + صافي فواتير الدلو − تسوياته (+ الاستردادات) — لكل عملة على حدة.",
      "المريض باتفاقاتٍ بعملاتٍ متعددة يظهر صفًّا لكل عملة — لا يُجمع ولا يُطرح بين الدلاء.",
      "اضغط اسم المريض لفتح كشف حسابه.",
    ],
  };
}

/** حركة المديونية الشهرية (الوضع الرابع) — رصيد أول الشهر → آخره. */
function debtMovementReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const year = Number(filters.from.slice(0, 4));
  const monthlyRows: ReportRow[] = [];
  // (P-01/D-1) الأشرطة بدلو العملة الأساسية وحده — التفصيل الكامل بكل عملة في الجدول.
  const bars: { label: string; minor: number }[] = [];

  for (let month = 1; month <= 12; month++) {
    const mFrom = `${year}-${String(month).padStart(2, "0")}-01`;
    const mTo = endOfMonth(mFrom);
    if (mFrom > filters.to) break;
    if (mTo < filters.from) continue;

    const newDebtByCurrency = emptyCurrencyRecord();
    const collectedByCurrency = emptyCurrencyRecord();
    const refundsByCurrency = emptyCurrencyRecord();
    for (const patient of ctx.movements) {
      if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
      if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;
      for (const invoice of patient.invoices) {
        if (invoice.date >= mFrom && invoice.date <= mTo) newDebtByCurrency[invoice.currency] += invoice.netMinor;
      }
      for (const payment of patient.payments) {
        if (payment.date < mFrom || payment.date > mTo) continue;
        if (payment.kind === "refund") refundsByCurrency[payment.settlementCurrency] += payment.settlementMinor;
        else collectedByCurrency[payment.settlementCurrency] += payment.settlementMinor;
      }
    }
    const openingByCurrency = balanceAsOf(ctx, addDays(mFrom, -1));
    const closingByCurrency = balanceAsOf(ctx, mTo);

    // (P-01/D-1) صفٌّ لكل (شهر × عملة نشطة) — لا عمود يمزج الدلاء.
    for (const currency of CURRENCIES) {
      const active = newDebtByCurrency[currency] !== 0 || collectedByCurrency[currency] !== 0
        || refundsByCurrency[currency] !== 0 || openingByCurrency[currency] !== 0
        || closingByCurrency[currency] !== 0;
      if (!active) continue;
      monthlyRows.push({
        monthLabel: monthName(month),
        currency,
        openingMinor: openingByCurrency[currency],
        newDebtMinor: newDebtByCurrency[currency],
        collectedMinor: collectedByCurrency[currency],
        adjustmentsMinor: refundsByCurrency[currency],
        closingMinor: closingByCurrency[currency],
      });
    }
    bars.push({ label: monthName(month), minor: closingByCurrency[base] });
  }

  const openingYear = balanceAsOf(ctx, addDays(filters.from, -1));
  const closingYear = balanceAsOf(ctx, filters.to);
  const sumByCurrency = (key: string): Record<Currency, number> => {
    // نجمع داخل الدلو فقط: كل صفٍّ يحمل عملته فتُضاف قيمته إلى دلوها.
    const result = emptyCurrencyRecord();
    for (const row of monthlyRows) {
      const currency = row.currency as Currency;
      result[currency] += Number(row[key] ?? 0);
    }
    return result;
  };

  return {
    report: "debt",
    title: "حركة المديونية الكاملة",
    subtitle: `سنة ${year} — رصيد أول المدة، ديون جديدة، تحصيل، تسويات، رصيد آخرها — لكل عملة دلوها`,
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      ...moneyKpis("opening", "مديونية أول الفترة", openingYear),
      ...moneyKpis("new", "ديون جديدة", sumByCurrency("newDebtMinor"), undefined, "warn"),
      ...moneyKpis("collected", "تحصيل ديون", sumByCurrency("collectedMinor"), undefined, "good"),
      ...moneyKpis("adj", "تسويات (استردادات)", sumByCurrency("adjustmentsMinor"), undefined, "bad"),
      ...moneyKpis("closing", "مديونية آخر الفترة", closingYear, "warn"),
    ],
    monthly: {
      columns: [
        { key: "monthLabel", label: "الشهر" },
        { key: "currency", label: "العملة" },
        { key: "openingMinor", label: "مديونية أول الشهر", type: "money", currencyKey: "currency" },
        { key: "newDebtMinor", label: "ديون جديدة", type: "money", currencyKey: "currency" },
        { key: "collectedMinor", label: "تحصيل ديون", type: "money", currencyKey: "currency" },
        { key: "adjustmentsMinor", label: "تسويات", type: "money", currencyKey: "currency" },
        { key: "closingMinor", label: "مديونية آخر الشهر", type: "money", currencyKey: "currency" },
      ],
      rows: monthlyRows,
      barKey: "closingMinor",
    },
    bars,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "رصيد أول الشهر = رصيد آخر اليوم الذي قبله (لا مجموع مستقل) — فلا يفترق الميزان.",
      "«التسويات» هنا = الاستردادات؛ قيود التسوية اليدوية على ذمم المرضى تُقرأ من دفتر اليومية.",
      "(P-01) كل شهر بصفوفٍ لعملاته النشطة — والأشرطة بدلو العملة الأساسية وحده.",
    ],
  };
}

/** مجموع أرصدة المرضى (الموجبة فقط) بتاريخ معيّن — داخل كل دلو على حدة. */
function balanceAsOf(ctx: ReportContext, date: string): Record<Currency, number> {
  const result = emptyCurrencyRecord();
  for (const patient of ctx.movements) {
    const balances = balancesByCurrencyAt(patient, date);
    for (const currency of CURRENCIES) {
      result[currency] += Math.max(0, balances[currency]);
    }
  }
  return result;
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
  // (P-01/D-1) فئات العمر بكل عملة على حدة — لا يُصنَّف دلوٌ بدلوٍ آخر.
  const bucketTotalsByCurrency = new Map<Currency, number[]>();
  for (const currency of CURRENCIES) bucketTotalsByCurrency.set(currency, AGING_BUCKETS.map(() => 0));
  const totalByCurrency = emptyCurrencyRecord();

  for (const row of filteredDebtRows(ctx, asOf)) {
    if (row.balanceMinor <= 0) continue;
    const currency = row.currency;
    totalByCurrency[currency] += row.balanceMinor;
    const bucketTotals = bucketTotalsByCurrency.get(currency) ?? AGING_BUCKETS.map(() => 0);
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
      currency,
      specialtyLabel: patientSpecialtyLabel(patient),
      statusLabel: PATIENT_STATUS_LABEL[patient.status],
      balanceMinor: row.balanceMinor,
      ...cells,
      ageDays: row.ageDays,
      oldestDate: row.oldestDate ? formatArabicDate(row.oldestDate) : "—",
    });
  }
  // (P-01/D-1) الترتيب داخل كل عملة (الأقدم دلوًّا) — العملات بترتيب الدلاء.
  rows.sort((a, b) => {
    const currencyOrder = CURRENCIES.indexOf(a.currency as Currency) - CURRENCIES.indexOf(b.currency as Currency);
    if (currencyOrder !== 0) return currencyOrder;
    return Number(b.ageDays) - Number(a.ageDays);
  });

  const kpis: KpiItem[] = [...moneyKpis("total", "إجمالي المديونية", totalByCurrency, "warn")];
  for (let i = 0; i < AGING_BUCKETS.length; i++) {
    const byCurrency = emptyCurrencyRecord();
    for (const currency of CURRENCIES) {
      byCurrency[currency] = bucketTotalsByCurrency.get(currency)?.[i] ?? 0;
    }
    kpis.push(...moneyKpis(AGING_BUCKETS[i].key, AGING_BUCKETS[i].label, byCurrency, i >= 3 ? "bad" : i >= 2 ? "warn" : "calm"));
  }

  return {
    report: "aging",
    title: "أعمار الديون",
    subtitle: "توزيع المديونية على أعمارها — من عمر أقدم دين غير مغطّى (FIFO داخل كل عملة)",
    periodLabel: `كما في ${formatArabicDate(asOf)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis,
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "phone", label: "الهاتف" },
      { key: "currency", label: "العملة" },
      { key: "specialtyLabel", label: "التخصص" },
      { key: "statusLabel", label: "حالة المريض" },
      { key: "balanceMinor", label: "الرصيد", type: "money", currencyKey: "currency" },
      { key: "b0", label: "٠–٣٠", type: "money", currencyKey: "currency" },
      { key: "b31", label: "٣١–٦٠", type: "money", currencyKey: "currency" },
      { key: "b61", label: "٦١–٩٠", type: "money", currencyKey: "currency" },
      { key: "b91", label: "٩١–١٨٠", type: "money", currencyKey: "currency" },
      { key: "b181", label: "+١٨٠", type: "money", currencyKey: "currency" },
      { key: "ageDays", label: "أيام التأخير", type: "count" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "رصيد المريض كله في فترة عمر أقدم دين غير مغطّى بدلو عملته — العرف المحاسبي في أعمار الديون.",
      "(P-01) كل صفٍّ دلو عملة: المريض بعملتين يظهر صفين، لكلٍّ عمره ورصيده.",
    ],
  };
}

// ─── التقرير حسب التخصص ──────────────────────────────────────────────────────

function specialtyReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const selected = filters.specialty;

  if (!selected) {
    const rows: ReportRow[] = [];
    const totalDebtByCurrency = emptyCurrencyRecord();
    for (const [code, label] of Object.entries(CATEGORY_LABEL)) {
      const sub = specialtyStats(ctx, code);
      for (const currency of CURRENCIES) {
        const plansValue = sub.plansValueByCurrency[currency];
        const collected = sub.collectedByCurrency[currency];
        const debt = sub.debtByCurrency[currency];
        if (sub.patients === 0 && collected === 0 && plansValue === 0) continue;
        if (plansValue === 0 && collected === 0 && debt === 0) continue;
        totalDebtByCurrency[currency] += debt;
        rows.push({
          specialtyCode: code,
          specialtyLabel: label,
          currency,
          patients: sub.patients,
          activePatients: sub.activePatients,
          newPatients: sub.newPatients,
          plansValueMinor: plansValue,
          collectedMinor: collected,
          debtMinor: debt,
          avgDebtMinor: sub.patients ? Math.round(debt / sub.patients) : 0,
          completedPlans: sub.completedPlans,
          stoppedPlans: sub.stoppedPlans,
        });
      }
    }
    // (P-01/D-1) الترتيب داخل كل عملة — لا مقارنة بين عملات.
    rows.sort((a, b) => {
      const currencyOrder = CURRENCIES.indexOf(a.currency as Currency) - CURRENCIES.indexOf(b.currency as Currency);
      if (currencyOrder !== 0) return currencyOrder;
      return Number(b.collectedMinor) - Number(a.collectedMinor);
    });

    return {
      report: "specialty",
      title: "التقرير حسب التخصص",
      subtitle: "نشاط كل تخصص وما له من تحصيل ومديونية — لكل عملة دلوها",
      periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
      from: filters.from, to: filters.to, baseCurrency: base,
      kpis: [
        countKpi("specialties", "تخصصات نشطة", new Set(rows.map((row) => row.specialtyCode)).size),
        ...moneyKpis("debt", "إجمالي مديونية مرضى التخصصات", totalDebtByCurrency, "warn",
          "مريضٌ في تخصصين يظهر في كلٍّ منهما — المجموع هنا بلا تكرار: مجموع أرصدة المرضى داخل كل عملة"),
      ],
      columns: [
        { key: "specialtyLabel", label: "التخصص" },
        { key: "currency", label: "العملة" },
        { key: "patients", label: "المرضى", type: "count" },
        { key: "activePatients", label: "نشطون", type: "count" },
        { key: "newPatients", label: "جدد", type: "count" },
        { key: "plansValueMinor", label: "قيمة الخطط", type: "money", currencyKey: "currency" },
        { key: "collectedMinor", label: "التحصيل", type: "money", currencyKey: "currency" },
        { key: "debtMinor", label: "المديونية", type: "money", currencyKey: "currency" },
        { key: "avgDebtMinor", label: "متوسط مديونية المريض", type: "money", currencyKey: "currency" },
        { key: "completedPlans", label: "خطط منتهية", type: "count" },
        { key: "stoppedPlans", label: "خطط متوقفة", type: "count" },
      ],
      rows,
      filtersLabel: filtersLabelOf(filters, doctors),
      notes: [
        "اضغط اسم التخصص لعرض مرضاه في تقرير المديونية.",
        "(P-01) التخصص بعملتين يظهر سطرين — قيمة خططه وتحصيله ومديونيته داخل كل عملة.",
      ],
    };
  }

  // تخصص واحد: إحصاءاته + مرضاه (صفٌّ لكل مريض × عملة نشطة).
  const sub = specialtyStats(ctx, selected);
  const patientRows: ReportRow[] = [];
  for (const patient of ctx.movements) {
    if (!patientHasSpecialty(patient, selected)) continue;
    const balances = balancesByCurrencyAt(patient, filters.to);
    const oldest = oldestUnpaidByCurrency(patient, filters.to);
    for (const currency of CURRENCIES) {
      if (balances[currency] === 0) continue;
      patientRows.push({
        patientId: patient.patientId,
        patientName: patient.name,
        patientNumber: patient.patientNumber,
        currency,
        statusLabel: PATIENT_STATUS_LABEL[patient.status],
        balanceMinor: Math.max(0, balances[currency]),
        ageDays: oldest[currency].ageDays,
      });
    }
  }
  patientRows.sort((a, b) => {
    const currencyOrder = CURRENCIES.indexOf(a.currency as Currency) - CURRENCIES.indexOf(b.currency as Currency);
    if (currencyOrder !== 0) return currencyOrder;
    return Number(b.balanceMinor) - Number(a.balanceMinor);
  });
  const avgDebtByCurrency = emptyCurrencyRecord();
  for (const currency of CURRENCIES) {
    avgDebtByCurrency[currency] = sub.patients ? Math.round(sub.debtByCurrency[currency] / sub.patients) : 0;
  }

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
      ...moneyKpis("plans", "قيمة خطط العلاج", sub.plansValueByCurrency),
      ...moneyKpis("collected", "التحصيل", sub.collectedByCurrency, "good"),
      ...moneyKpis("debt", "المديونية", sub.debtByCurrency, "warn"),
      ...moneyKpis("avgDebt", "متوسط مديونية المريض", avgDebtByCurrency),
      countKpi("completed", "حالات انتهت", sub.completedPlans),
      countKpi("stopped", "حالات متوقفة", sub.stoppedPlans, "bad"),
    ],
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "currency", label: "العملة" },
      { key: "statusLabel", label: "الحالة" },
      { key: "balanceMinor", label: "الرصيد", type: "money", currencyKey: "currency" },
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
  const plansValueByCurrency = emptyCurrencyRecord();
  const collectedByCurrency = emptyCurrencyRecord();
  const debtByCurrency = emptyCurrencyRecord();
  let completedPlans = 0;
  let stoppedPlans = 0;

  for (const patient of ctx.movements) {
    if (!patientHasSpecialty(patient, code)) continue;
    patients++;
    if (patient.status === "active") activePatients++;
    if (patient.createdDate && patient.createdDate >= filters.from && patient.createdDate <= filters.to) newPatients++;
    for (const plan of patient.plans) {
      if (plan.categories.includes(code)) {
        // (P-01/D-1) قيمة الخطة بعملة اتفاقها.
        plansValueByCurrency[plan.currency] += plan.totalMinor;
        if (plan.status === "completed") completedPlans++;
        if (plan.status === "stopped") stoppedPlans++;
      }
    }
    for (const payment of patient.payments) {
      if (payment.date >= filters.from && payment.date <= filters.to) {
        collectedByCurrency[payment.settlementCurrency] += payment.kind === "refund"
          ? -payment.settlementMinor
          : payment.settlementMinor;
      }
    }
    const balances = balancesByCurrencyAt(patient, filters.to);
    for (const currency of CURRENCIES) {
      debtByCurrency[currency] += Math.max(0, balances[currency]);
    }
  }
  return { patients, activePatients, newPatients, plansValueByCurrency, collectedByCurrency, debtByCurrency, completedPlans, stoppedPlans };
}

// ─── التقرير حسب الطبيب ──────────────────────────────────────────────────────

function doctorReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors, commissions } = ctx;
  const rows: ReportRow[] = [];
  const engineRow = (doctorId: number, currency: Currency) =>
    ctx.commissionRows?.find((row) => row.doctorId === doctorId && row.currency === currency);

  for (const [doctorId, doctorName] of doctors) {
    if (filters.doctorId && doctorId !== filters.doctorId) continue;
    let patientCount = 0;
    let newPatients = 0;
    let procedures = 0;
    const workByCurrency = emptyCurrencyRecord();
    const collectedByCurrency = emptyCurrencyRecord();
    const debtByCurrency = emptyCurrencyRecord();

    for (const patient of ctx.movements) {
      if (!patientHasDoctor(patient, doctorId)) continue;
      patientCount++;
      if (patient.createdDate && patient.createdDate >= filters.from && patient.createdDate <= filters.to) newPatients++;
      for (const invoice of patient.invoices) {
        if (invoice.date < filters.from || invoice.date > filters.to) continue;
        if (invoice.doctorIds.includes(doctorId)) {
          procedures += invoice.items.length;
          // (P-01/D-1) قيمة أعماله بعملة كل فاتورة — على مستوى البند.
          workByCurrency[invoice.currency] += invoice.netMinor;
        }
      }
      for (const payment of patient.payments) {
        if (payment.date < filters.from || payment.date > filters.to) continue;
        collectedByCurrency[payment.settlementCurrency] += payment.kind === "refund"
          ? -payment.settlementMinor
          : payment.settlementMinor;
      }
      const balances = balancesByCurrencyAt(patient, filters.to);
      for (const currency of CURRENCIES) {
        debtByCurrency[currency] += Math.max(0, balances[currency]);
      }
    }
    if (patientCount === 0 && procedures === 0) continue;

    // صفٌّ لكل (طبيب × عملة نشطة) — والمستحق من محرّك العمولات داخل العملة نفسها.
    for (const currency of CURRENCIES) {
      const workMinor = workByCurrency[currency];
      const collectedMinor = collectedByCurrency[currency];
      const debtMinor = debtByCurrency[currency];
      if (workMinor === 0 && collectedMinor === 0 && debtMinor === 0) continue;
      const fromEngine = engineRow(doctorId, currency);
      const commission = fromEngine?.commissionPercent ?? commissions.get(doctorId) ?? 0;
      const duesMinor = fromEngine?.netEarnedMinor ?? 0;
      rows.push({
        doctorId,
        doctorName,
        currency,
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
  }
  // (P-01/D-1) الترتيب داخل كل عملة — العملات بترتيب الدلاء.
  rows.sort((a, b) => {
    const currencyOrder = CURRENCIES.indexOf(a.currency as Currency) - CURRENCIES.indexOf(b.currency as Currency);
    if (currencyOrder !== 0) return currencyOrder;
    return Number(b.workMinor) - Number(a.workMinor);
  });

  const sumColumn = (key: string): Record<Currency, number> => {
    // نجمع داخل الدلو: كل صفٍّ يحمل عملته.
    const result = emptyCurrencyRecord();
    for (const row of rows) result[row.currency as Currency] += Number(row[key] ?? 0);
    return result;
  };

  return {
    report: "doctor",
    title: "التقرير حسب الطبيب",
    subtitle: "إنتاجية كل طبيب وتحصيل مرضاه ومستحقاته — للصلاحية المالية فقط، لكل عملة دلوها",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("doctors", "أطباء نشطون", new Set(rows.map((row) => row.doctorId)).size),
      ...moneyKpis("work", "قيمة الأعمال", sumColumn("workMinor")),
      ...moneyKpis("collected", "تحصيل مرضاهم", sumColumn("collectedMinor"), "good"),
      ...moneyKpis("dues", "مستحقات الأطباء (عمولات)", sumColumn("duesMinor"), "info",
        "من محرّك العمولات: التحصيل الفعلي بعد خصم المختبر، بالنسبة السارية وقت التحصيل"),
    ],
    columns: [
      { key: "doctorName", label: "الطبيب" },
      { key: "currency", label: "العملة" },
      { key: "patients", label: "مرضاه", type: "count" },
      { key: "newPatients", label: "جدد", type: "count" },
      { key: "procedures", label: "إجراءاته", type: "count" },
      { key: "workMinor", label: "قيمة أعماله", type: "money", currencyKey: "currency" },
      { key: "collectedMinor", label: "المحصّل من مرضاه", type: "money", currencyKey: "currency" },
      { key: "debtMinor", label: "مديونية مرضاه", type: "money", currencyKey: "currency" },
      { key: "commissionPercent", label: "نسبة العمولة", type: "percent" },
      { key: "duesMinor", label: "مستحق الطبيب", type: "money", currencyKey: "currency" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "«قيمة أعماله» من بنود الفواتير المسجلة باسمه على مستوى البند — فاتورة بطبيبين تُحتسب لكلٍّ على عمله.",
      "(P-01) الطبيب بعملتين يظهر سطرين — أعماله ومستحقاته داخل كل عملة، والعمولة نسبةٌ تُطبَّق داخل الدلو.",
    ],
  };
}

// ─── تقرير التحصيل ──────────────────────────────────────────────────────────

function collectionsReport(ctx: ReportContext, caller = "collections"): ReportResult {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;

  // (P-01/D-1) التصنيف (جديد/سابق) داخل كل دلو — الدفعة تسوّي دلوها فتُصنَّف فيه.
  const newByCurrency = emptyCurrencyRecord();
  const oldByCurrency = emptyCurrencyRecord();
  const totalsByCurrency = emptyCurrencyRecord();
  // الاستردادات بمكافئها الأساسي المسجَّل (عقد الدفعات) — عملة الأساس وحدها.
  let refundsMinor = 0;
  const actualByCurrency: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };
  const rows: ReportRow[] = [];

  for (const patient of ctx.movements) {
    if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;

    const classified = classifyPaymentsByCurrency(patient, from, to);
    for (const currency of CURRENCIES) {
      oldByCurrency[currency] += classified[currency].oldMinor;
      newByCurrency[currency] += classified[currency].newMinor;
      totalsByCurrency[currency] += classified[currency].oldMinor + classified[currency].newMinor;
    }

    for (const payment of patient.payments) {
      if (payment.date < from || payment.date > to) continue;
      if (filters.currency !== "all" && payment.currency !== filters.currency) continue;
      if (filters.method && payment.method !== filters.method) continue;
      if (filters.receivedBy && payment.createdBy !== filters.receivedBy) continue;

      const signed = payment.kind === "refund" ? -payment.baseMinor : payment.baseMinor;
      if (payment.kind === "refund") refundsMinor += payment.baseMinor;
      actualByCurrency[payment.currency] += payment.kind === "refund" ? -payment.amountMinor : payment.amountMinor;

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
    ...moneyKpis("total", "إجمالي التحصيل", totalsByCurrency, "good"),
    ...moneyKpis("new", "تحصيل جديد", newByCurrency, "info", "ما غطّى خدمات الفترة نفسها داخل دلو عملته"),
    ...moneyKpis("old", "تحصيل مديونية سابقة", oldByCurrency, "warn", "ما غطّى أرصدةً سابقة لبداية الفترة (FIFO داخل كل عملة)"),
    moneyKpi("refunds", "استردادات (مكافئ أساسي)", refundsMinor, base, "bad",
      "المسترد بمكافئه الأساسي المسجَّل بسعر يومه — عقد الدفعات، لا تحويل فواتير"),
  ];
  for (const [currency, amount] of Object.entries(actualByCurrency) as [Currency, number][]) {
    if (amount === 0) continue;
    kpis.push({ key: `cur-${currency}`, label: `${currency} (فعلي)`, count: amount, tone: "calm", hint: "مجموع ما قُبض بعملته كما دخل الدرج" });
  }

  return {
    report: caller === "debt" ? "debt" : "collections",
    title: caller === "debt" ? "تحصيل المديونيات خلال الفترة" : "تقرير التحصيل",
    subtitle: "قيمة الخدمات ≠ التحصيل الفعلي — هنا التحصيل وحده، مفصولًا جديدًا عن سابق، بكل عملة دلوها",
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
      "تصنيف جديد/سابق على FIFO داخل كل عملة: الدفعة تُغطّي أقدم رصيد دلوها أولًا.",
      "أرقام العملات «الفعليّة» بالوحدات الكبرى كما قُبضت — لا تُجمع عملات في رقم واحد.",
    ],
  };
}

// ─── تقارير الخدمات والإجراءات ──────────────────────────────────────────────

function servicesReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  /* (تقارير R1) من بنود الفاتورة نفسها: العدد = مجموع الكميات، والقيمة = نصيب البند
     من صافي الفاتورة. كانت تُقسم الفاتورة على «أوصافها المختلفة» فيضيع بندٌ متكرر
     وتُوزَّع القيمة بالتساوي. والطبيب والتخصص والخدمة بفلاتر البند نفسه. */
  const totals = new Map<string, {
    name: string; currency: Currency; count: number; totalMinor: number; patients: Set<number>;
  }>();

  for (const patient of ctx.movements) {
    for (const invoice of patient.invoices) {
      if (invoice.date < filters.from || invoice.date > filters.to) continue;
      for (const line of invoice.lines) {
        if (filters.doctorId && line.doctorId !== filters.doctorId) continue;
        if (filters.specialty && line.category !== filters.specialty) continue;
        if (filters.serviceId && line.serviceId !== filters.serviceId) continue;
        const key = `${line.serviceId ?? `d:${line.description}`}::${invoice.currency}`;
        const entry = totals.get(key) ?? {
          name: line.description, currency: invoice.currency, count: 0, totalMinor: 0, patients: new Set<number>(),
        };
        entry.count += line.quantity;
        entry.totalMinor += line.netMinor;
        entry.patients.add(patient.patientId);
        totals.set(key, entry);
      }
    }
  }

  const rows: ReportRow[] = [...totals.values()]
    .map((entry) => ({
      serviceName: entry.name,
      currency: entry.currency,
      count: entry.count,
      patients: entry.patients.size,
      totalMinor: entry.totalMinor,
    }))
    // (P-01/D-1) الترتيب داخل العملة — العملات بترتيب الدلاء، لا مقارنة بينها.
    .sort((a, b) => {
      const currencyOrder = CURRENCIES.indexOf(a.currency as Currency) - CURRENCIES.indexOf(b.currency as Currency);
      if (currencyOrder !== 0) return currencyOrder;
      return Number(b.totalMinor) - Number(a.totalMinor);
    });

  const valueByCurrency = emptyCurrencyRecord();
  for (const row of rows) valueByCurrency[row.currency as Currency] += Number(row.totalMinor);

  return {
    report: "services",
    title: "تقارير الخدمات والإجراءات",
    subtitle: "ما أُنجز فعلًا من خدمات خلال الفترة وقيمته — لكل عملة دلوها",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("services", "خدمات منجزة", rows.reduce((s, r) => s + Number(r.count), 0)),
      ...moneyKpis("value", "قيمة الخدمات", valueByCurrency),
    ],
    columns: [
      { key: "serviceName", label: "الخدمة" },
      { key: "currency", label: "العملة" },
      { key: "count", label: "العدد", type: "count" },
      { key: "patients", label: "المرضى", type: "count" },
      { key: "totalMinor", label: "القيمة", type: "money", currencyKey: "currency" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "العدد مجموع كميات البنود، والقيمة نصيب البند من صافي فاتورته بعد الخصم.",
      "الخدمة نفسها بعملتين سطران بعملتيهما — لا يُجمع ولا يُرتَّب عبر العملات.",
    ],
  };
}

// ─── سجل الزيارات (تقارير R1) ──────────────────────────────────────────────

const VISIT_STATUS_LABEL: Record<string, string> = {
  waiting: "في الانتظار", called: "نودي", in_chair: "على الكرسي", done: "منتهية",
};

function clinicTime(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const minutes = Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
  return minutes >= 0 ? minutes : null;
}

function moneyRecordText(record: Record<Currency, number>): string {
  const parts = CURRENCIES.filter((currency) => record[currency] !== 0)
    .map((currency) => formatMoney(record[currency], currency));
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * (تقارير R1 — RPT-03) «من زار المركز»: كل زيارةٍ من سجل الزيارات نفسه، بفاتورةٍ أو
 * بدونها — بأوقات الوصول والنداء والجلوس والانتهاء، ومدة الانتظار والجلسة، والطبيب،
 * وهل فُوترت وحُصّلت. يعمل ليومٍ أو أسبوعٍ أو شهرٍ أو فترةٍ مخصّصة.
 */
function visitsReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const visits = visitsInRange(ctx, filters.from, filters.to);
  const invoiceById = invoiceIndex(ctx);
  const byPatient = movementIndex(ctx);
  const rows: ReportRow[] = [];
  let waitTotal = 0; let waitCount = 0;
  let sessionTotal = 0; let sessionCount = 0;
  let invoiced = 0; let completed = 0; let firstVisits = 0;

  for (const visit of visits) {
    const invoice = visit.invoiceId !== null ? invoiceById.get(visit.invoiceId) : undefined;
    const patient = visit.patientId !== null ? byPatient.get(visit.patientId) : undefined;
    const waitMinutes = minutesBetween(visit.arrivedAt, visit.seatedAt);
    const sessionMinutes = minutesBetween(visit.seatedAt, visit.finishedAt);
    if (waitMinutes !== null) { waitTotal += waitMinutes; waitCount++; }
    if (sessionMinutes !== null) { sessionTotal += sessionMinutes; sessionCount++; }
    if (invoice) invoiced++;
    if (visit.status === "done") completed++;
    if (visit.firstVisit) firstVisits++;

    let collection = "—";
    if (invoice && patient) {
      const paid = patient.payments
        .filter((payment) => payment.invoiceId === invoice.id && payment.settlementCurrency === invoice.currency)
        .reduce((sum, payment) => sum + (payment.kind === "refund" ? -payment.settlementMinor : payment.settlementMinor), 0);
      collection = invoice.netMinor === 0 ? "بلا قيمة"
        : paid >= invoice.netMinor ? "مسدَّدة"
          : paid > 0 ? `جزئي (${formatMoney(paid, invoice.currency)})` : "غير محصّلة";
    }
    const categories = invoice ? [...new Set(invoice.lines.map((line) => line.category).filter(Boolean))] as string[] : [];

    rows.push({
      patientId: visit.patientId,
      visitDate: formatArabicDate(visit.date),
      arrivedTime: clinicTime(visit.arrivedAt),
      patientNumber: visit.patientNumber ?? "—",
      patientName: visit.patientName,
      phone: visit.phone ?? "—",
      kind: visit.firstVisit ? "مراجع جديد" : visit.patientId === null ? "بلا ملف" : "مراجع سابق",
      doctorName: visit.doctorId ? (doctors.get(visit.doctorId) ?? "—") : "—",
      specialtyLabel: categories.length ? categories.map((c) => CATEGORY_LABEL[c] ?? c).join("، ") : "—",
      appointment: visit.appointmentId ? "بموعد" : "بدون موعد",
      calledTime: clinicTime(visit.calledAt),
      seatedTime: clinicTime(visit.seatedAt),
      finishedTime: clinicTime(visit.finishedAt),
      waitMinutes: waitMinutes ?? "—",
      sessionMinutes: sessionMinutes ?? "—",
      statusLabel: VISIT_STATUS_LABEL[visit.status] ?? visit.status,
      services: invoice && invoice.lines.length ? invoice.lines.map((line) => line.description).join("، ") : "—",
      invoiceText: invoice ? formatMoney(invoice.netMinor, invoice.currency) : "بلا فاتورة",
      collection,
    });
  }

  return {
    report: "visits",
    title: "سجل الزيارات",
    subtitle: "كل زيارةٍ للمركز من سجل الزيارات نفسه — بفاتورةٍ أو بدونها",
    periodLabel: filters.from === filters.to
      ? formatArabicDate(filters.from)
      : `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("visits", "الزيارات", visits.length),
      countKpi("visitedPatients", "المرضى المراجعون", new Set(visits.map((visit) => visit.patientId ?? -visit.id)).size),
      countKpi("firstVisits", "مراجعون جدد", firstVisits, "good"),
      countKpi("completed", "زيارات منتهية", completed),
      countKpi("invoiced", "زيارات مفوترة", invoiced),
      countKpi("notInvoiced", "زيارات بلا فاتورة", visits.length - invoiced, visits.length - invoiced > 0 ? "warn" : "calm"),
      { key: "avgWait", label: "متوسط الانتظار (دقيقة)", text: waitCount ? String(Math.round(waitTotal / waitCount)) : "—" },
      { key: "avgSession", label: "متوسط الجلسة (دقيقة)", text: sessionCount ? String(Math.round(sessionTotal / sessionCount)) : "—" },
    ],
    columns: [
      { key: "visitDate", label: "التاريخ" },
      { key: "arrivedTime", label: "الوصول" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "phone", label: "الهاتف" },
      { key: "kind", label: "جديد/سابق" },
      { key: "doctorName", label: "الطبيب" },
      { key: "specialtyLabel", label: "التخصص" },
      { key: "appointment", label: "الموعد" },
      { key: "calledTime", label: "النداء" },
      { key: "seatedTime", label: "الجلوس" },
      { key: "finishedTime", label: "الانتهاء" },
      { key: "waitMinutes", label: "الانتظار (د)" },
      { key: "sessionMinutes", label: "الجلسة (د)" },
      { key: "statusLabel", label: "الحالة" },
      { key: "services", label: "الخدمات" },
      { key: "invoiceText", label: "الفاتورة" },
      { key: "collection", label: "التحصيل" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "الطبيب طبيب الزيارة نفسها؛ و«مراجع جديد» أول زيارةٍ مسجّلة للمريض في السجل كله.",
      "التحصيل: ما سُدّد من فاتورة الزيارة بعملتها.",
    ],
  };
}

// ─── تقارير المرضى ──────────────────────────────────────────────────────────

/**
 * (تقارير R1 — RPT-01) المرضى الجدد: **كل** مريضٍ سُجّل في الفترة (patients.created_at)
 * — دفع أو لم يدفع، فُوتر أو لم يُفوتر. كان المريض بلا فاتورةٍ ولا دفعة يُسقَط.
 * والأعمدة المالية معلومةٌ إضافية بعملاتها، لا شرطٌ للظهور.
 */
function doctorCommissionStatementReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const source = ctx.commissionRows ?? [];
  const filtered = filters.doctorId
    ? source.filter((row) => row.doctorId === filters.doctorId)
    : source;

  const accrued = emptyCurrencyRecord();
  const earned = emptyCurrencyRecord();
  const paid = emptyCurrencyRecord();
  const due = emptyCurrencyRecord();
  const rows: ReportRow[] = [];

  for (const row of filtered) {
    accrued[row.currency] += row.accruedMinor;
    earned[row.currency] += row.earnedMinor;
    paid[row.currency] += row.paidMinor;
    due[row.currency] += row.dueMinor;
    rows.push({
      doctorId: row.doctorId,
      doctorName: row.doctorName,
      currency: row.currency,
      commissionPercent: row.commissionPercent,
      accruedMinor: row.accruedMinor,
      earnedMinor: row.earnedMinor,
      paidMinor: row.paidMinor,
      dueMinor: row.dueMinor,
      statusLabel: row.dueMinor > 0 ? "مستحق للصرف" : row.dueMinor < 0 ? "مصروف بزيادة" : "مسدّد",
    });
  }

  rows.sort((a, b) =>
    String(a.doctorName).localeCompare(String(b.doctorName), "ar")
    || String(a.currency).localeCompare(String(b.currency)));

  return {
    report: "doctor-commission",
    title: filters.doctorId ? "كشف عمولة الطبيب" : "كشف عمولات الأطباء",
    subtitle: "من محرك العمولات الكانوني: التحصيل الفعلي، التكلفة، المصروف، وصافي المستحق — دون صيغة حساب موازية",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from,
    to: filters.to,
    baseCurrency: base,
    kpis: [
      ...moneyKpis("accrued", "الإنتاج المفوتر", accrued),
      ...moneyKpis("earned", "العمولة المكتسبة", earned, "good"),
      ...moneyKpis("paid", "المصروف للأطباء", paid, "info"),
      ...moneyKpis("due", "صافي المستحق", due, "warn"),
      countKpi("doctors", "الأطباء", new Set(filtered.map((row) => row.doctorId)).size),
    ],
    columns: [
      { key: "doctorName", label: "الطبيب" },
      { key: "currency", label: "العملة" },
      { key: "commissionPercent", label: "النسبة %", type: "percent" },
      { key: "accruedMinor", label: "الإنتاج المفوتر", type: "money", currencyKey: "currency" },
      { key: "earnedMinor", label: "العمولة المكتسبة", type: "money", currencyKey: "currency" },
      { key: "paidMinor", label: "المصروف", type: "money", currencyKey: "currency" },
      { key: "dueMinor", label: "الصافي المستحق", type: "money", currencyKey: "currency" },
      { key: "statusLabel", label: "الحالة" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "المبالغ لا تُجمع بين العملات؛ كل عملة دفتر مستقل.",
      "المصدر هو commissionReport نفسه المستخدم في شاشة المالية، لذلك لا توجد معادلة عمولة ثانية داخل مركز التقارير.",
      "القيمة السالبة في صافي المستحق تعني أن الطبيب صُرف له أكثر من المستحق وتبقى كمديونية عليه ولا تُصفّر.",
    ],
    actions: [
      { label: "إدارة عمولات الأطباء", href: "/finance/commissions" },
    ],
  };
}

// ─── تقرير المرضى الجدد ─────────────────────────────────────────────────────

function patientsReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const rows: ReportRow[] = [];
  const billedByCurrency = emptyCurrencyRecord();
  const balanceByCurrency = emptyCurrencyRecord();
  let withoutFinance = 0;
  let withVisit = 0;
  const visitsByPatient = new Map<number, ReportVisit[]>();
  for (const visit of visitsInRange(ctx, filters.from, filters.to)) {
    if (visit.patientId === null) continue;
    const list = visitsByPatient.get(visit.patientId) ?? [];
    list.push(visit);
    visitsByPatient.set(visit.patientId, list);
  }

  for (const patient of ctx.movements) {
    if (filters.specialty && !patientHasSpecialty(patient, filters.specialty)) continue;
    if (filters.doctorId && !patientHasDoctor(patient, filters.doctorId)) continue;
    if (!patient.createdDate || patient.createdDate < filters.from || patient.createdDate > filters.to) continue;
    if (filters.serviceId && !patient.invoices.some((invoice) =>
      invoice.date >= filters.from && invoice.date <= filters.to
      && invoice.lines.some((line) => line.serviceId === filters.serviceId))) continue;

    const billed = emptyCurrencyRecord();
    const paid = emptyCurrencyRecord();
    for (const invoice of patient.invoices) billed[invoice.currency] += invoice.netMinor;
    for (const payment of patient.payments) {
      paid[payment.settlementCurrency] += payment.kind === "refund" ? -payment.settlementMinor : payment.settlementMinor;
    }
    const balances = balancesByCurrencyAt(patient, filters.to);
    const balance = emptyCurrencyRecord();
    for (const currency of CURRENCIES) {
      balance[currency] = Math.max(0, balances[currency]);
      billedByCurrency[currency] += billed[currency];
      balanceByCurrency[currency] += balance[currency];
    }
    const hasFinance = patient.invoices.length > 0 || patient.payments.length > 0;
    if (!hasFinance) withoutFinance++;
    const periodVisits = visitsByPatient.get(patient.patientId) ?? [];
    if (periodVisits.length > 0) withVisit++;
    const firstVisit = periodVisits[0];

    rows.push({
      patientId: patient.patientId,
      patientName: patient.name,
      patientNumber: patient.patientNumber,
      phone: patient.phone ?? "—",
      createdDate: formatArabicDate(patient.createdDate),
      createdSort: patient.createdDate,
      statusLabel: PATIENT_STATUS_LABEL[patient.status],
      visits: periodVisits.length,
      firstVisit: firstVisit ? formatArabicDate(firstVisit.date) : "—",
      doctorName: firstVisit?.doctorId ? (doctors.get(firstVisit.doctorId) ?? "—") : mainDoctorName(patient, doctors),
      specialtyLabel: patientSpecialtyLabel(patient),
      billedText: moneyRecordText(billed),
      paidText: moneyRecordText(paid),
      balanceText: moneyRecordText(balance),
      financeLabel: hasFinance ? "نعم" : "لا حركة مالية بعد",
    });
  }
  rows.sort((a, b) => String(b.createdSort).localeCompare(String(a.createdSort)));

  return {
    report: "patients",
    title: "تقارير المرضى — المرضى الجدد",
    subtitle: "كل مريضٍ سُجّل خلال الفترة — دفع أو لم يدفع",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("new", "مرضى جدد", rows.length, "good"),
      countKpi("newWithVisit", "زاروا المركز في الفترة", withVisit),
      countKpi("newWithoutFinance", "بلا حركة مالية بعد", withoutFinance, withoutFinance > 0 ? "info" : "calm"),
      ...moneyKpis("billed", "قيمة تعاملهم", billedByCurrency),
      ...moneyKpis("balance", "أرصدتهم الآن", balanceByCurrency, "warn"),
    ],
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "phone", label: "الهاتف" },
      { key: "createdDate", label: "تاريخ التسجيل" },
      { key: "statusLabel", label: "الحالة" },
      { key: "visits", label: "زيارات الفترة", type: "count" },
      { key: "firstVisit", label: "أول زيارة" },
      { key: "doctorName", label: "الطبيب" },
      { key: "specialtyLabel", label: "التخصص" },
      { key: "billedText", label: "قيمة التعامل" },
      { key: "paidText", label: "المدفوع" },
      { key: "balanceText", label: "الرصيد" },
      { key: "financeLabel", label: "حركة مالية" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: ["الأعمدة المالية بعملاتها — لا يُجمع بين عملات. والمريض يظهر وإن لم تكن له حركة مالية."],
  };
}

// ─── كشف حساب مريض (داخل المركز) ─────────────────────────────────────────────

function patientStatementReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors } = ctx;
  const patient = ctx.movements.find((p) => p.patientId === filters.patientId);
  if (!patient) throw new ReportInputError("المريض غير موجود.");

  // (P-01/D-1) كشف الحساب دفاترُ فرعية بكل عملة: مدين/دائن/رصيد جارٍ داخل
  // الدلو — لا يُطرح دفعُ دلوٍ من فواتير دلوٍ آخر.
  const grossByCurrency = emptyCurrencyRecord();
  const billedByCurrency = emptyCurrencyRecord();
  const paidByCurrency = emptyCurrencyRecord();
  const refundsByCurrency = emptyCurrencyRecord();
  const balanceByCurrency = emptyCurrencyRecord();
  for (const invoice of patient.invoices) {
    grossByCurrency[invoice.currency] += invoice.totalMinor;
    billedByCurrency[invoice.currency] += invoice.netMinor;
  }
  for (const payment of patient.payments) {
    if (payment.kind === "refund") refundsByCurrency[payment.settlementCurrency] += payment.settlementMinor;
    else paidByCurrency[payment.settlementCurrency] += payment.settlementMinor;
  }
  const discountsByCurrency = emptyCurrencyRecord();
  for (const currency of CURRENCIES) {
    discountsByCurrency[currency] = grossByCurrency[currency] - billedByCurrency[currency];
    balanceByCurrency[currency] = balancesByCurrencyAt(patient, filters.to)[currency];
  }
  const lastPayment = patient.payments.filter((p) => p.kind !== "refund").pop() ?? null;

  // أحداث الكشف موسومة بدلو عملتها — رصيدٌ جارٍ لكل دلوٍ على حدة.
  const events: { date: string; description: string; currency: Currency; debit: number; credit: number }[] = [];
  if (patient.opening) {
    events.push({
      date: patient.opening.date, description: "رصيد افتتاحي (قبل تشغيل النظام)",
      currency: CLINIC_BASE_CURRENCY, debit: patient.opening.minor, credit: 0,
    });
  }
  for (const invoice of patient.invoices) {
    events.push({
      date: invoice.date,
      description: invoice.items.length > 0 ? invoice.items.join("، ") : `فاتورة #${invoice.id}`,
      currency: invoice.currency,
      debit: invoice.netMinor,
      credit: 0,
    });
  }
  for (const payment of patient.payments) {
    if (payment.kind === "refund") {
      events.push({
        date: payment.date, description: `استرداد ${payment.amountMinor} ${payment.currency}`,
        currency: payment.settlementCurrency, debit: payment.settlementMinor, credit: 0,
      });
    } else {
      events.push({
        date: payment.date,
        description: `دفعة ${payment.amountMinor} ${payment.currency}${payment.method === "transfer" ? " (حوالة)" : ""}`,
        currency: payment.settlementCurrency,
        debit: 0,
        credit: payment.settlementMinor,
      });
    }
  }
  // ترتيب: العملة أولًا (الأساس ثم البقية) ثم التاريخ داخل الدلو — دفترٌ لكل عملة.
  events.sort((a, b) => {
    const currencyOrder = CURRENCIES.indexOf(a.currency) - CURRENCIES.indexOf(b.currency);
    if (currencyOrder !== 0) return currencyOrder;
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return a.description.localeCompare(b.description);
  });

  const runningByCurrency = emptyCurrencyRecord();
  const ledgerRows: ReportRow[] = events.map((event) => {
    runningByCurrency[event.currency] += event.debit - event.credit;
    return {
      currency: event.currency,
      date: formatArabicDate(event.date),
      description: event.description,
      debitMinor: event.debit,
      creditMinor: event.credit,
      balanceMinor: runningByCurrency[event.currency],
    };
  });

  return {
    report: "patient-statement",
    title: "كشف حساب المريض",
    subtitle: `${patient.name} — ملف ${patient.patientNumber}${patient.phone ? ` — ${patient.phone}` : ""}`,
    periodLabel: `من فتح الملف حتى ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      ...moneyKpis("treatment", "إجمالي قيمة العلاج", grossByCurrency),
      ...moneyKpis("discounts", "إجمالي الخصومات", discountsByCurrency, "info"),
      ...moneyKpis("paid", "إجمالي ما دُفع", paidByCurrency, "good"),
      ...moneyKpis("refunds", "المرتجعات", refundsByCurrency, "bad"),
      ...moneyKpis("balance", "الرصيد المتبقي", balanceByCurrency, balanceByCurrency[base] > 0 ? "warn" : "good"),
      { key: "lastPayment", label: "آخر دفعة", text: lastPayment ? formatArabicDate(lastPayment.date) : "—" },
      { key: "lastVisit", label: "آخر زيارة", text: patient.lastVisitDate ? formatArabicDate(patient.lastVisitDate) : "—" },
    ],
    columns: [
      { key: "currency", label: "العملة" },
      { key: "date", label: "التاريخ" },
      { key: "description", label: "البيان" },
      { key: "debitMinor", label: "مدين", type: "money", currencyKey: "currency" },
      { key: "creditMinor", label: "دائن", type: "money", currencyKey: "currency" },
      { key: "balanceMinor", label: "الرصيد", type: "money", currencyKey: "currency" },
    ],
    rows: ledgerRows,
    actions: [
      { label: "نسخة الطباعة الرسمية", href: `/print/statement/${patient.patientId}` },
      { label: "ملف المريض الكامل", href: `/patients/${patient.patientId}` },
    ],
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "الرصيد = الافتتاحي (بالأساس) + صافي فواتير الدلو − تسوياته. الخصم داخل صافي الفاتورة.",
      "(P-01) الكشف دفاتر فرعية بكل عملة — رصيدٌ جارٍ لكل دلو، لا يمتد لدلوٍ آخر.",
    ],
  };
}



// ─── المواعيد ────────────────────────────────────────────────────────────────

const APPOINTMENT_STATUS_LABEL: Record<string, string> = {
  booked: "محجوز",
  arrived: "وصل",
  done: "تمّت",
  cancelled: "ملغي",
  no_show: "لم يحضر",
};

async function appointmentsReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { rows } = await getPool().query<{
    id: number; patient_id: number; patient_name: string; patient_number: string;
    date: string; time: string; duration_minutes: number; status: string;
    doctor_name: string | null; service_name: string | null; specialty: string | null;
    patient_confirmed: boolean;
  }>(
    `SELECT a.id, a.patient_id, p.full_name AS patient_name, p.patient_number,
            a.scheduled_date::text AS date, LEFT(a.scheduled_time::text, 5) AS time,
            a.duration_minutes, a.status, d.name AS doctor_name,
            COALESCE(s.name_ar, a.appointment_type) AS service_name,
            s.specialty,
            (a.patient_confirmed_at IS NOT NULL) AS patient_confirmed
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN parties d ON d.id = a.doctor_id
       LEFT JOIN appointment_services s ON s.id = a.service_id
      WHERE a.scheduled_date BETWEEN $1::date AND $2::date
        AND ($3::int IS NULL OR a.doctor_id = $3::int)
        AND ($4::int IS NULL OR a.patient_id = $4::int)
        AND ($5::text IS NULL OR s.specialty = $5::text)
      ORDER BY a.scheduled_date, a.scheduled_time, a.id`,
    [filters.from, filters.to, filters.doctorId, filters.patientId, filters.specialty],
  );

  const done = rows.filter((row) => row.status === "done").length;
  const noShow = rows.filter((row) => row.status === "no_show").length;
  const cancelled = rows.filter((row) => row.status === "cancelled").length;
  const confirmed = rows.filter((row) => row.patient_confirmed).length;
  const attendanceBase = done + noShow;
  const attendanceRate = attendanceBase > 0 ? Math.round((done / attendanceBase) * 100) : 0;

  return {
    report: "appointments",
    title: "تقرير المواعيد",
    subtitle: "الحجوزات وحالات الحضور وعدم الحضور خلال الفترة",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("appointments", "إجمالي المواعيد", rows.length),
      countKpi("done", "تمّت", done, "good"),
      countKpi("no-show", "لم يحضر", noShow, noShow > 0 ? "warn" : "calm"),
      countKpi("cancelled", "ملغاة", cancelled),
      countKpi("confirmed", "أكدها المريض", confirmed, "calm"),
      { key: "attendance-rate", label: "نسبة الحضور", text: `${attendanceRate}%`, tone: attendanceRate >= 80 ? "good" : "warn" },
    ],
    columns: [
      COMMON_COLUMNS.patient,
      { key: "date", label: "التاريخ", type: "date" },
      { key: "time", label: "الوقت" },
      { key: "doctorName", label: "الطبيب" },
      { key: "serviceName", label: "نوع الموعد" },
      { key: "durationMinutes", label: "المدة (دقيقة)", type: "count" },
      { key: "statusLabel", label: "الحالة" },
      { key: "confirmedLabel", label: "تأكيد المريض" },
    ],
    rows: rows.map((row) => ({
      patientId: row.patient_id,
      patientName: row.patient_name,
      patientNumber: row.patient_number,
      date: row.date,
      time: row.time,
      doctorName: row.doctor_name ?? "—",
      serviceName: row.service_name ?? "—",
      durationMinutes: row.duration_minutes,
      statusLabel: APPOINTMENT_STATUS_LABEL[row.status] ?? row.status,
      confirmedLabel: row.patient_confirmed ? "نعم" : "لا",
    })),
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "نسبة الحضور = المواعيد المنجزة ÷ (المنجزة + عدم الحضور). الإلغاء لا يدخل المقام.",
      filters.serviceId ? "فلتر «الخدمة» السريري لا يطبّق على خدمات الحجز لأنها دليل مستقل؛ استخدم التخصص والطبيب هنا." : "",
    ].filter(Boolean),
  };
}

// ─── خطط العلاج ───────────────────────────────────────────────────────────────

async function treatmentPlansReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { rows } = await getPool().query<{
    id: number; patient_id: number; patient_name: string; patient_number: string;
    title: string; status: string; start_date: string; specialty: string | null;
    doctor_name: string | null; base_currency: string; total_minor: string;
    consent_at: Date | null; items_count: string; done_items: string;
  }>(
    `SELECT tp.id, tp.patient_id, p.full_name AS patient_name, p.patient_number,
            tp.title, tp.status, tp.start_date::text AS start_date, tp.specialty,
            d.name AS doctor_name, tp.base_currency, tp.total_minor::text,
            tp.consent_at,
            (SELECT COUNT(*)::text FROM plan_items pi WHERE pi.plan_id = tp.id) AS items_count,
            (SELECT COUNT(*)::text FROM plan_items pi WHERE pi.plan_id = tp.id AND pi.status = 'done') AS done_items
       FROM treatment_plans tp
       JOIN patients p ON p.id = tp.patient_id
       LEFT JOIN parties d ON d.id = tp.primary_doctor_id
      WHERE tp.start_date BETWEEN $1::date AND $2::date
        AND ($3::int IS NULL OR tp.patient_id = $3::int)
        AND ($4::int IS NULL OR tp.primary_doctor_id = $4::int
             OR EXISTS (SELECT 1 FROM plan_items pi WHERE pi.plan_id = tp.id AND pi.doctor_id = $4::int))
        AND ($5::text IS NULL OR tp.specialty = $5::text
             OR EXISTS (SELECT 1 FROM plan_items pi WHERE pi.plan_id = tp.id AND pi.category = $5::text))
        AND ($6::int IS NULL OR EXISTS (SELECT 1 FROM plan_items pi WHERE pi.plan_id = tp.id AND pi.service_id = $6::int))
      ORDER BY tp.start_date DESC, tp.id DESC`,
    [filters.from, filters.to, filters.patientId, filters.doctorId, filters.specialty, filters.serviceId],
  );

  const normalized = rows
    .map((row) => {
      const currency = requireCurrency(row.base_currency, "خطة علاج", row.id);
      const totalMinor = num(row.total_minor);
      const itemsCount = num(row.items_count);
      const doneItems = num(row.done_items);
      return { ...row, currency, totalMinor, itemsCount, doneItems };
    })
    .filter((row) => filters.currency === "all" || row.currency === filters.currency);
  const valueByCurrency = emptyCurrencyRecord();
  for (const row of normalized) valueByCurrency[row.currency] += row.totalMinor;

  return {
    report: "treatment-plans",
    title: "تقرير خطط العلاج",
    subtitle: "الخطط التي بدأت خلال الفترة وتقدمها وموافقة المريض",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("plans", "خطط بدأت", normalized.length),
      countKpi("active", "جارية", normalized.filter((row) => row.status === "active").length, "calm"),
      countKpi("completed", "مكتملة", normalized.filter((row) => row.status === "completed").length, "good"),
      countKpi("consented", "بموافقة موثقة", normalized.filter((row) => row.consent_at !== null).length, "good"),
      ...moneyKpis("plans-value", "قيمة الاتفاقات", valueByCurrency, "calm"),
    ],
    columns: [
      COMMON_COLUMNS.patient,
      { key: "title", label: "الخطة" },
      { key: "startDate", label: "تاريخ البدء", type: "date" },
      { key: "doctorName", label: "الطبيب" },
      { key: "specialtyLabel", label: "التخصص" },
      { key: "statusLabel", label: "الحالة" },
      { key: "progress", label: "التقدم" },
      { key: "currency", label: "العملة" },
      { key: "totalMinor", label: "قيمة الخطة", type: "money", currencyKey: "currency" },
      { key: "consentLabel", label: "الموافقة" },
    ],
    rows: normalized.map((row) => ({
      patientId: row.patient_id,
      patientName: row.patient_name,
      patientNumber: row.patient_number,
      title: row.title,
      startDate: row.start_date,
      doctorName: row.doctor_name ?? "—",
      specialtyLabel: row.specialty ? (CATEGORY_LABEL[row.specialty] ?? row.specialty) : "عام",
      statusLabel: row.status === "active" ? "جارية" : row.status === "completed" ? "مكتملة" : row.status === "cancelled" ? "ملغاة" : row.status,
      progress: `${row.doneItems}/${row.itemsCount}`,
      currency: row.currency,
      totalMinor: row.totalMinor,
      consentLabel: row.consent_at ? "موثقة" : "غير موثقة",
    })),
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: ["الفترة هنا هي تاريخ بدء الخطة؛ قيمة الخطة اتفاق وليست مديونية مستحقة."],
  };
}

// ─── المختبر ─────────────────────────────────────────────────────────────────

async function labReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { rows } = await getPool().query<{
    id: number; patient_id: number; patient_name: string; patient_number: string;
    work_type: string; status: string; sent_date: string; due_date: string;
    lab_name: string; doctor_name: string | null; cost_minor: string | null;
    cost_currency: string | null; remake_original_id: number | null;
  }>(
    `SELECT l.id, l.patient_id, p.full_name AS patient_name, p.patient_number,
            COALESCE(ls.name, l.work_type) AS work_type, l.status,
            l.sent_date::text AS sent_date, l.due_date::text AS due_date,
            l.lab_name, d.name AS doctor_name,
            l.cost_minor::text, l.cost_currency, l.remake_original_id
       FROM lab_orders l
       JOIN patients p ON p.id = l.patient_id
       LEFT JOIN parties d ON d.id = l.doctor_id
       LEFT JOIN lab_services ls ON ls.id = l.lab_service_id
      WHERE l.sent_date BETWEEN $1::date AND $2::date
        AND ($3::int IS NULL OR l.patient_id = $3::int)
        AND ($4::int IS NULL OR l.doctor_id = $4::int)
      ORDER BY l.due_date, l.id`,
    [filters.from, filters.to, filters.patientId, filters.doctorId],
  );

  const normalized = rows.map((row) => {
    const currency = row.cost_currency && isCurrency(row.cost_currency) ? row.cost_currency : base;
    const costMinor = row.cost_minor === null ? 0 : num(row.cost_minor);
    const open = !["received", "delivered", "cancelled"].includes(row.status);
    const daysLate = open && row.due_date < filters.to
      ? Math.max(0, Math.round((toUTC(filters.to) - toUTC(row.due_date)) / 86_400_000))
      : 0;
    return { ...row, currency, costMinor, daysLate };
  }).filter((row) => filters.currency === "all" || row.currency === filters.currency);
  const costByCurrency = emptyCurrencyRecord();
  for (const row of normalized) costByCurrency[row.currency] += row.costMinor;

  const statusLabel: Record<string, string> = {
    needed: "لم يُرسل بعد", sent: "عند المختبر", in_progress: "قيد التصنيع",
    received: "وصل العيادة", delivered: "رُكّب للمريض", remake: "إعادة تصنيع", cancelled: "ملغى",
  };

  return {
    report: "lab",
    title: "تقرير أعمال المختبر",
    subtitle: "الأعمال المرسلة خلال الفترة ومواعيدها وإعادات التصنيع وتكاليفها",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("lab-orders", "أعمال المختبر", normalized.length),
      countKpi("lab-late", "متأخرة حتى نهاية الفترة", normalized.filter((row) => row.daysLate > 0).length, "warn"),
      countKpi("lab-remakes", "إعادة تصنيع", normalized.filter((row) => row.status === "remake" || row.remake_original_id !== null).length, "warn"),
      countKpi("lab-delivered", "رُكبت للمريض", normalized.filter((row) => row.status === "delivered").length, "good"),
      ...moneyKpis("lab-cost", "تكلفة المختبر", costByCurrency, "calm"),
    ],
    columns: [
      COMMON_COLUMNS.patient,
      { key: "workType", label: "العمل" },
      { key: "labName", label: "المختبر" },
      { key: "doctorName", label: "الطبيب" },
      { key: "sentDate", label: "أُرسل", type: "date" },
      { key: "dueDate", label: "الاستحقاق", type: "date" },
      { key: "statusLabel", label: "الحالة" },
      { key: "daysLate", label: "أيام التأخير", type: "count" },
      { key: "currency", label: "العملة" },
      { key: "costMinor", label: "التكلفة", type: "money", currencyKey: "currency" },
    ],
    rows: normalized.map((row) => ({
      patientId: row.patient_id,
      patientName: row.patient_name,
      patientNumber: row.patient_number,
      workType: row.work_type,
      labName: row.lab_name,
      doctorName: row.doctor_name ?? "—",
      sentDate: row.sent_date,
      dueDate: row.due_date,
      statusLabel: statusLabel[row.status] ?? row.status,
      daysLate: row.daysLate,
      currency: row.currency,
      costMinor: row.costMinor,
    })),
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "التأخير يُقاس حتى نهاية الفترة المختارة للأعمال التي لم تصل/تُركب/تُلغَ.",
      "لا تُطرح تكلفة المختبر من إيراد بعملة أخرى؛ كل تكلفة تبقى في دلو عملتها.",
    ],
  };
}

// ─── المخزون ─────────────────────────────────────────────────────────────────

async function inventoryReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { rows } = await getPool().query<{
    id: number; name: string; unit: string; category: string; min_level: string;
    balance: string; period_in: string; period_out: string; period_adjust: string;
    movements_count: string; nearest_expiry: string | null;
  }>(
    `SELECT i.id, i.name, i.unit, i.category, i.min_level::text,
            COALESCE(SUM(CASE
              WHEN m.kind = 'out' THEN -ABS(m.qty)
              WHEN m.kind = 'adjust' THEN m.qty
              ELSE ABS(m.qty) END), 0)::text AS balance,
            COALESCE(SUM(CASE WHEN (m.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date AND m.kind = 'in'
              THEN ABS(m.qty) ELSE 0 END), 0)::text AS period_in,
            COALESCE(SUM(CASE WHEN (m.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date AND m.kind = 'out'
              THEN ABS(m.qty) ELSE 0 END), 0)::text AS period_out,
            COALESCE(SUM(CASE WHEN (m.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date AND m.kind = 'adjust'
              THEN m.qty ELSE 0 END), 0)::text AS period_adjust,
            COUNT(m.id) FILTER (WHERE (m.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date)::text AS movements_count,
            MIN(CASE WHEN m.expiry_date IS NOT NULL AND m.expiry_date >= $3::date THEN m.expiry_date::text END) AS nearest_expiry
       FROM inventory_items i
       LEFT JOIN inventory_movements m ON m.item_id = i.id
      WHERE i.is_active
      GROUP BY i.id, i.name, i.unit, i.category, i.min_level
      ORDER BY i.name`,
    [CLINIC_TIME_ZONE, filters.from, filters.to],
  );

  const normalized = rows.map((row) => {
    const balance = Number(row.balance);
    const minLevel = Number(row.min_level);
    const status = balance <= 0 ? "out" : minLevel > 0 && balance < minLevel ? "low" : "ok";
    return { ...row, balance, minLevel, status };
  });

  return {
    report: "inventory",
    title: "تقرير المخزون",
    subtitle: "الأرصدة المشتقة من الحركات وحدود إعادة الطلب وحركة الفترة",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("items", "الأصناف النشطة", normalized.length),
      countKpi("out", "منتهية", normalized.filter((row) => row.status === "out").length, "bad"),
      countKpi("low", "تحت حد الطلب", normalized.filter((row) => row.status === "low").length, "warn"),
      countKpi("moved", "أصناف تحركت بالفترة", normalized.filter((row) => num(row.movements_count) > 0).length, "calm"),
    ],
    columns: [
      { key: "name", label: "الصنف" },
      { key: "category", label: "الفئة" },
      { key: "unit", label: "الوحدة" },
      { key: "balance", label: "الرصيد", type: "count" },
      { key: "minLevel", label: "حد الطلب", type: "count" },
      { key: "statusLabel", label: "الحالة" },
      { key: "periodIn", label: "إدخال الفترة", type: "count" },
      { key: "periodOut", label: "صرف الفترة", type: "count" },
      { key: "periodAdjust", label: "تسوية الفترة", type: "count" },
      { key: "nearestExpiry", label: "أقرب صلاحية", type: "date" },
    ],
    rows: normalized.map((row) => ({
      name: row.name,
      category: row.category,
      unit: row.unit,
      balance: row.balance,
      minLevel: row.minLevel,
      statusLabel: row.status === "out" ? "منتهي" : row.status === "low" ? "تحت حد الطلب" : "متوفر",
      periodIn: Number(row.period_in),
      periodOut: Number(row.period_out),
      periodAdjust: Number(row.period_adjust),
      nearestExpiry: row.nearest_expiry ?? "",
    })),
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "الرصيد ليس حقلًا مخزنًا؛ هو مجموع حركات الإدخال − الصرف + التسويات.",
      "لا نجمع كميات أصناف بوحدات مختلفة في KPI واحد حتى لا نخلط علبةً بملليلتر.",
    ],
  };
}

// ─── الموردون والمختبرات الدائنة ─────────────────────────────────────────────

async function suppliersReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { rows } = await getPool().query<{
    id: number; party_id: number; party_name: string; party_kind: string;
    description: string; due_date: string | null; currency: string; amount_minor: string;
    settled_minor: string; created_date: string;
  }>(
    `SELECT b.id, b.party_id, p.name AS party_name, p.kind AS party_kind,
            b.description, b.due_date::text, b.currency, b.amount_minor::text,
            (COALESCE((SELECT SUM(e.payable_settled_minor) FROM expenses e
                        WHERE e.payable_id = b.id
                          AND (e.created_at AT TIME ZONE $1)::date <= $2::date), 0)
             + COALESCE((SELECT SUM(a.settled_minor) FROM expense_payable_allocations a
                          WHERE a.payable_id = b.id
                            AND (a.created_at AT TIME ZONE $1)::date <= $2::date), 0))::text AS settled_minor,
            (b.created_at AT TIME ZONE $1)::date::text AS created_date
       FROM payables b
       JOIN parties p ON p.id = b.party_id
      WHERE p.kind IN ('supplier', 'lab')
        AND (b.created_at AT TIME ZONE $1)::date <= $2::date
      ORDER BY COALESCE(b.due_date, DATE '9999-12-31'), b.id`,
    [CLINIC_TIME_ZONE, filters.to],
  );

  const normalized = rows.map((row) => {
    const currency = requireCurrency(row.currency, "التزام مورد", row.id);
    const amountMinor = num(row.amount_minor);
    const settledMinor = num(row.settled_minor);
    const remainingMinor = Math.max(0, amountMinor - settledMinor);
    const overdue = remainingMinor > 0 && row.due_date !== null && row.due_date < filters.to;
    return { ...row, currency, amountMinor, settledMinor, remainingMinor, overdue };
  }).filter((row) => (filters.currency === "all" || row.currency === filters.currency) && row.remainingMinor > 0);
  const outstandingByCurrency = emptyCurrencyRecord();
  for (const row of normalized) outstandingByCurrency[row.currency] += row.remainingMinor;

  return {
    report: "suppliers",
    title: "تقرير الموردين والذمم الدائنة",
    subtitle: "الالتزامات القائمة حتى نهاية الفترة للموردين والمختبرات",
    periodLabel: `حتى ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("payables", "التزامات مفتوحة", normalized.length),
      countKpi("overdue", "متأخرة", normalized.filter((row) => row.overdue).length, "warn"),
      countKpi("suppliers", "جهات دائنة", new Set(normalized.map((row) => row.party_id)).size),
      ...moneyKpis("outstanding", "المتبقي المستحق", outstandingByCurrency, "bad"),
    ],
    columns: [
      { key: "partyName", label: "الجهة" },
      { key: "partyKind", label: "النوع" },
      { key: "description", label: "البيان" },
      { key: "createdDate", label: "تاريخ القيد", type: "date" },
      { key: "dueDate", label: "الاستحقاق", type: "date" },
      { key: "currency", label: "العملة" },
      { key: "amountMinor", label: "الأصل", type: "money", currencyKey: "currency" },
      { key: "settledMinor", label: "المسدّد", type: "money", currencyKey: "currency" },
      { key: "remainingMinor", label: "المتبقي", type: "money", currencyKey: "currency" },
      { key: "statusLabel", label: "الحالة" },
    ],
    rows: normalized.map((row) => ({
      partyName: row.party_name,
      partyKind: row.party_kind === "lab" ? "مختبر" : "مورّد",
      description: row.description,
      createdDate: row.created_date,
      dueDate: row.due_date ?? "",
      currency: row.currency,
      amountMinor: row.amountMinor,
      settledMinor: row.settledMinor,
      remainingMinor: row.remainingMinor,
      statusLabel: row.overdue ? "متأخر" : "مستحق",
    })),
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "المتبقي = أصل الالتزام − كل تسوياته حتى نهاية الفترة، بما فيها القيود العكسية.",
      "الموردون والمختبرات يظهرون هنا؛ مستحقات الأطباء لها محرك العمولات المستقل.",
    ],
  };
}

// ─── المتابعة والاستدعاء ─────────────────────────────────────────────────────

async function recallReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const [openPast, missed, lapsed] = await Promise.all([
    listOpenPastAppointments(),
    listMissedAppointments(),
    listLapsedPatients(6),
  ]);

  const patientAllowed = (patientId: number) => !filters.patientId || filters.patientId === patientId;
  const rows: ReportRow[] = [
    ...openPast.filter((row) => patientAllowed(row.patientId)).map((row) => ({
      patientId: row.patientId,
      patientName: row.patientName,
      kind: "موعد مضى ولم يُغلق",
      referenceDate: row.scheduledDate,
      phone: row.patientPhone ?? "—",
      doctorName: row.doctorName ?? "—",
      statusLabel: `متأخر ${row.daysLate} يوم`,
    })),
    ...missed.filter((row) => patientAllowed(row.patientId)).map((row) => ({
      patientId: row.patientId,
      patientName: row.patientName,
      kind: "لم يحضر",
      referenceDate: row.referenceDate,
      phone: row.patientPhone ?? "—",
      doctorName: "—",
      statusLabel: "ينتظر متابعة",
    })),
    ...lapsed.filter((row) => patientAllowed(row.patientId)).map((row) => ({
      patientId: row.patientId,
      patientName: row.patientName,
      kind: "منقطع عن العلاج",
      referenceDate: row.referenceDate,
      phone: row.patientPhone ?? "—",
      doctorName: "—",
      statusLabel: "أكثر من ٦ أسابيع",
    })),
  ];

  return {
    report: "recall",
    title: "تقرير المتابعة والاستدعاء",
    subtitle: "قائمة العمل الحالية للمرضى الذين يحتاجون تواصلًا",
    periodLabel: "لقطة تشغيلية حالية",
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("open-past", "مواعيد معلقة", openPast.filter((row) => patientAllowed(row.patientId)).length, "warn"),
      countKpi("missed", "لم يحضروا", missed.filter((row) => patientAllowed(row.patientId)).length, "warn"),
      countKpi("lapsed", "منقطعون +٦ أسابيع", lapsed.filter((row) => patientAllowed(row.patientId)).length, "calm"),
      countKpi("recall-total", "إجمالي يحتاج متابعة", rows.length),
    ],
    columns: [
      COMMON_COLUMNS.patient,
      { key: "kind", label: "السبب" },
      { key: "referenceDate", label: "التاريخ المرجعي", type: "date" },
      { key: "phone", label: "الهاتف" },
      { key: "doctorName", label: "الطبيب" },
      { key: "statusLabel", label: "الحالة" },
    ],
    rows,
    actions: [{ label: "فتح شاشة المتابعة", href: "/recall" }],
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "هذا التقرير لقطة تشغيلية حالية ويستخدم نفس مصدر شاشة المتابعة؛ فلاتر الفترة لا تعيد كتابة تاريخ المتابعة.",
      "المنقطع = مضى على آخر نشاطه أكثر من ٦ أسابيع ولا يملك موعدًا قادمًا، مع مهلة عدم الإزعاج بعد الاستدعاء.",
    ],
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
    baseCurrency: CLINIC_BASE_CURRENCY,
    clinicName: String(settings["clinic.name"] ?? "مركز الأسنان"),
  };
}

// ─── تحويل معاملات الطلب إلى فلاتر ──────────────────────────────────────────

/**
 * (P1-2) خطأ مدخلات التقرير — رسالته عربية مكتوبة للمستخدم، فيعيدها المسار كما هي
 * (400). أي استثناءٍ آخر (قاعدة بيانات، برمجة) لا تُكشف تفاصيله: 500 برسالةٍ عامة.
 */
export class ReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportInputError";
  }
}

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
