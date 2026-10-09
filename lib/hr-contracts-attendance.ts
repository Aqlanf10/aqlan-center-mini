/**
 * (HR-3 / HR-4) العقود، جداول العمل، الحضور والانصراف، والإجازات — **طبقة الخادم وقاعدة البيانات**.
 *
 * كل دالة هنا تلمس PostgreSQL (مباشرة أو عبر معاملة) وتُنفَّذ على الخادم حصرًا.
 * تضمن:
 * ١) كتابة التدقيق ذرّيًا داخل المعاملة نفسها (insertAuditRow(client, ...)) لتفادي الفقد أو الجمود.
 * ٢) التحقق الخادمي الصارم من هوية المستخدم وصلاحية جلسته.
 * ٣) الحفاظ على السجل الأصلي للحضور (raw punch log) ومنع الاستبدال الصامت بالتصحيحات المعتمدة.
 * ٤) منع التداخل والموافقة الذاتية غير المسموح بها في الإجازات.
 */

import { getPool, insertAuditRow, type DbClient, type DbPool } from "./db";
import { withTransaction } from "./transactions";
import type { SessionPayload } from "./auth";
import type { AuditAction } from "./audit";
import {
  type HrContractTemplateKind,
  type HrContractStatus,
  type HrContractView,
  type HrWorkScheduleView,
  type HrAttendanceRecordView,
  type HrAttendanceCorrectionView,
  type HrLeaveBalanceView,
  type HrLeaveRequestView,
  type HrScheduleType,
  type HrAttendanceStatus,
  type HrLeaveTypeCode,
  type HrLeaveRequestStatus,
  calculateShiftAttendance,
} from "./hr-contracts-attendance-shared";

export * from "./hr-contracts-attendance-shared";

type QueryRunner = DbClient | DbPool;

/* ── مساعدة التدقيق الذري مع المعاملة ─────────────────────────────────────── */

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

/* ── ١. إدارة العقود ─────────────────────────────────────────────────────── */

export async function listContracts(options?: {
  staffId?: number;
  status?: HrContractStatus;
  templateKind?: HrContractTemplateKind;
}): Promise<HrContractView[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.staffId) {
    params.push(options.staffId);
    conditions.push(`c.staff_id = $${params.length}`);
  }
  if (options?.status) {
    params.push(options.status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (options?.templateKind) {
    params.push(options.templateKind);
    conditions.push(`c.template_kind = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const query = `
    SELECT c.*, s.full_name as staff_name, s.department as staff_department
    FROM hr_contracts c
    JOIN hr_staff s ON s.id = c.staff_id
    ${whereClause}
    ORDER BY c.created_at DESC
  `;

  const { rows } = await pool.query(query, params);
  return rows.map(mapContractRow);
}

export async function getContract(id: number): Promise<HrContractView | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.*, s.full_name as staff_name, s.department as staff_department
     FROM hr_contracts c
     JOIN hr_staff s ON s.id = c.staff_id
     WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  return mapContractRow(rows[0]);
}

export async function createContract(
  input: {
    staffId: number;
    templateKind: HrContractTemplateKind;
    title: string;
    startDate: string;
    endDate?: string | null;
    probationEndDate?: string | null;
    noticePeriodDays?: number;
    termsPayload?: Record<string, unknown>;
    compensationKind: "commission" | "salary" | "salary_commission";
    baseSalaryMinor?: number | null;
    salaryCurrency?: string | null;
    salaryPeriod?: string | null;
    commissionRatePercent?: number | null;
    doctorPartyId?: number | null;
    notes?: string | null;
  },
  session: SessionPayload,
): Promise<HrContractView> {
  return withTransaction(async (client) => {
    // توليد رقم العقد تلقائيًا بشكل فريد
    const countRes = await client.query(`SELECT COUNT(*)::int as count FROM hr_contracts`);
    const nextSeq = (countRes.rows[0].count + 1).toString().padStart(4, "0");
    const datePrefix = new Date().toISOString().slice(0, 7).replace("-", "");
    const contractNumber = `CTR-${datePrefix}-${nextSeq}`;

    const { rows } = await client.query(
      `INSERT INTO hr_contracts (
        staff_id, contract_number, template_kind, title, status, start_date, end_date,
        probation_end_date, notice_period_days, terms_payload, compensation_kind,
        base_salary_minor, salary_currency, salary_period, commission_rate_percent,
        doctor_party_id, notes, created_by
      ) VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *`,
      [
        input.staffId,
        contractNumber,
        input.templateKind,
        input.title.trim(),
        input.startDate,
        input.endDate ?? null,
        input.probationEndDate ?? null,
        input.noticePeriodDays ?? 30,
        JSON.stringify(input.termsPayload ?? {}),
        input.compensationKind,
        input.baseSalaryMinor ?? null,
        input.salaryCurrency ?? null,
        input.salaryPeriod ?? null,
        input.commissionRatePercent ?? null,
        input.doctorPartyId ?? null,
        input.notes ?? null,
        session.username,
      ],
    );

    const contract = mapContractRow(rows[0]);
    await auditWithClient(
      client,
      "hr.contract.create",
      session,
      "hr_contract",
      contract.id,
      `${contract.contractNumber} (${contract.title})`,
      { staffId: input.staffId, templateKind: input.templateKind },
    );

    return contract;
  });
}

export async function approveContract(
  contractId: number,
  session: SessionPayload,
): Promise<HrContractView> {
  return withTransaction(async (client) => {
    const { rows: currentRows } = await client.query(
      `SELECT * FROM hr_contracts WHERE id = $1 FOR UPDATE`,
      [contractId],
    );
    if (!currentRows[0]) throw new Error("العقد غير موجود.");
    const current = currentRows[0];
    if (current.status === "approved" || current.status === "active") {
      return mapContractRow(current);
    }

    const { rows } = await client.query(
      `UPDATE hr_contracts
       SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [session.username, contractId],
    );

    const contract = mapContractRow(rows[0]);
    await auditWithClient(
      client,
      "hr.contract.approve",
      session,
      "hr_contract",
      contract.id,
      contract.contractNumber,
    );
    return contract;
  });
}

export async function createContractAddendum(
  parentContractId: number,
  input: {
    addendumReason: string;
    title: string;
    startDate: string;
    endDate?: string | null;
    termsPayload?: Record<string, unknown>;
    baseSalaryMinor?: number | null;
    salaryCurrency?: string | null;
    commissionRatePercent?: number | null;
    notes?: string | null;
  },
  session: SessionPayload,
): Promise<HrContractView> {
  return withTransaction(async (client) => {
    const { rows: parentRows } = await client.query(
      `SELECT * FROM hr_contracts WHERE id = $1 FOR UPDATE`,
      [parentContractId],
    );
    if (!parentRows[0]) throw new Error("العقد الأصلي غير موجود.");
    const parent = parentRows[0];

    const newVersion = parent.version_number + 1;
    const addendumNumber = `${parent.contract_number}-A${newVersion}`;

    const { rows } = await client.query(
      `INSERT INTO hr_contracts (
        staff_id, contract_number, template_kind, title, status, start_date, end_date,
        probation_end_date, notice_period_days, terms_payload, compensation_kind,
        base_salary_minor, salary_currency, salary_period, commission_rate_percent,
        doctor_party_id, parent_contract_id, version_number, addendum_reason, notes, created_by
      ) VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING *`,
      [
        parent.staff_id,
        addendumNumber,
        parent.template_kind,
        input.title.trim(),
        input.startDate,
        input.endDate ?? parent.end_date,
        parent.probation_end_date,
        parent.notice_period_days,
        JSON.stringify(input.termsPayload ?? parent.terms_payload),
        parent.compensation_kind,
        input.baseSalaryMinor !== undefined ? input.baseSalaryMinor : parent.base_salary_minor,
        input.salaryCurrency ?? parent.salary_currency,
        parent.salary_period,
        input.commissionRatePercent !== undefined ? input.commissionRatePercent : parent.commission_rate_percent,
        parent.doctor_party_id,
        parentContractId,
        newVersion,
        input.addendumReason.trim(),
        input.notes ?? null,
        session.username,
      ],
    );

    const contract = mapContractRow(rows[0]);
    await auditWithClient(
      client,
      "hr.contract.addendum",
      session,
      "hr_contract",
      contract.id,
      `${contract.contractNumber} (ملحق للإصدار ${parent.version_number})`,
      { parentContractId, reason: input.addendumReason },
    );
    return contract;
  });
}

function mapContractRow(row: Record<string, unknown>): HrContractView {
  return {
    id: Number(row.id),
    staffId: Number(row.staff_id),
    staffName: (row.staff_name as string) ?? undefined,
    staffDepartment: (row.staff_department as any) ?? undefined,
    contractNumber: String(row.contract_number),
    templateKind: row.template_kind as HrContractTemplateKind,
    title: String(row.title),
    status: row.status as HrContractStatus,
    startDate: String(row.start_date),
    endDate: row.end_date ? String(row.end_date) : null,
    probationEndDate: row.probation_end_date ? String(row.probation_end_date) : null,
    noticePeriodDays: Number(row.notice_period_days ?? 30),
    termsPayload: (typeof row.terms_payload === "object" ? row.terms_payload : JSON.parse(String(row.terms_payload ?? "{}"))) as any,
    compensationKind: row.compensation_kind as any,
    baseSalaryMinor: row.base_salary_minor !== null ? Number(row.base_salary_minor) : null,
    salaryCurrency: row.salary_currency ? String(row.salary_currency) : null,
    salaryPeriod: row.salary_period ? String(row.salary_period) : null,
    commissionRatePercent: row.commission_rate_percent !== null ? Number(row.commission_rate_percent) : null,
    doctorPartyId: row.doctor_party_id ? Number(row.doctor_party_id) : null,
    parentContractId: row.parent_contract_id ? Number(row.parent_contract_id) : null,
    versionNumber: Number(row.version_number ?? 1),
    addendumReason: row.addendum_reason ? String(row.addendum_reason) : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: row.approved_at ? new Date(row.approved_at as string).toISOString() : null,
    signedAt: row.signed_at ? new Date(row.signed_at as string).toISOString() : null,
    signedByStaff: Boolean(row.signed_by_staff),
    signedByCenter: Boolean(row.signed_by_center),
    attachmentRefs: (Array.isArray(row.attachment_refs) ? row.attachment_refs : JSON.parse(String(row.attachment_refs ?? "[]"))) as any,
    notes: row.notes ? String(row.notes) : null,
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/* ── ٢. جداول الدوام والورديات ───────────────────────────────────────────── */

export async function listSchedules(options?: {
  staffId?: number;
  department?: string;
  isActive?: boolean;
}): Promise<HrWorkScheduleView[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.staffId) {
    params.push(options.staffId);
    conditions.push(`ws.staff_id = $${params.length}`);
  }
  if (options?.department) {
    params.push(options.department);
    conditions.push(`ws.department = $${params.length}`);
  }
  if (options?.isActive !== undefined) {
    params.push(options.isActive);
    conditions.push(`ws.is_active = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT ws.*, s.full_name as staff_name
    FROM hr_work_schedules ws
    LEFT JOIN hr_staff s ON s.id = ws.staff_id
    ${whereClause}
    ORDER BY ws.is_active DESC, ws.effective_from DESC
  `;

  const { rows } = await pool.query(query, params);
  return rows.map(mapScheduleRow);
}

export async function createSchedule(
  input: {
    staffId?: number | null;
    department?: string | null;
    name: string;
    scheduleType: HrScheduleType;
    effectiveFrom: string;
    effectiveTo?: string | null;
    workingDays: number[];
    shiftStartTime: string;
    shiftEndTime: string;
    secondShiftStart?: string | null;
    secondShiftEnd?: string | null;
    gracePeriodMins?: number;
    expectedDailyHours?: number;
    crossesMidnight?: boolean;
  },
  session: SessionPayload,
): Promise<HrWorkScheduleView> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO hr_work_schedules (
        staff_id, department, name, schedule_type, effective_from, effective_to,
        working_days, shift_start_time, shift_end_time, second_shift_start, second_shift_end,
        grace_period_mins, expected_daily_hours, crosses_midnight, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        input.staffId ?? null,
        input.department ?? null,
        input.name.trim(),
        input.scheduleType,
        input.effectiveFrom,
        input.effectiveTo ?? null,
        JSON.stringify(input.workingDays),
        input.shiftStartTime,
        input.shiftEndTime,
        input.secondShiftStart ?? null,
        input.secondShiftEnd ?? null,
        input.gracePeriodMins ?? 15,
        input.expectedDailyHours ?? 8.00,
        input.crossesMidnight ?? false,
        session.username,
      ],
    );

    const schedule = mapScheduleRow(rows[0]);
    await auditWithClient(
      client,
      "hr.schedule.create",
      session,
      "hr_work_schedule",
      schedule.id,
      schedule.name,
      { scheduleType: input.scheduleType, staffId: input.staffId },
    );
    return schedule;
  });
}

function mapScheduleRow(row: Record<string, unknown>): HrWorkScheduleView {
  return {
    id: Number(row.id),
    staffId: row.staff_id ? Number(row.staff_id) : null,
    staffName: (row.staff_name as string) ?? null,
    department: (row.department as any) ?? null,
    name: String(row.name),
    scheduleType: row.schedule_type as HrScheduleType,
    effectiveFrom: String(row.effective_from),
    effectiveTo: row.effective_to ? String(row.effective_to) : null,
    workingDays: Array.isArray(row.working_days) ? row.working_days : JSON.parse(String(row.working_days ?? "[]")),
    shiftStartTime: String(row.shift_start_time),
    shiftEndTime: String(row.shift_end_time),
    secondShiftStart: row.second_shift_start ? String(row.second_shift_start) : null,
    secondShiftEnd: row.second_shift_end ? String(row.second_shift_end) : null,
    gracePeriodMins: Number(row.grace_period_mins ?? 15),
    expectedDailyHours: Number(row.expected_daily_hours ?? 8),
    crossesMidnight: Boolean(row.crosses_midnight),
    isActive: Boolean(row.is_active),
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/* ── ٣. الحضور والانصراف والتصحيحات ──────────────────────────────────────── */

export async function listAttendanceRecords(options: {
  date?: string;
  startDate?: string;
  endDate?: string;
  staffId?: number;
  department?: string;
  status?: HrAttendanceStatus;
}): Promise<HrAttendanceRecordView[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.date) {
    params.push(options.date);
    conditions.push(`ar.attendance_date = $${params.length}`);
  }
  if (options.startDate) {
    params.push(options.startDate);
    conditions.push(`ar.attendance_date >= $${params.length}`);
  }
  if (options.endDate) {
    params.push(options.endDate);
    conditions.push(`ar.attendance_date <= $${params.length}`);
  }
  if (options.staffId) {
    params.push(options.staffId);
    conditions.push(`ar.staff_id = $${params.length}`);
  }
  if (options.department) {
    params.push(options.department);
    conditions.push(`s.department = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    conditions.push(`ar.status = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT ar.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department
    FROM hr_attendance_records ar
    JOIN hr_staff s ON s.id = ar.staff_id
    ${whereClause}
    ORDER BY ar.attendance_date DESC, s.full_name ASC
  `;

  const { rows } = await pool.query(query, params);
  return rows.map(mapAttendanceRow);
}

export async function recordAttendance(
  input: {
    staffId: number;
    attendanceDate: string;
    checkIn?: string | null;
    checkOut?: string | null;
    status?: HrAttendanceStatus;
    notes?: string | null;
  },
  session: SessionPayload,
): Promise<HrAttendanceRecordView> {
  return withTransaction(async (client) => {
    // جلب جدول العمل الساري للموظف أو لقسمه لاحتساب التأخير والساعات بدقة
    const schedRes = await client.query(
      `SELECT ws.* FROM hr_work_schedules ws
       JOIN hr_staff s ON s.id = $1
       WHERE ws.is_active = true
         AND (ws.staff_id = $1 OR (ws.staff_id IS NULL AND ws.department = s.department))
       ORDER BY ws.staff_id NULLS LAST, ws.effective_from DESC
       LIMIT 1`,
      [input.staffId],
    );

    const schedule = schedRes.rows[0] ?? null;
    let workMins = 0;
    let lateMins = 0;
    let earlyExitMins = 0;
    let overtimeMins = 0;
    let calculatedStatus = input.status ?? "present";
    let isIncomplete = false;

    if (input.checkIn && !input.checkOut) {
      isIncomplete = true;
      calculatedStatus = "incomplete";
    } else if (input.checkIn && input.checkOut && schedule) {
      const calc = calculateShiftAttendance({
        checkIn: new Date(input.checkIn),
        checkOut: new Date(input.checkOut),
        scheduledStart: schedule.shift_start_time,
        scheduledEnd: schedule.shift_end_time,
        graceMins: schedule.grace_period_mins ?? 15,
        crossesMidnight: schedule.crosses_midnight ?? false,
      });
      workMins = calc.workMinutes;
      lateMins = calc.lateMinutes;
      earlyExitMins = calc.earlyExitMinutes;
      overtimeMins = calc.overtimeMinutes;
      if (!input.status) calculatedStatus = calc.status;
    }

    const { rows } = await client.query(
      `INSERT INTO hr_attendance_records (
        staff_id, schedule_id, attendance_date, status, check_in_raw, check_out_raw,
        check_in_actual, check_out_actual, work_minutes, late_minutes, early_exit_minutes,
        overtime_minutes, is_incomplete, source, notes, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $5, $6, $7, $8, $9, $10, $11, 'manual', $12, $13)
      ON CONFLICT (staff_id, attendance_date) DO UPDATE
      SET check_out_raw = COALESCE(EXCLUDED.check_out_raw, hr_attendance_records.check_out_raw),
          check_in_actual = COALESCE(EXCLUDED.check_in_actual, hr_attendance_records.check_in_actual),
          check_out_actual = COALESCE(EXCLUDED.check_out_actual, hr_attendance_records.check_out_actual),
          status = EXCLUDED.status,
          work_minutes = EXCLUDED.work_minutes,
          late_minutes = EXCLUDED.late_minutes,
          early_exit_minutes = EXCLUDED.early_exit_minutes,
          overtime_minutes = EXCLUDED.overtime_minutes,
          is_incomplete = EXCLUDED.is_incomplete,
          notes = COALESCE(EXCLUDED.notes, hr_attendance_records.notes),
          updated_at = NOW()
      RETURNING *`,
      [
        input.staffId,
        schedule ? schedule.id : null,
        input.attendanceDate,
        calculatedStatus,
        input.checkIn ? new Date(input.checkIn) : null,
        input.checkOut ? new Date(input.checkOut) : null,
        workMins,
        lateMins,
        earlyExitMins,
        overtimeMins,
        isIncomplete,
        input.notes ?? null,
        session.username,
      ],
    );

    // إعادة القراءة مع اسم الموظف
    const recordRes = await client.query(
      `SELECT ar.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department
       FROM hr_attendance_records ar
       JOIN hr_staff s ON s.id = ar.staff_id
       WHERE ar.id = $1`,
      [rows[0].id],
    );

    const record = mapAttendanceRow(recordRes.rows[0]);
    await auditWithClient(
      client,
      "hr.attendance.record",
      session,
      "hr_attendance_record",
      record.id,
      `${record.staffName} (${record.attendanceDate})`,
      { status: record.status, workMinutes: record.workMinutes },
    );
    return record;
  });
}

export async function correctAttendanceRecord(
  attendanceId: number,
  input: {
    fieldCorrected: "check_in" | "check_out" | "status" | "overtime" | "all";
    newCheckIn?: string | null;
    newCheckOut?: string | null;
    newStatus?: HrAttendanceStatus;
    reason: string;
  },
  session: SessionPayload,
): Promise<HrAttendanceRecordView> {
  return withTransaction(async (client) => {
    const { rows: currRows } = await client.query(
      `SELECT ar.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department
       FROM hr_attendance_records ar
       JOIN hr_staff s ON s.id = ar.staff_id
       WHERE ar.id = $1 FOR UPDATE`,
      [attendanceId],
    );
    if (!currRows[0]) throw new Error("سجل الحضور غير موجود.");
    const curr = currRows[0];

    const newIn = input.newCheckIn !== undefined ? (input.newCheckIn ? new Date(input.newCheckIn) : null) : curr.check_in_actual;
    const newOut = input.newCheckOut !== undefined ? (input.newCheckOut ? new Date(input.newCheckOut) : null) : curr.check_out_actual;
    const newStatus = input.newStatus ?? curr.status;

    // تسجيل التصحيح في سجل التصحيحات append-only
    await client.query(
      `INSERT INTO hr_attendance_corrections (
        attendance_id, staff_id, field_corrected, old_check_in, new_check_in,
        old_check_out, new_check_out, old_status, new_status, reason,
        requested_by, approved_by, approved_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
      [
        attendanceId,
        curr.staff_id,
        input.fieldCorrected,
        curr.check_in_actual,
        newIn,
        curr.check_out_actual,
        newOut,
        curr.status,
        newStatus,
        input.reason.trim(),
        session.username,
        session.username,
      ],
    );

    // تطبيق التصحيح على السجل الفعلي مع بقاء raw دون تغيير
    const { rows: updatedRows } = await client.query(
      `UPDATE hr_attendance_records
       SET check_in_actual = $1, check_out_actual = $2, status = $3, is_incomplete = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [newIn, newOut, newStatus, Boolean(newIn && !newOut), attendanceId],
    );

    const updated = mapAttendanceRow({ ...curr, ...updatedRows[0] });
    await auditWithClient(
      client,
      "hr.attendance.correct",
      session,
      "hr_attendance_record",
      attendanceId,
      `${updated.staffName} (${updated.attendanceDate})`,
      { reason: input.reason, field: input.fieldCorrected },
    );
    return updated;
  });
}

function mapAttendanceRow(row: Record<string, unknown>): HrAttendanceRecordView {
  return {
    id: Number(row.id),
    staffId: Number(row.staff_id),
    staffName: String(row.staff_name ?? ""),
    staffJobTitle: String(row.staff_job_title ?? ""),
    department: row.department as any,
    scheduleId: row.schedule_id ? Number(row.schedule_id) : null,
    attendanceDate: String(row.attendance_date),
    status: row.status as HrAttendanceStatus,
    checkInRaw: row.check_in_raw ? new Date(row.check_in_raw as string).toISOString() : null,
    checkOutRaw: row.check_out_raw ? new Date(row.check_out_raw as string).toISOString() : null,
    checkInActual: row.check_in_actual ? new Date(row.check_in_actual as string).toISOString() : null,
    checkOutActual: row.check_out_actual ? new Date(row.check_out_actual as string).toISOString() : null,
    workMinutes: Number(row.work_minutes ?? 0),
    lateMinutes: Number(row.late_minutes ?? 0),
    earlyExitMinutes: Number(row.early_exit_minutes ?? 0),
    overtimeMinutes: Number(row.overtime_minutes ?? 0),
    overtimeApproved: Boolean(row.overtime_approved),
    overtimeApprovedBy: row.overtime_approved_by ? String(row.overtime_approved_by) : null,
    overtimeApprovedAt: row.overtime_approved_at ? new Date(row.overtime_approved_at as string).toISOString() : null,
    isIncomplete: Boolean(row.is_incomplete),
    source: row.source as any,
    notes: row.notes ? String(row.notes) : null,
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/* ── ٤. الإجازات والأرصدة والطلبات ────────────────────────────────────────── */

export async function listLeaveBalances(options?: {
  staffId?: number;
  year?: number;
}): Promise<HrLeaveBalanceView[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.staffId) {
    params.push(options.staffId);
    conditions.push(`lb.staff_id = $${params.length}`);
  }
  if (options?.year) {
    params.push(options.year);
    conditions.push(`lb.year = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT lb.*, s.full_name as staff_name, lt.name_ar as leave_type_name
    FROM hr_leave_balances lb
    JOIN hr_staff s ON s.id = lb.staff_id
    JOIN hr_leave_types lt ON lt.code = lb.leave_type_code
    ${whereClause}
    ORDER BY lb.year DESC, s.full_name ASC
  `;

  const { rows } = await pool.query(query, params);
  return rows.map(mapLeaveBalanceRow);
}

export async function listLeaveRequests(options?: {
  staffId?: number;
  status?: HrLeaveRequestStatus;
  startDate?: string;
  endDate?: string;
}): Promise<HrLeaveRequestView[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.staffId) {
    params.push(options.staffId);
    conditions.push(`lr.staff_id = $${params.length}`);
  }
  if (options?.status) {
    params.push(options.status);
    conditions.push(`lr.status = $${params.length}`);
  }
  if (options?.startDate) {
    params.push(options.startDate);
    conditions.push(`lr.end_date >= $${params.length}`);
  }
  if (options?.endDate) {
    params.push(options.endDate);
    conditions.push(`lr.start_date <= $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `
    SELECT lr.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department,
           lt.name_ar as leave_type_name
    FROM hr_leave_requests lr
    JOIN hr_staff s ON s.id = lr.staff_id
    JOIN hr_leave_types lt ON lt.code = lr.leave_type_code
    ${whereClause}
    ORDER BY lr.created_at DESC
  `;

  const { rows } = await pool.query(query, params);
  return rows.map(mapLeaveRequestRow);
}

export async function createLeaveRequest(
  input: {
    staffId: number;
    leaveTypeCode: HrLeaveTypeCode;
    startDate: string;
    endDate: string;
    daysCount: number;
    isPartialDay?: boolean;
    partialHours?: number | null;
    reason: string;
    attachmentRefs?: Array<{ id: string; name: string; url?: string }>;
  },
  session: SessionPayload,
): Promise<HrLeaveRequestView> {
  return withTransaction(async (client) => {
    // ١) منع التداخل مع إجازات أخرى معتمدة أو قيد المراجعة
    const overlapRes = await client.query(
      `SELECT id FROM hr_leave_requests
       WHERE staff_id = $1
         AND status IN ('approved', 'pending', 'under_review')
         AND start_date <= $3 AND end_date >= $2`,
      [input.staffId, input.startDate, input.endDate],
    );
    if (overlapRes.rows.length > 0) {
      throw new Error("يوجد طلب إجازة آخر متداخل في نفس الفترة الزمنية.");
    }

    const { rows } = await client.query(
      `INSERT INTO hr_leave_requests (
        staff_id, leave_type_code, start_date, end_date, days_count,
        is_partial_day, partial_hours, reason, attachment_refs, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        input.staffId,
        input.leaveTypeCode,
        input.startDate,
        input.endDate,
        input.daysCount,
        input.isPartialDay ?? false,
        input.partialHours ?? null,
        input.reason.trim(),
        JSON.stringify(input.attachmentRefs ?? []),
        session.username,
      ],
    );

    // حجز الأيام في الرصيد المعلق (pending_days)
    const year = new Date(input.startDate).getFullYear();
    await client.query(
      `UPDATE hr_leave_balances
       SET pending_days = pending_days + $1, updated_at = NOW()
       WHERE staff_id = $2 AND leave_type_code = $3 AND year = $4`,
      [input.daysCount, input.staffId, input.leaveTypeCode, year],
    );

    const reqRes = await client.query(
      `SELECT lr.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department,
              lt.name_ar as leave_type_name
       FROM hr_leave_requests lr
       JOIN hr_staff s ON s.id = lr.staff_id
       JOIN hr_leave_types lt ON lt.code = lr.leave_type_code
       WHERE lr.id = $1`,
      [rows[0].id],
    );

    const req = mapLeaveRequestRow(reqRes.rows[0]);
    await auditWithClient(
      client,
      "hr.leave.request",
      session,
      "hr_leave_request",
      req.id,
      `${req.staffName} (${req.leaveTypeName} ${req.daysCount} يوم)`,
    );
    return req;
  });
}

export async function decideLeaveRequest(
  requestId: number,
  decision: "approved" | "rejected" | "cancelled",
  reason: string,
  session: SessionPayload,
): Promise<HrLeaveRequestView> {
  return withTransaction(async (client) => {
    const { rows: currRows } = await client.query(
      `SELECT lr.*, s.full_name as staff_name, s.user_id as staff_user_id
       FROM hr_leave_requests lr
       JOIN hr_staff s ON s.id = lr.staff_id
       WHERE lr.id = $1 FOR UPDATE`,
      [requestId],
    );
    if (!currRows[0]) throw new Error("طلب الإجازة غير موجود.");
    const curr = currRows[0];

    // منع الموافقة الذاتية: المدير أو المسؤول لا يوافق على طلبه هو نفسه إذا كان مسندًا لملفه
    if (decision === "approved" && curr.staff_user_id === session.userId && session.role !== "admin") {
      throw new Error("لا يجوز اعتماد طلب الإجازة ذاتيًا.");
    }

    const year = new Date(curr.start_date).getFullYear();

    if (decision === "approved") {
      // خصم من الرصيد: إنقاص pending_days وزيادة used_days
      await client.query(
        `UPDATE hr_leave_balances
         SET pending_days = GREATEST(0, pending_days - $1),
             used_days = used_days + $1,
             updated_at = NOW()
         WHERE staff_id = $2 AND leave_type_code = $3 AND year = $4`,
        [curr.days_count, curr.staff_id, curr.leave_type_code, year],
      );

      // ربط الحضور بالجدول: تثبيت حالة on_leave في سجل الحضور لكل يوم من فترة الإجازة
      const start = new Date(curr.start_date);
      const end = new Date(curr.end_date);
      const cur = new Date(start);
      while (cur <= end) {
        const dStr = cur.toISOString().slice(0, 10);
        await client.query(
          `INSERT INTO hr_attendance_records (
            staff_id, attendance_date, status, notes, created_by
          ) VALUES ($1, $2, 'on_leave', $3, $4)
          ON CONFLICT (staff_id, attendance_date) DO UPDATE
          SET status = 'on_leave', notes = EXCLUDED.notes, updated_at = NOW()`,
          [curr.staff_id, dStr, `إجازة معتمدة رقم #${requestId}`, session.username],
        );
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      // رفض أو إلغاء: إعادة الأيام من pending_days
      await client.query(
        `UPDATE hr_leave_balances
         SET pending_days = GREATEST(0, pending_days - $1), updated_at = NOW()
         WHERE staff_id = $2 AND leave_type_code = $3 AND year = $4`,
        [curr.days_count, curr.staff_id, curr.leave_type_code, year],
      );
    }

    const { rows } = await client.query(
      `UPDATE hr_leave_requests
       SET status = $1, decision_by = $2, decision_at = NOW(), decision_reason = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [decision, session.username, reason.trim(), requestId],
    );

    const reqRes = await client.query(
      `SELECT lr.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department,
              lt.name_ar as leave_type_name
       FROM hr_leave_requests lr
       JOIN hr_staff s ON s.id = lr.staff_id
       JOIN hr_leave_types lt ON lt.code = lr.leave_type_code
       WHERE lr.id = $1`,
      [requestId],
    );

    const req = mapLeaveRequestRow(reqRes.rows[0]);
    await auditWithClient(
      client,
      "hr.leave.decision",
      session,
      "hr_leave_request",
      req.id,
      `${req.staffName} (${decision === "approved" ? "قبول" : "رفض"} ${req.leaveTypeName})`,
      { decision, reason },
    );
    return req;
  });
}

function mapLeaveBalanceRow(row: Record<string, unknown>): HrLeaveBalanceView {
  const alloc = Number(row.allocated_days ?? 0);
  const carried = Number(row.carried_over_days ?? 0);
  const used = Number(row.used_days ?? 0);
  const pending = Number(row.pending_days ?? 0);
  return {
    id: Number(row.id),
    staffId: Number(row.staff_id),
    staffName: (row.staff_name as string) ?? undefined,
    leaveTypeCode: row.leave_type_code as HrLeaveTypeCode,
    leaveTypeName: (row.leave_type_name as string) ?? undefined,
    year: Number(row.year),
    allocatedDays: alloc,
    carriedOverDays: carried,
    usedDays: used,
    pendingDays: pending,
    availableDays: Math.max(0, alloc + carried - used - pending),
    effectiveFrom: String(row.effective_from),
    effectiveTo: String(row.effective_to),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function mapLeaveRequestRow(row: Record<string, unknown>): HrLeaveRequestView {
  return {
    id: Number(row.id),
    staffId: Number(row.staff_id),
    staffName: String(row.staff_name ?? ""),
    staffJobTitle: String(row.staff_job_title ?? ""),
    department: row.department as any,
    leaveTypeCode: row.leave_type_code as HrLeaveTypeCode,
    leaveTypeName: (row.leave_type_name as string) ?? undefined,
    startDate: String(row.start_date),
    endDate: String(row.end_date),
    daysCount: Number(row.days_count),
    isPartialDay: Boolean(row.is_partial_day),
    partialHours: row.partial_hours !== null ? Number(row.partial_hours) : null,
    reason: String(row.reason),
    status: row.status as HrLeaveRequestStatus,
    decisionBy: row.decision_by ? String(row.decision_by) : null,
    decisionAt: row.decision_at ? new Date(row.decision_at as string).toISOString() : null,
    decisionReason: row.decision_reason ? String(row.decision_reason) : null,
    attachmentRefs: (Array.isArray(row.attachment_refs) ? row.attachment_refs : JSON.parse(String(row.attachment_refs ?? "[]"))) as any,
    createdBy: String(row.created_by),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}
