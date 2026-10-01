import {
  CLINIC_TIME_ZONE, computeDebtRows, ensureSchema, getPool, listPatientCases, listPatientPlans, openOrthoCaseFor,
} from "./db";
import { arrivalSuggestions, buildArrivalCurrencyLines, type ArrivalCurrencyLine, type ArrivalSuggestion } from "./arrival-panel";
import { listLegacyBalanceArrangements, listLegacyOpeningPositions } from "./legacy-balance-arrangements-db";
import { isCurrency, type Currency } from "./money";
import { PHASE_LABEL } from "./ortho";
import { clinicDateString } from "./schedule";

export interface ArrivalPanel {
  patientId: number;
  patientName: string;
  today: string;
  /** مواعيد اليوم للمريض — ما المتوقع سريريًا. */
  appointments: { id: number; time: string; type: string | null; status: string; doctorName: string | null; plannedTitle: string | null }[];
  /** زيارة اليوم النشطة إن وُجدت — الوصول يُنشئها أو يعيد استخدامها (LIVE-4)، لا يكررها. */
  activeVisit: { id: number; status: string } | null;
  cases: { title: string; specialty: string; status: string }[];
  ortho: { phase: string; upperWire: string | null; lowerWire: string | null; lastAdjustmentOn: string | null; legacy: boolean } | null;
  /** المال بكل عملة على حدة — null لمن لا يرى المال. */
  money: { lines: ArrivalCurrencyLine[]; suggestions: ArrivalSuggestion[] } | null;
  /** هل يملك القارئ التحصيل فعلًا (لا مجرد رؤية المال)؟ يحدده المسار من الدور وصلاحياته. */
  canCollect: boolean;
}

/**
 * (P0-D) لوحة الوصول — تجميعٌ للقراءة فقط من المصادر القائمة: الرصيد الكانوني (computeDebtRows)،
 * والرصيد السابق وترتيبه (P0-C)، وتقدم خطط الاتفاق (BILL-1)، والفواتير المفتوحة. لا كتابة ولا محرك دفع.
 */
export async function arrivalPanel(patientId: number, options: { includeMoney: boolean }): Promise<ArrivalPanel | null> {
  await ensureSchema();
  const pool = getPool();
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const { rows: [patient] } = await pool.query<{ id: number; full_name: string }>(
    `SELECT id, full_name FROM patients WHERE id = $1`, [patientId]);
  if (!patient) return null;

  const [appointmentRows, visitRows, cases, ortho] = await Promise.all([
    pool.query<{ id: number; time: string; appointment_type: string | null; status: string; doctor_name: string | null; planned_title: string | null }>(
      `SELECT a.id, to_char(a.scheduled_time, 'HH24:MI') AS time, a.appointment_type, a.status,
              d.name AS doctor_name, pv.title AS planned_title
         FROM appointments a
         LEFT JOIN parties d ON d.id = a.doctor_id
         LEFT JOIN planned_visits pv ON pv.id = a.planned_visit_id
        WHERE a.patient_id = $1 AND a.scheduled_date = $2::date AND a.status <> 'cancelled'
        ORDER BY a.scheduled_time`, [patientId, today]),
    pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM visits
        WHERE patient_id = $1 AND signed_at IS NULL AND status NOT IN ('done', 'cancelled')
          AND (arrived_at AT TIME ZONE $2)::date = $3::date
        ORDER BY id DESC LIMIT 1`, [patientId, CLINIC_TIME_ZONE, today]),
    listPatientCases(patientId),
    openOrthoCaseFor(patientId, today),
  ]);

  let money: ArrivalPanel["money"] = null;
  if (options.includeMoney) {
    const [debtRows, openings, arrangements, plans, invoiceRows] = await Promise.all([
      /* includeNonPositive: الرصيد الدائن (سالب) يُعرض «رصيد دائن» لا يُسقط صفرًا. */
      computeDebtRows([patientId], true),
      listLegacyOpeningPositions(patientId),
      listLegacyBalanceArrangements(patientId, today),
      listPatientPlans(patientId, today),
      pool.query<{ currency: string; count: string }>(
        `SELECT base_currency AS currency, count(*)::text AS count FROM invoices
          WHERE patient_id = $1 AND status = 'open' GROUP BY base_currency`, [patientId]),
    ]);
    const lines = buildArrivalCurrencyLines({
      today,
      balances: debtRows
        .filter((row) => row.patientId === patientId)
        .map((row) => ({ currency: row.currency, dueMinor: row.dueMinor })),
      openings: openings.map((row) => ({ currency: row.currency, remainingMinor: row.remainingMinor })),
      arrangements: arrangements.map((row) => ({ id: row.id, currency: row.currency, cadence: row.cadence, progress: row.progress })),
      plans: plans.map((plan) => ({
        id: plan.id, title: plan.title, baseCurrency: plan.baseCurrency, status: plan.status,
        installmentCount: plan.installments.length, progress: plan.progress,
      })),
      openInvoices: invoiceRows.rows
        .filter((row) => isCurrency(row.currency))
        .map((row) => ({ currency: row.currency as Currency, count: Number(row.count) })),
    });
    money = { lines, suggestions: arrivalSuggestions(lines) };
  }

  return {
    patientId,
    patientName: patient.full_name,
    today,
    appointments: appointmentRows.rows.map((row) => ({
      id: row.id, time: row.time, type: row.appointment_type, status: row.status,
      doctorName: row.doctor_name, plannedTitle: row.planned_title,
    })),
    activeVisit: visitRows.rows[0] ?? null,
    cases: cases
      .filter((one) => one.status === "active" || one.status === "waiting")
      .map((one) => ({ title: one.title, specialty: one.specialty, status: one.status })),
    ortho: ortho ? {
      phase: PHASE_LABEL[ortho.phase] ?? ortho.phase,
      upperWire: ortho.upperWire,
      lowerWire: ortho.lowerWire,
      lastAdjustmentOn: ortho.adjustments[0]?.doneOn ?? null,
      legacy: ortho.baselineKind === "legacy",
    } : null,
    money,
    canCollect: false,
  };
}

/**
 * (P0-D) ما يراه الكاشير: هوية المريض وماله فقط — حدّه المالي القائم بلا ملف سريري ولا مواعيد،
 * فلا مواعيد اليوم ولا حالات ولا مرحلة تقويم ولا أسلاك.
 */
export function cashierArrivalProjection(panel: ArrivalPanel): ArrivalPanel {
  return { ...panel, appointments: [], activeVisit: null, cases: [], ortho: null };
}
