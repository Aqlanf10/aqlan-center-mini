/**
 * (HR-5 / HR-6) المستحقات، مسير الرواتب، وسندات الصرف — **طبقة الخادم وقاعدة البيانات**.
 *
 * المنطق المالي الخادم:
 * ١) عزل تام لكل عملة: YER وSAR وUSD منفصلة بلا جمع ولا تحويل تلقائي.
 * ٢) سحب عمولات الأطباء من مصدر العمولات الحالي المعتمد (doctor_commissions / parties).
 * ٣) الفصل بين الاستحقاق (إنشاء التزام في payables) والصرف (سند صرف في expenses يسدد الالتزام).
 * ٤) أمان التزامن ومنع الصرف الزائد عن صافي المستحق، مع مفتاح client_request_id لمنع التكرار.
 * ٥) كتابة التدقيق ذرّيًا داخل المعاملة نفسها (insertAuditRow(client, ...)).
 */

import { getPool, insertAuditRow, type DbClient, type DbPool } from "./db";
import { withTransaction } from "./transactions";
import type { SessionPayload } from "./auth";
import type { AuditAction } from "./audit";
import { type Currency } from "./money";
import {
  type HrPayrollPeriodView,
  type HrPayrollRunView,
  type HrPayrollItemView,
  type HrPayrollDisbursementView,
  type HrSettingsPayload,
  calculateItemNetDue,
  isAllowedHrCurrency,
} from "./hr-payroll-shared";

export * from "./hr-payroll-shared";

async function auditWithClient(
  client: DbClient,
  action: AuditAction,
  session: SessionPayload,
  entity: string,
  entityId: string | number,
  entityLabel: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await insertAuditRow(client, {
    action,
    entity,
    entityId: String(entityId),
    entityLabel,
    details: details ?? null,
    actor: session.username,
    actorRole: session.role,
  });
}

/* ── ١. إدارة فترات المسير ────────────────────────────────────────────────── */

export async function listPayrollPeriods(): Promise<HrPayrollPeriodView[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM hr_payroll_periods ORDER BY period_key DESC`,
  );
  return rows.map(mapPeriodRow);
}

export async function createPayrollPeriod(
  input: {
    periodKey: string; // e.g. "2026-10"
    name: string;
    startDate: string;
    endDate: string;
  },
  session: SessionPayload,
): Promise<HrPayrollPeriodView> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO hr_payroll_periods (period_key, name, start_date, end_date, status, created_by)
       VALUES ($1, $2, $3, $4, 'draft', $5)
       ON CONFLICT (period_key) DO UPDATE
       SET name = EXCLUDED.name, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date
       RETURNING *`,
      [input.periodKey, input.name.trim(), input.startDate, input.endDate, session.username],
    );

    const period = mapPeriodRow(rows[0]);
    await auditWithClient(
      client,
      "hr.payroll.period.create",
      session,
      "hr_payroll_period",
      period.id,
      `${period.periodKey} (${period.name})`,
    );
    return period;
  });
}

export async function closePayrollPeriod(
  periodId: number,
  session: SessionPayload,
): Promise<HrPayrollPeriodView> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE hr_payroll_periods
       SET status = 'closed', closed_at = NOW(), closed_by = $1
       WHERE id = $2
       RETURNING *`,
      [session.username, periodId],
    );
    if (!rows[0]) throw new Error("فترة المسير غير موجودة.");

    // إقفال كل دورات المسير التابعة لهذه الفترة
    await client.query(
      `UPDATE hr_payroll_runs SET status = 'closed' WHERE period_id = $1`,
      [periodId],
    );

    const period = mapPeriodRow(rows[0]);
    await auditWithClient(
      client,
      "hr.payroll.close",
      session,
      "hr_payroll_period",
      period.id,
      period.periodKey,
    );
    return period;
  });
}

function mapPeriodRow(row: Record<string, unknown>): HrPayrollPeriodView {
  return {
    id: Number(row.id),
    periodKey: String(row.period_key),
    name: String(row.name),
    startDate: String(row.start_date),
    endDate: String(row.end_date),
    status: row.status as any,
    closedAt: row.closed_at ? new Date(row.closed_at as string).toISOString() : null,
    closedBy: row.closed_by ? String(row.closed_by) : null,
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

/* ── ٢. احتساب دورات المسير وبنود الرواتب ─────────────────────────────────── */

export async function listPayrollRuns(periodId?: number): Promise<HrPayrollRunView[]> {
  const pool = getPool();
  const conditions = periodId ? `WHERE r.period_id = $1` : "";
  const params = periodId ? [periodId] : [];

  const { rows } = await pool.query(
    `SELECT r.*, p.period_key, p.name as period_name,
            (SELECT COUNT(*)::int FROM hr_payroll_items WHERE run_id = r.id) as items_count
     FROM hr_payroll_runs r
     JOIN hr_payroll_periods p ON p.id = r.period_id
     ${conditions}
     ORDER BY p.period_key DESC, r.currency ASC`,
    params,
  );
  return rows.map(mapRunRow);
}

export async function calculatePayrollRun(
  periodId: number,
  currency: Currency,
  session: SessionPayload,
): Promise<HrPayrollRunView> {
  if (!isAllowedHrCurrency(currency)) {
    throw new Error(`العملة غير معتمدة للمركز: ${currency}`);
  }

  return withTransaction(async (client) => {
    const { rows: periodRows } = await client.query(
      `SELECT * FROM hr_payroll_periods WHERE id = $1 FOR UPDATE`,
      [periodId],
    );
    if (!periodRows[0]) throw new Error("فترة المسير غير موجودة.");
    const period = periodRows[0];
    if (period.status === "closed") throw new Error("لا يمكن إعادة احتساب فترة مقفلة.");

    // إنشاء دورة المسير أو جلبها إذا كانت موجودة
    const { rows: runRows } = await client.query(
      `INSERT INTO hr_payroll_runs (period_id, currency, status, created_by)
       VALUES ($1, $2, 'draft', $3)
       ON CONFLICT (period_id, currency) DO UPDATE
       SET status = CASE WHEN hr_payroll_runs.status = 'closed' THEN 'closed' ELSE 'draft' END
       RETURNING *`,
      [periodId, currency, session.username],
    );
    const run = runRows[0];
    if (run.status === "closed") throw new Error("دورة المسير مقفلة.");

    // جلب جميع الموظفين النشطين المستحقين لأجر بهذه العملة
    // (راتب بهذه العملة أو نسبة/أطباء بهذه العملة)
    const staffQuery = `
      SELECT s.id, s.full_name, s.job_title, s.department, s.contract_kind,
             s.salary_amount_minor, s.salary_currency, s.salary_period, s.user_id,
             u.party_id as user_party_id
      FROM hr_staff s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.work_status = 'active'
        AND (
          (s.contract_kind IN ('salary', 'salary_commission') AND s.salary_currency = $1)
          OR (s.contract_kind IN ('commission', 'salary_commission'))
        )
      ORDER BY s.id ASC
    `;
    const { rows: staffList } = await client.query(staffQuery, [currency]);

    let totalBase = 0;
    let totalAllow = 0;
    let totalComm = 0;
    let totalAdv = 0;
    let totalDed = 0;
    let totalNet = 0;

    for (const st of staffList) {
      let baseMinor = 0;
      if (st.contract_kind !== "commission" && st.salary_currency === currency && st.salary_amount_minor) {
        baseMinor = Number(st.salary_amount_minor);
      }

      // سحب العمولات من المحرك القائم (إذا كان طبيبًا مربوطًا بجهة)
      let commMinor = 0;
      const commissionDetails: Array<{ source: string; amountMinor: number; note: string; periodKey: string }> = [];

      if ((st.contract_kind === "commission" || st.contract_kind === "salary_commission") && st.user_party_id) {
        // فحص العمولات المستحقة من جدول history أو doctor commissions
        const commRes = await client.query(
          `SELECT COALESCE(SUM(earned_minor), 0)::bigint as total_comm
           FROM doctor_commission_history
           WHERE doctor_id = $1 AND currency = $2
             AND calculated_at >= $3 AND calculated_at <= ($4::date + INTERVAL '1 day')`,
          [st.user_party_id, currency, period.start_date, period.end_date],
        );
        commMinor = Number(commRes.rows[0]?.total_comm ?? 0);
        if (commMinor > 0) {
          commissionDetails.push({
            source: "doctor_commission_history",
            amountMinor: commMinor,
            note: `عمولة الطبيب عن فترة ${period.period_key}`,
            periodKey: period.period_key,
          });
        }
      }

      // البدلات والخصومات المعتمدة لهذا الشهر من الإعدادات أو المسودة السابقة
      const allowMinor = 0;
      const advMinor = 0;
      const dedMinor = 0;

      const netDue = calculateItemNetDue({
        baseSalaryMinor: baseMinor,
        allowancesMinor: allowMinor,
        commissionsMinor: commMinor,
        advancesMinor: advMinor,
        deductionsMinor: dedMinor,
      });

      // حفظ البند مع الحفاظ على المدفوع السابق إن وجد
      await client.query(
        `INSERT INTO hr_payroll_items (
          run_id, staff_id, currency, base_salary_minor, allowances_minor,
          commissions_minor, commission_details, advances_minor, deductions_minor,
          net_due_minor, paid_minor, remaining_minor, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $10, 'accrued')
        ON CONFLICT (run_id, staff_id) DO UPDATE
        SET base_salary_minor = EXCLUDED.base_salary_minor,
            allowances_minor = EXCLUDED.allowances_minor,
            commissions_minor = EXCLUDED.commissions_minor,
            commission_details = EXCLUDED.commission_details,
            advances_minor = EXCLUDED.advances_minor,
            deductions_minor = EXCLUDED.deductions_minor,
            net_due_minor = EXCLUDED.net_due_minor,
            remaining_minor = EXCLUDED.net_due_minor - hr_payroll_items.paid_minor,
            status = CASE
              WHEN (EXCLUDED.net_due_minor - hr_payroll_items.paid_minor) = 0 THEN 'fully_paid'
              WHEN hr_payroll_items.paid_minor > 0 THEN 'partially_paid'
              ELSE 'accrued'
            END,
            updated_at = NOW()`,
        [
          run.id,
          st.id,
          currency,
          baseMinor,
          allowMinor,
          commMinor,
          JSON.stringify(commissionDetails),
          advMinor,
          dedMinor,
          netDue,
        ],
      );

      totalBase += baseMinor;
      totalAllow += allowMinor;
      totalComm += commMinor;
      totalAdv += advMinor;
      totalDed += dedMinor;
      totalNet += netDue;
    }

    // تحديث إجماليات الدورة
    const { rows: updatedRunRows } = await client.query(
      `UPDATE hr_payroll_runs
       SET total_base_salary_minor = $1, total_allowances_minor = $2, total_commissions_minor = $3,
           total_advances_minor = $4, total_deductions_minor = $5, total_net_due_minor = $6,
           total_remaining_minor = $6 - total_paid_minor
       WHERE id = $7
       RETURNING *`,
      [totalBase, totalAllow, totalComm, totalAdv, totalDed, totalNet, run.id],
    );

    // تحديث حالة الفترة إلى calculated إن كانت مسودة
    if (period.status === "draft") {
      await client.query(`UPDATE hr_payroll_periods SET status = 'calculated' WHERE id = $1`, [periodId]);
    }

    const runResult = mapRunRow({ ...period, ...updatedRunRows[0] });
    await auditWithClient(
      client,
      "hr.payroll.calculate",
      session,
      "hr_payroll_run",
      run.id,
      `${period.period_key} (${currency})`,
      { totalNetDueMinor: totalNet, currency },
    );

    return runResult;
  });
}

export async function approvePayrollRun(
  runId: number,
  session: SessionPayload,
): Promise<HrPayrollRunView> {
  return withTransaction(async (client) => {
    const { rows: runRows } = await client.query(
      `SELECT r.*, p.period_key, p.name as period_name
       FROM hr_payroll_runs r
       JOIN hr_payroll_periods p ON p.id = r.period_id
       WHERE r.id = $1 FOR UPDATE`,
      [runId],
    );
    if (!runRows[0]) throw new Error("دورة المسير غير موجودة.");
    const run = runRows[0];
    if (run.status === "approved" || run.status === "closed") {
      return mapRunRow(run);
    }

    // إنشاء التزام مالي في جدول الالتزامات (payables) لإثبات الاستحقاق دون تكرار
    const payableDesc = `مسير رواتب ${run.period_name} (${run.currency})`;
    const payableRes = await client.query(
      `INSERT INTO payables (
        category, description, amount_minor, currency, status, created_by
      ) VALUES ('salary', $1, $2, $3, 'approved', $4)
      RETURNING id`,
      [payableDesc, run.total_net_due_minor, run.currency, session.username],
    );
    const payableId = payableRes.rows[0].id;

    // ربط البنود بالالتزام المالي
    await client.query(
      `UPDATE hr_payroll_items SET payable_id = $1 WHERE run_id = $2`,
      [payableId, runId],
    );

    const { rows: updatedRun } = await client.query(
      `UPDATE hr_payroll_runs
       SET status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [session.username, runId],
    );

    const result = mapRunRow({ ...run, ...updatedRun[0] });
    await auditWithClient(
      client,
      "hr.payroll.approve",
      session,
      "hr_payroll_run",
      runId,
      `${run.period_key} (${run.currency}) — التزام #${payableId}`,
      { payableId, totalNetDueMinor: run.total_net_due_minor },
    );

    return result;
  });
}

/* ── ٣. صرف مستحقات المسير ────────────────────────────────────────────────── */

export async function listPayrollItems(runId: number): Promise<HrPayrollItemView[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT i.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department
     FROM hr_payroll_items i
     JOIN hr_staff s ON s.id = i.staff_id
     WHERE i.run_id = $1
     ORDER BY s.full_name ASC`,
    [runId],
  );
  return rows.map(mapItemRow);
}

export async function disbursePayrollItem(
  input: {
    itemId: number;
    amountMinor: number;
    paymentMethod: "cash" | "bank_transfer" | "cheque";
    referenceNumber?: string | null;
    notes?: string | null;
    clientRequestId?: string | null;
  },
  session: SessionPayload,
): Promise<HrPayrollDisbursementView> {
  if (input.amountMinor <= 0) {
    throw new Error("مبلغ الصرف يجب أن يكون أكبر من الصفر.");
  }

  return withTransaction(async (client) => {
    // ١) فحص منع التكرار بواسطة clientRequestId
    if (input.clientRequestId) {
      const { rows: existing } = await client.query(
        `SELECT * FROM hr_payroll_disbursements WHERE client_request_id = $1`,
        [input.clientRequestId],
      );
      if (existing[0]) return mapDisbursementRow(existing[0]);
    }

    // ٢) قفل بند المسير للتحقق من الرصيد المتبقي
    const { rows: itemRows } = await client.query(
      `SELECT i.*, s.full_name as staff_name, r.status as run_status, r.currency as run_currency
       FROM hr_payroll_items i
       JOIN hr_staff s ON s.id = i.staff_id
       JOIN hr_payroll_runs r ON r.id = i.run_id
       WHERE i.id = $1 FOR UPDATE`,
      [input.itemId],
    );
    if (!itemRows[0]) throw new Error("بند المسير غير موجود.");
    const item = itemRows[0];

    if (item.run_status !== "approved") {
      throw new Error("لا يمكن صرف مستحقات لمسير غير معتمد ماليًا.");
    }

    const currentRemaining = Number(item.remaining_minor);
    if (input.amountMinor > currentRemaining) {
      throw new Error(`مبلغ الصرف (${input.amountMinor}) يتجاوز المتبقي المستحق (${currentRemaining}).`);
    }

    // ٣) إنشاء سند الصرف في expenses لربطه محاسبيًا بالصندوق/البنك
    const expenseDesc = `صرف مستحقات موظف: ${item.staff_name}`;
    const expRes = await client.query(
      `INSERT INTO expenses (
        description, amount_minor, currency, payment_method, payable_id, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id`,
      [expenseDesc, input.amountMinor, item.currency, input.paymentMethod, item.payable_id, session.username],
    );
    const expenseId = expRes.rows[0].id;

    // ٤) تسجيل حركة الصرف في hr_payroll_disbursements
    const { rows: disbRows } = await client.query(
      `INSERT INTO hr_payroll_disbursements (
        item_id, staff_id, currency, amount_minor, payment_method, reference_number,
        expense_id, disbursed_by, notes, client_request_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        input.itemId,
        item.staff_id,
        item.currency,
        input.amountMinor,
        input.paymentMethod,
        input.referenceNumber ?? null,
        expenseId,
        session.username,
        input.notes ?? null,
        input.clientRequestId ?? null,
      ],
    );

    // ٥) تحديث المدفوع والمتبقي للبند
    const newPaid = Number(item.paid_minor) + input.amountMinor;
    const newRemaining = currentRemaining - input.amountMinor;
    const newStatus = newRemaining === 0 ? "fully_paid" : "partially_paid";

    await client.query(
      `UPDATE hr_payroll_items
       SET paid_minor = $1, remaining_minor = $2, status = $3, updated_at = NOW()
       WHERE id = $4`,
      [newPaid, newRemaining, newStatus, input.itemId],
    );

    // ٦) تحديث إجماليات الدورة
    await client.query(
      `UPDATE hr_payroll_runs
       SET total_paid_minor = total_paid_minor + $1,
           total_remaining_minor = total_remaining_minor - $1
       WHERE id = $2`,
      [input.amountMinor, item.run_id],
    );

    const disbursement = mapDisbursementRow({ ...disbRows[0], staff_name: item.staff_name });
    await auditWithClient(
      client,
      "hr.payroll.disburse",
      session,
      "hr_payroll_disbursement",
      disbursement.id,
      `${item.staff_name} (${input.amountMinor} ${item.currency}) — سند #${expenseId}`,
      { amountMinor: input.amountMinor, expenseId, itemId: input.itemId },
    );

    return disbursement;
  });
}

function mapRunRow(row: Record<string, unknown>): HrPayrollRunView {
  return {
    id: Number(row.id),
    periodId: Number(row.period_id),
    periodKey: row.period_key ? String(row.period_key) : undefined,
    periodName: row.period_name ? String(row.period_name) : undefined,
    currency: row.currency as Currency,
    status: row.status as any,
    totalBaseSalaryMinor: Number(row.total_base_salary_minor ?? 0),
    totalAllowancesMinor: Number(row.total_allowances_minor ?? 0),
    totalCommissionsMinor: Number(row.total_commissions_minor ?? 0),
    totalAdvancesMinor: Number(row.total_advances_minor ?? 0),
    totalDeductionsMinor: Number(row.total_deductions_minor ?? 0),
    totalNetDueMinor: Number(row.total_net_due_minor ?? 0),
    totalPaidMinor: Number(row.total_paid_minor ?? 0),
    totalRemainingMinor: Number(row.total_remaining_minor ?? 0),
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: row.approved_at ? new Date(row.approved_at as string).toISOString() : null,
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string).toISOString(),
    itemsCount: row.items_count !== undefined ? Number(row.items_count) : undefined,
  };
}

function mapItemRow(row: Record<string, unknown>): HrPayrollItemView {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    staffId: Number(row.staff_id),
    staffName: String(row.staff_name ?? ""),
    staffJobTitle: String(row.staff_job_title ?? ""),
    department: String(row.department ?? ""),
    currency: row.currency as Currency,
    baseSalaryMinor: Number(row.base_salary_minor ?? 0),
    allowancesMinor: Number(row.allowances_minor ?? 0),
    allowanceDetails: (Array.isArray(row.allowance_details) ? row.allowance_details : JSON.parse(String(row.allowance_details ?? "[]"))) as any,
    commissionsMinor: Number(row.commissions_minor ?? 0),
    commissionDetails: (Array.isArray(row.commission_details) ? row.commission_details : JSON.parse(String(row.commission_details ?? "[]"))) as any,
    advancesMinor: Number(row.advances_minor ?? 0),
    deductionsMinor: Number(row.deductions_minor ?? 0),
    deductionDetails: (Array.isArray(row.deduction_details) ? row.deduction_details : JSON.parse(String(row.deduction_details ?? "[]"))) as any,
    netDueMinor: Number(row.net_due_minor ?? 0),
    paidMinor: Number(row.paid_minor ?? 0),
    remainingMinor: Number(row.remaining_minor ?? 0),
    status: row.status as any,
    payableId: row.payable_id ? Number(row.payable_id) : null,
    notes: row.notes ? String(row.notes) : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function mapDisbursementRow(row: Record<string, unknown>): HrPayrollDisbursementView {
  return {
    id: Number(row.id),
    itemId: Number(row.item_id),
    staffId: Number(row.staff_id),
    staffName: row.staff_name ? String(row.staff_name) : undefined,
    currency: row.currency as Currency,
    amountMinor: Number(row.amount_minor),
    paymentMethod: row.payment_method as any,
    referenceNumber: row.reference_number ? String(row.reference_number) : null,
    expenseId: row.expense_id ? Number(row.expense_id) : null,
    disbursedBy: String(row.disbursed_by),
    disbursedAt: new Date(row.disbursed_at as string).toISOString(),
    notes: row.notes ? String(row.notes) : null,
    clientRequestId: row.client_request_id ? String(row.client_request_id) : null,
  };
}

/* ── ٤. إعدادات وسياسات الموارد البشرية ───────────────────────────────────── */

export async function getHrSettings(): Promise<HrSettingsPayload> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT key, value FROM hr_settings`);
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
): Promise<void> {
  return withTransaction(async (client) => {
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
  });
}
