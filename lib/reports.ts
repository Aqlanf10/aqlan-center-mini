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

import { getPool, ensureSchema, getSettings, listParties, listServices, commissionReport, listOpenPastAppointments, listMissedAppointments, listLapsedPatients, materialRatesMapAsOf, CLINIC_TIME_ZONE, type CommissionRow } from "./db";
import { CATEGORY_LABEL } from "./services-catalog";
import { CURRENCIES, formatMoney, isCurrency, requireCurrency, settlementTargetCurrency, settlePaymentMinor, FinancialCurrencyIntegrityError, type Currency, type DocumentCurrencyRef, CLINIC_BASE_CURRENCY } from "./money";
import type {
  ReportFilters, ReportResult, ReportRow, KpiItem, ReportColumn, ComparisonEntry,
  PeriodPreset, DebtMode, PatientStatusFilter, DebtStatusFilter,
  CurrencyFilter, CompareMode, ReportOptions,
} from "./reports-types";
import { PATIENT_STATUS_LABEL, PAYMENT_METHOD_LABEL, COMMON_COLUMNS } from "./reports-types";
import { attributeByKey, attributeCollections, type AttributionInput, type OpeningsByCurrency } from "./report-attribution";
import { loadCapacityContext } from "./capacity-context";
import {
  activityBySpecialty, emptyRecord as emptySpecialtyRecord, labCostBySpecialty, materialCost,
  parseSpecialtyDoctorKey, proceduresBySpecialtyDoctor, specialtyDoctorKey,
  type SpecialtyLabCost, type SpecialtyProcedure,
} from "./specialty-activity";

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
  /** (P1-5ب) دفعةٌ تسدّد الرصيد الافتتاحي بهذه العملة. */
  openingCurrency: Currency | null;
  settlementCurrency: Currency; settlementMinor: number;
  createdBy: string | null; note: string | null;
}

/** (P-01/D-1) خطةٌ تعرف عملة اتفاقها — قيمتها بعملتها لا بعملة الدفاتر. */
interface MovementPlan {
  id: number; title: string; totalMinor: number; currency: Currency; status: string; startDate: string;
  categories: string[]; paidMinor: number;
  /** (Reports R4) قيمة الخطة موزّعةً على تخصصات بنودها (الباقي الأكبر) — فلا تتكرر في تخصصين. */
  categoryShares: { category: string | null; minor: number }[];
}

interface PatientMovement {
  patientId: number; patientNumber: string; name: string; phone: string | null;
  createdDate: string | null; lastVisitDate: string | null;
  status: keyof typeof PATIENT_STATUS_LABEL;
  /** (P3-8ب) من أين جاء، ومن أحاله. */
  referralSource: string | null; referredBy: string | null;
  /** (P1-5ب) الرصيد الافتتاحي بعملته. */
  openings: OpeningsByCurrency;
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
    referral_source: string | null; referred_by: string | null;
  }>(
    `SELECT p.id, p.patient_number, p.full_name, p.phone, p.referral_source, p.referred_by,
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
      opening_currency: string | null;
      created_by: string | null; note: string | null;
    }>(
      `SELECT id, patient_id, (created_at AT TIME ZONE $1)::date::text AS date, kind,
              amount_minor::text AS amount, currency, base_amount_minor::text AS base,
              method, invoice_id, plan_id, opening_currency, created_by, note
         FROM payments WHERE patient_id = ANY($2::int[])`,
      [CLINIC_TIME_ZONE, ids],
    ),
    pool.query<{ patient_id: number; currency: string; as_of: string; amount: string }>(
      `SELECT patient_id, currency, as_of_date::text AS as_of, amount_minor::text AS amount
         FROM patient_opening_balances WHERE patient_id = ANY($1::int[])`,
      [ids],
    ),
    // (P-01/D-1) عملة اتفاق الخطة مع صفّها — قيمة الخطة بعملتها.
    pool.query<{
      id: number; patient_id: number; title: string; total: string; base_currency: string;
      status: string; start_date: string; categories: string[] | null;
      category_weights: { category: string | null; weight: string }[] | null;
    }>(
      `SELECT tp.id, tp.patient_id, tp.title, tp.total_minor::text AS total,
              tp.base_currency, tp.status,
              tp.start_date::text AS start_date,
              (SELECT COALESCE(json_agg(DISTINCT pi.category) FILTER (WHERE pi.category IS NOT NULL), '[]'::json)
                 FROM plan_items pi WHERE pi.plan_id = tp.id) AS categories,
              (SELECT COALESCE(json_agg(json_build_object('category', w.category, 'weight', w.weight::text)), '[]'::json)
                 FROM (SELECT pi.category, SUM(GREATEST(pi.quantity, 0) * GREATEST(pi.unit_price_minor, 0)) AS weight
                         FROM plan_items pi WHERE pi.plan_id = tp.id AND pi.status <> 'cancelled'
                        GROUP BY pi.category) w) AS category_weights
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
      referralSource: row.referral_source ?? null,
      referredBy: row.referred_by ?? null,
      status: (PATIENT_STATUS_LABEL[row.status] ? row.status : "unknown") as keyof typeof PATIENT_STATUS_LABEL,
      openings: {},
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
      openingCurrency: row.opening_currency === null ? null : requireCurrency(row.opening_currency, "دفعة رصيد سابق", row.id),
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
    if (patient) {
      patient.openings[requireCurrency(row.currency, "رصيد افتتاحي", row.patient_id)] = { date: row.as_of, minor: num(row.amount) };
    }
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
      categoryShares: splitByWeights(
        num(row.total),
        (row.category_weights ?? []).map((item) => ({ category: item.category, weight: num(item.weight) })),
      ),
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
      } else if (payment.openingCurrency) {
        // (P1-5ب) سداد رصيدٍ سابق بعملته — يسوّي دلو تلك العملة.
        target = payment.openingCurrency;
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
  /** (P1-5ب) الرصيد الافتتاحي بدلو عملته. */
  openings: OpeningsByCurrency;
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

/** (Reports R4) توزيع مبلغٍ على أوزانٍ بالباقي الأكبر — المجموع = المبلغ حرفيًّا. */
function splitByWeights<T extends { weight: number }>(
  amount: number,
  items: T[],
): (Omit<T, "weight"> & { minor: number })[] {
  const gross = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (items.length === 0 || gross <= 0) {
    return [{ ...({ category: null } as unknown as Omit<T, "weight">), minor: amount }];
  }
  let assigned = 0;
  const parts = items.map((item, index) => {
    const exact = (Math.max(0, item.weight) * amount) / gross;
    const floor = Math.floor(exact);
    assigned += floor;
    return { index, floor, remainder: exact - floor };
  });
  let left = amount - assigned;
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left <= 0) break;
    part.floor += 1;
    left -= 1;
  }
  return parts.map((part) => {
    const { weight: _weight, ...rest } = items[part.index];
    return { ...(rest as Omit<T, "weight">), minor: part.floor };
  });
}

/** (Reports R4) حركة المريض بصيغة محرّك الإسناد — البند بطبيبه وتخصصه وخدمته. */
function attributionInputOf(m: PatientMovement): AttributionInput {
  const payments: AttributionInput["payments"] = m.payments.map((payment) => ({
    id: payment.id,
    date: payment.date,
    kind: payment.kind,
    settlementCurrency: payment.settlementCurrency,
    settlementMinor: payment.settlementMinor,
  }));
  // رصيدٌ افتتاحي دائن (سالب) يسوّي الفواتير اللاحقة كما في الرصيد، ولا يُعدّ تحصيلًا — بدلو عملته.
  const positiveOpenings: OpeningsByCurrency = {};
  for (const currency of CURRENCIES) {
    const opening = m.openings[currency];
    if (!opening) continue;
    if (opening.minor < 0) {
      payments.unshift({
        id: -1 - CURRENCIES.indexOf(currency), date: opening.date, kind: "payment",
        settlementCurrency: currency, settlementMinor: -opening.minor, synthetic: true,
      });
    } else if (opening.minor > 0) {
      positiveOpenings[currency] = opening;
    }
  }
  return {
    openings: positiveOpenings,
    invoices: m.invoices.map((invoice) => ({
      id: invoice.id,
      date: invoice.date,
      currency: invoice.currency,
      netMinor: invoice.netMinor,
      lines: invoice.lines.map((line) => ({
        doctorId: line.doctorId, category: line.category, serviceId: line.serviceId, netMinor: line.netMinor,
      })),
    })),
    payments,
  };
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
  for (const currency of CURRENCIES) {
    const opening = m.openings[currency];
    if (opening && opening.date <= date) balances[currency] += opening.minor;
  }
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
    const opening = m.openings[currency];
    if (opening && opening.date <= asOf && opening.minor > 0) {
      debts.push({ date: opening.date, amount: opening.minor });
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
    // الشكل القديم: رصيدٌ واحد بالعملة الأساسية.
    openings: m.opening ? { [CLINIC_BASE_CURRENCY]: m.opening } : {},
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
  /** (RPT-SPEC) الإجراءات وتكاليف المختبر ونسب المواد — للتقرير حسب التخصص وحده. */
  specialty?: { procedures: SpecialtyProcedure[]; labCosts: SpecialtyLabCost[]; materialRates: Map<string, number> };
}

/** (RPT-SPEC) إجراءات الزيارات وتكاليف المختبر في المدى، ونسب المواد السارية في آخره. */
async function loadSpecialtyExtras(filters: ReportFilters): Promise<NonNullable<ReportContext["specialty"]>> {
  const pool = getPool();
  const procedures = await pool.query<{
    date: string; visit_id: number; patient_id: number | null; doctor_id: number | null; category: string | null; quantity: number;
  }>(
    `SELECT (v.arrived_at AT TIME ZONE $1)::date::text AS date, vp.visit_id, v.patient_id,
            COALESCE(vp.doctor_id, v.doctor_id) AS doctor_id, s.category, GREATEST(vp.quantity, 1) AS quantity
       FROM visit_procedures vp
       JOIN visits v ON v.id = vp.visit_id
       LEFT JOIN services s ON s.id = vp.service_id
      WHERE (v.arrived_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date`,
    [CLINIC_TIME_ZONE, filters.from, filters.to],
  );
  const labs = await pool.query<{
    date: string; doctor_id: number | null; lab_category: string | null; work_type: string | null;
    visit_category: string | null; cost_minor: string; cost_currency: string;
  }>(
    `SELECT (lo.created_at AT TIME ZONE $1)::date::text AS date, lo.doctor_id, ls.category AS lab_category,
            lo.work_type, lo.cost_minor::text AS cost_minor, lo.cost_currency,
            (SELECT CASE WHEN COUNT(DISTINCT s.category) = 1 THEN MIN(s.category) END
               FROM visit_procedures vp JOIN services s ON s.id = vp.service_id
              WHERE vp.visit_id = lo.visit_id AND s.category IS NOT NULL) AS visit_category
       FROM lab_orders lo
       LEFT JOIN lab_services ls ON ls.id = lo.lab_service_id
      WHERE (lo.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        AND lo.status <> 'cancelled' AND COALESCE(lo.cost_minor, 0) > 0`,
    [CLINIC_TIME_ZONE, filters.from, filters.to],
  );
  const materialRates = await materialRatesMapAsOf(filters.to).catch(() => new Map<string, number>());
  return {
    procedures: procedures.rows.map((row) => ({
      date: row.date, visitId: row.visit_id, patientId: row.patient_id, doctorId: row.doctor_id,
      category: row.category, quantity: Number(row.quantity),
    })),
    labCosts: labs.rows
      .filter((row) => isCurrency(row.cost_currency))
      .map((row) => ({
        date: row.date, doctorId: row.doctor_id, labCategory: row.lab_category, workType: row.work_type ?? "",
        visitCategory: row.visit_category, costMinor: num(row.cost_minor), currency: row.cost_currency as Currency,
      })),
    materialRates,
  };
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
    // (Reports R4) ذكاء العيادة: يقرأ الحركات والزيارات نفسها التي تخدم التقارير التفصيلية.
    "practice-overview", "provider-utilization", "practice-trends",
  ].includes(report);

  const ctx = await loadContext(filters, needsMovements);
  /* (P0-1) «مستحق الطبيب» في تقرير الطبيب يأتي من محرّك العمولات الواحد (التحصيل
     الفعلي، خصم المختبر، النسبة السارية وقت التحصيل) — لا من صيغةٍ ثانية كانت تضرب
     قيمة الفاتورة كاملةً في نسبة اليوم فتناقض شاشة العمولات. */
  if (report === "doctor" || report === "doctor-commission") {
    ctx.commissionRows = await commissionReport(filters.from, filters.to);
  }
  if (report === "specialty") ctx.specialty = await loadSpecialtyExtras(filters);

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
    case "practice-overview": return practiceOverviewReport(ctx);
    case "provider-utilization": return providerUtilizationReport(ctx);
    case "chair-utilization": return chairUtilizationReport(ctx);
    case "appointment-performance": return appointmentPerformanceReport(ctx);
    case "plan-intelligence": return planIntelligenceReport(ctx);
    case "unscheduled-treatment": return unscheduledTreatmentReport(ctx);
    case "lab-intelligence": return labIntelligenceReport(ctx);
    case "new-patient-intelligence": return newPatientIntelligenceReport(ctx);
    case "recall-intelligence": return recallIntelligenceReport(ctx);
    case "practice-trends": return practiceTrendsReport(ctx);
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
      // (Reports R4) من البنود نفسها: العدد = الكمية، والقيمة = نصيب البند من صافي الفاتورة
      // بعملتها — كانت الفاتورة تُقسم بالتساوي على أوصافها المختلفة.
      for (const line of invoice.lines) {
        const key = `${line.description}::${invoice.currency}`;
        const entry = topServices.get(key) ?? { name: line.description, currency: invoice.currency, count: 0, totalMinor: 0 };
        entry.count += line.quantity;
        entry.totalMinor += line.netMinor;
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
    // (P-01/D-1) مفوتر الدلو = فواتير عملته (+ الافتتاحي بعملته — P1-5ب)؛
    // محصّله = تسويات دلوها — كلٌّ داخل عملته، لا يُقترض من دلوٍ آخر.
    const billedMinor = patient.invoices
      .filter((inv) => inv.currency === currency)
      .reduce((sum, inv) => sum + inv.netMinor, 0)
      + (patient.openings[currency]?.minor ?? 0);
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

  const money = attributeContext<string>(ctx, (line) => line.category);

  if (!selected) {
    const rows: ReportRow[] = [];
    const totalDebtByCurrency = emptyCurrencyRecord();
    const entries: [string | null, string][] = [...Object.entries(CATEGORY_LABEL), [null, "بنود بلا تخصص"]];
    const extras = specialtyExtrasOf(ctx, money);
    const totalNetByCurrency = emptyCurrencyRecord();
    for (const [code, label] of entries) {
      const sub = specialtyStats(ctx, code, money);
      const invoiced = extras.invoiced.get(code) ?? emptySpecialtyRecord();
      const lab = extras.lab.get(code) ?? emptySpecialtyRecord();
      const material = extras.material.get(code) ?? emptySpecialtyRecord();
      for (const currency of CURRENCIES) {
        const plansValue = sub.plansValueByCurrency[currency];
        const collected = sub.collectedByCurrency[currency];
        const debt = sub.debtByCurrency[currency];
        if (plansValue === 0 && collected === 0 && debt === 0 && invoiced[currency] === 0 && lab[currency] === 0) continue;
        totalDebtByCurrency[currency] += debt;
        const net = collected - lab[currency] - material[currency];
        totalNetByCurrency[currency] += net;
        rows.push({
          specialtyCode: code,
          specialtyLabel: label,
          currency,
          patients: sub.patients,
          activePatients: sub.activePatients,
          newPatients: sub.newPatients,
          plansValueMinor: plansValue,
          invoicedMinor: invoiced[currency],
          collectedMinor: collected,
          debtMinor: debt,
          avgDebtMinor: sub.patients ? Math.round(debt / sub.patients) : 0,
          labCostMinor: lab[currency],
          materialCostMinor: material[currency],
          netMinor: net,
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
        ...moneyKpis("debt", "إجمالي المتبقي على الخدمات", totalDebtByCurrency, "warn",
          "مجموع المتبقي على بنود التخصصات — كل دينٍ في تخصص بنده وحده، بلا تكرار"),
        ...moneyKpis("unattributed", "تحصيل غير منسوب لبند", money.unattributedCollected, "info",
          "دفعات سدّدت رصيدًا افتتاحيًّا أو بقيت رصيدًا دائنًا للمريض"),
        countKpi("procedures", "إجراءات منجزة", [...extras.activity.values()].reduce((sum, a) => sum + a.procedures, 0), "good"),
        ...moneyKpis("net", "صافي التخصصات بعد المختبر والمواد", totalNetByCurrency, "good",
          "التحصيل ناقص تكاليف المختبر والمواد — كل عملةٍ في دلوها"),
      ],
      columns: [
        { key: "specialtyLabel", label: "التخصص" },
        { key: "currency", label: "العملة" },
        { key: "patients", label: "المرضى", type: "count" },
        { key: "activePatients", label: "نشطون", type: "count" },
        { key: "newPatients", label: "جدد", type: "count" },
        { key: "plansValueMinor", label: "قيمة الخطط", type: "money", currencyKey: "currency" },
        { key: "invoicedMinor", label: "المفوتر", type: "money", currencyKey: "currency" },
        { key: "collectedMinor", label: "التحصيل", type: "money", currencyKey: "currency" },
        { key: "debtMinor", label: "المديونية", type: "money", currencyKey: "currency" },
        { key: "avgDebtMinor", label: "متوسط مديونية المريض", type: "money", currencyKey: "currency" },
        { key: "labCostMinor", label: "تكلفة المختبر", type: "money", currencyKey: "currency" },
        { key: "materialCostMinor", label: "تكلفة المواد", type: "money", currencyKey: "currency" },
        { key: "netMinor", label: "الصافي", type: "money", currencyKey: "currency" },
        { key: "completedPlans", label: "خطط منتهية", type: "count" },
        { key: "stoppedPlans", label: "خطط متوقفة", type: "count" },
      ],
      rows,
      sections: [activitySection(extras, entries), doctorSection(ctx, extras, null)],
      filtersLabel: filtersLabelOf(filters, doctors),
      notes: [
        "المرضى = من له بندٌ من التخصص في فواتير الفترة أو خطةٌ منه بدأت في الفترة.",
        "التحصيل والمديونية نصيب بنود التخصص وحدها (FIFO داخل كل عملة ثم بنسبة صافي البند) — مريضٌ بتقويم وعلاج عصب لا يُحسب دفعُه للعصب في التقويم.",
        "قيمة الخطط = نصيب بنود التخصص من خطط بدأت في الفترة؛ والمكتملة والمتوقفة من هذه الخطط.",
        "(P-01) التخصص بعملتين يظهر سطرين — قيمة خططه وتحصيله ومديونيته داخل كل عملة.",
        ...SPECIALTY_EXTRA_NOTES,
      ],
    };
  }

  // تخصص واحد: إحصاءاته + مرضاه (صفٌّ لكل مريض × عملة نشطة).
  const sub = specialtyStats(ctx, selected, money);
  const patientRows: ReportRow[] = [];
  const byId = movementIndex(ctx);
  for (const [patientId, remaining] of money.remainingByPatient) {
    const record = remaining.get(selected);
    const patient = byId.get(patientId);
    if (!record || !patient) continue;
    const { coveredByInvoice } = attributeCollections(attributionInputOf(patient), filters.to);
    for (const currency of CURRENCIES) {
      if (record[currency] <= 0) continue;
      // عمر الدين: أقدم فاتورةٍ فيها بندٌ من التخصص وما زال عليها متبقٍّ بهذه العملة.
      const oldest = patient.invoices
        .filter((invoice) => invoice.currency === currency && invoice.date <= filters.to
          && invoice.lines.some((line) => line.category === selected)
          && invoice.netMinor - (coveredByInvoice.get(invoice.id) ?? 0) > 0)
        .map((invoice) => invoice.date)
        .sort()[0];
      patientRows.push({
        patientId: patient.patientId,
        patientName: patient.name,
        patientNumber: patient.patientNumber,
        currency,
        statusLabel: PATIENT_STATUS_LABEL[patient.status],
        balanceMinor: record[currency],
        ageDays: oldest ? Math.max(0, Math.round((toUTC(filters.to) - toUTC(oldest)) / 86_400_000)) : 0,
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
  const extras = specialtyExtrasOf(ctx, money);
  const selectedActivity = extras.activity.get(selected);
  const selectedNet = emptyCurrencyRecord();
  for (const currency of CURRENCIES) {
    selectedNet[currency] = sub.collectedByCurrency[currency]
      - (extras.lab.get(selected)?.[currency] ?? 0) - (extras.material.get(selected)?.[currency] ?? 0);
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
      countKpi("procedures", "إجراءات منجزة", selectedActivity?.procedures ?? 0, "good"),
      countKpi("visits", "زيارات", selectedActivity?.visits ?? 0),
      ...moneyKpis("invoiced", "المفوتر", extras.invoiced.get(selected) ?? emptySpecialtyRecord()),
      ...moneyKpis("lab", "تكلفة المختبر", extras.lab.get(selected) ?? emptySpecialtyRecord(), "warn"),
      ...moneyKpis("material", "تكلفة المواد", extras.material.get(selected) ?? emptySpecialtyRecord(), "warn"),
      ...moneyKpis("net", "الصافي بعد المختبر والمواد", selectedNet, "good"),
    ],
    sections: [doctorSection(ctx, extras, selected)],
    notes: SPECIALTY_EXTRA_NOTES,
    columns: [
      { key: "patientName", label: "المريض", type: "link", patientKey: "patientId" },
      { key: "patientNumber", label: "رقم الملف" },
      { key: "currency", label: "العملة" },
      { key: "statusLabel", label: "الحالة" },
      { key: "balanceMinor", label: "المتبقي على خدمات التخصص", type: "money", currencyKey: "currency" },
      { key: "ageDays", label: "أيام التأخير", type: "count" },
    ],
    rows: patientRows,
    filtersLabel: filtersLabelOf(filters, doctors),
  };
}

// ─── (RPT-SPEC) النشاط والتكاليف والأطباء داخل التخصص ────────────────────────

const SPECIALTY_EXTRA_NOTES = [
  "الإجراءات = بنود الزيارات المنجزة بتخصص خدمتها (بالكمية)، والزيارات والمرضى من الزيارات نفسها في الفترة.",
  "المفوتر = نصيب بنود التخصص من صافي فواتير الفترة بعد الخصم — بعملة الفاتورة.",
  "تكلفة المختبر بعملتها كما سُجّلت (بلا تحويل)، ويُنسب الأمر لتخصص زيارته إن كان واحدًا وإلا لنوع العمل؛ وما لا يُعرف تخصصه يبقى «بلا تخصص».",
  "تكلفة المواد = نسبة مواد التخصص السارية في آخر الفترة × تحصيله — كما يعتمدها محرّك العمولات.",
  "الصافي = التحصيل − المختبر − المواد، داخل كل عملة.",
];

interface SpecialtyExtras {
  activity: Map<string | null, ReturnType<typeof activityBySpecialty> extends Map<unknown, infer V> ? V : never>;
  invoiced: Map<string | null, Record<Currency, number>>;
  lab: Map<string | null, Record<Currency, number>>;
  material: Map<string | null, Record<Currency, number>>;
  /** (تخصص × طبيب) → مفوتر وتحصيل بعملاتهما، وعدد الإجراءات. */
  byDoctor: Map<string, { invoiced: Record<Currency, number>; collected: Record<Currency, number>; procedures: number }>;
}

function specialtyExtrasOf(ctx: ReportContext, money: LineAttribution<string>): SpecialtyExtras {
  const { from, to, doctorId } = ctx.filters;
  const extra = ctx.specialty ?? { procedures: [], labCosts: [], materialRates: new Map<string, number>() };
  const activity = activityBySpecialty(extra.procedures, from, to, doctorId ?? null);
  const lab = labCostBySpecialty(extra.labCosts, from, to, doctorId ?? null);

  const invoiced = new Map<string | null, Record<Currency, number>>();
  const byDoctor: SpecialtyExtras["byDoctor"] = new Map();
  const doctorEntry = (key: string) => {
    const entry = byDoctor.get(key) ?? { invoiced: emptySpecialtyRecord(), collected: emptySpecialtyRecord(), procedures: 0 };
    byDoctor.set(key, entry);
    return entry;
  };
  for (const patient of ctx.movements) {
    for (const invoice of patient.invoices) {
      if (invoice.date < from || invoice.date > to) continue;
      for (const line of invoice.lines) {
        const record = invoiced.get(line.category) ?? emptySpecialtyRecord();
        record[invoice.currency] += line.netMinor;
        invoiced.set(line.category, record);
        doctorEntry(specialtyDoctorKey(line.category, line.doctorId)).invoiced[invoice.currency] += line.netMinor;
      }
    }
  }
  const collectedByDoctor = attributeContext<string>(ctx, (line) => specialtyDoctorKey(line.category, line.doctorId)).collected;
  for (const [key, record] of collectedByDoctor) {
    if (key === null) continue;
    const entry = doctorEntry(key);
    for (const currency of CURRENCIES) entry.collected[currency] += record[currency];
  }
  for (const [key, count] of proceduresBySpecialtyDoctor(extra.procedures, from, to)) doctorEntry(key).procedures += count;

  const material = new Map<string | null, Record<Currency, number>>();
  for (const [code, collected] of money.collected) {
    if (code === null) continue;
    material.set(code, materialCost(collected, extra.materialRates.get(code)));
  }
  return { activity, invoiced, lab, material, byDoctor };
}

function activitySection(extras: SpecialtyExtras, entries: [string | null, string][]) {
  const rows: ReportRow[] = [];
  for (const [code, label] of entries) {
    const activity = extras.activity.get(code);
    if (!activity) continue;
    rows.push({ specialtyLabel: label, procedures: activity.procedures, visits: activity.visits, patients: activity.patients, doctors: activity.doctors });
  }
  rows.sort((a, b) => Number(b.procedures) - Number(a.procedures));
  return {
    title: "النشاط حسب التخصص — الإجراءات والزيارات",
    columns: [
      { key: "specialtyLabel", label: "التخصص" },
      { key: "procedures", label: "الإجراءات", type: "count" as const },
      { key: "visits", label: "الزيارات", type: "count" as const },
      { key: "patients", label: "المرضى", type: "count" as const },
      { key: "doctors", label: "الأطباء", type: "count" as const },
    ],
    rows,
  };
}

function doctorSection(ctx: ReportContext, extras: SpecialtyExtras, onlySpecialty: string | null) {
  const rows: ReportRow[] = [];
  for (const [key, entry] of extras.byDoctor) {
    const { category, doctorId } = parseSpecialtyDoctorKey(key);
    if (onlySpecialty !== null && category !== onlySpecialty) continue;
    if (ctx.filters.doctorId && doctorId !== ctx.filters.doctorId) continue;
    const label = category ? CATEGORY_LABEL[category] ?? category : "بلا تخصص";
    const doctorName = doctorId !== null ? ctx.doctors.get(doctorId) ?? `#${doctorId}` : "بلا طبيب";
    let first = true;
    for (const currency of CURRENCIES) {
      if (entry.invoiced[currency] === 0 && entry.collected[currency] === 0 && !(first && entry.procedures > 0 && currency === CURRENCIES[0])) continue;
      rows.push({
        specialtyLabel: label,
        doctorName,
        currency,
        // الإجراءات لا عملة لها: تُكتب مرةً في أول سطرٍ للطبيب داخل التخصص.
        procedures: first ? entry.procedures : 0,
        invoicedMinor: entry.invoiced[currency],
        collectedMinor: entry.collected[currency],
      });
      first = false;
    }
  }
  rows.sort((a, b) => String(a.specialtyLabel).localeCompare(String(b.specialtyLabel), "ar")
    || Number(b.collectedMinor) - Number(a.collectedMinor));
  return {
    title: onlySpecialty ? "الأطباء في هذا التخصص" : "الأطباء داخل كل تخصص",
    columns: [
      { key: "specialtyLabel", label: "التخصص" },
      { key: "doctorName", label: "الطبيب" },
      { key: "currency", label: "العملة" },
      { key: "procedures", label: "الإجراءات", type: "count" as const },
      { key: "invoicedMinor", label: "المفوتر", type: "money" as const, currencyKey: "currency" },
      { key: "collectedMinor", label: "التحصيل", type: "money" as const, currencyKey: "currency" },
    ],
    rows,
  };
}

/**
 * (Reports R4 — RPT-12…14) إحصاءات تخصصٍ من بنوده لا من «المريض لديه هذا التخصص».
 * المرضى = من له بندٌ من التخصص في فواتير الفترة أو خطةٌ منه بدأت في الفترة؛ والتحصيل
 * والمتبقي نصيب بنود التخصص وحدها؛ وقيمة الخطة نصيب بنودها من التخصص.
 */
function specialtyStats(ctx: ReportContext, code: string | null, money?: LineAttribution<string>) {
  const { filters } = ctx;
  const { from, to } = filters;
  const attribution = money ?? attributeContext<string>(ctx, (line) => line.category);
  const patients = new Set<number>();
  const plansValueByCurrency = emptyCurrencyRecord();
  let completedPlans = 0;
  let stoppedPlans = 0;

  for (const patient of ctx.movements) {
    const hasLine = patient.invoices.some((invoice) => invoice.date >= from && invoice.date <= to
      && invoice.lines.some((line) => line.category === code));
    let hasPlan = false;
    for (const plan of patient.plans) {
      if (plan.startDate < from || plan.startDate > to) continue;
      const share = plan.categoryShares.filter((item) => item.category === code).reduce((sum, item) => sum + item.minor, 0);
      if (share <= 0 && !(code !== null && plan.categories.includes(code))) continue;
      hasPlan = true;
      // (P-01/D-1) قيمة الخطة بعملة اتفاقها — ونصيب التخصص منها فقط.
      plansValueByCurrency[plan.currency] += share;
      if (plan.status === "completed") completedPlans++;
      if (plan.status === "stopped") stoppedPlans++;
    }
    if (hasLine || hasPlan) patients.add(patient.patientId);
  }
  const byId = movementIndex(ctx);
  const members = [...patients].map((id) => byId.get(id)).filter((patient): patient is PatientMovement => Boolean(patient));
  return {
    patients: members.length,
    activePatients: members.filter((patient) => patient.status === "active").length,
    newPatients: members.filter((patient) => patient.createdDate !== null && patient.createdDate >= from && patient.createdDate <= to).length,
    plansValueByCurrency,
    collectedByCurrency: attribution.collected.get(code) ?? emptyCurrencyRecord(),
    debtByCurrency: attribution.remaining.get(code) ?? emptyCurrencyRecord(),
    completedPlans,
    stoppedPlans,
  };
}

// ─── التقرير حسب الطبيب ──────────────────────────────────────────────────────

/**
 * (Reports R4 — RPT-08…11) إسناد المال لكل مفتاحٍ على مستوى البند، مرةً لكل سياق.
 * الطبيب والتخصص والخدمة كلها من البند نفسه — لا من «علاقة المريض التاريخية».
 */
interface LineAttribution<K> {
  collected: Map<K | null, Record<Currency, number>>;
  remaining: Map<K | null, Record<Currency, number>>;
  unattributedCollected: Record<Currency, number>;
  openingRemaining: number;
  /** المتبقي لكل مريض × مفتاح — لصفوف المرضى في تقرير التخصص. */
  remainingByPatient: Map<number, Map<K | null, Record<Currency, number>>>;
}

function attributeContext<K>(ctx: ReportContext, keyOf: (line: AttributionInput["invoices"][number]["lines"][number]) => K | null): LineAttribution<K> {
  const { from, to } = ctx.filters;
  const collected = new Map<K | null, Record<Currency, number>>();
  const remaining = new Map<K | null, Record<Currency, number>>();
  const remainingByPatient = new Map<number, Map<K | null, Record<Currency, number>>>();
  const unattributedCollected = emptyCurrencyRecord();
  let openingRemaining = 0;
  const merge = (target: Map<K | null, Record<Currency, number>>, source: Map<K | null, Record<Currency, number>>) => {
    for (const [key, record] of source) {
      const into = target.get(key) ?? emptyCurrencyRecord();
      for (const currency of CURRENCIES) into[currency] += record[currency];
      target.set(key, into);
    }
  };
  for (const patient of ctx.movements) {
    const totals = attributeByKey(attributionInputOf(patient), from, to, keyOf);
    merge(collected, totals.collected);
    merge(remaining, totals.remaining);
    if (totals.remaining.size > 0) remainingByPatient.set(patient.patientId, totals.remaining);
    for (const currency of CURRENCIES) unattributedCollected[currency] += totals.unattributedCollected[currency];
    openingRemaining += Math.max(0, totals.openingRemaining);
  }
  return { collected, remaining, unattributedCollected, openingRemaining, remainingByPatient };
}

function doctorReport(ctx: ReportContext): ReportResult {
  const { filters, base, doctors, commissions } = ctx;
  const { from, to } = filters;
  const rows: ReportRow[] = [];
  const engineRow = (doctorId: number, currency: Currency) =>
    ctx.commissionRows?.find((row) => row.doctorId === doctorId && row.currency === currency);
  const inSpecialty = (category: string | null) => !filters.specialty || category === filters.specialty;

  /* التحصيل والمتبقي من البنود (قاعدة FIFO لمحرك العمولات) — ما ليس في التخصص المختار
     يُسند إلى مفتاحٍ مهمل فلا يدخل صفَّ أي طبيب. */
  const OUTSIDE = -1;
  const money = attributeContext<number>(ctx, (line) => (inSpecialty(line.category) ? line.doctorId : OUTSIDE));

  // مرضى الطبيب في الفترة: من عمل لهم (بند في فاتورة الفترة) أو زاروه (زيارة الفترة) — RPT-08.
  const patientsOf = new Map<number, Set<number>>();
  const workOf = new Map<number, Record<Currency, number>>();
  const proceduresOf = new Map<number, number>();
  const touch = (doctorId: number, patientId: number) => {
    const set = patientsOf.get(doctorId) ?? new Set<number>();
    set.add(patientId);
    patientsOf.set(doctorId, set);
  };
  const createdById = new Map(ctx.movements.map((patient) => [patient.patientId, patient.createdDate]));
  for (const patient of ctx.movements) {
    for (const invoice of patient.invoices) {
      if (invoice.date < from || invoice.date > to) continue;
      for (const line of invoice.lines) {
        if (line.doctorId === null || !inSpecialty(line.category)) continue;
        touch(line.doctorId, patient.patientId);
        const work = workOf.get(line.doctorId) ?? emptyCurrencyRecord();
        work[invoice.currency] += line.netMinor; // RPT-11: نصيب بنده من الصافي لا الفاتورة كاملة
        workOf.set(line.doctorId, work);
        proceduresOf.set(line.doctorId, (proceduresOf.get(line.doctorId) ?? 0) + line.quantity);
      }
    }
  }
  if (!filters.specialty) {
    for (const visit of ctx.visits) {
      if (visit.date < from || visit.date > to || visit.doctorId === null || visit.patientId === null) continue;
      if (!createdById.has(visit.patientId)) continue; // خارج فلتر حالة المريض
      touch(visit.doctorId, visit.patientId);
    }
  }

  for (const [doctorId, doctorName] of doctors) {
    if (filters.doctorId && doctorId !== filters.doctorId) continue;
    const patients = patientsOf.get(doctorId) ?? new Set<number>();
    const newPatients = [...patients].filter((id) => {
      const created = createdById.get(id);
      return created !== null && created !== undefined && created >= from && created <= to;
    }).length;
    const procedures = proceduresOf.get(doctorId) ?? 0;
    const work = workOf.get(doctorId) ?? emptyCurrencyRecord();
    const collected = money.collected.get(doctorId) ?? emptyCurrencyRecord();
    const debt = money.remaining.get(doctorId) ?? emptyCurrencyRecord();
    if (patients.size === 0 && procedures === 0 && CURRENCIES.every((currency) => collected[currency] === 0 && debt[currency] === 0)) continue;

    // صفٌّ لكل (طبيب × عملة نشطة) — والمستحق من محرّك العمولات داخل العملة نفسها.
    let wrote = false;
    for (const currency of CURRENCIES) {
      const fromEngine = engineRow(doctorId, currency);
      if (work[currency] === 0 && collected[currency] === 0 && debt[currency] === 0 && !fromEngine) continue;
      wrote = true;
      rows.push({
        doctorId,
        doctorName,
        currency,
        patients: patients.size,
        newPatients,
        procedures,
        workMinor: work[currency],
        collectedMinor: collected[currency],
        debtMinor: debt[currency],
        commissionPercent: fromEngine?.commissionPercent ?? commissions.get(doctorId) ?? 0,
        duesMinor: fromEngine?.netEarnedMinor ?? 0,
      });
    }
    if (!wrote) {
      rows.push({
        doctorId, doctorName, currency: base, patients: patients.size, newPatients, procedures,
        workMinor: 0, collectedMinor: 0, debtMinor: 0,
        commissionPercent: commissions.get(doctorId) ?? 0, duesMinor: 0,
      });
    }
  }

  // ما لا طبيب له (بندٌ بلا طبيب) يظهر صفًّا صريحًا فتتطابق المجاميع مع تقرير التحصيل.
  if (!filters.doctorId) {
    const orphanCollected = money.collected.get(null) ?? emptyCurrencyRecord();
    const orphanDebt = money.remaining.get(null) ?? emptyCurrencyRecord();
    for (const currency of CURRENCIES) {
      if (orphanCollected[currency] === 0 && orphanDebt[currency] === 0) continue;
      rows.push({
        doctorId: null, doctorName: "بنود بلا طبيب محدد", currency,
        patients: null, newPatients: null, procedures: null,
        workMinor: 0, collectedMinor: orphanCollected[currency], debtMinor: orphanDebt[currency],
        commissionPercent: null, duesMinor: 0,
      });
    }
  }

  // (P-01/D-1) الترتيب داخل كل عملة — العملات بترتيب الدلاء.
  rows.sort((a, b) => {
    const currencyOrder = CURRENCIES.indexOf(a.currency as Currency) - CURRENCIES.indexOf(b.currency as Currency);
    if (currencyOrder !== 0) return currencyOrder;
    if (a.doctorId === null) return 1;
    if (b.doctorId === null) return -1;
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
    subtitle: "إنتاجية كل طبيب من بنوده، وما حُصّل من أعماله وما بقي عليها — لكل عملة دلوها",
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      countKpi("doctors", "أطباء نشطون", new Set(rows.filter((row) => row.doctorId !== null).map((row) => row.doctorId)).size),
      ...moneyKpis("work", "قيمة الأعمال", sumColumn("workMinor")),
      ...moneyKpis("collected", "المحصّل من الأعمال", sumColumn("collectedMinor"), "good"),
      ...moneyKpis("unattributed", "تحصيل غير منسوب لبند", money.unattributedCollected, "info",
        "دفعات سدّدت رصيدًا افتتاحيًّا أو بقيت رصيدًا دائنًا للمريض — لا طبيب لها"),
      ...moneyKpis("dues", "مستحقات الأطباء (عمولات)", sumColumn("duesMinor"), "info",
        "من محرّك العمولات: التحصيل الفعلي بعد خصم المختبر، بالنسبة السارية وقت التحصيل"),
    ],
    columns: [
      { key: "doctorName", label: "الطبيب" },
      { key: "currency", label: "العملة" },
      { key: "patients", label: "مرضاه في الفترة", type: "count" },
      { key: "newPatients", label: "جدد", type: "count" },
      { key: "procedures", label: "إجراءاته", type: "count" },
      { key: "workMinor", label: "قيمة أعماله", type: "money", currencyKey: "currency" },
      { key: "collectedMinor", label: "المحصّل من أعماله", type: "money", currencyKey: "currency" },
      { key: "debtMinor", label: "المتبقي على أعماله", type: "money", currencyKey: "currency" },
      { key: "commissionPercent", label: "نسبة العمولة", type: "percent" },
      { key: "duesMinor", label: "مستحق الطبيب", type: "money", currencyKey: "currency" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "مرضاه = من عمل لهم بندًا في فواتير الفترة أو زاروه في الفترة — لا علاقةٌ تاريخية سابقة.",
      "قيمة أعماله = نصيب بنوده من صافي الفاتورة بعد الخصم؛ فاتورة بطبيبين تُقسم على بنود كلٍّ منهما.",
      "المحصّل والمتبقي يُسندان إلى البنود بقاعدة محرّك العمولات: FIFO داخل كل عملة، والرصيد الافتتاحي أولًا، ثم يُقسم على البنود بنسبة صافيها.",
      "مجموع «المحصّل من الأعمال» + «تحصيل غير منسوب» = إجمالي تقرير التحصيل للفترة داخل كل عملة.",
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
      ...moneyKpis("accrued", "العمولة على المفوتر", accrued, undefined,
        "نسبة الطبيب من قيمة أعماله المفوترة — قبل التحصيل"),
      ...moneyKpis("earned", "العمولة المكتسبة", earned, "good"),
      ...moneyKpis("paid", "المصروف للأطباء", paid, "info"),
      ...moneyKpis("due", "صافي المستحق", due, "warn"),
      countKpi("doctors", "الأطباء", new Set(filtered.map((row) => row.doctorId)).size),
    ],
    columns: [
      { key: "doctorName", label: "الطبيب" },
      { key: "currency", label: "العملة" },
      { key: "commissionPercent", label: "النسبة %", type: "percent" },
      { key: "accruedMinor", label: "العمولة على المفوتر", type: "money", currencyKey: "currency" },
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
  const bySource = new Map<string, number>();
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
      sourceLabel: patient.referralSource
        ? `${patient.referralSource}${patient.referredBy ? ` (${patient.referredBy})` : ""}`
        : "غير محدد",
    });
    const sourceKey = patient.referralSource ?? "غير محدد";
    bySource.set(sourceKey, (bySource.get(sourceKey) ?? 0) + 1);
  }
  rows.sort((a, b) => String(b.createdSort).localeCompare(String(a.createdSort)));
  /* (P3-8ب) من أين جاء المرضى الجدد — الأكثر أولًا، و«غير محدد» يُعدّ ولا يُخفى. */
  const sourceSummary = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ar"))
    .map(([source, count]) => `${source}: ${count}`)
    .join(" · ");

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
      { key: "sourceLabel", label: "المصدر" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "الأعمدة المالية بعملاتها — لا يُجمع بين عملات. والمريض يظهر وإن لم تكن له حركة مالية.",
      ...(sourceSummary ? [`من أين جاؤوا: ${sourceSummary}`] : []),
    ],
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
  for (const currency of CURRENCIES) {
    const opening = patient.openings[currency];
    if (!opening) continue;
    events.push({
      date: opening.date, description: "رصيد افتتاحي (قبل تشغيل النظام)",
      currency, debit: opening.minor, credit: 0,
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
  // (Reports R4) قاعدةٌ واحدة لنتيجة الموعد ونسبه — تقرير المواعيد وأداء المواعيد والملخّص.
  const attended = rows.filter((row) => appointmentOutcome(row.status) === "attended").length;
  const noShow = rows.filter((row) => row.status === "no_show").length;
  const cancelled = rows.filter((row) => row.status === "cancelled").length;
  const confirmed = rows.filter((row) => row.patient_confirmed).length;
  const attendanceRate = appointmentRates({ total: rows.length, attended, noShow, cancelled }).attendanceRate;

  return {
    report: "appointments",
    title: "تقرير المواعيد",
    subtitle: "الحجوزات وحالات الحضور وعدم الحضور خلال الفترة",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("appointments", "إجمالي المواعيد", rows.length),
      countKpi("done", "تمّت", done, "good"),
      countKpi("attended", "حضروا (وصل أو تمّت)", attended, "good"),
      countKpi("no-show", "لم يحضر", noShow, noShow > 0 ? "warn" : "calm"),
      countKpi("cancelled", "ملغاة", cancelled),
      countKpi("confirmed", "أكدها المريض", confirmed, "calm"),
      { key: "attendance-rate", label: "نسبة الحضور", text: rateText(attendanceRate), tone: attendanceRate === null || attendanceRate >= 80 ? "good" : "warn" },
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
      "نسبة الحضور = حضر («وصل» أو «تمّت») ÷ (حضر + لم يحضر). الإلغاء والمواعيد المفتوحة خارج المقام.",
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
      countKpi("lab-open-overdue", "كل المتأخر المفتوح (أيًّا كان الإرسال)", await openLabOverdueCount(filters.to, filters.doctorId), "bad"),
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

// ─── (Reports R4) ذكاء العيادة ───────────────────────────────────────────────
//
// كل تقرير هنا من بيانات النظام الحالية فقط: لا حقلٌ مخترع ولا مقامٌ وهمي. ما لا
// يمكن حسابه بدقة يُعرض «—» مع ملاحظة، لا رقمًا يبدو صحيحًا. والمال بدلو عملته دائمًا.

const WEEKDAY_LABEL = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** نتيجة الموعد — قاعدةٌ واحدة لتقرير المواعيد وأداء المواعيد وملخّص العيادة. */
export type AppointmentOutcome = "attended" | "no_show" | "cancelled" | "open";

export function appointmentOutcome(status: string): AppointmentOutcome {
  if (status === "done" || status === "arrived") return "attended";
  if (status === "no_show") return "no_show";
  if (status === "cancelled") return "cancelled";
  return "open";
}

function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/**
 * نسب المواعيد:
 * - الحضور = حضر ÷ (حضر + لم يحضر) — الإلغاء والمواعيد المفتوحة خارج المقام.
 * - عدم الحضور = لم يحضر ÷ (حضر + لم يحضر).
 * - الإلغاء = ملغي ÷ كل المواعيد.
 */
export function appointmentRates(counts: { total: number; attended: number; noShow: number; cancelled: number }) {
  const decided = counts.attended + counts.noShow;
  return {
    attendanceRate: percentOf(counts.attended, decided),
    noShowRate: percentOf(counts.noShow, decided),
    cancellationRate: percentOf(counts.cancelled, counts.total),
  };
}

function rateText(value: number | null): string {
  return value === null ? "—" : `${value}٪`;
}

/** رابط التقرير التفصيلي لنفس الفترة وفلاتر الطبيب/التخصص — Drill-down من بطاقة. */
function drillHref(ctx: ReportContext, section: string, report: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ section, report, preset: "custom", from: ctx.filters.from, to: ctx.filters.to });
  if (ctx.filters.doctorId) params.set("doctorId", String(ctx.filters.doctorId));
  if (ctx.filters.specialty) params.set("specialty", ctx.filters.specialty);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `/reports?${params.toString()}`;
}

function kpiOf(result: ReportResult, key: string): KpiItem | undefined {
  return result.kpis.find((kpi) => kpi.key === key);
}

function withHref(kpis: KpiItem[], href: string): KpiItem[] {
  return kpis.map((kpi) => ({ ...kpi, href }));
}

/** عدد أعمال المختبر المفتوحة المتأخرة حتى يومٍ ما — لتقرير المختبر وملخّص العيادة معًا. */
async function openLabOverdueCount(asOf: string, doctorId: number | null): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM lab_orders l
      WHERE l.status NOT IN ('received', 'delivered', 'cancelled')
        AND l.due_date < $1::date
        AND ($2::int IS NULL OR l.doctor_id = $2::int)`,
    [asOf, doctorId],
  );
  return num(rows[0]?.n);
}

// ─── 1. ملخّص العيادة ───────────────────────────────────────────────────────

async function practiceOverviewReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;
  /* كل رقمٍ هنا من المُنشئ نفسه الذي يخدم تقريره التفصيلي — فالبطاقة وتقريرها لا يختلفان. */
  const summary = periodSummary(ctx, from, to);
  const [patients, appointments, plans, recall, labOverdue] = await Promise.all([
    Promise.resolve(patientsReport(ctx)),
    appointmentsReport(ctx),
    treatmentPlansReport(ctx),
    recallReport(ctx),
    openLabOverdueCount(to, filters.doctorId),
  ]);

  const count = (result: ReportResult, key: string) => kpiOf(result, key)?.count ?? 0;
  const kpis: KpiItem[] = [
    { ...countKpi("new", "مرضى جدد", count(patients, "new"), "good"), href: drillHref(ctx, "operational", "patients") },
    { ...countKpi("visits", "الزيارات", summary.visits), href: drillHref(ctx, "operational", "visits") },
    { ...countKpi("appointments", "المواعيد", count(appointments, "appointments")), href: drillHref(ctx, "operational", "appointments") },
    { ...countKpi("attended", "حضروا", count(appointments, "attended"), "good"), href: drillHref(ctx, "operational", "appointments", { group: "statusLabel" }) },
    { ...countKpi("no-show", "لم يحضروا", count(appointments, "no-show"), count(appointments, "no-show") > 0 ? "warn" : "calm"), href: drillHref(ctx, "operational", "appointments", { group: "statusLabel" }) },
    { ...countKpi("cancelled", "مواعيد ملغاة", count(appointments, "cancelled")), href: drillHref(ctx, "operational", "appointments", { group: "statusLabel" }) },
    ...withHref(moneyKpis("production", "الإنتاج (قيمة الخدمات)", summary.invoicedByCurrency), drillHref(ctx, "financial", "services")),
    ...withHref(moneyKpis("collected", "التحصيل", summary.collectedByCurrency, "good"), drillHref(ctx, "financial", "collections")),
    ...withHref(moneyKpis("outstanding", "المستحقات القائمة", summary.outstandingEnd, "warn"), drillHref(ctx, "receivables", "debt", { debtMode: "outstanding" })),
    { ...countKpi("plans", "خطط علاج بدأت", count(plans, "plans")), href: drillHref(ctx, "clinical", "treatment-plans") },
    { ...countKpi("plans-active", "خطط جارية منها", count(plans, "active"), "calm"), href: drillHref(ctx, "clinical", "treatment-plans", { group: "statusLabel" }) },
    { ...countKpi("lab-overdue", "أعمال مختبر متأخرة", labOverdue, labOverdue > 0 ? "bad" : "calm"), href: drillHref(ctx, "clinical", "lab", { sort: "daysLate:desc" }) },
    { ...countKpi("recall", "يحتاجون متابعة", count(recall, "recall-total"), "warn"), href: drillHref(ctx, "operational", "recall") },
  ];

  let comparison: ReportResult["comparison"];
  const previous = comparisonRange(from, to, filters.compare);
  if (previous) {
    const before = periodSummary(ctx, previous.from, previous.to);
    const change = (current: number, prior: number) => (prior === 0 ? null : Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10);
    const entries: ComparisonEntry[] = [
      { label: "الزيارات", currentMinor: summary.visits, previousMinor: before.visits, changePercent: change(summary.visits, before.visits), count: true },
      { label: "مرضى جدد (بحركة مالية أو زيارة)", currentMinor: summary.newPatients, previousMinor: before.newPatients, changePercent: change(summary.newPatients, before.newPatients), count: true },
    ];
    for (const currency of CURRENCIES) {
      if (summary.invoicedByCurrency[currency] !== 0 || before.invoicedByCurrency[currency] !== 0) {
        entries.push({ label: `الإنتاج (${currency})`, currency, currentMinor: summary.invoicedByCurrency[currency], previousMinor: before.invoicedByCurrency[currency], changePercent: change(summary.invoicedByCurrency[currency], before.invoicedByCurrency[currency]) });
      }
      if (summary.collectedByCurrency[currency] !== 0 || before.collectedByCurrency[currency] !== 0) {
        entries.push({ label: `التحصيل (${currency})`, currency, currentMinor: summary.collectedByCurrency[currency], previousMinor: before.collectedByCurrency[currency], changePercent: change(summary.collectedByCurrency[currency], before.collectedByCurrency[currency]) });
      }
    }
    comparison = { title: previous.label, entries };
  }

  // الاتجاه اليومي داخل الفترة (بحدٍّ أعلى ٩٢ يومًا) — من الأحداث نفسها لا من «آخر زيارة».
  const { rows: daily } = await getPool().query<{
    day: string; new_patients: string; visits: string; appointments: string; attended: string; no_show: string; cancelled: string;
  }>(
    `WITH days AS (
       SELECT d::date AS day FROM generate_series($2::date, LEAST($3::date, $2::date + 91), INTERVAL '1 day') d
     )
     SELECT days.day::text AS day,
            (SELECT COUNT(*) FROM patients p WHERE (p.created_at AT TIME ZONE $1)::date = days.day)::text AS new_patients,
            (SELECT COUNT(*) FROM visits v WHERE (v.arrived_at AT TIME ZONE $1)::date = days.day
               AND ($4::int IS NULL OR v.doctor_id = $4::int))::text AS visits,
            (SELECT COUNT(*) FROM appointments a WHERE a.scheduled_date = days.day
               AND ($4::int IS NULL OR a.doctor_id = $4::int))::text AS appointments,
            (SELECT COUNT(*) FROM appointments a WHERE a.scheduled_date = days.day AND a.status IN ('done', 'arrived')
               AND ($4::int IS NULL OR a.doctor_id = $4::int))::text AS attended,
            (SELECT COUNT(*) FROM appointments a WHERE a.scheduled_date = days.day AND a.status = 'no_show'
               AND ($4::int IS NULL OR a.doctor_id = $4::int))::text AS no_show,
            (SELECT COUNT(*) FROM appointments a WHERE a.scheduled_date = days.day AND a.status = 'cancelled'
               AND ($4::int IS NULL OR a.doctor_id = $4::int))::text AS cancelled
       FROM days ORDER BY days.day`,
    [CLINIC_TIME_ZONE, from, to, filters.doctorId],
  );

  return {
    report: "practice-overview",
    title: "ملخّص العيادة",
    subtitle: "أهم مؤشرات الفترة — اضغط أي بطاقة لفتح تقريرها التفصيلي بنفس الفترة",
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis,
    comparison,
    columns: [
      { key: "day", label: "اليوم", type: "date" },
      { key: "weekday", label: "اليوم من الأسبوع" },
      { key: "newPatients", label: "مرضى جدد", type: "count" },
      { key: "visits", label: "زيارات", type: "count" },
      { key: "appointments", label: "مواعيد", type: "count" },
      { key: "attended", label: "حضروا", type: "count" },
      { key: "noShow", label: "لم يحضروا", type: "count" },
      { key: "cancelled", label: "ملغاة", type: "count" },
    ],
    rows: daily.map((row) => ({
      day: row.day,
      weekday: WEEKDAY_LABEL[new Date(`${row.day}T12:00:00Z`).getUTCDay()],
      newPatients: num(row.new_patients),
      visits: num(row.visits),
      appointments: num(row.appointments),
      attended: num(row.attended),
      noShow: num(row.no_show),
      cancelled: num(row.cancelled),
    })),
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "كل بطاقة محسوبة بالمُنشئ نفسه الذي يخدم تقريرها التفصيلي — فالرقمان متطابقان دائمًا.",
      "الإنتاج = صافي الفواتير بعد الخصم لكل عملة؛ التحصيل والمستحقات لكل عملة على حدة ولا تُجمع العملات.",
      "أعمال المختبر المتأخرة: كل عملٍ لم يصل ولم يُركّب ولم يُلغَ وتجاوز تاريخ استحقاقه حتى نهاية الفترة.",
      "الاتجاه اليومي يعرض حتى ٩٢ يومًا من بداية الفترة؛ للفترات الأطول استخدم تقرير الاتجاهات الشهري.",
    ],
  };
}

// ─── 2. استغلال الأطباء ─────────────────────────────────────────────────────

async function providerUtilizationReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;
  const { rows: appointmentRows } = await getPool().query<{
    doctor_id: number; total: string; attended: string; no_show: string; cancelled: string;
    booked_minutes: string; patients: string;
  }>(
    `SELECT a.doctor_id,
            COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE a.status IN ('done', 'arrived'))::text AS attended,
            COUNT(*) FILTER (WHERE a.status = 'no_show')::text AS no_show,
            COUNT(*) FILTER (WHERE a.status = 'cancelled')::text AS cancelled,
            COALESCE(SUM(a.duration_minutes) FILTER (WHERE a.status <> 'cancelled'), 0)::text AS booked_minutes,
            COUNT(DISTINCT a.patient_id)::text AS patients
       FROM appointments a
      WHERE a.doctor_id IS NOT NULL AND a.scheduled_date BETWEEN $1::date AND $2::date
      GROUP BY a.doctor_id`,
    [from, to],
  );
  const appointmentsBy = new Map(appointmentRows.map((row) => [row.doctor_id, row]));

  // الزيارات من سجلها: دقائق الكرسي الفعلية = الجلوس → الانتهاء حين يُسجَّلان كلاهما.
  const visitsBy = new Map<number, { visits: number; timed: number; chairMinutes: number; patients: Set<number> }>();
  for (const visit of ctx.visits) {
    if (visit.date < from || visit.date > to || visit.doctorId === null) continue;
    const entry = visitsBy.get(visit.doctorId) ?? { visits: 0, timed: 0, chairMinutes: 0, patients: new Set<number>() };
    entry.visits += 1;
    if (visit.patientId !== null) entry.patients.add(visit.patientId);
    const minutes = minutesBetween(visit.seatedAt, visit.finishedAt);
    if (minutes !== null && minutes > 0 && minutes <= 720) {
      entry.timed += 1;
      entry.chairMinutes += minutes;
    }
    visitsBy.set(visit.doctorId, entry);
  }

  // الإنتاج من بنوده (RPT-11) والتحصيل من إسناد البنود — القاعدتان نفسهما في تقرير الطبيب.
  const production = new Map<number, Record<Currency, number>>();
  for (const patient of ctx.movements) {
    for (const invoice of patient.invoices) {
      if (invoice.date < from || invoice.date > to) continue;
      for (const line of invoice.lines) {
        if (line.doctorId === null) continue;
        const record = production.get(line.doctorId) ?? emptyCurrencyRecord();
        record[invoice.currency] += line.netMinor;
        production.set(line.doctorId, record);
      }
    }
  }
  const money = attributeContext<number>(ctx, (line) => line.doctorId);

  const rows: ReportRow[] = [];
  for (const [doctorId, doctorName] of doctors) {
    if (filters.doctorId && doctorId !== filters.doctorId) continue;
    const appointments = appointmentsBy.get(doctorId);
    const visits = visitsBy.get(doctorId);
    const produced = production.get(doctorId) ?? emptyCurrencyRecord();
    const collected = money.collected.get(doctorId) ?? emptyCurrencyRecord();
    if (!appointments && !visits && CURRENCIES.every((currency) => produced[currency] === 0 && collected[currency] === 0)) continue;
    const total = num(appointments?.total);
    const attended = num(appointments?.attended);
    const noShow = num(appointments?.no_show);
    const cancelled = num(appointments?.cancelled);
    const rates = appointmentRates({ total, attended, noShow, cancelled });
    rows.push({
      doctorId,
      doctorName,
      appointments: total,
      attended,
      noShow,
      noShowRate: rates.noShowRate,
      visits: visits?.visits ?? 0,
      patients: visits ? visits.patients.size : num(appointments?.patients),
      bookedMinutes: num(appointments?.booked_minutes),
      chairMinutes: visits?.chairMinutes ?? 0,
      avgVisitMinutes: visits && visits.timed > 0 ? Math.round(visits.chairMinutes / visits.timed) : null,
      productionText: moneyRecordText(produced),
      collectedText: moneyRecordText(collected),
      utilization: "—",
    });
  }
  rows.sort((a, b) => Number(b.visits) - Number(a.visits));

  const sum = (key: string) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  return {
    report: "provider-utilization",
    title: "استغلال الأطباء",
    subtitle: "المواعيد والزيارات ودقائق الكرسي والإنتاج والتحصيل لكل طبيب",
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      countKpi("doctors", "أطباء عملوا", rows.length),
      countKpi("appointments", "مواعيد", sum("appointments")),
      countKpi("visits", "زيارات", sum("visits")),
      countKpi("booked-minutes", "دقائق محجوزة", sum("bookedMinutes")),
      countKpi("chair-minutes", "دقائق كرسي فعلية", sum("chairMinutes"), "good"),
    ],
    columns: [
      { key: "doctorName", label: "الطبيب" },
      { key: "appointments", label: "مواعيد", type: "count" },
      { key: "attended", label: "حضروا", type: "count" },
      { key: "noShow", label: "لم يحضروا", type: "count" },
      { key: "noShowRate", label: "عدم الحضور", type: "percent" },
      { key: "visits", label: "زيارات", type: "count" },
      { key: "patients", label: "مرضى", type: "count" },
      { key: "bookedMinutes", label: "دقائق محجوزة", type: "count" },
      { key: "chairMinutes", label: "دقائق كرسي فعلية", type: "count" },
      { key: "avgVisitMinutes", label: "متوسط الزيارة (د)", type: "count" },
      { key: "productionText", label: "الإنتاج" },
      { key: "collectedText", label: "المحصّل من أعماله" },
      { key: "utilization", label: "نسبة الاستغلال" },
    ],
    rows,
    actions: [{ label: "إنتاجية الأطباء المالية", href: drillHref(ctx, "doctors", "doctor") }],
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "نسبة الاستغلال لا تُحسب: النظام لا يسجّل ساعات عمل لكل طبيب، ولن نخترع مقامًا. استغلال الكراسي في تقريره المستقل بساعات المركز.",
      "دقائق الكرسي الفعلية = من الجلوس إلى الانتهاء في الزيارات التي سُجّل فيها الوقتان (حتى ١٢ ساعة للزيارة).",
      "الإنتاج نصيب بنوده من صافي الفواتير؛ والمحصّل من أعماله بقاعدة FIFO لمحرك العمولات — كل عملة على حدة.",
      "عدم الحضور = لم يحضر ÷ (حضر + لم يحضر)؛ والمواعيد المفتوحة والملغاة خارج المقام.",
    ],
  };
}

// ─── 3. استغلال الكراسي ─────────────────────────────────────────────────────

function minutesOfShift(start: string, end: string): number {
  const toMinutes = (value: string) => {
    const [hours, minutes] = value.split(":").map(Number);
    return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : NaN;
  };
  const span = toMinutes(end) - toMinutes(start);
  return Number.isFinite(span) && span > 0 ? span : 0;
}

async function chairUtilizationReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;
  const capacity = await loadCapacityContext();
  const dailyMinutes = capacity.shifts.reduce((sum, shift) => sum + minutesOfShift(shift.start, shift.end), 0);

  const pool = getPool();
  const [operatingDays, booked, occupied] = await Promise.all([
    pool.query<{ days: string }>(
      `SELECT COUNT(*)::text AS days FROM (
         SELECT a.scheduled_date AS day FROM appointments a
          WHERE a.scheduled_date BETWEEN $2::date AND $3::date AND a.status <> 'cancelled'
         UNION
         SELECT (v.arrived_at AT TIME ZONE $1)::date FROM visits v
          WHERE (v.arrived_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
       ) d`,
      [CLINIC_TIME_ZONE, from, to],
    ),
    pool.query<{ chair: number | null; minutes: string; appointments: string }>(
      `SELECT a.chair_no AS chair, COALESCE(SUM(a.duration_minutes), 0)::text AS minutes, COUNT(*)::text AS appointments
         FROM appointments a
        WHERE a.scheduled_date BETWEEN $1::date AND $2::date
          AND a.status <> 'cancelled' AND a.occupies_chair
        GROUP BY a.chair_no`,
      [from, to],
    ),
    pool.query<{ chair: number | null; minutes: string; visits: string; timed: string }>(
      `SELECT v.chair,
              COALESCE(SUM(LEAST(EXTRACT(EPOCH FROM (v.finished_at - v.seated_at)) / 60, 720))
                FILTER (WHERE v.seated_at IS NOT NULL AND v.finished_at > v.seated_at), 0)::text AS minutes,
              COUNT(*)::text AS visits,
              COUNT(*) FILTER (WHERE v.seated_at IS NOT NULL AND v.finished_at > v.seated_at)::text AS timed
         FROM visits v
        WHERE (v.arrived_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        GROUP BY v.chair`,
      [CLINIC_TIME_ZONE, from, to],
    ),
  ]);
  const days = num(operatingDays.rows[0]?.days);
  const available = dailyMinutes * days;
  const bookedBy = new Map(booked.rows.map((row) => [row.chair, row]));
  const occupiedBy = new Map(occupied.rows.map((row) => [row.chair, row]));

  const rows: ReportRow[] = [];
  let untimed = 0;
  const chairs = [...Array.from({ length: capacity.chairs }, (_, index) => index + 1)];
  for (const chair of [...chairs, null]) {
    const bookedRow = bookedBy.get(chair);
    const occupiedRow = occupiedBy.get(chair);
    if (chair === null && !bookedRow && !occupiedRow) continue;
    const occupiedMinutes = Math.round(num(occupiedRow?.minutes));
    const bookedMinutes = num(bookedRow?.minutes);
    untimed += num(occupiedRow?.visits) - num(occupiedRow?.timed);
    const hasDenominator = chair !== null && available > 0;
    rows.push({
      chair: chair === null ? "غير مسند لكرسي" : `كرسي ${chair}`,
      availableMinutes: hasDenominator ? available : null,
      bookedMinutes,
      occupiedMinutes,
      idleMinutes: hasDenominator ? Math.max(0, available - occupiedMinutes) : null,
      bookedRate: hasDenominator ? percentOf(bookedMinutes, available) : null,
      utilization: hasDenominator ? percentOf(occupiedMinutes, available) : null,
      appointments: num(bookedRow?.appointments),
      visits: num(occupiedRow?.visits),
    });
  }

  const totalOccupied = rows.filter((row) => row.availableMinutes !== null).reduce((sum, row) => sum + Number(row.occupiedMinutes), 0);
  const totalAvailable = available * capacity.chairs;
  return {
    report: "chair-utilization",
    title: "استغلال الكراسي",
    subtitle: "الدقائق المتاحة والمحجوزة والمشغولة فعلًا والفارغة لكل كرسي",
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      countKpi("chairs", "الكراسي", capacity.chairs),
      countKpi("operating-days", "أيام تشغيل", days),
      countKpi("daily-minutes", "دقائق الدوام اليومي", dailyMinutes),
      { key: "utilization", label: "استغلال المركز", text: rateText(percentOf(totalOccupied, totalAvailable)), tone: "info" },
      countKpi("untimed", "زيارات بلا وقت جلوس/انتهاء", untimed, untimed > 0 ? "warn" : "calm",
        "لا تدخل دقائق الإشغال — سجّل الجلوس والانتهاء من شاشة الصالة"),
    ],
    columns: [
      { key: "chair", label: "الكرسي" },
      { key: "availableMinutes", label: "دقائق متاحة", type: "count" },
      { key: "bookedMinutes", label: "دقائق محجوزة", type: "count" },
      { key: "occupiedMinutes", label: "دقائق مشغولة فعلًا", type: "count" },
      { key: "idleMinutes", label: "دقائق فارغة", type: "count" },
      { key: "bookedRate", label: "نسبة الحجز", type: "percent" },
      { key: "utilization", label: "نسبة الاستغلال", type: "percent" },
      { key: "appointments", label: "مواعيد", type: "count" },
      { key: "visits", label: "زيارات", type: "count" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "المتاح = دقائق الدوام من الإعدادات (الوردية الأولى + الثانية إن وُجدت) × أيام التشغيل الفعلية.",
      "يوم التشغيل = يومٌ فيه موعدٌ غير ملغى أو زيارة مسجّلة — فأيام العطلة لا تُحسب فراغًا وهميًّا.",
      "المشغول فعلًا = الجلوس → الانتهاء في الزيارات المسجّلة على الكرسي؛ الزيارة بلا وقتين لا تُخمَّن.",
      "«غير مسند لكرسي» بلا نسبة: لا مقام له.",
    ],
  };
}

// ─── 4. أداء المواعيد ───────────────────────────────────────────────────────

async function appointmentPerformanceReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;
  const { rows } = await getPool().query<{
    status: string; doctor_name: string | null; service_name: string | null; weekday: number; hour: number;
  }>(
    `SELECT a.status, d.name AS doctor_name, COALESCE(s.name_ar, a.appointment_type) AS service_name,
            EXTRACT(DOW FROM a.scheduled_date)::int AS weekday, EXTRACT(HOUR FROM a.scheduled_time)::int AS hour
       FROM appointments a
       LEFT JOIN parties d ON d.id = a.doctor_id
       LEFT JOIN appointment_services s ON s.id = a.service_id
      WHERE a.scheduled_date BETWEEN $1::date AND $2::date
        AND ($3::int IS NULL OR a.doctor_id = $3::int)
        AND ($4::int IS NULL OR a.patient_id = $4::int)
        AND ($5::text IS NULL OR s.specialty = $5::text)`,
    [from, to, filters.doctorId, filters.patientId, filters.specialty],
  );

  type Bucket = { total: number; attended: number; noShow: number; cancelled: number; open: number };
  const empty = (): Bucket => ({ total: 0, attended: 0, noShow: 0, cancelled: 0, open: 0 });
  const add = (bucket: Bucket, outcome: AppointmentOutcome) => {
    bucket.total += 1;
    if (outcome === "attended") bucket.attended += 1;
    else if (outcome === "no_show") bucket.noShow += 1;
    else if (outcome === "cancelled") bucket.cancelled += 1;
    else bucket.open += 1;
  };
  const overall = empty();
  const dims = new Map<string, Map<string, Bucket>>();
  const dimensionOrder = ["الطبيب", "الخدمة", "يوم الأسبوع", "الفترة الزمنية"];
  for (const dimension of dimensionOrder) dims.set(dimension, new Map());
  for (const row of rows) {
    const outcome = appointmentOutcome(row.status);
    add(overall, outcome);
    const band = Math.floor(row.hour / 2) * 2;
    const keys: [string, string][] = [
      ["الطبيب", row.doctor_name ?? "بلا طبيب"],
      ["الخدمة", row.service_name ?? "غير محددة"],
      ["يوم الأسبوع", `${row.weekday}:${WEEKDAY_LABEL[row.weekday] ?? "—"}`],
      ["الفترة الزمنية", `${String(band).padStart(2, "0")}:00–${String(band + 2).padStart(2, "0")}:00`],
    ];
    for (const [dimension, value] of keys) {
      const map = dims.get(dimension)!;
      const bucket = map.get(value) ?? empty();
      add(bucket, outcome);
      map.set(value, bucket);
    }
  }

  const output: ReportRow[] = [];
  for (const dimension of dimensionOrder) {
    const entries = [...dims.get(dimension)!.entries()];
    entries.sort(([a], [b]) => (dimension === "الطبيب" || dimension === "الخدمة" ? a.localeCompare(b, "ar") : a.localeCompare(b)));
    for (const [value, bucket] of entries) {
      const rates = appointmentRates(bucket);
      output.push({
        dimension,
        value: dimension === "يوم الأسبوع" ? value.split(":")[1] : value,
        total: bucket.total,
        attended: bucket.attended,
        noShow: bucket.noShow,
        cancelled: bucket.cancelled,
        open: bucket.open,
        attendanceRate: rates.attendanceRate,
        noShowRate: rates.noShowRate,
        cancellationRate: rates.cancellationRate,
      });
    }
  }
  const rates = appointmentRates(overall);
  return {
    report: "appointment-performance",
    title: "أداء المواعيد",
    subtitle: "الحضور وعدم الحضور والإلغاء — حسب الطبيب والخدمة ويوم الأسبوع والفترة الزمنية",
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      countKpi("booked", "مواعيد الفترة", overall.total),
      countKpi("attended", "حضروا", overall.attended, "good"),
      countKpi("no-show", "لم يحضروا", overall.noShow, overall.noShow > 0 ? "warn" : "calm"),
      countKpi("cancelled", "ملغاة", overall.cancelled),
      countKpi("open", "مفتوحة (لم تُغلق بعد)", overall.open, "info"),
      { key: "attendance-rate", label: "نسبة الحضور", text: rateText(rates.attendanceRate), tone: "good" },
      { key: "no-show-rate", label: "نسبة عدم الحضور", text: rateText(rates.noShowRate), tone: "warn" },
      { key: "cancellation-rate", label: "نسبة الإلغاء", text: rateText(rates.cancellationRate) },
    ],
    columns: [
      { key: "dimension", label: "البُعد" },
      { key: "value", label: "القيمة" },
      { key: "total", label: "المواعيد", type: "count" },
      { key: "attended", label: "حضروا", type: "count" },
      { key: "noShow", label: "لم يحضروا", type: "count" },
      { key: "cancelled", label: "ملغاة", type: "count" },
      { key: "open", label: "مفتوحة", type: "count" },
      { key: "attendanceRate", label: "الحضور", type: "percent" },
      { key: "noShowRate", label: "عدم الحضور", type: "percent" },
      { key: "cancellationRate", label: "الإلغاء", type: "percent" },
    ],
    rows: output,
    actions: [{ label: "قائمة المواعيد", href: drillHref(ctx, "operational", "appointments") }],
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "حضر = «وصل» أو «تمّت». الحضور وعدم الحضور ÷ (حضر + لم يحضر)؛ الإلغاء ÷ كل المواعيد.",
      "«مفتوحة» = محجوزة لم تُغلق بعد (مستقبلية أو فائتة لم تُسجَّل نتيجتها) — خارج مقام الحضور.",
      "جمّع حسب «البُعد» لعرض كل تقسيمٍ منفصلًا. تحليل أسباب الإلغاء مؤجل حتى يُسجَّل سبب إلغاء معتمد.",
    ],
  };
}

// ─── 5. ذكاء خطط العلاج ─────────────────────────────────────────────────────

interface PlanIntelligenceRow {
  id: number; status: string; consented: boolean; currency: Currency; totalMinor: number; executedMinor: number;
  doctorName: string; specialty: string;
}

async function loadPlanIntelligence(ctx: ReportContext): Promise<PlanIntelligenceRow[]> {
  const { filters } = ctx;
  const { rows } = await getPool().query<{
    id: number; status: string; consent_at: Date | null; base_currency: string; total_minor: string;
    executed_minor: string; doctor_name: string | null; specialty: string | null;
  }>(
    `SELECT tp.id, tp.status, tp.consent_at, tp.base_currency, tp.total_minor::text,
            COALESCE((SELECT SUM(GREATEST(pi.quantity, 0) * GREATEST(pi.unit_price_minor, 0))
                        FROM plan_items pi WHERE pi.plan_id = tp.id AND pi.status = 'done'), 0)::text AS executed_minor,
            d.name AS doctor_name, tp.specialty
       FROM treatment_plans tp
       LEFT JOIN parties d ON d.id = tp.primary_doctor_id
      WHERE tp.start_date BETWEEN $1::date AND $2::date
        AND ($3::int IS NULL OR tp.patient_id = $3::int)
        AND ($4::int IS NULL OR tp.primary_doctor_id = $4::int
             OR EXISTS (SELECT 1 FROM plan_items pi WHERE pi.plan_id = tp.id AND pi.doctor_id = $4::int))
        AND ($5::text IS NULL OR tp.specialty = $5::text
             OR EXISTS (SELECT 1 FROM plan_items pi WHERE pi.plan_id = tp.id AND pi.category = $5::text))`,
    [filters.from, filters.to, filters.patientId, filters.doctorId, filters.specialty],
  );
  return rows.map((row) => {
    const totalMinor = num(row.total_minor);
    return {
      id: row.id,
      status: row.status,
      consented: row.consent_at !== null,
      currency: requireCurrency(row.base_currency, "خطة علاج", row.id),
      totalMinor,
      // المنفّذ = بنود «تمّت» بسعرها، ولا يتجاوز قيمة الخطة المتفق عليها.
      executedMinor: Math.min(totalMinor, num(row.executed_minor)),
      doctorName: row.doctor_name ?? "بلا طبيب رئيسي",
      specialty: row.specialty ? (CATEGORY_LABEL[row.specialty] ?? row.specialty) : "عام",
    };
  }).filter((row) => filters.currency === "all" || row.currency === filters.currency);
}

async function planIntelligenceReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const plans = await loadPlanIntelligence(ctx);
  const unscheduled = await unscheduledTreatmentRows(ctx);
  const byStatus = (status: string) => plans.filter((plan) => plan.status === status).length;
  const approved = plans.filter((plan) => plan.consented).length;
  const value = emptyCurrencyRecord();
  const executed = emptyCurrencyRecord();
  for (const plan of plans) {
    value[plan.currency] += plan.totalMinor;
    executed[plan.currency] += plan.executedMinor;
  }
  const remaining = emptyCurrencyRecord();
  for (const currency of CURRENCIES) remaining[currency] = value[currency] - executed[currency];

  const rows: ReportRow[] = [];
  for (const [dimension, keyOf] of [
    ["الطبيب", (plan: PlanIntelligenceRow) => plan.doctorName],
    ["التخصص", (plan: PlanIntelligenceRow) => plan.specialty],
  ] as const) {
    const groups = new Map<string, PlanIntelligenceRow[]>();
    for (const plan of plans) {
      const key = `${keyOf(plan)}::${plan.currency}`;
      groups.set(key, [...(groups.get(key) ?? []), plan]);
    }
    for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "ar"))) {
      const [name, currency] = key.split("::");
      const groupValue = group.reduce((sum, plan) => sum + plan.totalMinor, 0);
      const groupExecuted = group.reduce((sum, plan) => sum + plan.executedMinor, 0);
      rows.push({
        dimension,
        name,
        currency,
        plans: group.length,
        approved: group.filter((plan) => plan.consented).length,
        acceptanceRate: percentOf(group.filter((plan) => plan.consented).length, group.length),
        active: group.filter((plan) => plan.status === "active").length,
        completed: group.filter((plan) => plan.status === "completed").length,
        stopped: group.filter((plan) => plan.status === "stopped").length,
        valueMinor: groupValue,
        executedMinor: groupExecuted,
        remainingMinor: groupValue - groupExecuted,
      });
    }
  }

  return {
    report: "plan-intelligence",
    title: "ذكاء خطط العلاج",
    subtitle: "الخطط الجديدة وقبولها وتنفيذها وما بقي منها — حسب الطبيب والتخصص",
    periodLabel: `${formatArabicDate(filters.from)} → ${formatArabicDate(filters.to)}`,
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      { ...countKpi("created", "خطط أُنشئت", plans.length), href: drillHref(ctx, "clinical", "treatment-plans") },
      countKpi("approved", "بموافقة موثقة", approved, "good"),
      { key: "acceptance", label: "نسبة القبول", text: rateText(percentOf(approved, plans.length)), tone: "info" },
      countKpi("active", "جارية", byStatus("active"), "calm"),
      countKpi("completed", "مكتملة", byStatus("completed"), "good"),
      countKpi("stopped", "متوقفة", byStatus("stopped"), "bad"),
      { ...countKpi("unscheduled", "علاج بلا موعد قادم", unscheduled.length, unscheduled.length > 0 ? "warn" : "calm"), href: drillHref(ctx, "intelligence", "unscheduled-treatment") },
      ...moneyKpis("value", "قيمة الخطط", value),
      ...moneyKpis("executed", "المنفّذ منها", executed, "good"),
      ...moneyKpis("remaining", "المتبقي للتنفيذ", remaining, "warn"),
    ],
    columns: [
      { key: "dimension", label: "البُعد" },
      { key: "name", label: "الاسم" },
      { key: "currency", label: "العملة" },
      { key: "plans", label: "خطط", type: "count" },
      { key: "approved", label: "موافَق عليها", type: "count" },
      { key: "acceptanceRate", label: "القبول", type: "percent" },
      { key: "active", label: "جارية", type: "count" },
      { key: "completed", label: "مكتملة", type: "count" },
      { key: "stopped", label: "متوقفة", type: "count" },
      { key: "valueMinor", label: "القيمة", type: "money", currencyKey: "currency" },
      { key: "executedMinor", label: "المنفّذ", type: "money", currencyKey: "currency" },
      { key: "remainingMinor", label: "المتبقي", type: "money", currencyKey: "currency" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "الخطط = التي بدأت في الفترة. القبول = موافقة موثّقة ÷ الخطط.",
      "المنفّذ = بنود «تمّت» × سعرها، بحدٍّ أعلى قيمة الخطة؛ المتبقي = القيمة − المنفّذ. كل عملة على حدة.",
      "«علاج بلا موعد قادم» قائمة عملٍ حالية في تقريرها المستقل.",
    ],
  };
}

// ─── 5ب. علاج غير مجدول (قائمة عمل) ─────────────────────────────────────────

async function unscheduledTreatmentRows(ctx: ReportContext): Promise<ReportRow[]> {
  const { filters } = ctx;
  const today = await dbTodayISO();
  const { rows } = await getPool().query<{
    plan_id: number; patient_id: number; patient_name: string; patient_number: string; phone: string | null;
    title: string; doctor_name: string | null; specialty: string | null; start_date: string; consent_at: Date | null;
    base_currency: string; pending_items: string; pending_minor: string; last_visit: string | null;
  }>(
    `SELECT tp.id AS plan_id, p.id AS patient_id, p.full_name AS patient_name, p.patient_number, p.phone,
            tp.title, d.name AS doctor_name, tp.specialty, tp.start_date::text AS start_date, tp.consent_at,
            tp.base_currency,
            COUNT(pi.id)::text AS pending_items,
            COALESCE(SUM(GREATEST(pi.quantity, 0) * GREATEST(pi.unit_price_minor, 0)), 0)::text AS pending_minor,
            (SELECT MAX((v.arrived_at AT TIME ZONE $1)::date)::text FROM visits v WHERE v.patient_id = p.id) AS last_visit
       FROM treatment_plans tp
       JOIN patients p ON p.id = tp.patient_id
       JOIN plan_items pi ON pi.plan_id = tp.id AND pi.status IN ('planned', 'in_progress')
       LEFT JOIN parties d ON d.id = tp.primary_doctor_id
      WHERE tp.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM appointments a
                         WHERE a.patient_id = tp.patient_id AND a.status = 'booked' AND a.scheduled_date >= $2::date)
        AND ($3::int IS NULL OR tp.patient_id = $3::int)
        AND ($4::int IS NULL OR tp.primary_doctor_id = $4::int OR pi.doctor_id = $4::int)
        AND ($5::text IS NULL OR tp.specialty = $5::text OR pi.category = $5::text)
      GROUP BY tp.id, p.id, d.name
      ORDER BY last_visit NULLS FIRST, tp.start_date`,
    [CLINIC_TIME_ZONE, today, filters.patientId, filters.doctorId, filters.specialty],
  );
  return rows.map((row) => ({
    patientId: row.patient_id,
    patientName: row.patient_name,
    patientNumber: row.patient_number,
    phone: row.phone ?? "—",
    planTitle: row.title,
    doctorName: row.doctor_name ?? "—",
    specialtyLabel: row.specialty ? (CATEGORY_LABEL[row.specialty] ?? row.specialty) : "عام",
    startDate: row.start_date,
    consentLabel: row.consent_at ? "موثقة" : "غير موثقة",
    pendingItems: num(row.pending_items),
    currency: requireCurrency(row.base_currency, "خطة علاج", row.plan_id),
    pendingMinor: num(row.pending_minor),
    lastVisit: row.last_visit ?? "",
  }));
}

async function unscheduledTreatmentReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const rows = await unscheduledTreatmentRows(ctx);
  const pending = emptyCurrencyRecord();
  for (const row of rows) pending[row.currency as Currency] += Number(row.pendingMinor);
  return {
    report: "unscheduled-treatment",
    title: "علاج غير مجدول",
    subtitle: "خطط جارية لها بنود لم تُنفّذ ولا موعد قادم للمريض — قائمة اتصال",
    periodLabel: "لقطة تشغيلية حالية",
    from: filters.from, to: filters.to, baseCurrency: base,
    kpis: [
      countKpi("plans", "خطط تحتاج جدولة", rows.length, rows.length > 0 ? "warn" : "calm"),
      countKpi("patients", "مرضى", new Set(rows.map((row) => row.patientId)).size),
      countKpi("items", "بنود معلّقة", rows.reduce((sum, row) => sum + Number(row.pendingItems), 0)),
      ...moneyKpis("pending", "قيمة البنود المعلّقة", pending, "info"),
    ],
    columns: [
      COMMON_COLUMNS.patient,
      { key: "patientNumber", label: "رقم الملف" },
      { key: "phone", label: "الهاتف" },
      { key: "planTitle", label: "الخطة" },
      { key: "doctorName", label: "الطبيب" },
      { key: "specialtyLabel", label: "التخصص" },
      { key: "startDate", label: "بدء الخطة", type: "date" },
      { key: "consentLabel", label: "الموافقة" },
      { key: "pendingItems", label: "بنود معلّقة", type: "count" },
      { key: "currency", label: "العملة" },
      { key: "pendingMinor", label: "قيمتها", type: "money", currencyKey: "currency" },
      { key: "lastVisit", label: "آخر زيارة", type: "date" },
    ],
    rows,
    actions: [{ label: "فتح شاشة المتابعة", href: "/recall" }],
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "اللقطة حالية (اليوم): خطة جارية فيها بنود «مخطط/قيد التنفيذ» ولا موعد محجوز للمريض من اليوم فصاعدًا.",
      "قيمة البنود بسعر البند في الخطة وبعملة الخطة — ليست مديونية.",
      "الأقدم زيارةً أولًا: من لم يزر أبدًا ثم الأبعد عهدًا.",
    ],
  };
}

// ─── 6. ذكاء المختبر ───────────────────────────────────────────────────────

async function labIntelligenceReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;
  const { rows } = await getPool().query<{
    lab: string; doctor_name: string | null; status: string; sent_date: string; due_date: string;
    received_date: string | null; remake: boolean; cost_minor: string | null; cost_currency: string | null;
  }>(
    `SELECT COALESCE(pa.name, l.lab_name) AS lab, d.name AS doctor_name, l.status,
            l.sent_date::text AS sent_date, l.due_date::text AS due_date,
            (l.received_at AT TIME ZONE $1)::date::text AS received_date,
            (l.remake_original_id IS NOT NULL OR l.status = 'remake') AS remake,
            l.cost_minor::text, l.cost_currency
       FROM lab_orders l
       LEFT JOIN parties pa ON pa.id = l.party_id
       LEFT JOIN parties d ON d.id = l.doctor_id
      WHERE l.sent_date BETWEEN $2::date AND $3::date
        AND ($4::int IS NULL OR l.doctor_id = $4::int)
        AND ($5::int IS NULL OR l.patient_id = $5::int)`,
    [CLINIC_TIME_ZONE, from, to, filters.doctorId, filters.patientId],
  );

  type Bucket = {
    total: number; open: number; dueInPeriod: number; overdue: number; delivered: number; remakes: number;
    turnaroundDays: number; received: number; onTime: number; cost: Record<Currency, number>;
  };
  const empty = (): Bucket => ({
    total: 0, open: 0, dueInPeriod: 0, overdue: 0, delivered: 0, remakes: 0,
    turnaroundDays: 0, received: 0, onTime: 0, cost: emptyCurrencyRecord(),
  });
  const buckets = new Map<string, Bucket>();
  const overall = empty();
  for (const row of rows) {
    const open = !["received", "delivered", "cancelled"].includes(row.status);
    const keys = [`المختبر::${row.lab}`, `الطبيب × المختبر::${row.doctor_name ?? "بلا طبيب"} ← ${row.lab}`];
    for (const bucket of [overall, ...keys.map((key) => {
      const existing = buckets.get(key) ?? empty();
      buckets.set(key, existing);
      return existing;
    })]) {
      bucket.total += 1;
      if (open) bucket.open += 1;
      if (row.due_date >= from && row.due_date <= to) bucket.dueInPeriod += 1;
      if (open && row.due_date < to) bucket.overdue += 1;
      if (row.status === "delivered") bucket.delivered += 1;
      if (row.remake) bucket.remakes += 1;
      if (row.received_date) {
        bucket.received += 1;
        bucket.turnaroundDays += Math.max(0, Math.round((toUTC(row.received_date) - toUTC(row.sent_date)) / 86_400_000));
        if (row.received_date <= row.due_date) bucket.onTime += 1;
      }
      if (row.cost_minor !== null && row.cost_currency && isCurrency(row.cost_currency)) {
        bucket.cost[row.cost_currency] += num(row.cost_minor);
      }
    }
  }

  const output: ReportRow[] = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "ar"))
    .map(([key, bucket]) => {
      const [dimension, name] = key.split("::");
      return {
        dimension,
        name,
        total: bucket.total,
        open: bucket.open,
        dueInPeriod: bucket.dueInPeriod,
        overdue: bucket.overdue,
        delivered: bucket.delivered,
        remakes: bucket.remakes,
        remakeRate: percentOf(bucket.remakes, bucket.total),
        avgTurnaround: bucket.received > 0 ? Math.round((bucket.turnaroundDays / bucket.received) * 10) / 10 : null,
        onTimeRate: percentOf(bucket.onTime, bucket.received),
        costText: moneyRecordText(bucket.cost),
      };
    });

  return {
    report: "lab-intelligence",
    title: "ذكاء المختبر",
    subtitle: "أداء كل مختبر: الحالات والتأخير والإعادات ومدة التسليم والالتزام بالموعد والتكلفة",
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      { ...countKpi("cases", "حالات أُرسلت", overall.total), href: drillHref(ctx, "clinical", "lab") },
      countKpi("open", "مفتوحة", overall.open, "calm"),
      { ...countKpi("overdue", "متأخرة", overall.overdue, overall.overdue > 0 ? "bad" : "calm"), href: drillHref(ctx, "clinical", "lab", { sort: "daysLate:desc" }) },
      countKpi("delivered", "رُكّبت للمريض", overall.delivered, "good"),
      countKpi("remakes", "إعادات", overall.remakes, overall.remakes > 0 ? "warn" : "calm"),
      { key: "turnaround", label: "متوسط أيام التسليم", text: overall.received > 0 ? String(Math.round((overall.turnaroundDays / overall.received) * 10) / 10) : "—" },
      { key: "on-time", label: "الالتزام بالموعد", text: rateText(percentOf(overall.onTime, overall.received)), tone: "info" },
      ...moneyKpis("cost", "التكلفة", overall.cost, "calm"),
    ],
    columns: [
      { key: "dimension", label: "البُعد" },
      { key: "name", label: "الاسم" },
      { key: "total", label: "حالات", type: "count" },
      { key: "open", label: "مفتوحة", type: "count" },
      { key: "dueInPeriod", label: "تستحق في الفترة", type: "count" },
      { key: "overdue", label: "متأخرة", type: "count" },
      { key: "delivered", label: "رُكّبت", type: "count" },
      { key: "remakes", label: "إعادات", type: "count" },
      { key: "remakeRate", label: "نسبة الإعادة", type: "percent" },
      { key: "avgTurnaround", label: "متوسط أيام التسليم", type: "count" },
      { key: "onTimeRate", label: "الالتزام بالموعد", type: "percent" },
      { key: "costText", label: "التكلفة" },
    ],
    rows: output,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "الحالات = الأعمال المرسلة في الفترة. المتأخرة = مفتوحة وتجاوزت الاستحقاق قبل نهاية الفترة.",
      "مدة التسليم والالتزام بالموعد تُحسب فقط للأعمال التي سُجّل وصولها (تاريخ الوصول مقابل الإرسال والاستحقاق).",
      "التكلفة لكل عملة على حدة ولا تُجمع العملات. جمّع حسب «البُعد» لفصل المختبرات عن جدول الطبيب × المختبر.",
    ],
  };
}

// ─── 7. ذكاء المرضى الجدد ──────────────────────────────────────────────────

async function newPatientIntelligenceReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;
  const { rows } = await getPool().query<{
    cohort: string; patients: string; visited: string; planned: string; consented: string; started: string;
  }>(
    `SELECT to_char((p.created_at AT TIME ZONE $1)::date, 'YYYY-MM') AS cohort,
            COUNT(*)::text AS patients,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = p.id))::text AS visited,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM treatment_plans tp WHERE tp.patient_id = p.id))::text AS planned,
            COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM treatment_plans tp WHERE tp.patient_id = p.id AND tp.consent_at IS NOT NULL))::text AS consented,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM plan_items pi JOIN treatment_plans tp ON tp.id = pi.plan_id
               WHERE tp.patient_id = p.id AND (pi.status IN ('done', 'in_progress') OR pi.started_at IS NOT NULL)
            ))::text AS started
       FROM patients p
      WHERE (p.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        AND ($4::int IS NULL OR p.id = $4::int)
      GROUP BY cohort
      ORDER BY cohort`,
    [CLINIC_TIME_ZONE, from, to, filters.patientId],
  );
  const total = { patients: 0, visited: 0, planned: 0, consented: 0, started: 0 };
  const output = rows.map((row) => {
    const values = {
      patients: num(row.patients), visited: num(row.visited), planned: num(row.planned),
      consented: num(row.consented), started: num(row.started),
    };
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += values[key];
    const [year, month] = row.cohort.split("-").map(Number);
    return {
      cohort: `${monthName(month)} ${year}`,
      ...values,
      visitRate: percentOf(values.visited, values.patients),
      planRate: percentOf(values.planned, values.patients),
      consentRate: percentOf(values.consented, values.patients),
      startRate: percentOf(values.started, values.patients),
    };
  });
  return {
    report: "new-patient-intelligence",
    title: "ذكاء المرضى الجدد",
    subtitle: "من التسجيل إلى الزيارة الأولى ثم خطة العلاج ثم بدء العلاج — لكل شهر تسجيل",
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      { ...countKpi("new", "مرضى جدد", total.patients, "good"), href: drillHref(ctx, "operational", "patients") },
      { key: "visit-rate", label: "زاروا المركز", text: `${total.visited} · ${rateText(percentOf(total.visited, total.patients))}` },
      { key: "plan-rate", label: "لهم خطة علاج", text: `${total.planned} · ${rateText(percentOf(total.planned, total.patients))}` },
      { key: "consent-rate", label: "وافقوا على خطة", text: `${total.consented} · ${rateText(percentOf(total.consented, total.patients))}` },
      { key: "start-rate", label: "بدأوا العلاج", text: `${total.started} · ${rateText(percentOf(total.started, total.patients))}`, tone: "good" },
    ],
    columns: [
      { key: "cohort", label: "شهر التسجيل" },
      { key: "patients", label: "جدد", type: "count" },
      { key: "visited", label: "زاروا", type: "count" },
      { key: "visitRate", label: "٪ الزيارة", type: "percent" },
      { key: "planned", label: "لهم خطة", type: "count" },
      { key: "planRate", label: "٪ الخطة", type: "percent" },
      { key: "consented", label: "وافقوا", type: "count" },
      { key: "consentRate", label: "٪ الموافقة", type: "percent" },
      { key: "started", label: "بدأوا العلاج", type: "count" },
      { key: "startRate", label: "٪ البدء", type: "percent" },
    ],
    rows: output,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "الأفواج بشهر تسجيل المريض؛ والتحويل يُقاس حتى اليوم (زيارة/خطة/موافقة/بند بدأ أو تمّ في أي وقت بعد التسجيل).",
      "بدء العلاج = بندٌ من خطته «قيد التنفيذ» أو «تمّ» أو له وقت بدء مسجّل.",
      "مصدر الإحالة غير متاح بعد: يحتاج حقل «مصدر الإحالة» في ملف المريض — مؤجّل ولا يُخمَّن.",
    ],
  };
}

// ─── 8. ذكاء المتابعة والاستدعاء ───────────────────────────────────────────

async function recallIntelligenceReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const { from, to } = filters;
  const recall = await recallReport(ctx);
  // مسارٌ مثبت من الأحداث: موعد «لم يحضر» في الفترة ← موعد جديد أُنشئ بعده ← زيارة بعده.
  const { rows } = await getPool().query<{
    appointment_id: number; patient_id: number; patient_name: string; patient_number: string; phone: string | null;
    scheduled_date: string; doctor_name: string | null; rebooked_on: string | null; returned_on: string | null;
  }>(
    `SELECT a.id AS appointment_id, p.id AS patient_id, p.full_name AS patient_name, p.patient_number, p.phone,
            a.scheduled_date::text AS scheduled_date, d.name AS doctor_name,
            (SELECT MIN((b.created_at AT TIME ZONE $1)::date)::text FROM appointments b
              WHERE b.patient_id = a.patient_id AND b.id <> a.id
                AND (b.created_at AT TIME ZONE $1)::date >= a.scheduled_date) AS rebooked_on,
            (SELECT MIN((v.arrived_at AT TIME ZONE $1)::date)::text FROM visits v
              WHERE v.patient_id = a.patient_id AND (v.arrived_at AT TIME ZONE $1)::date > a.scheduled_date) AS returned_on
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       LEFT JOIN parties d ON d.id = a.doctor_id
      WHERE a.status = 'no_show' AND a.scheduled_date BETWEEN $2::date AND $3::date
        AND ($4::int IS NULL OR a.doctor_id = $4::int)
        AND ($5::int IS NULL OR a.patient_id = $5::int)
      ORDER BY a.scheduled_date, a.id`,
    [CLINIC_TIME_ZONE, from, to, filters.doctorId, filters.patientId],
  );
  const rebooked = rows.filter((row) => row.rebooked_on !== null).length;
  const returned = rows.filter((row) => row.returned_on !== null).length;
  const count = (key: string) => kpiOf(recall, key)?.count ?? 0;
  return {
    report: "recall-intelligence",
    title: "ذكاء المتابعة والاستدعاء",
    subtitle: "من لم يحضر: هل أُعيد حجزه؟ هل عاد فعلًا؟ + قائمة المتابعة الحالية",
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      { ...countKpi("due-now", "يحتاجون متابعة الآن", count("recall-total"), "warn"), href: drillHref(ctx, "operational", "recall") },
      countKpi("open-past", "مواعيد فائتة لم تُغلق", count("open-past"), "warn"),
      countKpi("lapsed", "منقطعون", count("lapsed"), "calm"),
      countKpi("no-show", "لم يحضروا في الفترة", rows.length),
      { key: "rebooked", label: "أُعيد حجزهم", text: `${rebooked} · ${rateText(percentOf(rebooked, rows.length))}`, tone: "info" },
      { key: "returned", label: "عادوا فعلًا", text: `${returned} · ${rateText(percentOf(returned, rows.length))}`, tone: "good" },
    ],
    columns: [
      COMMON_COLUMNS.patient,
      { key: "patientNumber", label: "رقم الملف" },
      { key: "phone", label: "الهاتف" },
      { key: "scheduledDate", label: "الموعد الفائت", type: "date" },
      { key: "doctorName", label: "الطبيب" },
      { key: "rebookedOn", label: "أُعيد الحجز في", type: "date" },
      { key: "returnedOn", label: "عاد في", type: "date" },
      { key: "stage", label: "المرحلة" },
    ],
    rows: rows.map((row) => ({
      patientId: row.patient_id,
      patientName: row.patient_name,
      patientNumber: row.patient_number,
      phone: row.phone ?? "—",
      scheduledDate: row.scheduled_date,
      doctorName: row.doctor_name ?? "—",
      rebookedOn: row.rebooked_on ?? "",
      returnedOn: row.returned_on ?? "",
      stage: row.returned_on ? "عاد" : row.rebooked_on ? "أُعيد حجزه" : "لم يُتواصل بعد",
    })),
    actions: [{ label: "فتح شاشة المتابعة", href: "/recall" }],
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "التحويل هنا مثبت من الأحداث: موعد «لم يحضر» في الفترة ← موعدٌ جديد أُنشئ في يومه أو بعده ← زيارةٌ مسجّلة بعده.",
      "قائمة المتابعة الحالية (الفائتة، لم يحضروا، المنقطعون) من مصدر شاشة المتابعة نفسه.",
      "لا يوجد في النظام «موعد استدعاء دوري مستحق» مستقل؛ لذلك لا تُعرض نسبة تحويل استدعاءات دورية.",
    ],
  };
}

// ─── 9. الاتجاهات ───────────────────────────────────────────────────────────

async function practiceTrendsReport(ctx: ReportContext): Promise<ReportResult> {
  const { filters, base, doctors } = ctx;
  const from = startOfMonth(filters.from);
  // حدٌّ أعلى ٢٤ شهرًا — لا تحميل لتاريخ المركز كله.
  const to = filters.to < addMonths(from, 24) ? filters.to : addDays(addMonths(from, 24), -1);
  const months: string[] = [];
  for (let month = from; month <= to; month = addMonths(month, 1)) months.push(month.slice(0, 7));
  const monthOf = (date: string) => date.slice(0, 7);
  const label = (key: string) => {
    const [year, month] = key.split("-").map(Number);
    return `${monthName(month)} ${year}`;
  };

  type Cell = { visits: number; newPatients: number; appointments: number; noShow: number; labCases: number; services: number; production: Record<Currency, number>; collected: Record<Currency, number> };
  const cell = (): Cell => ({ visits: 0, newPatients: 0, appointments: 0, noShow: 0, labCases: 0, services: 0, production: emptyCurrencyRecord(), collected: emptyCurrencyRecord() });
  const grid = new Map<string, Cell>();
  const at = (dimension: string, name: string, month: string) => {
    const key = `${dimension}::${name}::${month}`;
    const existing = grid.get(key) ?? cell();
    grid.set(key, existing);
    return existing;
  };

  for (const visit of ctx.visits) {
    if (visit.date < from || visit.date > to) continue;
    if (filters.doctorId && visit.doctorId !== filters.doctorId) continue;
    at("المركز", "المركز", monthOf(visit.date)).visits += 1;
    if (visit.doctorId !== null) at("الطبيب", doctors.get(visit.doctorId) ?? `#${visit.doctorId}`, monthOf(visit.date)).visits += 1;
  }
  const serviceNames = new Map((await listServices()).map((service) => [service.id, service.name]));
  for (const patient of ctx.movements) {
    if (patient.createdDate && patient.createdDate >= from && patient.createdDate <= to) at("المركز", "المركز", monthOf(patient.createdDate)).newPatients += 1;
    for (const invoice of patient.invoices) {
      if (invoice.date < from || invoice.date > to) continue;
      for (const line of invoice.lines) {
        if (filters.doctorId && line.doctorId !== filters.doctorId) continue;
        const month = monthOf(invoice.date);
        at("المركز", "المركز", month).production[invoice.currency] += line.netMinor;
        at("المركز", "المركز", month).services += line.quantity;
        if (line.doctorId !== null) at("الطبيب", doctors.get(line.doctorId) ?? `#${line.doctorId}`, month).production[invoice.currency] += line.netMinor;
        const serviceName = line.serviceId !== null ? (serviceNames.get(line.serviceId) ?? line.description) : line.description;
        const service = at("الخدمة", serviceName, month);
        service.services += line.quantity;
        service.production[invoice.currency] += line.netMinor;
      }
    }
    if (!filters.doctorId) {
      for (const payment of patient.payments) {
        if (payment.date < from || payment.date > to) continue;
        at("المركز", "المركز", monthOf(payment.date)).collected[payment.settlementCurrency] += payment.kind === "refund" ? -payment.settlementMinor : payment.settlementMinor;
      }
    }
  }
  const [appointments, labs] = await Promise.all([
    getPool().query<{ month: string; total: string; no_show: string }>(
      `SELECT to_char(a.scheduled_date, 'YYYY-MM') AS month, COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE a.status = 'no_show')::text AS no_show
         FROM appointments a
        WHERE a.scheduled_date BETWEEN $1::date AND $2::date AND ($3::int IS NULL OR a.doctor_id = $3::int)
        GROUP BY month`,
      [from, to, filters.doctorId],
    ),
    getPool().query<{ month: string; lab: string; cases: string }>(
      `SELECT to_char(l.sent_date, 'YYYY-MM') AS month, COALESCE(pa.name, l.lab_name) AS lab, COUNT(*)::text AS cases
         FROM lab_orders l LEFT JOIN parties pa ON pa.id = l.party_id
        WHERE l.sent_date BETWEEN $1::date AND $2::date AND ($3::int IS NULL OR l.doctor_id = $3::int)
        GROUP BY month, lab`,
      [from, to, filters.doctorId],
    ),
  ]);
  for (const row of appointments.rows) {
    const center = at("المركز", "المركز", row.month);
    center.appointments += num(row.total);
    center.noShow += num(row.no_show);
  }
  for (const row of labs.rows) {
    at("المختبر", row.lab, row.month).labCases += num(row.cases);
    at("المركز", "المركز", row.month).labCases += num(row.cases);
  }
  for (const month of months) at("المركز", "المركز", month); // كل شهرٍ يظهر ولو كان صفرًا

  const order = ["المركز", "الطبيب", "الخدمة", "المختبر"];
  const rows: ReportRow[] = [...grid.entries()]
    .map(([key, value]) => {
      const [dimension, name, month] = key.split("::");
      return { dimension, name, month, value };
    })
    .sort((a, b) => order.indexOf(a.dimension) - order.indexOf(b.dimension) || a.name.localeCompare(b.name, "ar") || a.month.localeCompare(b.month))
    .map(({ dimension, name, month, value }) => ({
      dimension,
      name,
      monthKey: month,
      month: label(month),
      visits: dimension === "المركز" || dimension === "الطبيب" ? value.visits : null,
      newPatients: dimension === "المركز" ? value.newPatients : null,
      appointments: dimension === "المركز" ? value.appointments : null,
      noShow: dimension === "المركز" ? value.noShow : null,
      services: dimension === "المركز" || dimension === "الخدمة" ? value.services : null,
      labCases: dimension === "المركز" || dimension === "المختبر" ? value.labCases : null,
      productionText: dimension === "المختبر" ? "" : moneyRecordText(value.production),
      collectedText: dimension === "المركز" && !filters.doctorId ? moneyRecordText(value.collected) : "",
    }));

  const centerRows = rows.filter((row) => row.dimension === "المركز");
  let comparison: ReportResult["comparison"];
  const previous = comparisonRange(filters.from, filters.to, filters.compare);
  if (previous) {
    const now = periodSummary(ctx, filters.from, filters.to);
    const before = periodSummary(ctx, previous.from, previous.to);
    const change = (current: number, prior: number) => (prior === 0 ? null : Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10);
    const entries: ComparisonEntry[] = [
      { label: "الزيارات", currentMinor: now.visits, previousMinor: before.visits, changePercent: change(now.visits, before.visits), count: true },
    ];
    for (const currency of CURRENCIES) {
      if (now.invoicedByCurrency[currency] !== 0 || before.invoicedByCurrency[currency] !== 0) {
        entries.push({ label: `الإنتاج (${currency})`, currency, currentMinor: now.invoicedByCurrency[currency], previousMinor: before.invoicedByCurrency[currency], changePercent: change(now.invoicedByCurrency[currency], before.invoicedByCurrency[currency]) });
      }
    }
    comparison = { title: previous.label, entries };
  }

  return {
    report: "practice-trends",
    title: "الاتجاهات الشهرية",
    subtitle: "المركز والأطباء والخدمات والمختبرات شهرًا بشهر",
    periodLabel: `${formatArabicDate(from)} → ${formatArabicDate(to)}`,
    from, to, baseCurrency: base,
    kpis: [
      countKpi("months", "أشهر", months.length),
      countKpi("visits", "زيارات", centerRows.reduce((sum, row) => sum + Number(row.visits ?? 0), 0)),
      countKpi("new", "مرضى جدد", centerRows.reduce((sum, row) => sum + Number(row.newPatients ?? 0), 0), "good"),
      countKpi("lab", "حالات مختبر", centerRows.reduce((sum, row) => sum + Number(row.labCases ?? 0), 0)),
    ],
    comparison,
    columns: [
      { key: "dimension", label: "البُعد" },
      { key: "name", label: "الاسم" },
      { key: "month", label: "الشهر" },
      { key: "visits", label: "زيارات", type: "count" },
      { key: "newPatients", label: "مرضى جدد", type: "count" },
      { key: "appointments", label: "مواعيد", type: "count" },
      { key: "noShow", label: "لم يحضروا", type: "count" },
      { key: "services", label: "خدمات", type: "count" },
      { key: "labCases", label: "حالات مختبر", type: "count" },
      { key: "productionText", label: "الإنتاج" },
      { key: "collectedText", label: "التحصيل" },
    ],
    rows,
    filtersLabel: filtersLabelOf(filters, doctors),
    notes: [
      "المدى يبدأ من أول شهر الفترة، بحدٍّ أعلى ٢٤ شهرًا. جمّع حسب «البُعد» أو «الاسم» لعرض اتجاه طبيبٍ أو خدمةٍ أو مختبر.",
      "الإنتاج نصيب البنود من صافي الفواتير، والتحصيل تسوية الدفعات — لكل عملة على حدة ولا تُجمع العملات.",
      "للمقارنة بالفترة السابقة أو نفس الفترة قبل سنة اختر «المقارنة» في الفلاتر.",
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
