/**
 * (HR-5 / HR-6) المستحقات، مسير الرواتب، وسندات الصرف — **طبقة الخادم وقاعدة البيانات**.
 *
 * المنطق المالي الخادم:
 * ١) عزل تام لكل عملة: YER وSAR وUSD منفصلة بلا جمع ولا تحويل تلقائي.
 * ٢) سحب عمولات الأطباء من محرك العمولات المعتمد (commissionReport في lib/db.ts) بلا تكرار ولا أعمدة مخترعة.
 * ٣) الفصل التام بين الاستحقاق (إنشاء التزام في payables بكامل أعمدته الحقيقية) والصرف (سند صرف في expenses داخل وردية مفتوحة).
 * ٤) أمان التزامن ومنع الصرف الزائد عن صافي المستحق، مع مفتاح client_request_id موصول من البداية للنهاية.
 * ٥) كتابة التدقيق ذرّيًا داخل المعاملة نفسها (insertAuditRow(client, ...)).
 */

import {
  getPool,
  insertAuditRow,
  commissionReport,
  recordExpenseInTx,
  ratesFromSettings,
  getSettings,
  type DbClient,
} from "./db";
import { withTransaction } from "./transactions";
import type { SessionPayload } from "./auth";
import type { AuditAction } from "./audit";
import { CLINIC_BASE_CURRENCY, toBaseAmount, type Currency } from "./money";
import { refusalMessage } from "./supplier-payments";
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

/**
 * يضمن وجود جهة مسجلة للموظف في جدول parties لإشباع القيد الأجنبي للالتزامات
 */
async function ensureStaffParty(
  client: DbClient,
  staffId: number,
  fullName: string,
  existingPartyId?: number | null,
): Promise<number> {
  if (existingPartyId) {
    const { rows } = await client.query(`SELECT id FROM parties WHERE id = $1`, [existingPartyId]);
    if (rows[0]) return rows[0].id;
  }

  const userRes = await client.query(
    `SELECT u.party_id FROM hr_staff s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [staffId],
  );
  if (userRes.rows[0]?.party_id) {
    return userRes.rows[0].party_id;
  }

  const partyRes = await client.query(
    `SELECT id FROM parties WHERE name = $1 AND kind = 'employee' LIMIT 1`,
    [fullName.trim()],
  );
  if (partyRes.rows[0]) return partyRes.rows[0].id;

  const newParty = await client.query(
    `INSERT INTO parties (name, kind, is_active) VALUES ($1, 'employee', true) RETURNING id`,
    [fullName.trim()],
  );
  return newParty.rows[0].id;
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
  return withTransaction(getPool(), async (client) => {
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

export async function getOrCreatePayrollPeriod(
  inputOrKey:
    | {
        periodKey: string;
        name: string;
        startDate: string;
        endDate: string;
      }
    | string,
  session: SessionPayload,
): Promise<HrPayrollPeriodView> {
  if (typeof inputOrKey === "string") {
    const periodKey = inputOrKey.trim();
    const parts = periodKey.split("-").map(Number);
    const y = parts[0] || new Date().getFullYear();
    const m = parts[1] || new Date().getMonth() + 1;
    const startDate = `${periodKey}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return createPayrollPeriod(
      {
        periodKey,
        name: `مسير شهر ${periodKey}`,
        startDate,
        endDate: lastDay,
      },
      session,
    );
  }
  return createPayrollPeriod(inputOrKey, session);
}

export async function closePayrollPeriod(
  periodIdOrKey: number | string,
  session: SessionPayload,
): Promise<HrPayrollPeriodView> {
  const isNumeric = typeof periodIdOrKey === "number" || /^\d+$/.test(String(periodIdOrKey));
  const pId = isNumeric ? Number(periodIdOrKey) : -1;
  const pKey = !isNumeric ? String(periodIdOrKey).trim() : "";

  return withTransaction(getPool(), async (client) => {
    const { rows } = await client.query(
      `UPDATE hr_payroll_periods
       SET status = 'closed', closed_at = NOW(), closed_by = $1
       WHERE (id = $2 AND $2 > 0) OR (period_key = $3 AND $3 <> '')
       RETURNING *`,
      [session.username, pId, pKey],
    );
    if (!rows[0]) throw new Error("فترة المسير غير موجودة.");

    const period = mapPeriodRow(rows[0]);
    // إقفال كل دورات المسير التابعة لهذه الفترة
    await client.query(
      `UPDATE hr_payroll_runs SET status = 'closed' WHERE period_id = $1`,
      [period.id],
    );

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

export async function listPayrollRuns(periodId?: number | string): Promise<HrPayrollRunView[]> {
  const pool = getPool();
  const conditions = periodId ? `WHERE r.period_id = $1` : "";
  const params = periodId ? [Number(periodId)] : [];

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

export async function getPayrollRunById(id: number | string): Promise<HrPayrollRunView | null> {
  const runId = Number(id);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT r.*, p.period_key, p.name as period_name,
            (SELECT COUNT(*)::int FROM hr_payroll_items WHERE run_id = r.id) as items_count
     FROM hr_payroll_runs r
     JOIN hr_payroll_periods p ON p.id = r.period_id
     WHERE r.id = $1`,
    [runId],
  );
  if (!rows[0]) return null;
  return mapRunRow(rows[0]);
}

export async function calculatePayrollRun(
  periodId: number | string,
  currency: Currency,
  session: SessionPayload,
): Promise<HrPayrollRunView> {
  const pId = Number(periodId);
  if (!isAllowedHrCurrency(currency)) {
    throw new Error(`العملة غير معتمدة للمركز: ${currency}`);
  }

  return withTransaction(getPool(), async (client) => {
    const { rows: periodRows } = await client.query(
      `SELECT * FROM hr_payroll_periods WHERE id = $1 FOR UPDATE`,
      [pId],
    );
    if (!periodRows[0]) throw new Error("فترة المسير غير موجودة.");
    const period = periodRows[0];
    if (period.status === "closed") throw new Error("لا يمكن إعادة احتساب فترة مقفلة.");

    // فحص إن كانت دورة المسير معتمدة مسبقًا: ممنوع إعادتها لمسودة لتفادي مضاعفة الالتزامات المالية
    const { rows: existingRun } = await client.query(
      `SELECT * FROM hr_payroll_runs WHERE period_id = $1 AND currency = $2 FOR UPDATE`,
      [pId, currency],
    );
    if (existingRun[0]?.status === "approved" || existingRun[0]?.status === "closed") {
      throw new Error("لا يمكن إعادة احتساب دورة مسير معتمدة ماليًا أو مقفلة.");
    }

    // إنشاء دورة المسير أو تحديث المسودة
    const { rows: runRows } = await client.query(
      `INSERT INTO hr_payroll_runs (period_id, currency, status, created_by)
       VALUES ($1, $2, 'draft', $3)
       ON CONFLICT (period_id, currency) DO UPDATE
       SET status = 'draft'
       RETURNING *`,
      [pId, currency, session.username],
    );
    const run = runRows[0];

    // جلب جميع الموظفين النشطين المستحقين لأجر بهذه العملة
    const staffQuery = `
      SELECT s.id, s.full_name, s.job_title, s.department, s.contract_kind,
             s.salary_amount_minor, s.salary_currency, s.salary_period, s.user_id,
             u.party_id as user_party_id,
             c.doctor_party_id
      FROM hr_staff s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN LATERAL (
        SELECT doctor_party_id FROM hr_contracts
         WHERE staff_id = s.id AND status IN ('approved', 'active')
         ORDER BY version_number DESC, id DESC LIMIT 1
      ) c ON true
      WHERE s.work_status = 'active'
        AND (
          (s.contract_kind IN ('salary', 'salary_commission') AND s.salary_currency = $1)
          OR (s.contract_kind IN ('commission', 'salary_commission'))
        )
      ORDER BY s.id ASC
    `;
    const { rows: staffList } = await client.query(staffQuery, [currency]);

    // استخراج العمولات المعتمدة من المحرك الحقيقي القائم للفترة
    const commRows = await commissionReport(period.start_date, period.end_date);

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

      // حساب عمولة الطبيب المكتسبة بدقة من محرك العمولات المعتمد
      let commMinor = 0;
      const commissionDetails: Array<{ source: string; amountMinor: number; note: string; periodKey: string }> = [];

      const docPartyId = st.doctor_party_id ?? st.user_party_id;
      if ((st.contract_kind === "commission" || st.contract_kind === "salary_commission") && docPartyId) {
        const found = commRows.find((r) => r.doctorId === docPartyId && r.currency === currency);
        if (found) {
          // فحص ما اعتُمد بالفعل في مسيرات أخرى معتمدة لنفس الفترة حتى لا تتكرر
          const { rows: alreadyAccrued } = await client.query(
            `SELECT COALESCE(SUM(i.commissions_minor), 0)::bigint as total
             FROM hr_payroll_items i
             JOIN hr_payroll_runs r ON r.id = i.run_id
             WHERE i.staff_id = $1 AND i.currency = $2 AND r.status IN ('approved', 'closed')
               AND r.period_id = $3`,
            [st.id, currency, pId],
          );
          const already = Number(alreadyAccrued[0]?.total ?? 0);
          commMinor = Math.max(0, found.dueMinor - already);

          if (commMinor > 0) {
            commissionDetails.push({
              source: "commissionReport",
              amountMinor: commMinor,
              note: `عمولة الطبيب المستحقة عن فترة ${period.period_key} (الصافي المستحق: ${found.dueMinor})`,
              periodKey: period.period_key,
            });
          }
        }
      }

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

    if (period.status === "draft") {
      await client.query(`UPDATE hr_payroll_periods SET status = 'calculated' WHERE id = $1`, [pId]);
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
  runId: number | string,
  session: SessionPayload,
): Promise<HrPayrollRunView> {
  const rId = Number(runId);
  return withTransaction(getPool(), async (client) => {
    const { rows: runRows } = await client.query(
      `SELECT r.*, p.period_key, p.name as period_name
       FROM hr_payroll_runs r
       JOIN hr_payroll_periods p ON p.id = r.period_id
       WHERE r.id = $1 FOR UPDATE`,
      [rId],
    );
    if (!runRows[0]) throw new Error("دورة المسير غير موجودة.");
    const run = runRows[0];
    if (run.status === "approved" || run.status === "closed") {
      return mapRunRow(run);
    }

    const { rows: items } = await client.query(
      `SELECT i.*, s.full_name as staff_name, s.user_id, u.party_id as user_party_id, c.doctor_party_id
       FROM hr_payroll_items i
       JOIN hr_staff s ON s.id = i.staff_id
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN LATERAL (
         SELECT doctor_party_id FROM hr_contracts
          WHERE staff_id = s.id AND status IN ('approved', 'active')
          ORDER BY version_number DESC, id DESC LIMIT 1
       ) c ON true
       WHERE i.run_id = $1 FOR UPDATE OF i`,
      [rId],
    );

    const settings = await getSettings();
    const settingsRates = ratesFromSettings(settings);
    const exchangeRate = settingsRates[run.currency as Currency] ?? 1;

    for (const item of items) {
      if (item.net_due_minor > 0 && !item.payable_id) {
        const partyId = await ensureStaffParty(
          client,
          item.staff_id,
          item.staff_name,
          item.doctor_party_id ?? item.user_party_id,
        );
        const baseAmount = toBaseAmount(
          Number(item.net_due_minor),
          item.currency as Currency,
          CLINIC_BASE_CURRENCY,
          exchangeRate,
        );
        const payableDesc = `مستحقات مسير ${run.period_name} (${run.currency}) — ${item.staff_name}`;

        const payableRes = await client.query(
          `INSERT INTO payables (
            party_id, category, description, amount_minor, currency,
            exchange_rate, base_amount_minor, base_currency, created_by
          ) VALUES ($1, 'salary', $2, $3, $4, $5, $6, $7, $8)
          RETURNING id`,
          [
            partyId,
            payableDesc,
            Number(item.net_due_minor),
            item.currency,
            exchangeRate,
            baseAmount,
            CLINIC_BASE_CURRENCY,
            session.username,
          ],
        );
        const payableId = payableRes.rows[0].id;
        await client.query(`UPDATE hr_payroll_items SET payable_id = $1 WHERE id = $2`, [payableId, item.id]);
      }
    }

    const { rows: updatedRun } = await client.query(
      `UPDATE hr_payroll_runs
       SET status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [session.username, rId],
    );

    const result = mapRunRow({ ...run, ...updatedRun[0] });
    await auditWithClient(
      client,
      "hr.payroll.approve",
      session,
      "hr_payroll_run",
      rId,
      `${run.period_key} (${run.currency})`,
      { totalNetDueMinor: run.total_net_due_minor },
    );
    return result;
  });
}

/* ── ٣. صرف مستحقات المسير ────────────────────────────────────────────────── */

export async function listPayrollItems(runId: number | string): Promise<HrPayrollItemView[]> {
  const rId = Number(runId);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT i.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department
     FROM hr_payroll_items i
     JOIN hr_staff s ON s.id = i.staff_id
     WHERE i.run_id = $1
     ORDER BY s.full_name ASC`,
    [rId],
  );
  return rows.map(mapItemRow);
}

export interface DisburseInput {
  amount?: number;
  amountMinor?: number;
  paymentMethod?: "cash" | "bank_transfer" | "cheque" | string;
  referenceNumber?: string | null;
  notes?: string | null;
  clientRequestId?: string | null;
  safeOrBankId?: string | null;
}

export async function disbursePayrollItem(
  itemIdOrInput: number | string | {
    itemId: number | string;
    amountMinor?: number;
    amount?: number;
    paymentMethod?: "cash" | "bank_transfer" | "cheque" | string;
    referenceNumber?: string | null;
    notes?: string | null;
    clientRequestId?: string | null;
    safeOrBankId?: string | null;
  },
  inputOrSession?: DisburseInput | SessionPayload,
  maybeSession?: SessionPayload,
): Promise<HrPayrollDisbursementView> {
  let itemId: number;
  let amountMinor: number;
  let paymentMethod: "cash" | "bank_transfer" | "cheque";
  let referenceNumber: string | null = null;
  let notes: string | null = null;
  let clientRequestId: string | null = null;
  let session: SessionPayload;

  if (typeof itemIdOrInput === "object" && itemIdOrInput !== null) {
    itemId = Number(itemIdOrInput.itemId);
    amountMinor = Number(itemIdOrInput.amountMinor ?? itemIdOrInput.amount ?? 0);
    paymentMethod = (itemIdOrInput.paymentMethod as any) || "cash";
    referenceNumber = itemIdOrInput.referenceNumber ?? null;
    notes = itemIdOrInput.notes ?? null;
    clientRequestId = itemIdOrInput.clientRequestId ?? null;
    session = inputOrSession as SessionPayload;
  } else {
    itemId = Number(itemIdOrInput);
    const inp = (inputOrSession as DisburseInput) ?? {};
    amountMinor = Number(inp.amountMinor ?? inp.amount ?? 0);
    paymentMethod = (inp.paymentMethod as any) || "cash";
    referenceNumber = inp.referenceNumber ?? null;
    notes = inp.notes ?? null;
    clientRequestId = inp.clientRequestId ?? null;
    session = maybeSession!;
  }

  if (amountMinor <= 0) {
    throw new Error("مبلغ الصرف يجب أن يكون أكبر من الصفر.");
  }

  return withTransaction(getPool(), async (client) => {
    // ١) فحص منع التكرار بواسطة clientRequestId
    if (clientRequestId) {
      const { rows: existing } = await client.query(
        `SELECT d.*, s.full_name as staff_name
         FROM hr_payroll_disbursements d
         JOIN hr_staff s ON s.id = d.staff_id
         WHERE d.client_request_id = $1`,
        [clientRequestId],
      );
      if (existing[0]) return mapDisbursementRow(existing[0]);
    }

    // ٢) قفل بند المسير للتحقق من الرصيد المتبقي
    const { rows: itemRows } = await client.query(
      `SELECT i.*, s.full_name as staff_name, r.status as run_status, r.currency as run_currency
       FROM hr_payroll_items i
       JOIN hr_staff s ON s.id = i.staff_id
       JOIN hr_payroll_runs r ON r.id = i.run_id
       WHERE i.id = $1 FOR UPDATE OF i`,
      [itemId],
    );
    if (!itemRows[0]) throw new Error("بند المسير غير موجود.");
    const item = itemRows[0];

    if (item.run_status !== "approved" && item.run_status !== "closed") {
      throw new Error("لا يمكن صرف مستحقات لمسير غير معتمد ماليًا.");
    }

    const currentRemaining = Number(item.remaining_minor);
    if (amountMinor > currentRemaining) {
      throw new Error(`مبلغ الصرف (${amountMinor}) يتجاوز المتبقي المستحق (${currentRemaining}).`);
    }

    // ٣) إنشاء سند الصرف في expenses عبر محرك الصرف المعتمد recordExpenseInTx
    const settings = await getSettings();
    const settingsRates = ratesFromSettings(settings);
    const currency = item.currency as Currency;
    const exchangeRate = settingsRates[currency] ?? 1;

    // تحديد تصنيف السند: إذا كان البند عمولة طبيب خالصة، يُصرف كـ commission
    // حتى ينعكس تلقائيًا في كشف حساب الطبيب ومحرك العمولات، وإلا كـ salary
    const expenseCategory = (Number(item.commissions_minor) > 0 && Number(item.base_salary_minor) === 0)
      ? "commission"
      : "salary";

    const expenseNote = `صرف مستحقات: ${item.staff_name} — مسير #${item.run_id}${notes ? ` (${notes})` : ""}`;

    const expResult = await recordExpenseInTx(
      client,
      {
        category: expenseCategory as any,
        partyId: null, // سيسحب من الالتزام تلقائيًا
        payeeText: item.staff_name,
        amountMinor,
        currency,
        baseCurrency: CLINIC_BASE_CURRENCY,
        exchangeRate,
        payableId: item.payable_id ? Number(item.payable_id) : null,
        note: expenseNote,
        createdBy: session.username,
        rates: settingsRates,
      },
      settingsRates,
    );

    if (expResult.id === null) {
      const msg = refusalMessage(expResult.reason ?? "no_shift", expResult.quote);
      throw new Error(msg);
    }
    const expenseId = expResult.id;

    // ٤) تسجيل حركة الصرف في hr_payroll_disbursements
    const { rows: disbRows } = await client.query(
      `INSERT INTO hr_payroll_disbursements (
        item_id, staff_id, currency, amount_minor, payment_method, reference_number,
        expense_id, disbursed_by, notes, client_request_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        itemId,
        item.staff_id,
        item.currency,
        amountMinor,
        paymentMethod,
        referenceNumber,
        expenseId,
        session.username,
        notes,
        clientRequestId,
      ],
    );

    // ٥) تحديث المدفوع والمتبقي للبند
    const newPaid = Number(item.paid_minor) + amountMinor;
    const newRemaining = currentRemaining - amountMinor;
    const newStatus = newRemaining === 0 ? "fully_paid" : "partially_paid";

    await client.query(
      `UPDATE hr_payroll_items
       SET paid_minor = $1, remaining_minor = $2, status = $3, updated_at = NOW()
       WHERE id = $4`,
      [newPaid, newRemaining, newStatus, itemId],
    );

    // ٦) تحديث إجماليات الدورة
    await client.query(
      `UPDATE hr_payroll_runs
       SET total_paid_minor = total_paid_minor + $1,
           total_remaining_minor = total_remaining_minor - $1
       WHERE id = $2`,
      [amountMinor, item.run_id],
    );

    const disbursement = mapDisbursementRow({ ...disbRows[0], staff_name: item.staff_name });
    await auditWithClient(
      client,
      "hr.payroll.disburse",
      session,
      "hr_payroll_disbursement",
      disbursement.id,
      `${item.staff_name} (${amountMinor} ${item.currency}) — سند #${expenseId}`,
      { amountMinor, expenseId, itemId, clientRequestId },
    );

    return disbursement;
  });
}

export async function disburseEntireRun(
  runId: number | string,
  input: DisburseInput,
  session: SessionPayload,
): Promise<HrPayrollDisbursementView[]> {
  const rId = Number(runId);
  const pool = getPool();
  const { rows: items } = await pool.query(
    `SELECT id, remaining_minor FROM hr_payroll_items WHERE run_id = $1 AND remaining_minor > 0 ORDER BY id ASC`,
    [rId],
  );

  const disbursements: HrPayrollDisbursementView[] = [];
  const baseReqId = input.clientRequestId || `batch_${rId}_${Date.now()}`;

  for (const item of items) {
    const itemReqId = `${baseReqId}_item_${item.id}`;
    const disb = await disbursePayrollItem(
      {
        itemId: item.id,
        amountMinor: Number(item.remaining_minor),
        paymentMethod: input.paymentMethod || "cash",
        referenceNumber: input.referenceNumber,
        notes: input.notes,
        clientRequestId: itemReqId,
      },
      session,
    );
    disbursements.push(disb);
  }

  return disbursements;
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
  return withTransaction(getPool(), async (client) => {
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

export async function updateHrSettings(
  patch: Partial<HrSettingsPayload>,
  session: SessionPayload,
): Promise<HrSettingsPayload> {
  if (patch.payrollCycle) {
    await updateHrSetting("payroll_cycle", patch.payrollCycle as any, session);
  }
  if (patch.attendancePolicy) {
    await updateHrSetting("attendance_policy", patch.attendancePolicy as any, session);
  }
  if (patch.leavePolicy) {
    await updateHrSetting("leave_policy", patch.leavePolicy as any, session);
  }
  return getHrSettings();
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
    date: new Date().toISOString().slice(0, 10),
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
