/** HR payroll uses the existing commission engine, payables and append-only expenses. */
import { createHash } from "node:crypto";
import {
  getPool, insertAuditRow, commissionReport, loadCommissionPolicyTimelines, commissionPolicyResolver, recordExpenseInTx, voidExpenseInTx,
  payableAmountSql, payableSettledTotalSql, ratesFromSettings, getSettings, CLINIC_TIME_ZONE,
  type DbClient, type DbPool,
} from "./db";
import { withTransaction } from "./transactions";
import type { SessionPayload } from "./auth";
import type { AuditAction } from "./audit";
import { CLINIC_BASE_CURRENCY, toBaseAmount, type Currency } from "./money";
import { CLINIC_ZONE_FALLBACK } from "./clinicZone";
import { clinicDateString } from "./schedule";
import { refusalMessage } from "./supplier-payments";
import {
  resolvePayTerms, loadStaffContracts, profileFromRow, hasSalary, hasCommission, PAY_BLOCKER_LABEL,
} from "./hr-pay-terms";
import {
  type HrPayrollPeriodView, type HrPayrollRunView, type HrPayrollItemView,
  type HrPayrollDisbursementView, type HrSettingsPayload, isAllowedHrCurrency,
} from "./hr-payroll-shared";
export * from "./hr-payroll-shared";

type Row = Record<string, any>;
type QueryRunner = DbClient | DbPool;
export class HrPayrollError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); this.name = "HrPayrollError"; }
}
const fail = (code: string, message: string, status = 409): never => { throw new HrPayrollError(code, status, message); };
export type HrPayrollWriteAuthorizer = ((client: DbClient) => Promise<boolean>) & { isCurrent: () => boolean };
/** HTTP callers supply the live authorizer; trusted internal writers keep their explicit actor contract. */
async function withPayrollTransaction<T>(session: SessionPayload, authorize: HrPayrollWriteAuthorizer | undefined,
  work: (client: DbClient) => Promise<T>): Promise<T> {
  manager(session);
  return withTransaction(getPool(), async client => {
    if (authorize && !(await authorize(client))) fail("authority_changed", "تغيّرت صلاحية الجلسة؛ لم تُنفّذ العملية.", 403);
    if (session.expiresAt < Date.now()) fail("session_expired", "انتهت الجلسة؛ لم تُنفّذ العملية.", 401);
    const result = await work(client);
    // Credentials remain locked until COMMIT; time may still expire while a domain lock is awaited.
    if (session.expiresAt < Date.now() || (authorize && !authorize.isCurrent())) {
      fail("session_expired", "انتهت الجلسة أثناء الانتظار؛ تراجعت العملية بالكامل.", 401);
    }
    return result;
  });
}
function manager(session: SessionPayload) {
  if (!session || session.role !== "admin") fail("forbidden", "إدارة المسير والصرف للمدير وحده.", 403);
}
function idOf(id: number | string): number {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) fail("invalid_id", "المعرّف غير صالح.", 400);
  return n;
}
const jsonObject = (v: unknown): Record<string, any> => typeof v === "string" ? JSON.parse(v) : (v ?? {}) as Record<string, any>;
const dateText = (v: string | Date): string => v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
const periodColumns = "p.*, p.start_date::text AS start_date, p.end_date::text AS end_date";
async function auditWithClient(client: DbClient, action: AuditAction, session: SessionPayload, entity: string,
  entityId: string | number, entityLabel: string, details?: Record<string, unknown>) {
  await insertAuditRow(client, { action, entity, entityId: String(entityId), entityLabel, details: details ?? null,
    actor: session.username, actorRole: session.role });
}
async function ensureStaffParty(client: DbClient, staffId: number, fullName: string, doctorId: number | null): Promise<number> {
  if (doctorId) {
    const { rows } = await client.query("SELECT id FROM parties WHERE id = $1 AND kind = 'doctor' FOR UPDATE", [doctorId]);
    if (!rows[0]) fail("doctor_missing", "جهة الطبيب المرتبطة بالعقد غير صالحة.");
    return Number(rows[0].id);
  }
  // Reuse the structural staff -> payroll item -> payable association, never a name match.
  const { rows } = await client.query(`SELECT b.party_id FROM hr_payroll_items i JOIN payables b ON b.id = i.payable_id
    WHERE i.staff_id = $1 ORDER BY i.id LIMIT 1`, [staffId]);
  if (rows[0]) return Number(rows[0].party_id);
  const created = await client.query("INSERT INTO parties (name, kind, is_active) VALUES ($1, 'employee', true) RETURNING id", [fullName]);
  return Number(created.rows[0].id);
}
function mapPeriodRow(row: Row): HrPayrollPeriodView {
  return { id: Number(row.id), periodKey: row.period_key, name: row.name, startDate: dateText(row.start_date), endDate: dateText(row.end_date),
    status: row.status, closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null, closedBy: row.closed_by,
    createdBy: row.created_by, createdAt: new Date(row.created_at).toISOString() };
}
function mapRunRow(row: Row): HrPayrollRunView {
  return { id: Number(row.id), periodId: Number(row.period_id), periodKey: row.period_key, periodName: row.period_name,
    currency: row.currency, status: row.status, totalBaseSalaryMinor: Number(row.total_base_salary_minor ?? 0),
    totalAllowancesMinor: Number(row.total_allowances_minor ?? 0), totalCommissionsMinor: Number(row.total_commissions_minor ?? 0),
    totalAdvancesMinor: Number(row.total_advances_minor ?? 0), totalDeductionsMinor: Number(row.total_deductions_minor ?? 0),
    totalNetDueMinor: Number(row.total_net_due_minor ?? 0), totalPaidMinor: Number(row.total_paid_minor ?? 0),
    totalRemainingMinor: Number(row.total_remaining_minor ?? 0), approvedBy: row.approved_by,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    createdBy: row.created_by, createdAt: new Date(row.created_at).toISOString(), itemsCount: row.items_count };
}
function mapItemRow(row: Row): HrPayrollItemView {
  return { id: Number(row.id), runId: Number(row.run_id), staffId: Number(row.staff_id), staffName: row.staff_name ?? "",
    staffJobTitle: row.staff_job_title ?? "", department: row.department ?? "", currency: row.currency,
    baseSalaryMinor: Number(row.base_salary_minor), allowancesMinor: Number(row.allowances_minor), allowanceDetails: row.allowance_details ?? [],
    commissionsMinor: Number(row.commissions_minor), commissionDetails: row.commission_details ?? [], advancesMinor: Number(row.advances_minor),
    deductionsMinor: Number(row.deductions_minor), deductionDetails: row.deduction_details ?? [], netDueMinor: Number(row.net_due_minor),
    paidMinor: Number(row.paid_minor), remainingMinor: Number(row.remaining_minor), status: row.status,
    payableId: row.payable_id ? Number(row.payable_id) : null, commissionPayableId: row.commission_payable_id ? Number(row.commission_payable_id) : null,
    payTermsSnapshot: jsonObject(row.pay_terms_snapshot), blockerCodes: row.blocker_codes ?? [],
    salaryRemainingMinor: Number(row.salary_remaining ?? row.base_salary_minor), commissionRemainingMinor: Number(row.commission_remaining ?? row.commissions_minor),
    notes: row.notes, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}
function mapDisbursementRow(row: Row): HrPayrollDisbursementView {
  return { id: Number(row.id), itemId: Number(row.item_id), staffId: Number(row.staff_id), staffName: row.staff_name,
    currency: row.currency, amountMinor: Number(row.amount_minor), paymentMethod: row.payment_method, referenceNumber: row.reference_number,
    expenseId: row.expense_id ? Number(row.expense_id) : null, disbursedBy: row.disbursed_by,
    disbursedAt: new Date(row.disbursed_at).toISOString(), notes: row.notes, clientRequestId: row.client_request_id,
    reversedAt: row.reversed_at ? new Date(row.reversed_at).toISOString() : null, reversedBy: row.reversed_by,
    reversalReason: row.reversal_reason, parts: [] };
}
async function disbursementView(row: Row, runner: QueryRunner): Promise<HrPayrollDisbursementView> {
  const view = mapDisbursementRow(row);
  const { rows } = await runner.query("SELECT * FROM hr_payroll_disbursement_parts WHERE disbursement_id = $1 ORDER BY id", [view.id]);
  view.parts = rows.map((p) => ({ component: p.component, amountMinor: Number(p.amount_minor), expenseId: Number(p.expense_id), payableId: p.payable_id }));
  return view;
}
export async function listPayrollPeriods(): Promise<HrPayrollPeriodView[]> {
  const { rows } = await getPool().query(`SELECT ${periodColumns} FROM hr_payroll_periods p ORDER BY p.period_key DESC`);
  return rows.map(mapPeriodRow);
}
export async function createPayrollPeriod(input: { periodKey: string; name: string; startDate: string; endDate: string }, session: SessionPayload, authorize?: HrPayrollWriteAuthorizer) {
  manager(session);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.periodKey)) fail("invalid_period", "الشهر غير صالح.", 400);
  const [y, m] = input.periodKey.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  if (input.startDate !== `${input.periodKey}-01` || input.endDate !== last) fail("period_dates", "تواريخ فترة الشهر غير متطابقة؛ لا تُغيّر فترة قائمة.", 409);
  return withPayrollTransaction(session, authorize, async (client) => {
    const created = await client.query(`INSERT INTO hr_payroll_periods (period_key, name, start_date, end_date, created_by)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (period_key) DO NOTHING RETURNING id`,
      [input.periodKey, input.name.trim(), input.startDate, input.endDate, session.username]);
    const { rows } = await client.query(`SELECT ${periodColumns} FROM hr_payroll_periods p WHERE period_key = $1 FOR UPDATE`, [input.periodKey]);
    if (rows[0].start_date !== input.startDate || rows[0].end_date !== input.endDate) fail("period_changed", "الفترة القائمة لها تواريخ مختلفة؛ لا يمكن إعادة كتابتها.");
    const result = mapPeriodRow(rows[0]);
    if (created.rows[0]) await auditWithClient(client, "hr.payroll.period.create", session, "hr_payroll_period", result.id, result.periodKey);
    return result;
  });
}
export async function getOrCreatePayrollPeriod(input: Parameters<typeof createPayrollPeriod>[0] | string, session: SessionPayload, authorize?: HrPayrollWriteAuthorizer) {
  if (typeof input !== "string") return createPayrollPeriod(input, session, authorize);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input)) fail("invalid_period", "الشهر غير صالح.", 400);
  const [y, m] = input.split("-").map(Number);
  return createPayrollPeriod({ periodKey: input, name: `مسير شهر ${input}`, startDate: `${input}-01`, endDate: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }, session, authorize);
}
async function lockRun(client: DbClient, runId: number): Promise<Row> {
  const head = await client.query("SELECT period_id FROM hr_payroll_runs WHERE id = $1", [runId]);
  if (!head.rows[0]) fail("run_missing", "دورة المسير غير موجودة.", 404);
  const period = await client.query(`SELECT ${periodColumns} FROM hr_payroll_periods p WHERE id = $1 FOR UPDATE`, [head.rows[0].period_id]);
  const run = await client.query("SELECT * FROM hr_payroll_runs WHERE id = $1 FOR UPDATE", [runId]);
  return { ...run.rows[0], period_status: period.rows[0].status, period_key: period.rows[0].period_key,
    period_name: period.rows[0].name, start_date: period.rows[0].start_date, end_date: period.rows[0].end_date };
}
export async function closePayrollPeriod(idOrKey: number | string, session: SessionPayload, authorize?: HrPayrollWriteAuthorizer) {
  manager(session);
  return withPayrollTransaction(session, authorize, async (client) => {
    const numeric = typeof idOrKey === "number" || /^\d+$/.test(idOrKey);
    const { rows } = await client.query(`SELECT ${periodColumns} FROM hr_payroll_periods p WHERE ${numeric ? "id" : "period_key"} = $1 FOR UPDATE`, [numeric ? idOf(idOrKey) : idOrKey]);
    if (!rows[0]) fail("period_missing", "فترة المسير غير موجودة.", 404);
    if (rows[0].status === "closed") return mapPeriodRow(rows[0]);
    const runs = await client.query("SELECT * FROM hr_payroll_runs WHERE period_id = $1 ORDER BY id FOR UPDATE", [rows[0].id]);
    if (runs.rows.some((r) => Number(r.total_remaining_minor) > 0)) fail("remaining_balance", "لا يمكن الإقفال: يوجد متبقٍ غير مسدّد.");
    if (!runs.rows.length || runs.rows.some((r) => r.status !== "approved")) fail("not_approved", "اعتمد المسيرات أولًا قبل إقفال الفترة.");
    const updated = await client.query(`UPDATE hr_payroll_periods p SET status = 'closed', closed_at = NOW(), closed_by = $2
      WHERE id = $1 RETURNING ${periodColumns}`, [rows[0].id, session.username]);
    await client.query("UPDATE hr_payroll_runs SET status = 'closed' WHERE period_id = $1", [rows[0].id]);
    await auditWithClient(client, "hr.payroll.close", session, "hr_payroll_period", rows[0].id, rows[0].period_key);
    return mapPeriodRow(updated.rows[0]);
  });
}
export async function listPayrollRuns(periodId?: number | string): Promise<HrPayrollRunView[]> {
  const { rows } = await getPool().query(`SELECT r.*, p.period_key, p.name AS period_name,
    (SELECT COUNT(*)::int FROM hr_payroll_items WHERE run_id = r.id) AS items_count
    FROM hr_payroll_runs r JOIN hr_payroll_periods p ON p.id = r.period_id
    ${periodId ? "WHERE r.period_id = $1" : ""} ORDER BY p.period_key DESC, r.currency`, periodId ? [idOf(periodId)] : []);
  return rows.map(mapRunRow);
}
export async function getPayrollRunById(id: number | string): Promise<HrPayrollRunView | null> {
  const { rows } = await getPool().query(`SELECT r.*, p.period_key, p.name AS period_name FROM hr_payroll_runs r
    JOIN hr_payroll_periods p ON p.id = r.period_id WHERE r.id = $1`, [idOf(id)]);
  return rows[0] ? mapRunRow(rows[0]) : null;
}
async function staffResolution(client: DbClient, row: Row, period: Row) {
  const resolved = resolvePayTerms(profileFromRow(row), await loadStaffContracts(client, Number(row.id)), { start: period.start_date, end: period.end_date });
  const contract = resolved.contract;
  if (contract && hasCommission(contract.kind) && contract.commissionRatePercent !== null) {
    const doctorId = contract.doctorPartyId ?? row.user_party_id;
    const resolver = commissionPolicyResolver(await loadCommissionPolicyTimelines(client));
    const dates = await client.query("SELECT ($1::date::timestamp AT TIME ZONE $3) AS start, (($2::date+1)::timestamp AT TIME ZONE $3)-interval '1 microsecond' AS finish",[period.start_date,period.end_date,CLINIC_TIME_ZONE]);
    const policies = [dates.rows[0].start,dates.rows[0].finish].map((date:Date)=>resolver(Number(doctorId),date.toISOString()));
    if (policies.some((policy)=>!policy || (policy.config?.defaultPercent ?? policy.percent)!==contract.commissionRatePercent)) resolved.blockers.push("commission_policy_conflict");
  }
  return resolved;
}
export async function calculatePayrollRun(periodId: number | string, currency: Currency, session: SessionPayload, authorize?: HrPayrollWriteAuthorizer): Promise<HrPayrollRunView> {
  manager(session);
  if (!isAllowedHrCurrency(currency)) fail("invalid_currency", "العملة غير معتمدة.", 400);
  return withPayrollTransaction(session, authorize, async (client) => {
    const { rows: periods } = await client.query(`SELECT ${periodColumns} FROM hr_payroll_periods p WHERE id = $1 FOR UPDATE`, [idOf(periodId)]);
    const period = periods[0];
    if (!period) fail("period_missing", "فترة المسير غير موجودة.", 404);
    if (period.status === "closed") fail("closed", "لا يمكن احتساب فترة مقفلة.");
    const existing = await client.query("SELECT * FROM hr_payroll_runs WHERE period_id = $1 AND currency = $2 FOR UPDATE", [period.id, currency]);
    if (existing.rows[0] && existing.rows[0].status !== "draft") fail("approved", "لا يمكن إعادة احتساب مسير معتمد.");
    const runRows = await client.query(`INSERT INTO hr_payroll_runs (period_id, currency, created_by) VALUES ($1,$2,$3)
      ON CONFLICT (period_id,currency) DO UPDATE SET status = 'draft' RETURNING *`, [period.id, currency, session.username]);
    const run = runRows.rows[0];
    const staff = await client.query(`SELECT s.*, s.hire_date::text, s.end_date::text, s.salary_effective_on::text,
      u.party_id AS user_party_id FROM hr_staff s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.work_status IN ('active','ended') ORDER BY s.id FOR SHARE OF s`);
    const commissions = await commissionReport(period.start_date, period.end_date, undefined, client);
    let baseTotal = 0, commissionTotal = 0;
    const included: number[] = [], doctors = new Set<number>();
    for (const st of staff.rows) {
      const resolved = await staffResolution(client, st, period);
      if (!resolved.inScope || !resolved.terms) continue;
      const terms = resolved.terms;
      if (!hasCommission(terms.kind) && terms.currency !== currency) continue;
      const blockers = [...resolved.blockers];
      const doctorId = resolved.contract?.doctorPartyId ?? st.user_party_id ?? null;
      let commissionMinor = 0;
      if (hasCommission(terms.kind) && doctorId) {
        if (doctors.has(Number(doctorId))) fail("duplicate_doctor", "الطبيب مرتبط بأكثر من ملف موظف في المسير نفسه؛ صحّح الربط أولًا.");
        doctors.add(Number(doctorId));
        commissionMinor = Math.max(0, commissions.find((c) => c.doctorId === Number(doctorId) && c.currency === currency)?.dueMinor ?? 0);
      } else if (hasCommission(terms.kind)) blockers.push("no_pay_terms");
      const baseMinor = blockers.length === 0 && hasSalary(terms.kind) && terms.currency === currency ? terms.salaryMinor ?? 0 : 0;
      if (blockers.length) commissionMinor = 0;
      const snapshot = { ...resolved.snapshot, doctorPartyId: doctorId };
      await client.query(`INSERT INTO hr_payroll_items (run_id,staff_id,currency,base_salary_minor,commissions_minor,
        commission_details,net_due_minor,remaining_minor,pay_terms_snapshot,blocker_codes,commission_basis_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,NOW()) ON CONFLICT (run_id,staff_id) DO UPDATE SET
        base_salary_minor=$4,commissions_minor=$5,commission_details=$6,net_due_minor=$7,remaining_minor=$7,
        pay_terms_snapshot=$8,blocker_codes=$9,commission_basis_at=NOW(),updated_at=NOW()`,
        [run.id, st.id, currency, baseMinor, commissionMinor,
          JSON.stringify(commissionMinor ? [{ source: "commissionReport", periodKey: period.period_key, amountMinor: commissionMinor }] : []),
          baseMinor + commissionMinor, JSON.stringify(snapshot), [...new Set(blockers)]]);
      included.push(Number(st.id)); baseTotal += baseMinor; commissionTotal += commissionMinor;
    }
    await client.query("DELETE FROM hr_payroll_items WHERE run_id=$1 AND NOT (staff_id = ANY($2::int[]))", [run.id, included]);
    const updated = await client.query(`UPDATE hr_payroll_runs SET total_base_salary_minor=$2,total_commissions_minor=$3,
      total_net_due_minor=$2::bigint+$3::bigint,total_remaining_minor=$2::bigint+$3::bigint WHERE id=$1 RETURNING *`, [run.id, baseTotal, commissionTotal]);
    await client.query("UPDATE hr_payroll_periods SET status='calculated' WHERE id=$1 AND status='draft'", [period.id]);
    await auditWithClient(client,"hr.payroll.calculate",session,"hr_payroll_run",run.id,`${period.period_key} (${currency})`);
    return mapRunRow({ ...updated.rows[0], period_key: period.period_key, period_name: period.name });
  });
}
export async function approvePayrollRun(runId: number | string, session: SessionPayload, authorize?: HrPayrollWriteAuthorizer): Promise<HrPayrollRunView> {
  manager(session);
  return withPayrollTransaction(session, authorize, async (client) => {
    const run = await lockRun(client, idOf(runId));
    if (run.period_status === "closed") fail("closed", "الفترة مقفلة.");
    if (run.status === "approved") return mapRunRow(run);
    const { rows: items } = await client.query(`SELECT i.*,s.full_name AS staff_name FROM hr_payroll_items i
      JOIN hr_staff s ON s.id=i.staff_id WHERE i.run_id=$1 ORDER BY i.id FOR UPDATE OF i`, [run.id]);
    if (!items.length) fail("empty_run", "لا توجد بنود لاعتمادها.");
    const rates = ratesFromSettings(await getSettings());
    for (const item of items) {
      const staffRows = await client.query(`SELECT s.*,hire_date::text,end_date::text,salary_effective_on::text,u.party_id AS user_party_id
        FROM hr_staff s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=$1 FOR UPDATE OF s`, [item.staff_id]);
      const staff = staffRows.rows[0];
      const resolved = await staffResolution(client, staff, run);
      const blockers = [...new Set([...(item.blocker_codes ?? []), ...resolved.blockers])];
      if (blockers.length) fail("pay_terms_blocked", `لا يمكن الاعتماد: ${blockers.map((b) => PAY_BLOCKER_LABEL[b as keyof typeof PAY_BLOCKER_LABEL] ?? b).join("؛ ")}. يلزم تصحيح التعارض أو قرار معتمد ثم إعادة الاحتساب.`);
      const snapshot = jsonObject(item.pay_terms_snapshot);
      const doctorId = resolved.contract?.doctorPartyId ?? staff.user_party_id ?? null;
      if (!resolved.inScope || JSON.stringify({ ...resolved.snapshot, doctorPartyId: doctorId }) !== JSON.stringify(snapshot)) {
        // JSONB key order is not stable; compare the actual earning identity, not serialization order.
        const fields = ["source","contractId","versionNumber","kind","baseSalaryMinor","currency","salaryPeriod","doctorPartyId"];
        const now = { ...resolved.snapshot, doctorPartyId: doctorId } as Row;
        if (!resolved.inScope || fields.some((f) => now[f] !== snapshot[f])) fail("stale_terms", "تغيّرت شروط الأجر بعد الاحتساب؛ أعد الاحتساب قبل الاعتماد.");
      }
      const partyId = await ensureStaffParty(client, Number(item.staff_id), item.staff_name, doctorId);
      if (Number(item.commissions_minor) > 0) {
        const current = (await commissionReport(run.start_date, run.end_date, undefined, client))
          .find((c) => c.doctorId === partyId && c.currency === item.currency);
        if ((current?.dueMinor ?? 0) < Number(item.commissions_minor)) fail("stale_commission", "تغيّر مستحق كشف الطبيب بعد الاحتساب؛ أعد الاحتساب قبل الاعتماد.");
      }
      for (const [category, amount, column] of [["salary", Number(item.base_salary_minor), "payable_id"], ["commission", Number(item.commissions_minor), "commission_payable_id"]] as const) {
        if (amount <= 0) continue;
        const rate = rates[item.currency as Currency] ?? 1;
        const payable = await client.query(`INSERT INTO payables (party_id,category,description,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [partyId, category, `مسير ${run.period_key} — ${item.staff_name}`, amount,
          item.currency, rate, toBaseAmount(amount,item.currency,CLINIC_BASE_CURRENCY,rate),CLINIC_BASE_CURRENCY,session.username]);
        await client.query(`UPDATE hr_payroll_items SET ${column}=$2 WHERE id=$1`, [item.id, payable.rows[0].id]);
      }
      await client.query("UPDATE hr_payroll_items SET commission_basis_at=clock_timestamp() WHERE id=$1", [item.id]);
    }
    const updated = await client.query("UPDATE hr_payroll_runs SET status='approved',approved_by=$2,approved_at=NOW() WHERE id=$1 RETURNING *", [run.id,session.username]);
    await client.query("UPDATE hr_payroll_periods SET status='approved' WHERE id=$1", [run.period_id]);
    await auditWithClient(client,"hr.payroll.approve",session,"hr_payroll_run",run.id,`${run.period_key} (${run.currency})`);
    return mapRunRow({ ...run, ...updated.rows[0] });
  });
}
const itemBalanceSelect = `i.*,s.full_name AS staff_name,s.job_title AS staff_job_title,s.department,
  CASE WHEN b.id IS NULL THEN i.base_salary_minor ELSE ${payableAmountSql("b")} - ${payableSettledTotalSql("b")} END AS salary_remaining,
  CASE WHEN c.id IS NULL THEN i.commissions_minor ELSE ${payableAmountSql("c")} - ${payableSettledTotalSql("c")} END AS commission_remaining`;
export async function listPayrollItems(runId: number | string): Promise<HrPayrollItemView[]> {
  const { rows } = await getPool().query(`SELECT ${itemBalanceSelect} FROM hr_payroll_items i JOIN hr_staff s ON s.id=i.staff_id
    LEFT JOIN payables b ON b.id=i.payable_id LEFT JOIN payables c ON c.id=i.commission_payable_id WHERE i.run_id=$1 ORDER BY s.full_name`, [idOf(runId)]);
  const views = rows.map(mapItemRow);
  for (const view of views) {
    const disb = await getPool().query("SELECT * FROM hr_payroll_disbursements WHERE item_id=$1 ORDER BY id", [view.id]);
    view.disbursements = await Promise.all(disb.rows.map((r) => disbursementView(r,getPool())));
  }
  return views;
}
export interface DisburseInput {
  amount?: number; amountMinor?: number; components?: { salaryMinor?: number; commissionMinor?: number };
  paymentMethod?: string; referenceNumber?: string | null; notes?: string | null; clientRequestId?: string | null; safeOrBankId?: string | null;
}
function normalizeDisbursement(itemId: number, input: DisburseInput, session: SessionPayload) {
  manager(session);
  const key = input.clientRequestId?.trim() || null;
  if (key && (key.length < 8 || key.length > 100)) fail("invalid_key", "مفتاح الطلب يجب أن يكون بين 8 و100 حرف.", 400);
  const method = input.paymentMethod ?? "cash";
  if (method !== "cash" || input.safeOrBankId) fail("unsupported_payment", "هذا المسار يسجّل صرفًا في وردية الصندوق فقط؛ تحويل البنك يحتاج مساره المحاسبي المعتمد.", 400);
  const amount = input.amountMinor ?? input.amount;
  const components = input.components === undefined ? null : { salaryMinor: input.components.salaryMinor ?? 0, commissionMinor: input.components.commissionMinor ?? 0 };
  for (const n of [amount, components?.salaryMinor, components?.commissionMinor]) {
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0)) fail("invalid_amount", "المبلغ يجب أن يكون عددًا صحيحًا من الوحدات الصغرى.", 400);
  }
  if (components && amount !== undefined && amount !== components.salaryMinor + components.commissionMinor) fail("components_mismatch", "مجموع توزيع الراتب والعمولة لا يطابق المبلغ.", 400);
  const total = components ? components.salaryMinor + components.commissionMinor : amount ?? 0;
  if (!Number.isSafeInteger(total) || total <= 0) fail("invalid_amount", "مبلغ الصرف يجب أن يكون أكبر من الصفر.", 400);
  const reference = input.referenceNumber?.trim() || null, notes = input.notes?.trim() || null;
  if ((reference?.length ?? 0) > 100 || (notes?.length ?? 0) > 1000) fail("invalid_text", "المرجع أو الملاحظة أطول من المسموح.", 400);
  const fingerprint = createHash("sha256").update(JSON.stringify({ itemId,total,components,method,reference,notes,actorId: session.userId })).digest("hex");
  return { itemId, key, total, components, method, reference, notes, fingerprint };
}
export async function findDisbursementByRequestId(key: string, runner: QueryRunner = getPool()): Promise<HrPayrollDisbursementView | null> {
  const { rows } = await runner.query("SELECT d.*,s.full_name AS staff_name FROM hr_payroll_disbursements d JOIN hr_staff s ON s.id=d.staff_id WHERE client_request_id=$1", [key]);
  return rows[0] ? disbursementView(rows[0],runner) : null;
}
async function replay(client: QueryRunner, key: string, fingerprint: string) {
  const { rows } = await client.query("SELECT * FROM hr_payroll_disbursements WHERE client_request_id=$1", [key]);
  if (!rows[0]) return null;
  if (rows[0].request_fingerprint !== fingerprint) fail("key_conflict", "مفتاح الطلب نفسه مرتبط بصرف مختلف؛ لا يمكن إعادة استخدامه.");
  const view = await disbursementView(rows[0],client); view.replayed = true; return view;
}
async function refreshRunTotals(client: DbClient, runId: number) {
  await client.query(`UPDATE hr_payroll_runs r SET total_paid_minor=t.paid,total_remaining_minor=t.remaining
    FROM (SELECT COALESCE(SUM(paid_minor),0) AS paid,COALESCE(SUM(remaining_minor),0) AS remaining FROM hr_payroll_items WHERE run_id=$1) t WHERE r.id=$1`, [runId]);
}
async function disburseInTx(client: DbClient, input: ReturnType<typeof normalizeDisbursement>, session: SessionPayload): Promise<HrPayrollDisbursementView> {
  if (input.key) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`hr:payroll:request:${input.key}`]);
    const existing = await replay(client,input.key,input.fingerprint); if (existing) return existing;
  }
  const head = await client.query("SELECT run_id FROM hr_payroll_items WHERE id=$1", [input.itemId]);
  if (!head.rows[0]) fail("item_missing", "بند المسير غير موجود.", 404);
  const run = await lockRun(client, Number(head.rows[0].run_id));
  if (run.period_status === "closed" || run.status === "closed") fail("closed", "فترة المسير مقفلة ولا تقبل صرفًا.");
  if (run.status !== "approved") fail("not_approved", "لا يمكن صرف مستحقات لمسير غير معتمد ماليًا.");
  const { rows } = await client.query(`SELECT ${itemBalanceSelect} FROM hr_payroll_items i JOIN hr_staff s ON s.id=i.staff_id
    LEFT JOIN payables b ON b.id=i.payable_id LEFT JOIN payables c ON c.id=i.commission_payable_id WHERE i.id=$1 FOR UPDATE OF i`, [input.itemId]);
  const item = rows[0];
  if (!jsonObject(item.pay_terms_snapshot).source) fail("legacy_payroll", "مسير سابق لا يحتوي لقطة موثّقة لشروط الأجر؛ يلزم مصالحة معتمدة قبل الصرف.");
  if (input.total > Number(item.remaining_minor)) fail("excess", "مبلغ الصرف يتجاوز المتبقي المستحق.");
  const salaryRemaining = Math.max(0,Number(item.salary_remaining)), commissionRemaining = Math.max(0,Number(item.commission_remaining));
  let components = input.components;
  if (!components) {
    if (salaryRemaining > 0 && commissionRemaining > 0 && input.total !== salaryRemaining + commissionRemaining) fail("allocation_required", "حدّد توزيع الدفعة الجزئية بين الراتب والعمولة صراحةً.", 400);
    components = { salaryMinor: salaryRemaining > 0 ? (commissionRemaining > 0 ? salaryRemaining : input.total) : 0,
      commissionMinor: salaryRemaining === 0 ? input.total : (commissionRemaining > 0 ? commissionRemaining : 0) };
  }
  if (components.salaryMinor > salaryRemaining || components.commissionMinor > commissionRemaining) fail("excess_component", "مبلغ الجزء يتجاوز المتبقي المستحق.");
  const payableIds = [item.payable_id,item.commission_payable_id].filter(Boolean);
  const parties = await client.query("SELECT DISTINCT party_id FROM payables WHERE id=ANY($1::int[]) ORDER BY party_id", [payableIds]);
  for (const party of parties.rows) await client.query("SELECT id FROM parties WHERE id=$1 FOR UPDATE", [party.party_id]);
  if (components.commissionMinor > 0) {
    const snapshot = jsonObject(item.pay_terms_snapshot), doctorId = Number(snapshot.doctorPartyId);
    if (!doctorId || !item.commission_payable_id) fail("commission_missing", "التزام العمولة غير مرتبط بمصدره؛ يلزم مراجعة المسير.");
    const earned = (await commissionReport(run.start_date,run.end_date,undefined,client)).find((c) => c.doctorId===doctorId && c.currency===item.currency);
    if (components.commissionMinor > Math.max(0,earned?.dueMinor ?? 0)) fail("doctor_already_paid", "صُرفت العمولة من كشف الطبيب أو تغيّر استحقاقها؛ لا تُصرف ثانيةً من المسير.");
  }
  const rates = ratesFromSettings(await getSettings()), rate = rates[item.currency as Currency] ?? 1;
  const parts: HrPayrollDisbursementView["parts"] = [];
  for (const [component,amount,payableId] of [["salary",components.salaryMinor,item.payable_id],["commission",components.commissionMinor,item.commission_payable_id]] as const) {
    if (!amount) continue;
    if (!payableId) fail("payable_missing", "التزام الجزء غير موجود؛ لا يُصرف بلا ربط مالي.");
    const expense = await recordExpenseInTx(client,{ hrPayrollItemId:Number(item.id), category:component,partyId:null,payeeText:item.staff_name,amountMinor:amount,
      currency:item.currency,baseCurrency:CLINIC_BASE_CURRENCY,exchangeRate:rate,payableId:Number(payableId),
      note:`صرف مسير ${run.period_key} — ${item.staff_name}${input.notes ? ` — ${input.notes}` : ""}`,createdBy:session.username,rates },rates);
    if (!expense.id) fail(expense.reason ?? "expense_refused",expense.reason === "no_shift" ? "لا توجد وردية صندوق مفتوحة. افتح الوردية من شاشة الصندوق أولًا." : refusalMessage(expense.reason ?? "no_shift",expense.quote));
    parts.push({ component,amountMinor:amount,expenseId:expense.id!,payableId:Number(payableId) });
  }
  const created = await client.query(`INSERT INTO hr_payroll_disbursements (item_id,staff_id,currency,amount_minor,payment_method,
    reference_number,expense_id,disbursed_by,notes,client_request_id,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [item.id,item.staff_id,item.currency,input.total,input.method,input.reference,parts[0].expenseId,session.username,input.notes,input.key,input.fingerprint]);
  for (const part of parts) await client.query(`INSERT INTO hr_payroll_disbursement_parts (disbursement_id,component,amount_minor,expense_id,payable_id)
    VALUES ($1,$2,$3,$4,$5)`, [created.rows[0].id,part.component,part.amountMinor,part.expenseId,part.payableId]);
  await client.query(`UPDATE hr_payroll_items SET paid_minor=paid_minor+$2,remaining_minor=remaining_minor-$2,
    status=CASE WHEN remaining_minor=$2 THEN 'fully_paid' ELSE 'partially_paid' END,updated_at=NOW() WHERE id=$1`, [item.id,input.total]);
  await refreshRunTotals(client, Number(item.run_id));
  await auditWithClient(client,"hr.payroll.disburse",session,"hr_payroll_disbursement",created.rows[0].id,item.staff_name,{ amountMinor:input.total,parts,clientRequestId:input.key });
  const view = mapDisbursementRow({ ...created.rows[0],staff_name:item.staff_name }); view.parts=parts; return view;
}
export async function disbursePayrollItem(idOrInput: number | string | (DisburseInput & { itemId: number | string }), inputOrSession: DisburseInput | SessionPayload, maybeSession?: SessionPayload, authorize?: HrPayrollWriteAuthorizer): Promise<HrPayrollDisbursementView> {
  const object = typeof idOrInput === "object", session = (object ? inputOrSession : maybeSession) as SessionPayload;
  const input = normalizeDisbursement(idOf(object ? idOrInput.itemId : idOrInput), (object ? idOrInput : inputOrSession) as DisburseInput, session);
  try { return await withPayrollTransaction(session, authorize, (client) => disburseInTx(client,input,session)); }
  catch (error) {
    // COMMIT may have reached PostgreSQL even when the response was lost. Resolve by the same key, never create another key.
    if (input.key && !(error instanceof HrPayrollError)) {
      const existing = await withPayrollTransaction(session, authorize, client => replay(client,input.key!,input.fingerprint)).catch(() => null); if (existing) return existing;
    }
    throw error;
  }
}
export async function disburseEntireRun(runId: number | string, input: DisburseInput, session: SessionPayload, authorize?: HrPayrollWriteAuthorizer): Promise<HrPayrollDisbursementView[]> {
  manager(session);
  const id = idOf(runId), key = input.clientRequestId?.trim();
  if (!key || key.length < 8 || key.length > 60) fail("batch_key", "الصرف الجماعي يتطلب مفتاح طلب ثابتًا بين 8 و60 حرف.", 400);
  return withPayrollTransaction(session, authorize, async (client) => {
    // Acquire batch and child request locks before row locks, including concurrent individual retries.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`hr:payroll:batch:${key}`]);
    const replayRows = await client.query("SELECT * FROM hr_payroll_disbursements WHERE left(client_request_id,length($1))=$1 ORDER BY id", [`${key}:item:`]);
    if (replayRows.rows.length) {
      const result: HrPayrollDisbursementView[] = [];
      for (const row of replayRows.rows) {
        const normalized = normalizeDisbursement(Number(row.item_id),{ ...input,amountMinor:Number(row.amount_minor),clientRequestId:row.client_request_id },session);
        const view = await replay(client,row.client_request_id,normalized.fingerprint); if (view) result.push(view);
        const item = await client.query("SELECT run_id FROM hr_payroll_items WHERE id=$1", [row.item_id]);
        if (Number(item.rows[0].run_id)!==id) fail("key_conflict", "مفتاح الطلب الجماعي مرتبط بمسير مختلف.");
      }
      return result;
    }
    const items = await client.query("SELECT id,remaining_minor FROM hr_payroll_items WHERE run_id=$1 AND remaining_minor>0 ORDER BY id", [id]);
    for (const item of items.rows) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`hr:payroll:request:${key}:item:${item.id}`]);
    const run = await lockRun(client,id);
    if (run.status !== "approved" || run.period_status === "closed") fail("closed", "الصرف الجماعي يتطلب مسيرًا معتمدًا وفترة غير مقفلة.");
    const results: HrPayrollDisbursementView[] = [];
    for (const item of items.rows) results.push(await disburseInTx(client,normalizeDisbursement(Number(item.id),{ ...input,amountMinor:Number(item.remaining_minor),clientRequestId:`${key}:item:${item.id}` },session),session));
    return results;
  });
}
export async function reversePayrollDisbursement(disbursementId: number | string, input: { reason: string }, session: SessionPayload, authorize?: HrPayrollWriteAuthorizer): Promise<HrPayrollDisbursementView> {
  manager(session);
  const id = idOf(disbursementId), reason = input.reason?.trim();
  if (!reason || reason.length < 2 || reason.length > 500) fail("reversal_reason", "اكتب سببًا واضحًا لعكس الصرف.", 400);
  return withPayrollTransaction(session, authorize, async (client) => {
    const head = await client.query("SELECT i.run_id FROM hr_payroll_disbursements d JOIN hr_payroll_items i ON i.id=d.item_id WHERE d.id=$1", [id]);
    if (!head.rows[0]) fail("disbursement_missing", "حركة الصرف غير موجودة.", 404);
    const run = await lockRun(client,Number(head.rows[0].run_id));
    const itemHead = await client.query("SELECT item_id FROM hr_payroll_disbursements WHERE id=$1", [id]);
    await client.query("SELECT id FROM hr_payroll_items WHERE id=$1 FOR UPDATE", [itemHead.rows[0].item_id]);
    const rows = await client.query("SELECT * FROM hr_payroll_disbursements WHERE id=$1 FOR UPDATE", [id]);
    const disb = rows.rows[0];
    if (disb.reversed_at) return disbursementView(disb,client);
    if (run.period_status === "closed") fail("closed", "الفترة مقفلة؛ تصحيحها يحتاج المسار المعتمد للفترة المفتوحة.");
    const view = await disbursementView(disb,client);
    if (!view.parts.length) fail("legacy_disbursement", "هذا الصرف قديم وغير موزّع؛ يحتاج مصالحة موثّقة قبل عكسه.");
    const parties = await client.query("SELECT DISTINCT party_id FROM payables WHERE id=ANY($1::int[]) ORDER BY party_id", [view.parts.map((p)=>p.payableId)]);
    for (const party of parties.rows) await client.query("SELECT id FROM parties WHERE id=$1 FOR UPDATE", [party.party_id]);
    for (const part of view.parts) {
      const reversal = await voidExpenseInTx(client,part.expenseId,{ actor:session.username,actorRole:session.role,reason });
      if (!reversal.ok) fail("reversal_refused",reversal.reason === "no_shift" || reversal.reason === "closed_shift" ? "افتح وردية الصندوق قبل عكس الصرف." : "تعذّر عكس السند؛ راجع حركة الصرف الأصلية.");
    }
    const updated = await client.query("UPDATE hr_payroll_disbursements SET reversed_at=NOW(),reversed_by=$2,reversal_reason=$3 WHERE id=$1 RETURNING *", [id,session.username,reason]);
    await client.query(`UPDATE hr_payroll_items SET paid_minor=paid_minor-$2,remaining_minor=remaining_minor+$2,
      status=CASE WHEN paid_minor=$2 THEN 'accrued' ELSE 'partially_paid' END,updated_at=NOW() WHERE id=$1`, [disb.item_id,Number(disb.amount_minor)]);
    await refreshRunTotals(client,Number(run.id));
    await auditWithClient(client,"hr.payroll.disburse",session,"hr_payroll_disbursement",id,"عكس الصرف",{ reason,amountMinor:-Number(disb.amount_minor) });
    return disbursementView(updated.rows[0],client);
  });
}

/* ── ٤. إعدادات وسياسات الموارد البشرية ───────────────────────────────────── */

export async function getHrSettings(runner: QueryRunner = getPool()): Promise<HrSettingsPayload> {
  const { rows } = await runner.query(`SELECT key, value FROM hr_settings`);
  const result: Record<string, any> = {};
  for (const r of rows) {
    result[r.key] = typeof r.value === "object" ? r.value : JSON.parse(String(r.value));
  }
  return {
    payrollCycle: result.payroll_cycle,
    attendancePolicy: result.attendance_policy,
    leavePolicy: result.leave_policy,
  };
}

export async function updateHrSetting(
  key: string,
  value: Record<string, unknown>,
  session: SessionPayload,
  authorize?: HrPayrollWriteAuthorizer,
): Promise<void> {
  return withPayrollTransaction(session, authorize, client => updateSettingInTx(client, key, value, session));
}

async function updateSettingInTx(client: DbClient, key: string, value: Record<string, unknown>, session: SessionPayload) {
    await client.query(
      `INSERT INTO hr_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [key, JSON.stringify(value), session.username],
    );

    await auditWithClient(
      client,
      "hr.settings.update",
      session,
      "hr_settings",
      key,
      `تحديث سياسة: ${key}`,
      { key, value },
    );
}

export async function updateHrSettings(
  patch: Partial<HrSettingsPayload>,
  session: SessionPayload,
  authorize?: HrPayrollWriteAuthorizer,
): Promise<HrSettingsPayload> {
  return withPayrollTransaction(session, authorize, async client => {
    const changes = [["payroll_cycle", patch.payrollCycle], ["attendance_policy", patch.attendancePolicy], ["leave_policy", patch.leavePolicy]] as const;
    for (const [key, value] of changes) {
      if (value !== undefined) {
        if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_setting", "صيغة سياسة الموارد البشرية غير صالحة.", 400);
        await updateSettingInTx(client, key, value, session);
      }
    }
    return getHrSettings(client);
  });
}

/* ── ٥. تقارير الموارد البشرية التنفيذية ───────────────────────────────────── */

export async function getHrReportSummary(): Promise<{
  staffSummary: {
    totalStaff: number;
    activeStaff: number;
    departmentBreakdown: Record<string, number>;
  };
  expiringContracts: Array<{
    id: string;
    staffId: string;
    staffName: string;
    contractNumber: string;
    endDate: string;
    daysRemaining: number;
  }>;
  attendanceExceptions: {
    date: string;
    latePunchesCount: number;
    incompletePunchesCount: number;
    totalOvertimeHours: number;
  };
  leaveSummary: {
    totalApprovedLeaves: number;
    pendingRequestsCount: number;
    consumedDaysThisYear: number;
  };
  payrollSummaryByCurrency: Array<{
    currency: string;
    totalNetDue: number;
    totalDisbursed: number;
    totalRemainingPayable: number;
  }>;
}> {
  const pool = getPool();

  const [staffRes, expiringRes, attRes, leaveRes, payrollRes] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int as total,
             COUNT(*) FILTER (WHERE work_status = 'active')::int as active,
             department, COUNT(*)::int as dept_count
      FROM hr_staff
      GROUP BY department
    `),
    pool.query(`
      SELECT c.id, c.staff_id, s.full_name as staff_name, c.contract_number, c.end_date,
             (c.end_date - CURRENT_DATE)::int as days_remaining
      FROM hr_contracts c
      JOIN hr_staff s ON s.id = c.staff_id
      WHERE c.status IN ('active', 'approved')
        AND c.end_date IS NOT NULL
        AND c.end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '30 days')
      ORDER BY c.end_date ASC
    `),
    pool.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'late')::int as late_count,
             COUNT(*) FILTER (WHERE is_incomplete = true)::int as incomplete_count,
             COALESCE(SUM(overtime_minutes), 0)::bigint as total_overtime_mins
      FROM hr_attendance_records
      WHERE attendance_date >= (CURRENT_DATE - INTERVAL '30 days')
    `),
    pool.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'approved')::int as approved_count,
             COUNT(*) FILTER (WHERE status = 'pending')::int as pending_count,
             COALESCE(SUM(days_count) FILTER (WHERE status = 'approved' AND EXTRACT(YEAR FROM start_date) = EXTRACT(YEAR FROM CURRENT_DATE)), 0)::numeric as consumed_days
      FROM hr_leave_requests
    `),
    pool.query(`
      SELECT currency,
             COALESCE(SUM(total_net_due_minor), 0)::bigint as total_net,
             COALESCE(SUM(total_paid_minor), 0)::bigint as total_paid,
             COALESCE(SUM(total_remaining_minor), 0)::bigint as total_remaining
      FROM hr_payroll_runs
      WHERE status IN ('approved', 'closed')
      GROUP BY currency
    `),
  ]);

  let totalStaff = 0;
  let activeStaff = 0;
  const deptMap: Record<string, number> = {};

  for (const r of staffRes.rows) {
    totalStaff += Number(r.dept_count);
    if (r.active) activeStaff += Number(r.active);
    deptMap[r.department] = Number(r.dept_count);
  }

  const expiringContracts = expiringRes.rows.map((r) => ({
    id: String(r.id),
    staffId: String(r.staff_id),
    staffName: String(r.staff_name),
    contractNumber: String(r.contract_number),
    endDate: String(r.end_date),
    daysRemaining: Number(r.days_remaining),
  }));

  const attRow = attRes.rows[0] ?? {};
  const attendanceExceptions = {
    date: clinicDateString(new Date(), CLINIC_ZONE_FALLBACK),
    latePunchesCount: Number(attRow.late_count ?? 0),
    incompletePunchesCount: Number(attRow.incomplete_count ?? 0),
    totalOvertimeHours: Math.round(Number(attRow.total_overtime_mins ?? 0) / 60),
  };

  const lRow = leaveRes.rows[0] ?? {};
  const leaveSummary = {
    totalApprovedLeaves: Number(lRow.approved_count ?? 0),
    pendingRequestsCount: Number(lRow.pending_count ?? 0),
    consumedDaysThisYear: Number(lRow.consumed_days ?? 0),
  };

  const payrollSummaryByCurrency = payrollRes.rows.map((r) => ({
    currency: String(r.currency),
    totalNetDue: Number(r.total_net),
    totalDisbursed: Number(r.total_paid),
    totalRemainingPayable: Number(r.total_remaining),
  }));

  return {
    staffSummary: {
      totalStaff,
      activeStaff,
      departmentBreakdown: deptMap,
    },
    expiringContracts,
    attendanceExceptions,
    leaveSummary,
    payrollSummaryByCurrency,
  };
}
