import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (HR-5 / HR-6) الدورة المالية لمسير الرواتب والمستحقات على PostgreSQL 18 الحقيقي:
 *
 *  * التحقق من عقود الطاقم (راتب ثابت، نسبة أطباء، نظام مختلط).
 *  * احتساب المسير واعتماده مع منع التعديل أو إعادة الاحتساب بعد الاعتماد.
 *  * إنشاء قيود الالتزامات (payables) بربط حقيقي بالجهات ومطابقة الأرصدة.
 *  * رفض الصرف بدون وردية صندوق مفتوحة.
 *  * صرف المستحقات داخل وردية مفتوحة وإنشاء سندات صرف (expenses) نظامية.
 *  * منع الصرف المكرر واختبار مفتاح المعاملة المالي (clientRequestId).
 *  * دورة الإجازات: رفض الموافقة الذاتية، خصم الأرصدة وتسجيل الحضور، وعكسها عند الإلغاء.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool,
  resetPoolForTesting,
  ensureSchema,
  openShift,
  closeShift,
} = await import("../../lib/db");

const {
  createStaff,
} = await import("../../lib/hr");

const {
  createContract,
  transitionContractStatus,
  adjustLeaveBalance,
  createLeaveRequest,
  decideLeaveRequest,
  listAttendanceRecords,
  listLeaveBalances,
} = await import("../../lib/hr-contracts-attendance");

const {
  getOrCreatePayrollPeriod,
  calculatePayrollRun,
  approvePayrollRun,
  disbursePayrollItem,
  listPayrollItems,
} = await import("../../lib/hr-payroll");

import type { SessionPayload } from "../../lib/auth";

const adminSession: SessionPayload = {
  userId: 1,
  username: "hr-admin-finance",
  role: "admin",
  expiresAt: Date.now() + 3600000,
};

const managerSession: SessionPayload = {
  userId: 2,
  username: "hr-manager-finance",
  role: "admin",
  expiresAt: Date.now() + 3600000,
};

const staffUserSession: SessionPayload = {
  userId: 3,
  username: "hr-staff-finance",
  role: "reception",
  expiresAt: Date.now() + 3600000,
};

let supportStaffId: number;
let doctorStaffId: number;
let doctorPartyId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();

  // Create users for sessions
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, role)
     VALUES (1, 'hr-admin-finance', 'المدير العام', 'x', 'admin'),
            (2, 'hr-manager-finance', 'مدير الموارد', 'x', 'admin'),
            (3, 'hr-staff-finance', 'الموظف المشبوك', 'x', 'reception')
     ON CONFLICT (id) DO NOTHING`,
  );

  // 1. Create support staff
  const staffRes = await createStaff(
    {
      fullName: "أحمد الاستقبال",
      phone: "770000001",
      department: "secretariat",
      jobTitle: "موظف استقبال",
      hireDate: "2026-01-01",
      workStatus: "active",
      endDate: null,
      contractKind: "salary",
      payTerms: {
        amountMinor: 10000000,
        currency: "YER",
        period: "monthly",
        effectiveOn: "2026-01-01",
      },
      note: null,
    },
    adminSession,
  );
  supportStaffId = staffRes.id;

  // Link staff user id to support staff
  await pool.query(`UPDATE hr_staff SET user_id = 3 WHERE id = $1`, [supportStaffId]);

  // 2. Create doctor staff
  const doctorRes = await createStaff(
    {
      fullName: "د. سامي الجراح",
      phone: "770000002",
      department: "doctors",
      jobTitle: "طبيب أسنان عام",
      hireDate: "2026-01-01",
      workStatus: "active",
      endDate: null,
      contractKind: "salary_commission",
      payTerms: {
        amountMinor: 15000000,
        currency: "YER",
        period: "monthly",
        effectiveOn: "2026-01-01",
      },
      note: null,
    },
    adminSession,
  );
  doctorStaffId = doctorRes.id;

  // Create doctor in parties table
  const partyRes = await pool.query(
    `INSERT INTO parties (name, kind, phone) VALUES ('د. سامي الجراح', 'doctor', '770000002') RETURNING id`,
  );
  doctorPartyId = partyRes.rows[0].id;
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("HR Financial Lifecycle and Payroll on PostgreSQL 18", () => {
  it("creates valid employment contracts for support staff and doctor", async () => {
    // Contract 1: Support staff fixed salary
    const c1 = await createContract(
      {
        staffId: supportStaffId,
        templateKind: "support_staff",
        title: "عقد موظف استقبال",
        startDate: "2026-01-01",
        compensationKind: "salary",
        baseSalaryMinor: 15000000, // 150,000 YER
        salaryCurrency: "YER",
        salaryPeriod: "monthly",
      },
      adminSession,
    );
    expect(c1.id).toBeDefined();
    await transitionContractStatus(c1.id, "active", "اعتماد العقد للتشغيل", adminSession);

    // Contract 2: Doctor hybrid (Salary + Commission)
    const c2 = await createContract(
      {
        staffId: doctorStaffId,
        templateKind: "doctor_hybrid",
        title: "عقد طبيب مختلط",
        startDate: "2026-01-01",
        compensationKind: "salary_commission",
        baseSalaryMinor: 10000000, // 100,000 YER
        commissionRatePercent: 30, // 30%
        doctorPartyId,
        salaryCurrency: "YER",
        salaryPeriod: "monthly",
      },
      adminSession,
    );
    expect(c2.id).toBeDefined();
    await transitionContractStatus(c2.id, "active", "اعتماد عقد الطبيب", adminSession);
  });

  it("calculates payroll run and enforces approval immutability", async () => {
    const period = await getOrCreatePayrollPeriod("2026-10", adminSession);
    expect(period.periodKey).toBe("2026-10");

    // Calculate payroll for period in YER
    const run = await calculatePayrollRun(period.id, "YER", adminSession);
    expect(run.status).toBe("draft");
    expect(run.totalBaseSalaryMinor).toBe(25000000); // 150,000 + 100,000 = 250,000 YER in minor

    const items = await listPayrollItems(run.id);
    expect(items.length).toBe(2);

    const supportItem = items.find((i) => i.staffId === supportStaffId);
    expect(supportItem?.baseSalaryMinor).toBe(15000000);
    expect(supportItem?.netDueMinor).toBe(15000000);

    const doctorItem = items.find((i) => i.staffId === doctorStaffId);
    expect(doctorItem?.baseSalaryMinor).toBe(10000000);

    // Approve the payroll run
    const approvedRun = await approvePayrollRun(run.id, adminSession);
    expect(approvedRun.status).toBe("approved");

    // Re-calculating an approved run MUST fail to prevent duplicate payables
    await expect(
      calculatePayrollRun(period.id, "YER", adminSession),
    ).rejects.toThrow("معتمد");

    // Verify payables were inserted
    const approvedItems = await listPayrollItems(run.id);
    for (const item of approvedItems) {
      expect(item.payableId).toBeDefined();
      expect(item.payableId).not.toBeNull();
    }
  });

  it("refuses disbursement without an open cashier shift", async () => {
    const period = await getOrCreatePayrollPeriod("2026-10", adminSession);
    const pool = getPool();
    const { rows: [run] } = await pool.query(
      `SELECT * FROM hr_payroll_runs WHERE period_id = $1 AND status = 'approved'`,
      [period.id],
    );
    const items = await listPayrollItems(run.id);
    const item = items[0];

    // Attempting disburse without open shift must throw
    await expect(
      disbursePayrollItem(item.id, { amountMinor: 5000000 }, adminSession),
    ).rejects.toThrow("لا توجد وردية صندوق مفتوحة");
  });

  it("disburses payroll item under open shift, creates compliant expense, and verifies idempotency", async () => {
    const pool = getPool();

    // 1. Open cashier shift
    const shift = await openShift({
      openedBy: "hr-admin-finance",
      opening: { YER: 500000, SAR: 0, USD: 0 },
    });
    expect(shift).not.toBeNull();
    if (!shift) throw new Error("Could not open cashier shift");

    const { rows: [item] } = await pool.query(
      `SELECT * FROM hr_payroll_items WHERE staff_id = $1 ORDER BY id DESC LIMIT 1`,
      [supportStaffId],
    );

    // 2. Disburse full net salary with clientRequestId
    const clientRequestId = "disburse-support-staff-req-001";
    const disbursement = await disbursePayrollItem(
      item.id,
      {
        amountMinor: 15000000,
        paymentMethod: "cash",
        notes: "صرف راتب شهر أكتوبر",
        clientRequestId,
      },
      adminSession,
    );

    expect(disbursement.amountMinor).toBe(15000000);
    expect(disbursement.expenseId).toBeDefined();

    // Verify expense created in database
    const { rows: expRows } = await pool.query(
      `SELECT * FROM expenses WHERE id = $1`,
      [disbursement.expenseId],
    );
    expect(expRows.length).toBe(1);
    expect(expRows[0].shift_id).toBe(shift.id);
    expect(expRows[0].category).toBe("salary");
    expect(expRows[0].base_amount_minor).toBe("15000000");

    // Verify payable balance reduced to 0
    const { rows: payRows } = await pool.query(
      `SELECT * FROM payables WHERE id = $1`,
      [item.payable_id],
    );
    expect(Number(payRows[0].balance_minor)).toBe(0);

    // 3. Idempotent replay: calling disburse again with same clientRequestId returns existing record
    const replay = await disbursePayrollItem(
      item.id,
      {
        amountMinor: 15000000,
        paymentMethod: "cash",
        clientRequestId,
      },
      adminSession,
    );
    expect(replay.id).toBe(disbursement.id);
    expect(replay.expenseId).toBe(disbursement.expenseId);

    // Close shift
    await closeShift({
      id: shift.id,
      closedBy: "hr-admin-finance",
      counted: { YER: 350000, SAR: 0, USD: 0 },
      note: "إغلاق وردية الاختبار",
    });
  });

  it("handles leave balance lifecycle, self-approval refusal, and cancellation rollback", async () => {
    // 1. Allocate 30 annual leave days
    await adjustLeaveBalance(
      supportStaffId,
      "annual",
      2026,
      30,
      "الرصيد السنوي لعام 2026",
      adminSession,
    );

    const initialBalances = await listLeaveBalances({ staffId: supportStaffId, year: 2026 });
    expect(initialBalances[0].allocatedDays).toBe(30);
    expect(initialBalances[0].usedDays).toBe(0);

    // 2. Staff user requests 5 days leave
    const leaveReq = await createLeaveRequest(
      {
        staffId: supportStaffId,
        leaveTypeCode: "annual",
        startDate: "2026-11-01",
        endDate: "2026-11-05",
        daysCount: 5,
        reason: "إجازة اعتيادية",
      },
      staffUserSession,
    );
    expect(leaveReq.daysCount).toBe(5);
    expect(leaveReq.status).toBe("pending");

    // 3. Self-approval refusal: the staff user cannot approve their own leave request
    await expect(
      decideLeaveRequest(leaveReq.id, "approved", "موافقة ذاتية", staffUserSession),
    ).rejects.toThrow("لا يحق للموظف اعتماد أو رفض طلب إجازته بنفسه");

    // 4. Manager approves leave
    const approvedLeave = await decideLeaveRequest(
      leaveReq.id,
      "approved",
      "معتمد من الإدارة",
      managerSession,
    );
    expect(approvedLeave.status).toBe("approved");

    // Verify leave balance deducted
    const afterApprovalBalances = await listLeaveBalances({ staffId: supportStaffId, year: 2026 });
    expect(afterApprovalBalances[0].usedDays).toBe(5);
    expect(afterApprovalBalances[0].availableDays).toBe(25);

    // Verify auto-recorded on_leave attendance records
    const attendanceRecords = await listAttendanceRecords({
      staffId: supportStaffId,
      startDate: "2026-11-01",
      endDate: "2026-11-05",
    });
    expect(attendanceRecords.length).toBe(5);
    for (const rec of attendanceRecords) {
      expect(rec.status).toBe("on_leave");
    }

    // 5. Manager cancels the leave request
    const cancelledLeave = await decideLeaveRequest(
      leaveReq.id,
      "cancelled",
      "إلغاء بناء على رغبة الموظف",
      managerSession,
    );
    expect(cancelledLeave.status).toBe("cancelled");

    // Verify leave balance restored
    const afterCancelBalances = await listLeaveBalances({ staffId: supportStaffId, year: 2026 });
    expect(afterCancelBalances[0].usedDays).toBe(0);
    expect(afterCancelBalances[0].availableDays).toBe(30);

    // Verify on_leave attendance records were reverted / cleaned up
    const cleanedAttendance = await listAttendanceRecords({
      staffId: supportStaffId,
      startDate: "2026-11-01",
      endDate: "2026-11-05",
    });
    expect(cleanedAttendance.length).toBe(0);
  });
});
