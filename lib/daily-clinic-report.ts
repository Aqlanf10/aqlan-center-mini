import { CLINIC_TIME_ZONE, getPool } from "./db";
import { onClinicDaySql } from "./clinic-day-sql";
import { clinicDateString } from "./schedule";
import { buildDailyClinicReport, DailyClinicReportIntegrityError, isDailyClinicReportDate } from "./daily-clinic-report-model";
import { loadDailyClinicExpenseReport, type DailyClinicExpenseQueryRunner } from "./daily-clinic-expense-report";
import type {
  DailyClinicReport, DailyClinicSource, DailyClinicSourceInvoice, DailyClinicSourceInvoiceCorrection,
  DailyClinicSourceInvoiceLine, DailyClinicSourceItem, DailyClinicSourceLegacyAgreement,
  DailyClinicSourceOpening, DailyClinicSourcePayment, DailyClinicSourcePlan,
  DailyClinicSourceVisit, DailyClinicSourceWork,
} from "./daily-clinic-report-types";

export function getDailyClinicReportToday(): string {
  return clinicDateString(new Date(), CLINIC_TIME_ZONE);
}

type Row = Record<string, unknown>;
function integer(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
    throw new DailyClinicReportIntegrityError("Missing numeric report source");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new DailyClinicReportIntegrityError("Unsafe numeric report source");
  return number;
}
const nullableInteger = (value: unknown) => value === null || value === undefined ? null : integer(value);
const nullableText = (value: unknown) => value === null || value === undefined ? null : String(value);
function timestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== "string") throw new DailyClinicReportIntegrityError("Missing report timestamp");
  if (typeof value === "string" && (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)
    || !/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value))) {
    throw new DailyClinicReportIntegrityError("Unzoned report timestamp");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new DailyClinicReportIntegrityError("Invalid report timestamp");
  return date.toISOString();
}
const nullableTimestamp = (value: unknown) => value === null || value === undefined ? null : timestamp(value);
async function rows(runner: DailyClinicExpenseQueryRunner, sql: string, values: unknown[]): Promise<Row[]> {
  return (await runner.query(sql, values)).rows as Row[];
}

/** Exported source SQL also has a real PostgreSQL contract test; never executes schema setup. */
export const DAILY_CLINIC_VISITS_SQL = `
 SELECT v.id, v.patient_id, COALESCE(p.full_name, v.patient_name) AS patient_name, p.patient_number,
        v.arrived_at, v.signed_at, (v.signed_at AT TIME ZONE $1)::date::text AS signed_clinic_date,
        v.billing_currency, v.treatment_done, d.name AS doctor_name, pv.plan_id AS planned_plan_id
   FROM visits v
   LEFT JOIN patients p ON p.id = v.patient_id
   LEFT JOIN parties d ON d.id = v.doctor_id
   LEFT JOIN planned_visits pv ON pv.id = v.planned_visit_id
  WHERE ${onClinicDaySql("v.arrived_at", "$1", "$2::date")}
  ORDER BY v.arrived_at, v.id`;

export const DAILY_CLINIC_PROCEDURES_SQL = `
 SELECT vp.id, vp.visit_id, v.patient_id, COALESCE(pi.service_name, s.name) AS description,
        vp.quantity, vp.tooth_code, d.name AS doctor_name,
        pi.plan_id, vp.plan_item_id, vp.unit_price_minor::text AS unit_price_minor
   FROM visit_procedures vp JOIN visits v ON v.id = vp.visit_id
   LEFT JOIN services s ON s.id = vp.service_id
   LEFT JOIN plan_items pi ON pi.id = vp.plan_item_id
   LEFT JOIN parties d ON d.id = vp.doctor_id
  WHERE vp.visit_id = ANY($1::int[])
  ORDER BY vp.visit_id, vp.id`;

/** (INV-LINK REPORT) Invoice lines with their plan item, plan and case — read from the line's own link. */
export const DAILY_CLINIC_INVOICE_LINES_SQL = `
 SELECT ii.id, ii.invoice_id, ii.description, ii.total_minor::text AS total_minor,
        ii.plan_item_id, pi.plan_id, pi.case_id, pi.tooth_code
   FROM invoice_items ii
   LEFT JOIN plan_items pi ON pi.id = ii.plan_item_id
  WHERE ii.invoice_id = ANY($1::int[])
  ORDER BY ii.invoice_id, ii.id`;

/** Stored correction evidence only: the audit row written by correctInvoice. */
export const DAILY_CLINIC_INVOICE_CORRECTIONS_SQL = `
 SELECT entity_id::int AS original_invoice_id, details->>'الفاتورة_المصححة' AS corrected_invoice_number,
        details->>'السبب' AS reason, actor, created_at
   FROM audit_log
  WHERE action = 'invoice.correct' AND entity = 'invoice' AND entity_id ~ '^[0-9]{1,9}$'
    AND details ? 'الفاتورة_المصححة'
    AND (entity_id = ANY($1::text[]) OR details->>'الفاتورة_المصححة' = ANY($2::text[]))
  ORDER BY created_at, id`;

/** Historical (pre-system) agreements with their immutable coverage snapshot when one was recorded. */
export const DAILY_CLINIC_LEGACY_AGREEMENTS_SQL = `
 SELECT la.id, la.patient_id, la.service_name, la.specialty, la.tooth_code, la.currency,
        la.agreed_minor::text AS agreed_minor, la.previously_paid_minor::text AS previously_paid_minor,
        la.remaining_minor::text AS remaining_minor, la.historical_as_of::text AS historical_as_of,
        la.status, la.void_reason, la.plan_item_id, la.case_id,
        cs.agreement_id IS NOT NULL AS coverage_recorded, cs.snapshot_tooth_codes AS coverage_teeth,
        cs.snapshot_scope AS coverage_scope
   FROM legacy_treatment_agreements la
   LEFT JOIN legacy_treatment_coverage_snapshots cs ON cs.agreement_id = la.id
  WHERE la.patient_id = ANY($1::int[])
  ORDER BY la.patient_id, la.id`;

/** Caller supplies one READ ONLY REPEATABLE READ snapshot for every component. */
export async function loadDailyClinicReportSource(
  runner: DailyClinicExpenseQueryRunner,
  date: string,
  timeZone: string,
): Promise<DailyClinicSource> {
  if (!isDailyClinicReportDate(date)) throw new DailyClinicReportIntegrityError("Invalid report date");
  const clock = await rows(runner,
    `SELECT NOW() AS generated_at, (($2::date + 1)::timestamp AT TIME ZONE $1) AS cutoff`, [timeZone, date]);
  if (!clock[0]) throw new DailyClinicReportIntegrityError("Missing report clock");
  const visitsRaw = await rows(runner, DAILY_CLINIC_VISITS_SQL, [timeZone, date]);
  const visits: DailyClinicSourceVisit[] = visitsRaw.map((row) => ({
    id: integer(row.id), patientId: nullableInteger(row.patient_id), patientNumber: nullableText(row.patient_number),
    patientName: String(row.patient_name), arrivedAt: timestamp(row.arrived_at), signedAt: nullableTimestamp(row.signed_at),
    signedClinicDate: nullableText(row.signed_clinic_date), billingCurrency: nullableText(row.billing_currency),
    treatmentDone: nullableText(row.treatment_done), doctorName: nullableText(row.doctor_name),
    plannedPlanId: nullableInteger(row.planned_plan_id),
  }));
  const dayPaymentPatients = await rows(runner,
    `SELECT DISTINCT patient_id FROM payments WHERE ${onClinicDaySql("created_at", "$1", "$2::date")}`, [timeZone, date]);
  const patientIds = [...new Set([
    ...visits.flatMap((visit) => visit.patientId === null ? [] : [visit.patientId]),
    ...dayPaymentPatients.map((row) => integer(row.patient_id)),
  ])];
  const visitIds = visits.map((visit) => visit.id);
  // Empty ANY arrays remain valid and yield zero rows. No unscoped fallbacks or list caps.
  const plansRaw = await rows(runner, `
    SELECT t.id, t.patient_id, t.title, t.status, t.consent_at, t.base_currency,
           t.total_minor::text AS total_minor,
           EXISTS (SELECT 1 FROM plan_installments pi WHERE pi.plan_id = t.id) AS funded,
           EXISTS (SELECT 1 FROM plan_items x JOIN invoice_items ii ON ii.plan_item_id = x.id
                     JOIN invoices i ON i.id = ii.invoice_id
                    WHERE x.plan_id = t.id AND i.status <> 'cancelled') AS invoice_linked
      FROM treatment_plans t WHERE t.patient_id = ANY($1::int[]) ORDER BY t.id`, [patientIds]);
  const plans: DailyClinicSourcePlan[] = plansRaw.map((row) => ({
    id: integer(row.id), patientId: integer(row.patient_id), title: String(row.title), status: String(row.status),
    consentAt: nullableTimestamp(row.consent_at), currency: String(row.base_currency), totalMinor: integer(row.total_minor),
    funded: row.funded === true, invoiceLinked: row.invoice_linked === true,
  }));
  const planIds = plans.map((plan) => plan.id);
  const itemsRaw = await rows(runner, `
    SELECT id, plan_id, service_name, quantity, unit_price_minor::text AS unit_price_minor,
           status, visit_id, done_at, (done_at AT TIME ZONE $2)::date::text AS done_clinic_date
      FROM plan_items WHERE plan_id = ANY($1::int[]) ORDER BY id`, [planIds, timeZone]);
  const items: DailyClinicSourceItem[] = itemsRaw.map((row) => ({
    id: integer(row.id), planId: integer(row.plan_id), serviceName: String(row.service_name),
    quantity: integer(row.quantity), unitPriceMinor: integer(row.unit_price_minor), status: String(row.status),
    visitId: nullableInteger(row.visit_id), doneAt: nullableTimestamp(row.done_at), doneClinicDate: nullableText(row.done_clinic_date),
  }));
  const procedures = await rows(runner, DAILY_CLINIC_PROCEDURES_SQL, [visitIds]);
  const work: DailyClinicSourceWork[] = procedures.map((row) => ({
    sourceType: "procedure", id: integer(row.id), visitId: integer(row.visit_id), patientId: nullableInteger(row.patient_id),
    description: nullableText(row.description) ?? "إجراء مسجل", quantity: integer(row.quantity), toothCode: nullableInteger(row.tooth_code),
    doctorName: nullableText(row.doctor_name), planId: nullableInteger(row.plan_id), planItemId: nullableInteger(row.plan_item_id),
    unitPriceMinor: integer(row.unit_price_minor),
  }));
  const orthoRows = await rows(runner, `
    SELECT a.id, a.visit_id, c.patient_id, c.plan_id, a.done
      FROM ortho_adjustments a JOIN ortho_cases c ON c.id = a.case_id
     WHERE a.visit_id = ANY($1::int[]) ORDER BY a.visit_id, a.id`, [visitIds]);
  work.push(...orthoRows.map((row): DailyClinicSourceWork => ({
    sourceType: "ortho_adjustment", id: integer(row.id), visitId: integer(row.visit_id), patientId: integer(row.patient_id),
    description: nullableText(row.done)?.trim() || "جلسة تقويم موثقة", quantity: 1, toothCode: null,
    // Ortho adjustments record an author, not an immutable treating-doctor ID.
    // A case coordinator or note recorder is not evidence of the actual performer.
    doctorName: null, planId: nullableInteger(row.plan_id), planItemId: null, unitPriceMinor: null,
  })));
  const endoRows = await rows(runner, `
    SELECT ev.id, ev.visit_id, t.patient_id, t.tooth_code, ev.stage, d.name AS doctor_name
      FROM endo_visits ev JOIN endo_treatments t ON t.id = ev.treatment_id
      LEFT JOIN parties d ON d.id = ev.doctor_id
     WHERE ev.visit_id = ANY($1::int[]) ORDER BY ev.visit_id, ev.id`, [visitIds]);
  work.push(...endoRows.map((row): DailyClinicSourceWork => ({
    sourceType: "endo_visit", id: integer(row.id), visitId: integer(row.visit_id), patientId: integer(row.patient_id),
    description: `علاج عصب — ${String(row.stage)}`, quantity: 1, toothCode: nullableInteger(row.tooth_code),
    doctorName: nullableText(row.doctor_name), planId: null, planItemId: null, unitPriceMinor: null,
  })));
  const sessionLinks = await rows(runner, `
    SELECT DISTINCT ts.visit_id, pi.plan_id, tp.patient_id
      FROM treatment_sessions ts JOIN plan_items pi ON pi.id = ts.plan_item_id
      JOIN treatment_plans tp ON tp.id = pi.plan_id
     WHERE ts.visit_id = ANY($1::int[]) ORDER BY ts.visit_id, pi.plan_id`, [visitIds]);
  const invoicesRaw = await rows(runner, `
    SELECT id, patient_id, base_currency, total_minor::text AS total_minor,
           discount_minor::text AS discount_minor, status, plan_id, invoice_number, created_at,
           (created_at AT TIME ZONE $2)::date::text AS clinic_date
      FROM invoices WHERE patient_id = ANY($1::int[]) ORDER BY id`, [patientIds, timeZone]);
  const invoices: DailyClinicSourceInvoice[] = invoicesRaw.map((row) => ({
    id: integer(row.id), patientId: integer(row.patient_id), currency: String(row.base_currency),
    totalMinor: integer(row.total_minor), discountMinor: integer(row.discount_minor), status: String(row.status), planId: nullableInteger(row.plan_id),
    invoiceNumber: String(row.invoice_number), createdAt: timestamp(row.created_at), clinicDate: String(row.clinic_date),
  }));
  const invoiceIds = invoices.map((invoice) => invoice.id);
  // (INV-LINK REPORT) Invoice-first lines link through invoice_items.plan_item_id; invoices.plan_id may stay empty.
  const invoiceLines: DailyClinicSourceInvoiceLine[] = (await rows(runner, DAILY_CLINIC_INVOICE_LINES_SQL, [invoiceIds])).map((row) => ({
    id: integer(row.id), invoiceId: integer(row.invoice_id), description: String(row.description),
    totalMinor: integer(row.total_minor), planItemId: nullableInteger(row.plan_item_id), planId: nullableInteger(row.plan_id),
    caseId: nullableInteger(row.case_id), toothCode: nullableInteger(row.tooth_code),
  }));
  const invoiceCorrections: DailyClinicSourceInvoiceCorrection[] = (await rows(runner, DAILY_CLINIC_INVOICE_CORRECTIONS_SQL,
    [invoiceIds.map(String), invoices.map((invoice) => invoice.invoiceNumber)])).map((row) => ({
    originalInvoiceId: integer(row.original_invoice_id), correctedInvoiceNumber: String(row.corrected_invoice_number),
    reason: nullableText(row.reason), at: timestamp(row.created_at), actor: String(row.actor),
  }));
  const legacyAgreements: DailyClinicSourceLegacyAgreement[] = (await rows(runner, DAILY_CLINIC_LEGACY_AGREEMENTS_SQL, [patientIds])).map((row) => ({
    id: integer(row.id), patientId: integer(row.patient_id), serviceName: String(row.service_name), specialty: String(row.specialty),
    toothCode: nullableInteger(row.tooth_code), coverageRecorded: row.coverage_recorded === true,
    coverageTeeth: Array.isArray(row.coverage_teeth) ? (row.coverage_teeth as unknown[]).map(integer) : null,
    coverageScope: nullableText(row.coverage_scope), currency: String(row.currency),
    agreedMinor: integer(row.agreed_minor), previouslyPaidMinor: integer(row.previously_paid_minor), remainingMinor: integer(row.remaining_minor),
    historicalAsOf: String(row.historical_as_of), status: String(row.status), voidReason: nullableText(row.void_reason),
    planItemId: integer(row.plan_item_id), caseId: nullableInteger(row.case_id),
  }));
  const paymentsRaw = await rows(runner, `
    SELECT y.id, y.patient_id, p.full_name AS patient_name, y.receipt_number,
           y.invoice_id, y.plan_id, y.opening_currency, y.currency,
           y.amount_minor::text AS amount_minor, y.base_amount_minor::text AS base_amount_minor,
           y.exchange_rate::text AS exchange_rate, y.kind, y.method, y.created_at,
           (y.created_at AT TIME ZONE $2)::date::text AS clinic_date, y.reversal_of_id
      FROM payments y JOIN patients p ON p.id = y.patient_id
     WHERE y.patient_id = ANY($1::int[]) ORDER BY y.created_at, y.id`, [patientIds, timeZone]);
  const payments: DailyClinicSourcePayment[] = paymentsRaw.map((row) => ({
    id: integer(row.id), patientId: integer(row.patient_id), patientName: String(row.patient_name), receiptNumber: String(row.receipt_number),
    invoiceId: nullableInteger(row.invoice_id), planId: nullableInteger(row.plan_id), openingCurrency: nullableText(row.opening_currency),
    currency: String(row.currency), amountMinor: integer(row.amount_minor), baseAmountMinor: integer(row.base_amount_minor),
    exchangeRate: Number(row.exchange_rate), kind: String(row.kind), method: String(row.method), createdAt: timestamp(row.created_at),
    clinicDate: String(row.clinic_date), reversalOfId: nullableInteger(row.reversal_of_id),
  }));
  const openingsRaw = await rows(runner, `
    SELECT patient_id, currency, amount_minor::text AS amount_minor
      FROM patient_opening_balances WHERE patient_id = ANY($1::int[]) ORDER BY patient_id, currency`, [patientIds]);
  const openings: DailyClinicSourceOpening[] = openingsRaw.map((row) => ({
    patientId: integer(row.patient_id), currency: String(row.currency), amountMinor: integer(row.amount_minor),
  }));
  const expenses = await loadDailyClinicExpenseReport({ date, timeZone }, runner);
  return { date, clinicTimeZone: timeZone, generatedAt: timestamp(clock[0].generated_at), selectedDayCutoff: timestamp(clock[0].cutoff),
    visits, plans, items, work, invoices, invoiceLines, invoiceCorrections, legacyAgreements, payments, openings,
    additionalPlanLinks: sessionLinks.map((row) => ({ planId: integer(row.plan_id), patientId: integer(row.patient_id), visitId: integer(row.visit_id) })),
    expenses };
}

export async function loadDailyClinicReport(date: string): Promise<DailyClinicReport> {
  if (!isDailyClinicReportDate(date)) throw new DailyClinicReportIntegrityError("Invalid report date");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const source = await loadDailyClinicReportSource(client, date, CLINIC_TIME_ZONE);
    const report = buildDailyClinicReport(source);
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
