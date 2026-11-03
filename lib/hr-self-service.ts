import type { SessionPayload } from "./auth";
import { CLINIC_TIME_ZONE, ensureSchema, getPool, type DbClient } from "./db";
import { staffIdentityForUser } from "./hr-person-identity-approval";
import { clinicDateString } from "./schedule";

export interface HrSelfServiceSummary {
  linked: boolean;
  staff: {
    id: number;
    fullName: string;
    department: string | null;
    jobTitle: string | null;
    workStatus: string;
    contractKind: string;
    hireDate: string | null;
  } | null;
  contract: {
    id: number;
    contractNumber: string;
    title: string;
    templateKind: string;
    status: string;
    startDate: string;
    endDate: string | null;
    compensationKind: string;
    baseSalaryMinor: number | null;
    salaryCurrency: string | null;
    salaryPeriod: string | null;
    commissionRatePercent: number | null;
  } | null;
  schedules: Array<{
    id: number;
    name: string;
    scheduleType: string;
    workingDays: number[];
    shiftStartTime: string;
    shiftEndTime: string;
    gracePeriodMins: number;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
  attendanceMonth: string;
  attendance: Array<{
    id: number;
    attendanceDate: string;
    status: string;
    checkInActual: string | null;
    checkOutActual: string | null;
    workMinutes: number;
    lateMinutes: number;
    earlyExitMinutes: number;
    overtimeMinutes: number;
    isIncomplete: boolean;
  }>;
  leaveBalances: Array<{
    leaveTypeCode: string;
    leaveTypeName: string;
    year: number;
    allocatedDays: number;
    usedDays: number;
    pendingDays: number;
    availableDays: number;
  }>;
  leaveRequests: Array<{
    id: number;
    leaveTypeName: string;
    startDate: string;
    endDate: string;
    daysCount: number;
    status: string;
    reason: string;
  }>;
}

export async function getMyHrSummary(session: SessionPayload): Promise<HrSelfServiceSummary> {
  await ensureSchema();
  return getMyHrSummaryWith(getPool(), session.userId);
}

export async function getMyHrSummaryWith(
  pool: Pick<DbClient, "query">,
  userId: number,
): Promise<HrSelfServiceSummary> {
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const currentMonth = today.slice(0, 7);
  const currentYear = Number(today.slice(0, 4));

  let staffId: number | null = null;
  try {
    staffId = await staffIdentityForUser(pool, userId);
  } catch {
    staffId = null;
  }

  if (!staffId) {
    return {
      linked: false,
      staff: null,
      contract: null,
      schedules: [],
      attendanceMonth: currentMonth,
      attendance: [],
      leaveBalances: [],
      leaveRequests: [],
    };
  }

  const staffRes = await pool.query<{
    id: number;
    full_name: string;
    department: string | null;
    job_title: string | null;
    work_status: string;
    contract_kind: string;
    hire_date: string | null;
  }>(
    `SELECT id, full_name, department, job_title, work_status, contract_kind, hire_date::text AS hire_date
       FROM hr_staff WHERE id = $1`,
    [staffId],
  );
  const contractRes = await pool.query<{
    id: number;
    contract_number: string;
    title: string;
    template_kind: string;
    status: string;
    start_date: string;
    end_date: string | null;
    compensation_kind: string;
    base_salary_minor: string | null;
    salary_currency: string | null;
    salary_period: string | null;
    commission_rate_percent: string | null;
  }>(
    `SELECT id, contract_number, title, template_kind, status,
            start_date::text AS start_date, end_date::text AS end_date,
            compensation_kind, base_salary_minor::text AS base_salary_minor,
            salary_currency, salary_period, commission_rate_percent::text AS commission_rate_percent
       FROM hr_contracts
      WHERE staff_id = $1 AND status IN ('active', 'approved')
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, start_date DESC, id DESC
      LIMIT 1`,
    [staffId],
  );
  const scheduleRes = await pool.query<{
    id: number;
    name: string;
    schedule_type: string;
    working_days: number[];
    shift_start_time: string;
    shift_end_time: string;
    grace_period_mins: number;
    effective_from: string;
    effective_to: string | null;
  }>(
    `SELECT id, name, schedule_type, working_days, shift_start_time::text AS shift_start_time,
            shift_end_time::text AS shift_end_time, grace_period_mins,
            effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM hr_work_schedules
      WHERE staff_id = $1 AND is_active = TRUE
      ORDER BY effective_from DESC, id DESC`,
    [staffId],
  );
  const attRes = await pool.query<{
    id: number;
    attendance_date: string;
    status: string;
    check_in_actual: Date | null;
    check_out_actual: Date | null;
    work_minutes: number;
    late_minutes: number;
    early_exit_minutes: number;
    overtime_minutes: number;
    is_incomplete: boolean;
  }>(
    `SELECT id, attendance_date::text AS attendance_date, status,
            check_in_actual, check_out_actual,
            COALESCE(work_minutes, 0) AS work_minutes,
            COALESCE(late_minutes, 0) AS late_minutes,
            COALESCE(early_exit_minutes, 0) AS early_exit_minutes,
            COALESCE(overtime_minutes, 0) AS overtime_minutes,
            COALESCE(is_incomplete, FALSE) AS is_incomplete
       FROM hr_attendance_records
      WHERE staff_id = $1 AND to_char(attendance_date, 'YYYY-MM') = $2
      ORDER BY attendance_date DESC, id DESC`,
    [staffId, currentMonth],
  );
  const balRes = await pool.query<{
    leave_type_code: string;
    leave_type_name: string;
    year: number;
    allocated_days: string;
    carried_over_days: string;
    used_days: string;
    pending_days: string;
  }>(
    `SELECT lb.leave_type_code, lt.name_ar AS leave_type_name, lb.year,
            lb.allocated_days::text AS allocated_days,
            COALESCE(lb.carried_over_days, 0)::text AS carried_over_days,
            COALESCE(lb.used_days, 0)::text AS used_days,
            COALESCE(lb.pending_days, 0)::text AS pending_days
       FROM hr_leave_balances lb
       JOIN hr_leave_types lt ON lt.code = lb.leave_type_code
      WHERE lb.staff_id = $1 AND lb.year = $2
      ORDER BY lb.leave_type_code`,
    [staffId, currentYear],
  );
  const reqRes = await pool.query<{
    id: number;
    leave_type_name: string;
    start_date: string;
    end_date: string;
    days_count: string;
    status: string;
    reason: string;
  }>(
    `SELECT lr.id, lt.name_ar AS leave_type_name,
            lr.start_date::text AS start_date, lr.end_date::text AS end_date,
            lr.days_count::text AS days_count, lr.status, lr.reason
       FROM hr_leave_requests lr
       JOIN hr_leave_types lt ON lt.code = lr.leave_type_code
      WHERE lr.staff_id = $1
      ORDER BY lr.created_at DESC
      LIMIT 20`,
    [staffId],
  );

  const s = staffRes.rows[0];
  if (!s) {
    return {
      linked: false,
      staff: null,
      contract: null,
      schedules: [],
      attendanceMonth: currentMonth,
      attendance: [],
      leaveBalances: [],
      leaveRequests: [],
    };
  }

  const c = contractRes.rows[0] ?? null;

  return {
    linked: true,
    staff: {
      id: s.id,
      fullName: s.full_name,
      department: s.department,
      jobTitle: s.job_title,
      workStatus: s.work_status,
      contractKind: s.contract_kind,
      hireDate: s.hire_date,
    },
    contract: c
      ? {
          id: c.id,
          contractNumber: c.contract_number,
          title: c.title,
          templateKind: c.template_kind,
          status: c.status,
          startDate: c.start_date,
          endDate: c.end_date,
          compensationKind: c.compensation_kind,
          baseSalaryMinor: c.base_salary_minor !== null ? Number(c.base_salary_minor) : null,
          salaryCurrency: c.salary_currency,
          salaryPeriod: c.salary_period,
          commissionRatePercent: c.commission_rate_percent !== null ? Number(c.commission_rate_percent) : null,
        }
      : null,
    schedules: scheduleRes.rows.map((row) => ({
      id: row.id,
      name: row.name,
      scheduleType: row.schedule_type,
      workingDays: Array.isArray(row.working_days) ? row.working_days : [],
      shiftStartTime: row.shift_start_time.slice(0, 5),
      shiftEndTime: row.shift_end_time.slice(0, 5),
      gracePeriodMins: row.grace_period_mins,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    })),
    attendanceMonth: currentMonth,
    attendance: attRes.rows.map((row) => ({
      id: row.id,
      attendanceDate: row.attendance_date,
      status: row.status,
      checkInActual: row.check_in_actual ? row.check_in_actual.toISOString() : null,
      checkOutActual: row.check_out_actual ? row.check_out_actual.toISOString() : null,
      workMinutes: Number(row.work_minutes),
      lateMinutes: Number(row.late_minutes),
      earlyExitMinutes: Number(row.early_exit_minutes),
      overtimeMinutes: Number(row.overtime_minutes),
      isIncomplete: Boolean(row.is_incomplete),
    })),
    leaveBalances: balRes.rows.map((row) => {
      const alloc = Number(row.allocated_days) + Number(row.carried_over_days);
      const used = Number(row.used_days);
      const pending = Number(row.pending_days);
      return {
        leaveTypeCode: row.leave_type_code,
        leaveTypeName: row.leave_type_name,
        year: row.year,
        allocatedDays: alloc,
        usedDays: used,
        pendingDays: pending,
        availableDays: Math.max(0, Number((alloc - used - pending).toFixed(2))),
      };
    }),
    leaveRequests: reqRes.rows.map((row) => ({
      id: row.id,
      leaveTypeName: row.leave_type_name,
      startDate: row.start_date,
      endDate: row.end_date,
      daysCount: Number(row.days_count),
      status: row.status,
      reason: row.reason,
    })),
  };
}
