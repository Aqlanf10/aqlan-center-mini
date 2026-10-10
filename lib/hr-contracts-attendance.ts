/**
 * (HR-3 / HR-4) العقود، جداول العمل، الحضور والانصراف، والإجازات — **طبقة الخادم وقاعدة البيانات**.
 *
 * كل دالة هنا تلمس PostgreSQL (مباشرة أو عبر معاملة) وتُنفَّذ على الخادم حصرًا.
 * تضمن:
 * ١) كتابة التدقيق ذرّيًا داخل المعاملة نفسها (insertAuditRow(client, ...)) لتفادي الفقد أو الجمود.
 * ٢) التحقق الخادمي الصارم من هوية المستخدم وصلاحية جلسته ومنع الموافقة الذاتية.
 * ٣) الحفاظ على السجل الأصلي للحضور (raw punch log) ومنع الاستبدال الصامت بالتصحيحات المعتمدة.
 * ٤) منع التداخل والموافقة الذاتية غير المسموح بها في الإجازات مع سلامة الأرصدة عند التكرار أو الإلغاء.
 */

import { getPool, insertAuditRow, type DbClient } from "./db";
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

export interface CreateContractInput {
  staffId: number | string;
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
}

export interface UpdateContractInput {
  title?: string;
  startDate?: string;
  endDate?: string | null;
  probationEndDate?: string | null;
  noticePeriodDays?: number;
  termsPayload?: Record<string, unknown>;
  baseSalaryMinor?: number | null;
  salaryCurrency?: string | null;
  salaryPeriod?: string | null;
  commissionRatePercent?: number | null;
  doctorPartyId?: number | null;
  notes?: string | null;
  signedByStaff?: boolean;
  signedByCenter?: boolean;
}

export interface CreateAddendumInput {
  addendumReason: string;
  title: string;
  startDate: string;
  endDate?: string | null;
  termsPayload?: Record<string, unknown>;
  baseSalaryMinor?: number | null;
  salaryCurrency?: string | null;
  commissionRatePercent?: number | null;
  notes?: string | null;
}

export async function listContracts(options?: {
  staffId?: number | string;
  status?: HrContractStatus;
  templateKind?: HrContractTemplateKind;
}): Promise<HrContractView[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.staffId) {
    params.push(Number(options.staffId));
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

export async function getContract(id: number | string): Promise<HrContractView | null> {
  const contractId = Number(id);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.*, s.full_name as staff_name, s.department as staff_department
     FROM hr_contracts c
     JOIN hr_staff s ON s.id = c.staff_id
     WHERE c.id = $1`,
    [contractId],
  );
  if (!rows[0]) return null;
  return mapContractRow(rows[0]);
}

export const getContractById = getContract;

export async function createContract(
  input: CreateContractInput,
  session: SessionPayload,
): Promise<HrContractView> {
  const staffId = Number(input.staffId);
  return withTransaction(getPool(), async (client) => {
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
        staffId,
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
      { staffId, templateKind: input.templateKind },
    );

    return contract;
  });
}

export async function updateContract(
  id: number | string,
  input: UpdateContractInput,
  session: SessionPayload,
): Promise<HrContractView> {
  const contractId = Number(id);
  return withTransaction(getPool(), async (client) => {
    const { rows: currentRows } = await client.query(
      `SELECT * FROM hr_contracts WHERE id = $1 FOR UPDATE`,
      [contractId],
    );
    if (!currentRows[0]) throw new Error("العقد غير موجود.");
    const current = currentRows[0];

    if (current.status !== "draft" && current.status !== "under_review") {
      throw new Error("لا يمكن تعديل بنود عقد معتمد أو نشط مباشرة؛ استخدم إنشاء ملحق عقد.");
    }

    const { rows } = await client.query(
      `UPDATE hr_contracts
       SET title = COALESCE($1, title),
           start_date = COALESCE($2, start_date),
           end_date = COALESCE($3, end_date),
           probation_end_date = COALESCE($4, probation_end_date),
           notice_period_days = COALESCE($5, notice_period_days),
           terms_payload = CASE WHEN $6::jsonb IS NOT NULL THEN $6::jsonb ELSE terms_payload END,
           base_salary_minor = COALESCE($7, base_salary_minor),
           salary_currency = COALESCE($8, salary_currency),
           salary_period = COALESCE($9, salary_period),
           commission_rate_percent = COALESCE($10, commission_rate_percent),
           doctor_party_id = COALESCE($11, doctor_party_id),
           notes = COALESCE($12, notes),
           signed_by_staff = COALESCE($13, signed_by_staff),
           signed_by_center = COALESCE($14, signed_by_center),
           updated_at = NOW()
       WHERE id = $15
       RETURNING *`,
      [
        input.title?.trim() ?? null,
        input.startDate ?? null,
        input.endDate ?? null,
        input.probationEndDate ?? null,
        input.noticePeriodDays ?? null,
        input.termsPayload ? JSON.stringify(input.termsPayload) : null,
        input.baseSalaryMinor ?? null,
        input.salaryCurrency ?? null,
        input.salaryPeriod ?? null,
        input.commissionRatePercent ?? null,
        input.doctorPartyId ?? null,
        input.notes ?? null,
        input.signedByStaff ?? null,
        input.signedByCenter ?? null,
        contractId,
      ],
    );

    const contract = mapContractRow(rows[0]);
    await auditWithClient(
      client,
      "hr.contract.update",
      session,
      "hr_contract",
      contract.id,
      `${contract.contractNumber} (${contract.title})`,
      { contractId },
    );

    return contract;
  });
}

export async function approveContract(
  contractId: number | string,
  session: SessionPayload,
): Promise<HrContractView> {
  const cId = Number(contractId);
  return withTransaction(getPool(), async (client) => {
    const { rows: currentRows } = await client.query(
      `SELECT * FROM hr_contracts WHERE id = $1 FOR UPDATE`,
      [cId],
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
      [session.username, cId],
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

export async function transitionContractStatus(
  id: number | string,
  newStatus: HrContractStatus,
  reason: string,
  session: SessionPayload,
): Promise<HrContractView> {
  const cId = Number(id);
  if (newStatus === "approved") {
    return approveContract(cId, session);
  }

  return withTransaction(getPool(), async (client) => {
    const { rows: currentRows } = await client.query(
      `SELECT * FROM hr_contracts WHERE id = $1 FOR UPDATE`,
      [cId],
    );
    if (!currentRows[0]) throw new Error("العقد غير موجود.");

    const { rows } = await client.query(
      `UPDATE hr_contracts
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [newStatus, cId],
    );

    const contract = mapContractRow(rows[0]);
    const action = newStatus === "active" ? "hr.contract.approve" : newStatus === "terminated" ? "hr.contract.terminate" : "hr.contract.update";
    await auditWithClient(
      client,
      action,
      session,
      "hr_contract",
      contract.id,
      `${contract.contractNumber} -> ${newStatus}`,
      { oldStatus: currentRows[0].status, newStatus, reason: reason.trim() },
    );
    return contract;
  });
}

export async function createContractAddendum(
  parentContractId: number | string,
  input: CreateAddendumInput,
  session: SessionPayload,
): Promise<HrContractView> {
  const pId = Number(parentContractId);
  return withTransaction(getPool(), async (client) => {
    const { rows: parentRows } = await client.query(
      `SELECT * FROM hr_contracts WHERE id = $1 FOR UPDATE`,
      [pId],
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
        pId,
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
      { parentContractId: pId, reason: input.addendumReason },
    );
    return contract;
  });
}

export async function listContractAddenda(
  parentContractId: number | string,
): Promise<HrContractView[]> {
  const pId = Number(parentContractId);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT c.*, s.full_name as staff_name, s.department as staff_department
     FROM hr_contracts c
     JOIN hr_staff s ON s.id = c.staff_id
     WHERE c.parent_contract_id = $1
     ORDER BY c.version_number ASC`,
    [pId],
  );
  return rows.map(mapContractRow);
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

export interface CreateScheduleInput {
  staffId?: number | string | null;
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
}

export type UpdateScheduleInput = Partial<CreateScheduleInput> & { isActive?: boolean };

export async function listSchedules(options?: {
  staffId?: number | string;
  department?: string;
  isActive?: boolean;
  isDefault?: boolean;
}): Promise<HrWorkScheduleView[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.staffId) {
    params.push(Number(options.staffId));
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
  if (options?.isDefault === true) {
    conditions.push(`ws.staff_id IS NULL`);
  } else if (options?.isDefault === false) {
    conditions.push(`ws.staff_id IS NOT NULL`);
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

export const listWorkSchedules = listSchedules;

export async function getWorkScheduleById(id: number | string): Promise<HrWorkScheduleView | null> {
  const schedId = Number(id);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ws.*, s.full_name as staff_name
     FROM hr_work_schedules ws
     LEFT JOIN hr_staff s ON s.id = ws.staff_id
     WHERE ws.id = $1`,
    [schedId],
  );
  if (!rows[0]) return null;
  return mapScheduleRow(rows[0]);
}

export async function createSchedule(
  input: CreateScheduleInput,
  session: SessionPayload,
): Promise<HrWorkScheduleView> {
  const staffId = input.staffId !== undefined && input.staffId !== null ? Number(input.staffId) : null;
  return withTransaction(getPool(), async (client) => {
    const { rows } = await client.query(
      `INSERT INTO hr_work_schedules (
        staff_id, department, name, schedule_type, effective_from, effective_to,
        working_days, shift_start_time, shift_end_time, second_shift_start, second_shift_end,
        grace_period_mins, expected_daily_hours, crosses_midnight, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        staffId,
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
      { scheduleType: input.scheduleType, staffId },
    );
    return schedule;
  });
}

export const createWorkSchedule = createSchedule;

export async function updateWorkSchedule(
  id: number | string,
  input: UpdateScheduleInput,
  session: SessionPayload,
): Promise<HrWorkScheduleView> {
  const schedId = Number(id);
  return withTransaction(getPool(), async (client) => {
    const { rows: currentRows } = await client.query(
      `SELECT * FROM hr_work_schedules WHERE id = $1 FOR UPDATE`,
      [schedId],
    );
    if (!currentRows[0]) throw new Error("جدول الدوام غير موجود.");

    const staffId = input.staffId !== undefined ? (input.staffId ? Number(input.staffId) : null) : undefined;

    const { rows } = await client.query(
      `UPDATE hr_work_schedules
       SET staff_id = COALESCE($1, staff_id),
           department = COALESCE($2, department),
           name = COALESCE($3, name),
           schedule_type = COALESCE($4, schedule_type),
           effective_from = COALESCE($5, effective_from),
           effective_to = COALESCE($6, effective_to),
           working_days = CASE WHEN $7::jsonb IS NOT NULL THEN $7::jsonb ELSE working_days END,
           shift_start_time = COALESCE($8, shift_start_time),
           shift_end_time = COALESCE($9, shift_end_time),
           second_shift_start = COALESCE($10, second_shift_start),
           second_shift_end = COALESCE($11, second_shift_end),
           grace_period_mins = COALESCE($12, grace_period_mins),
           expected_daily_hours = COALESCE($13, expected_daily_hours),
           crosses_midnight = COALESCE($14, crosses_midnight),
           is_active = COALESCE($15, is_active),
           updated_at = NOW()
       WHERE id = $16
       RETURNING *`,
      [
        staffId ?? null,
        input.department ?? null,
        input.name?.trim() ?? null,
        input.scheduleType ?? null,
        input.effectiveFrom ?? null,
        input.effectiveTo ?? null,
        input.workingDays ? JSON.stringify(input.workingDays) : null,
        input.shiftStartTime ?? null,
        input.shiftEndTime ?? null,
        input.secondShiftStart ?? null,
        input.secondShiftEnd ?? null,
        input.gracePeriodMins ?? null,
        input.expectedDailyHours ?? null,
        input.crossesMidnight ?? null,
        input.isActive ?? null,
        schedId,
      ],
    );

    const schedule = mapScheduleRow(rows[0]);
    await auditWithClient(
      client,
      "hr.schedule.update",
      session,
      "hr_work_schedule",
      schedule.id,
      schedule.name,
      { scheduleId: schedId },
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

export interface AttendancePunchInput {
  staffId: number | string;
  punchType: "check_in" | "check_out";
  punchTime?: string;
  source?: string;
  note?: string | null;
  ipAddress?: string | null;
}

export interface RequestCorrectionInput {
  attendanceRecordId: number | string;
  fieldCorrected: "check_in" | "check_out" | "status" | "overtime" | "all";
  newCheckIn?: string | null;
  newCheckOut?: string | null;
  newStatus?: HrAttendanceStatus | string | null;
  reason: string;
}

export async function listAttendanceRecords(options: {
  date?: string;
  startDate?: string;
  endDate?: string;
  staffId?: number | string;
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
    params.push(Number(options.staffId));
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
    staffId: number | string;
    attendanceDate: string;
    checkIn?: string | null;
    checkOut?: string | null;
    status?: HrAttendanceStatus;
    notes?: string | null;
  },
  session: SessionPayload,
): Promise<HrAttendanceRecordView> {
  const staffId = Number(input.staffId);
  return withTransaction(getPool(), async (client) => {
    // جلب جدول العمل الساري للموظف أو لقسمه لاحتساب التأخير والساعات بدقة
    const schedRes = await client.query(
      `SELECT ws.* FROM hr_work_schedules ws
       JOIN hr_staff s ON s.id = $1
       WHERE ws.is_active = true
         AND (ws.staff_id = $1 OR (ws.staff_id IS NULL AND ws.department = s.department))
       ORDER BY ws.staff_id NULLS LAST, ws.effective_from DESC
       LIMIT 1`,
      [staffId],
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
        staffId,
        schedule?.id ?? null,
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

    const fullRes = await client.query(
      `SELECT ar.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department
       FROM hr_attendance_records ar
       JOIN hr_staff s ON s.id = ar.staff_id
       WHERE ar.id = $1`,
      [rows[0].id],
    );

    const record = mapAttendanceRow(fullRes.rows[0]);
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

export async function recordAttendancePunch(
  input: AttendancePunchInput,
  session: SessionPayload,
): Promise<HrAttendanceRecordView> {
  const staffId = Number(input.staffId);
  const punchIso = input.punchTime || new Date().toISOString();
  const dateStr = punchIso.slice(0, 10);

  if (input.punchType === "check_in") {
    return recordAttendance(
      {
        staffId,
        attendanceDate: dateStr,
        checkIn: punchIso,
        notes: input.note,
      },
      session,
    );
  }

  // punchType === "check_out"
  const pool = getPool();
  const existing = await pool.query(
    `SELECT * FROM hr_attendance_records WHERE staff_id = $1 AND attendance_date = $2`,
    [staffId, dateStr],
  );

  const checkIn = existing.rows[0]?.check_in_actual ? new Date(existing.rows[0].check_in_actual).toISOString() : null;

  return recordAttendance(
    {
      staffId,
      attendanceDate: dateStr,
      checkIn,
      checkOut: punchIso,
      notes: input.note,
    },
    session,
  );
}

export async function correctAttendanceRecord(
  attendanceId: number | string,
  input: {
    fieldCorrected: "check_in" | "check_out" | "status" | "overtime" | "all";
    newCheckIn?: string | null;
    newCheckOut?: string | null;
    newStatus?: HrAttendanceStatus | string;
    reason: string;
  },
  session: SessionPayload,
): Promise<HrAttendanceRecordView> {
  const attId = Number(attendanceId);
  return withTransaction(getPool(), async (client) => {
    const { rows: currRows } = await client.query(
      `SELECT ar.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department, s.user_id as staff_user_id
       FROM hr_attendance_records ar
       JOIN hr_staff s ON s.id = ar.staff_id
       WHERE ar.id = $1 FOR UPDATE`,
      [attId],
    );
    if (!currRows[0]) throw new Error("سجل الحضور غير موجود.");
    const curr = currRows[0];

    // منع الموافقة الذاتية على تصحيح الحضور
    if (curr.staff_user_id === session.userId) {
      throw new Error("لا يجوز اعتماد تصحيح الحضور ذاتيًا.");
    }

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
        attId,
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
      [newIn, newOut, newStatus, Boolean(newIn && !newOut), attId],
    );

    const updated = mapAttendanceRow({ ...curr, ...updatedRows[0] });
    await auditWithClient(
      client,
      "hr.attendance.correct",
      session,
      "hr_attendance_record",
      attId,
      `${updated.staffName} (${updated.attendanceDate})`,
      { reason: input.reason, field: input.fieldCorrected },
    );
    return updated;
  });
}

export async function requestAttendanceCorrection(
  input: RequestCorrectionInput,
  session: SessionPayload,
): Promise<HrAttendanceCorrectionView> {
  const attId = Number(input.attendanceRecordId);
  return withTransaction(getPool(), async (client) => {
    const { rows: currRows } = await client.query(
      `SELECT ar.*, s.full_name as staff_name, s.user_id as staff_user_id
       FROM hr_attendance_records ar
       JOIN hr_staff s ON s.id = ar.staff_id
       WHERE ar.id = $1 FOR UPDATE`,
      [attId],
    );
    if (!currRows[0]) throw new Error("سجل الحضور غير موجود.");
    const curr = currRows[0];

    const newIn = input.newCheckIn ? new Date(input.newCheckIn) : null;
    const newOut = input.newCheckOut ? new Date(input.newCheckOut) : null;

    const { rows } = await client.query(
      `INSERT INTO hr_attendance_corrections (
        attendance_id, staff_id, field_corrected, old_check_in, new_check_in,
        old_check_out, new_check_out, old_status, new_status, reason,
        requested_by, approved_by, approved_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      RETURNING *`,
      [
        attId,
        curr.staff_id,
        input.fieldCorrected,
        curr.check_in_actual,
        newIn,
        curr.check_out_actual,
        newOut,
        curr.status,
        input.newStatus ?? curr.status,
        input.reason.trim(),
        session.username,
        session.username,
      ],
    );

    // تحديث السجل الفعلي
    if (newIn !== null || newOut !== null || input.newStatus) {
      await client.query(
        `UPDATE hr_attendance_records
         SET check_in_actual = COALESCE($1, check_in_actual),
             check_out_actual = COALESCE($2, check_out_actual),
             status = COALESCE($3, status),
             updated_at = NOW()
         WHERE id = $4`,
        [newIn, newOut, input.newStatus ?? null, attId],
      );
    }

    const corr = mapCorrectionRow({ ...rows[0], staff_name: curr.staff_name });
    await auditWithClient(
      client,
      "hr.attendance.correct",
      session,
      "hr_attendance_correction",
      corr.id,
      `${curr.staff_name} (${input.fieldCorrected})`,
      { attendanceId: attId, reason: input.reason },
    );
    return corr;
  });
}

export async function listAttendanceCorrections(options?: {
  staffId?: number | string;
  status?: string;
}): Promise<HrAttendanceCorrectionView[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.staffId) {
    params.push(Number(options.staffId));
    conditions.push(`c.staff_id = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT c.*, s.full_name as staff_name
     FROM hr_attendance_corrections c
     JOIN hr_staff s ON s.id = c.staff_id
     ${whereClause}
     ORDER BY c.created_at DESC`,
    params,
  );
  return rows.map(mapCorrectionRow);
}

export async function decideAttendanceCorrection(
  id: number | string,
  decision: "approved" | "rejected",
  reason: string | null,
  session: SessionPayload,
): Promise<HrAttendanceCorrectionView> {
  const corrId = Number(id);
  return withTransaction(getPool(), async (client) => {
    const { rows: corrRows } = await client.query(
      `SELECT c.*, s.full_name as staff_name, s.user_id as staff_user_id
       FROM hr_attendance_corrections c
       JOIN hr_staff s ON s.id = c.staff_id
       WHERE c.id = $1 FOR UPDATE`,
      [corrId],
    );
    if (!corrRows[0]) throw new Error("طلب تصحيح الحضور غير موجود.");
    const corr = corrRows[0];

    // منع الموافقة الذاتية
    if (decision === "approved" && (corr.requested_by === session.username || corr.staff_user_id === session.userId)) {
      throw new Error("لا يجوز اعتماد تصحيح الحضور ذاتيًا.");
    }

    if (decision === "approved") {
      await client.query(
        `UPDATE hr_attendance_records
         SET check_in_actual = COALESCE($1, check_in_actual),
             check_out_actual = COALESCE($2, check_out_actual),
             status = COALESCE($3, status),
             updated_at = NOW()
         WHERE id = $4`,
        [corr.new_check_in, corr.new_check_out, corr.new_status, corr.attendance_id],
      );
    }

    const { rows } = await client.query(
      `UPDATE hr_attendance_corrections
       SET approved_by = $1, approved_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [session.username, corrId],
    );

    const result = mapCorrectionRow({ ...rows[0], staff_name: corr.staff_name });
    await auditWithClient(
      client,
      "hr.attendance.correct",
      session,
      "hr_attendance_correction",
      corrId,
      `${corr.staff_name} (${decision})`,
      { decision, reason },
    );
    return result;
  });
}

function mapCorrectionRow(row: Record<string, unknown>): HrAttendanceCorrectionView {
  return {
    id: Number(row.id),
    attendanceId: Number(row.attendance_id),
    staffId: Number(row.staff_id),
    staffName: (row.staff_name as string) ?? undefined,
    fieldCorrected: row.field_corrected as any,
    oldCheckIn: row.old_check_in ? new Date(row.old_check_in as string).toISOString() : null,
    newCheckIn: row.new_check_in ? new Date(row.new_check_in as string).toISOString() : null,
    oldCheckOut: row.old_check_out ? new Date(row.old_check_out as string).toISOString() : null,
    newCheckOut: row.new_check_out ? new Date(row.new_check_out as string).toISOString() : null,
    oldStatus: row.old_status ? String(row.old_status) : null,
    newStatus: row.new_status ? String(row.new_status) : null,
    reason: String(row.reason),
    requestedBy: String(row.requested_by),
    approvedBy: String(row.approved_by),
    approvedAt: new Date(row.approved_at as string).toISOString(),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
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

export async function listLeaveTypes(): Promise<Array<{
  id: number;
  code: HrLeaveTypeCode;
  nameAr: string;
  isPaid: boolean;
  defaultDaysPerYear: number | null;
  allowNegative: boolean;
  requiresAttachment: boolean;
}>> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT * FROM hr_leave_types ORDER BY id ASC`);
  return rows.map((r) => ({
    id: Number(r.id),
    code: r.code as HrLeaveTypeCode,
    nameAr: String(r.name_ar),
    isPaid: Boolean(r.is_paid),
    defaultDaysPerYear: r.default_days_per_year !== null ? Number(r.default_days_per_year) : null,
    allowNegative: Boolean(r.allow_negative),
    requiresAttachment: Boolean(r.requires_attachment),
  }));
}

export async function listLeaveBalances(
  optionsOrStaffId?: number | string | { staffId?: number | string; year?: number },
  maybeYear?: number,
): Promise<HrLeaveBalanceView[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  let staffId: number | undefined;
  let year: number | undefined;

  if (typeof optionsOrStaffId === "object" && optionsOrStaffId !== null) {
    if (optionsOrStaffId.staffId !== undefined) staffId = Number(optionsOrStaffId.staffId);
    if (optionsOrStaffId.year !== undefined) year = Number(optionsOrStaffId.year);
  } else if (optionsOrStaffId !== undefined) {
    staffId = Number(optionsOrStaffId);
    if (maybeYear !== undefined) year = Number(maybeYear);
  }

  if (staffId !== undefined) {
    params.push(staffId);
    conditions.push(`lb.staff_id = $${params.length}`);
  }
  if (year !== undefined) {
    params.push(year);
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

export async function adjustLeaveBalance(
  staffIdOrInput: number | string | {
    staffId: number | string;
    leaveTypeCode: string;
    year: number;
    allocatedDays: number;
    carriedOverDays?: number;
    effectiveFrom?: string;
    effectiveTo?: string;
  },
  leaveTypeCodeOrSession?: string | SessionPayload,
  year?: number,
  allocatedDays?: number,
  reason?: string,
  session?: SessionPayload,
): Promise<HrLeaveBalanceView> {
  let sId: number;
  let code: string;
  let yr: number;
  let days: number;
  let sess: SessionPayload;

  if (typeof staffIdOrInput === "object" && staffIdOrInput !== null) {
    sId = Number(staffIdOrInput.staffId);
    code = staffIdOrInput.leaveTypeCode;
    yr = Number(staffIdOrInput.year);
    days = Number(staffIdOrInput.allocatedDays);
    sess = leaveTypeCodeOrSession as SessionPayload;
  } else {
    sId = Number(staffIdOrInput);
    code = String(leaveTypeCodeOrSession);
    yr = Number(year);
    days = Number(allocatedDays);
    sess = session!;
  }

  return withTransaction(getPool(), async (client) => {
    const effFrom = `${yr}-01-01`;
    const effTo = `${yr}-12-31`;

    const { rows } = await client.query(
      `INSERT INTO hr_leave_balances (
        staff_id, leave_type_code, year, allocated_days, effective_from, effective_to
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (staff_id, leave_type_code, year) DO UPDATE
      SET allocated_days = EXCLUDED.allocated_days, updated_at = NOW()
      RETURNING *`,
      [sId, code, yr, days, effFrom, effTo],
    );

    const balanceRes = await client.query(
      `SELECT lb.*, s.full_name as staff_name, lt.name_ar as leave_type_name
       FROM hr_leave_balances lb
       JOIN hr_staff s ON s.id = lb.staff_id
       JOIN hr_leave_types lt ON lt.code = lb.leave_type_code
       WHERE lb.id = $1`,
      [rows[0].id],
    );

    const balance = mapLeaveBalanceRow(balanceRes.rows[0]);
    await auditWithClient(
      client,
      "hr.leave.balance_adjust",
      sess,
      "hr_leave_balance",
      balance.id,
      `${balance.staffName} (${balance.leaveTypeName} ${yr}: ${days} يوم)`,
      { staffId: sId, leaveTypeCode: code, year: yr, allocatedDays: days, reason },
    );
    return balance;
  });
}

export async function listLeaveRequests(options?: {
  staffId?: number | string;
  status?: HrLeaveRequestStatus;
  startDate?: string;
  endDate?: string;
}): Promise<HrLeaveRequestView[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.staffId) {
    params.push(Number(options.staffId));
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

export interface CreateLeaveRequestInput {
  staffId: number | string;
  leaveTypeCode: HrLeaveTypeCode;
  startDate: string;
  endDate: string;
  daysCount: number;
  isPartialDay?: boolean;
  partialHours?: number | null;
  reason: string;
  attachmentRefs?: Array<{ id: string; name: string; url?: string }>;
}

export async function createLeaveRequest(
  input: CreateLeaveRequestInput,
  session: SessionPayload,
): Promise<HrLeaveRequestView> {
  const staffId = Number(input.staffId);
  return withTransaction(getPool(), async (client) => {
    // ١) منع التداخل مع إجازات أخرى معتمدة أو قيد المراجعة
    const overlapRes = await client.query(
      `SELECT id FROM hr_leave_requests
       WHERE staff_id = $1
         AND status IN ('approved', 'pending', 'under_review')
         AND start_date <= $3 AND end_date >= $2`,
      [staffId, input.startDate, input.endDate],
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
        staffId,
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
      [input.daysCount, staffId, input.leaveTypeCode, year],
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

export const requestLeave = createLeaveRequest;

export async function decideLeaveRequest(
  requestId: number | string,
  decision: "approved" | "rejected" | "cancelled",
  reason: string,
  session: SessionPayload,
): Promise<HrLeaveRequestView> {
  const reqId = Number(requestId);
  return withTransaction(getPool(), async (client) => {
    const { rows: currRows } = await client.query(
      `SELECT lr.*, s.full_name as staff_name, s.user_id as staff_user_id
       FROM hr_leave_requests lr
       JOIN hr_staff s ON s.id = lr.staff_id
       WHERE lr.id = $1 FOR UPDATE`,
      [reqId],
    );
    if (!currRows[0]) throw new Error("طلب الإجازة غير موجود.");
    const curr = currRows[0];

    // إن كانت الحالة هي نفسها تمامًا، فالعملية idempotent تعيد السجل فورًا دون تكرار أي أثر مالي أو زمني
    if (curr.status === decision) {
      return mapLeaveRequestRow(curr);
    }

    // منع الموافقة الذاتية: لا يجوز لأي مستخدم (حتى المدير) اعتماد طلبه الخاص
    if (decision === "approved" && curr.staff_user_id === session.userId) {
      throw new Error("لا يجوز اعتماد طلب الإجازة ذاتيًا.");
    }

    const year = new Date(curr.start_date).getFullYear();

    if (decision === "approved") {
      // نقل الأيام من المعلقة إلى المستعملة
      if (curr.status === "pending" || curr.status === "under_review") {
        await client.query(
          `UPDATE hr_leave_balances
           SET pending_days = GREATEST(0, pending_days - $1),
               used_days = used_days + $1,
               updated_at = NOW()
           WHERE staff_id = $2 AND leave_type_code = $3 AND year = $4`,
          [curr.days_count, curr.staff_id, curr.leave_type_code, year],
        );
      } else {
        // إعادة اعتماد بعد إلغاء أو رفض
        await client.query(
          `UPDATE hr_leave_balances
           SET used_days = used_days + $1,
               updated_at = NOW()
           WHERE staff_id = $2 AND leave_type_code = $3 AND year = $4`,
          [curr.days_count, curr.staff_id, curr.leave_type_code, year],
        );
      }

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
          [curr.staff_id, dStr, `إجازة معتمدة رقم #${reqId}`, session.username],
        );
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      // قرار الرفض أو الإلغاء
      if (curr.status === "approved") {
        // كانت الإجازة معتمدة: استرجاع رصيد الأيام المستخدمة وعكس الحضور
        await client.query(
          `UPDATE hr_leave_balances
           SET used_days = GREATEST(0, used_days - $1),
               updated_at = NOW()
           WHERE staff_id = $2 AND leave_type_code = $3 AND year = $4`,
          [curr.days_count, curr.staff_id, curr.leave_type_code, year],
        );

        // حذف قيود on_leave المنشأة لهذا الطلب
        await client.query(
          `DELETE FROM hr_attendance_records
           WHERE staff_id = $1
             AND attendance_date BETWEEN $2 AND $3
             AND status = 'on_leave'
             AND notes = $4`,
          [curr.staff_id, curr.start_date, curr.end_date, `إجازة معتمدة رقم #${reqId}`],
        );
      } else if (curr.status === "pending" || curr.status === "under_review") {
        // كانت قيد الانتظار: استرجاع الأيام المعلقة فقط
        await client.query(
          `UPDATE hr_leave_balances
           SET pending_days = GREATEST(0, pending_days - $1),
               updated_at = NOW()
           WHERE staff_id = $2 AND leave_type_code = $3 AND year = $4`,
          [curr.days_count, curr.staff_id, curr.leave_type_code, year],
        );
      }
    }

    await client.query(
      `UPDATE hr_leave_requests
       SET status = $1, decision_by = $2, decision_at = NOW(), decision_reason = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [decision, session.username, reason.trim(), reqId],
    );

    const reqRes = await client.query(
      `SELECT lr.*, s.full_name as staff_name, s.job_title as staff_job_title, s.department,
              lt.name_ar as leave_type_name
       FROM hr_leave_requests lr
       JOIN hr_staff s ON s.id = lr.staff_id
       JOIN hr_leave_types lt ON lt.code = lr.leave_type_code
       WHERE lr.id = $1`,
      [reqId],
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
