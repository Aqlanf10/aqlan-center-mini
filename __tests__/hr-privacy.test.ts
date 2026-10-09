import { describe, expect, it } from "vitest";
import {
  canAssignTasks, canManageStaff, canManageTask, canSeeTask, canUseTasks, canWorkOnTask,
  cleanJobTitle, staffToView, taskToView, validatePayTermsInput,
  type HrStaffRow, type HrTaskRow,
} from "../lib/hr-shared";

/**
 * (HR-1/HR-2) حراسة الخصوصية والصلاحيات — دوال خالصة بجدول: الخاصة لصاحبها
 * وحده (المدير ليس استثناءً)، ومسؤولية المكلّف عبر **الربط الحالي** بين حسابه
 * وملف الطاقم حصرًا (مراجعة دوت: فكّ الربط يسحب الوصول فورًا — لا مساءلة عبر
 * assignee_user_id المخزَّن)، وحقول الإدارة محصورة بـcanManageTask، وشروط
 * الأجر ثلاثتها معًا أو لا شيء بعملةٍ معتمدة.
 */

const adminSession = { userId: 1, role: "admin" } as const;
const receptionSession = { userId: 2, role: "reception" } as const;
const doctorSession = { userId: 3, role: "doctor" } as const;
const cashierSession = { userId: 4, role: "cashier" } as const;

const sharedRow = (overrides: Partial<HrTaskRow> = {}): HrTaskRow => ({
  id: 10, title: "مهمة", description: "", is_private: false, status: "planned", priority: "normal",
  due_at: null, planned_for: null, owner_user_id: 2, owner_display_name: "الاستقبال", assignee_staff_id: 7,
  assignee_user_id: null, assignee_label: "الحارس", completed_at: null, client_request_id: null,
  created_by: "t", created_at: new Date(), updated_at: new Date(), ...overrides,
});

const privateRow = (ownerUserId: number): HrTaskRow =>
  sharedRow({ is_private: true, owner_user_id: ownerUserId, assignee_staff_id: null, assignee_label: "" });

describe("task visibility — row-level, server-side, via the CURRENT account↔staff link", () => {
  it("a private task is visible to its owner alone — including the admin", () => {
    expect(canSeeTask(privateRow(3), doctorSession)).toBe(true);
    expect(canSeeTask(privateRow(3), adminSession)).toBe(false);
    expect(canSeeTask(privateRow(3), receptionSession)).toBe(false);
    expect(canSeeTask(privateRow(3), cashierSession)).toBe(false);
  });

  it("a shared task is visible to management and its owner — never via the stored assignee_user_id", () => {
    expect(canSeeTask(sharedRow(), adminSession)).toBe(true);
    expect(canSeeTask(sharedRow(), receptionSession)).toBe(true);
    expect(canSeeTask(sharedRow(), { userId: 2, role: "doctor" })).toBe(true); // الصاحب طبيب هنا
    // لقطة assignee_user_id القديمة لا تفتح رؤيةً ولو طابقت الجلسة —
    // مراجعة دوت: الحساب السابق يفقد الوصول فور فكّ الربط.
    expect(canSeeTask(sharedRow({ assignee_user_id: 3 }), doctorSession)).toBe(false);
  });

  it("assignment access flows only through the CURRENT staff-file link (viewerStaffId)", () => {
    // الطبيب مرتبط حاليًّا بملفه رقم 7 المسند إليه: يرى المهمة.
    expect(canSeeTask(sharedRow({ assignee_user_id: null }), doctorSession, 7)).toBe(true);
    expect(canSeeTask(sharedRow({ assignee_user_id: 3 }), doctorSession, 7)).toBe(true);
    // الربط فُكّ (viewerStaffId=null) أو تغيّر (99): الوصول سقط فورًا رغم اللقطة.
    expect(canSeeTask(sharedRow({ assignee_user_id: 3 }), doctorSession, null)).toBe(false);
    expect(canSeeTask(sharedRow({ assignee_user_id: 3 }), doctorSession, 99)).toBe(false);
  });

  it("work rights follow the same current-link rule", () => {
    expect(canWorkOnTask(sharedRow({ assignee_user_id: 3 }), doctorSession, 7)).toBe(true);
    expect(canWorkOnTask(sharedRow({ assignee_user_id: 3 }), doctorSession, null)).toBe(false);
    expect(canWorkOnTask(privateRow(3), receptionSession)).toBe(false);
  });

  it("management edits; the assignee works (status/checklist/comments) but cannot reassign or convert", () => {
    const row = sharedRow();
    expect(canManageTask(row, adminSession)).toBe(true);
    expect(canManageTask(row, receptionSession)).toBe(true);
    expect(canManageTask(row, doctorSession)).toBe(false); // مسؤولٌ فقط لا مدير
    expect(canWorkOnTask(row, doctorSession, 7)).toBe(true);

    const privateTask = privateRow(3);
    expect(canManageTask(privateTask, adminSession)).toBe(false);
    expect(canManageTask(privateTask, doctorSession)).toBe(true);
    expect(canWorkOnTask(privateTask, receptionSession)).toBe(false);
  });

  it("oversight and usage roles are fixed: staff management is admin-only, assignment is admin+reception", () => {
    expect(canManageStaff("admin")).toBe(true);
    expect(canManageStaff("reception")).toBe(false);
    expect(canAssignTasks("reception")).toBe(true);
    expect(canAssignTasks("doctor")).toBe(false);
    expect(canUseTasks("doctor")).toBe(true);
    expect(canUseTasks("cashier")).toBe(false);
    expect(canUseTasks("assistant")).toBe(false);
  });
});

describe("pay terms — currency, period and effective date travel together, currency locked to approved ones", () => {
  it("accepts a complete triple and normalizes it", () => {
    const result = validatePayTermsInput({ salaryAmountMinor: 150000, salaryCurrency: "YER", salaryPeriod: "monthly", salaryEffectiveOn: "2026-10-01" });
    expect(typeof result).toBe("object");
    expect(result).toEqual({ amountMinor: 150000, currency: "YER", period: "monthly", effectiveOn: "2026-10-01" });
    expect(validatePayTermsInput({ salaryAmountMinor: 15000000, salaryCurrency: "SAR", salaryPeriod: "monthly", salaryEffectiveOn: "2026-10-01" }))
      .toEqual({ amountMinor: 15000000, currency: "SAR", period: "monthly", effectiveOn: "2026-10-01" });
    expect(validatePayTermsInput({ salaryAmountMinor: 15000000, salaryCurrency: "USD", salaryPeriod: "monthly", salaryEffectiveOn: "2026-10-01" }))
      .toEqual({ amountMinor: 15000000, currency: "USD", period: "monthly", effectiveOn: "2026-10-01" });
  });

  it("rejects any incomplete or malformed piece", () => {
    expect(typeof validatePayTermsInput({ salaryAmountMinor: 100, salaryCurrency: "YER", salaryPeriod: "monthly" })).toBe("string");
    expect(typeof validatePayTermsInput({ salaryAmountMinor: -5, salaryCurrency: "YER", salaryPeriod: "monthly", salaryEffectiveOn: "2026-10-01" })).toBe("string");
    expect(typeof validatePayTermsInput({ salaryAmountMinor: 100, salaryCurrency: "yer", salaryPeriod: "monthly", salaryEffectiveOn: "2026-10-01" })).toBe("string");
    expect(typeof validatePayTermsInput({ salaryAmountMinor: 100, salaryCurrency: "YER", salaryPeriod: "yearly", salaryEffectiveOn: "2026-10-01" })).toBe("string");
    expect(typeof validatePayTermsInput({ salaryAmountMinor: 100, salaryCurrency: "YER", salaryPeriod: "monthly", salaryEffectiveOn: "شهر الجديد" })).toBe("string");
    expect(validatePayTermsInput({})).toBeNull();
  });

  it("rejects currencies outside the clinic's approved set (YER/SAR/USD) — no arbitrary ISO codes", () => {
    // مراجعة دوت: العملة لم تعد أي رمزٍ من ثلاثة أحرف — EUR وAED وXYZ مرفوضة.
    expect(typeof validatePayTermsInput({ salaryAmountMinor: 100, salaryCurrency: "EUR", salaryPeriod: "monthly", salaryEffectiveOn: "2026-10-01" })).toBe("string");
    expect(typeof validatePayTermsInput({ salaryAmountMinor: 100, salaryCurrency: "AED", salaryPeriod: "monthly", salaryEffectiveOn: "2026-10-01" })).toBe("string");
    expect(typeof validatePayTermsInput({ salaryAmountMinor: 100, salaryCurrency: "XYZ", salaryPeriod: "monthly", salaryEffectiveOn: "2026-10-01" })).toBe("string");
    expect(typeof validatePayTermsInput({ salaryAmountMinor: 100, salaryCurrency: "YEE", salaryPeriod: "monthly", salaryEffectiveOn: "2026-10-01" })).toBe("string");
  });
});

describe("staff view — salaries never leak through shared views", () => {
  const row: HrStaffRow = {
    id: 5, full_name: "حارس المركز", job_title: "حارس", department: "guard", work_status: "active",
    hire_date: "2026-01-01", end_date: null, contract_kind: "salary", salary_amount_minor: 1200000,
    salary_currency: "YER", salary_period: "monthly", salary_effective_on: "2026-01-01",
    user_id: null, user_linked_at: null, phone: null, note: null, created_by: "admin",
    created_at: new Date(), updated_at: new Date(),
  };

  it("includePayTerms=true shows the triple; false strips it to null", () => {
    expect(staffToView(row, true).payTerms).toEqual({ amountMinor: 1200000, currency: "YER", period: "monthly", effectiveOn: "2026-01-01" });
    const stripped = staffToView(row, false);
    expect(stripped.payTerms).toBeNull();
    expect(stripped.contractKind).toBe("salary");
    expect(JSON.stringify(stripped)).not.toContain("1200000");
  });

  it("a commission-only file carries no pay terms even when asked", () => {
    const commissionRow = { ...row, contract_kind: "commission" as const, salary_amount_minor: null, salary_currency: null, salary_period: null, salary_effective_on: null };
    expect(staffToView(commissionRow, true).payTerms).toBeNull();
  });
});

describe("task view — overdue and the planning date are derived on the server", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  it("marks past-due open tasks only", () => {
    const overdue = taskToView(sharedRow({ due_at: new Date("2026-10-01T00:00:00Z"), status: "in_progress" }), now);
    expect(overdue.overdue).toBe(true);
    const onTime = taskToView(sharedRow({ due_at: new Date("2026-10-20T00:00:00Z") }), now);
    expect(onTime.overdue).toBe(false);
    const doneLate = taskToView(sharedRow({ due_at: new Date("2026-10-01T00:00:00Z"), status: "completed" }), now);
    expect(doneLate.overdue).toBe(false);
  });

  it("carries the planning date separate from the due date", () => {
    const view = taskToView(sharedRow({ planned_for: "2026-10-12", due_at: new Date("2026-10-20T00:00:00Z") }), now);
    expect(view.plannedFor).toBe("2026-10-12");
    expect(view.dueAt).not.toBeNull();
    expect(taskToView(sharedRow(), now).plannedFor).toBeNull();
  });
});

describe("job title — free text, cleaned, unrelated to roles", () => {
  it("trims, strips control characters, caps length", () => {
    expect(cleanJobTitle(" حارس  الباب ")).toBe("حارس الباب");
    expect(cleanJobTitle("منسق\u0000مرضى")).toBe("منسقمرضى");
    expect(cleanJobTitle("x".repeat(81))).toBeNull();
    expect(cleanJobTitle(42)).toBeNull();
  });
});
