import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (HR-INT) سلامة مسير الرواتب والصرف على PostgreSQL 18 الحقيقي — كل اختبارٍ يجهّز حالته بنفسه (TRUNCATE ثم بناء) فلا يتوقف
 * على نجاح سابقه. الأرقام تُثبَت من مصادرها المالية القانونية لا من صفوف الموارد البشرية وحدها:
 *
 *   كشف الطبيب  = `commissionReport` (المدفوع = سندات category='commission' للجهة)
 *   الالتزام     = `partyStatement(...).payables[].remainingMinor` (مشتق من السندات، لا عمود رصيد)
 *   سند الصرف    = صف `expenses` (التصنيف، الجهة، الالتزام، الوردية)
 *   الصندوق      = مجموع سندات الوردية المفتوحة
 *
 * عيوب مثبتة بهذا الملف على الرأس 895500c9 (تفشل قبل الإصلاح):
 *   ١ مصدر الأجر: المسير يقرأ ملف الموظف ويتجاهل العقد المعتمد فيصرف بقيمةٍ تخالف الاتفاق.
 *   ٢ صرف المختلط كله category=salary فيبقى كشف الطبيب يرى عمولته مستحقة ويُصرف ثانيةً.
 *   ٣ مفتاح الطلب: نفس المفتاح بمحتوًى مختلف يعيد النتيجة القديمة بصمت؛ والسباق ينفجر بقيد فريد.
 *   ٤ لا عكس لسند صرف مسير.
 */

assertRealPostgresUrl();
stubPostgresEnv();
// عدة اتصالات تُحجز معًا (حواجز + كتّاب متزامنون).
process.env.DB_POOL_MAX = "10";

const db = await import("../../lib/db");
const hr = await import("../../lib/hr");
const contracts = await import("../../lib/hr-contracts-attendance");
const payroll = await import("../../lib/hr-payroll");
const {
  commissionReport, createParty, ensureSchema, getPool, partyStatement, recordExpense, resetPoolForTesting,
} = db;

import type { SessionPayload } from "../../lib/auth";

const admin: SessionPayload = { userId: 1, username: "hr-int-admin", role: "admin", expiresAt: Date.now() + 3_600_000 };
const PERIOD = "2026-10";
const IN_PERIOD = "2026-10-02 10:00+03";
let seq = 0;
let shiftId = 0;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function openShiftNow(): Promise<number> {
  const [row] = await q<{ id: number }>(`INSERT INTO cashier_shifts (opened_by) VALUES ('hr-int') RETURNING id`);
  shiftId = row.id;
  return row.id;
}

type Kind = "commission" | "salary" | "salary_commission";
interface Setup {
  staffId: number;
  partyId: number | null;
}

/** موظفٌ بملفٍ (ومعه طرف طبيب إن كان بنسبة)، بلا عقد. */
async function staffWith(input: {
  name?: string; kind: Kind; salary?: number; currency?: "YER" | "SAR" | "USD"; period?: "monthly" | "weekly" | "daily" | "per_shift";
  percent?: number; effectiveOn?: string; hireDate?: string | null; endDate?: string | null;
}): Promise<Setup> {
  seq += 1;
  const salaried = input.kind !== "commission";
  const created = await hr.createStaff({
    fullName: input.name ?? `موظف اختبار ${seq}`, jobTitle: "اختبار", department: input.kind === "salary" ? "secretariat" : "doctors",
    hireDate: input.hireDate === undefined ? "2025-01-01" : input.hireDate, workStatus: "active", endDate: input.endDate ?? null,
    contractKind: input.kind,
    payTerms: salaried ? {
      amountMinor: input.salary ?? 100_000, currency: input.currency ?? "YER", period: input.period ?? "monthly",
      effectiveOn: input.effectiveOn ?? "2025-01-01",
    } : null,
    phone: null, note: null,
  }, admin);
  let partyId: number | null = null;
  if (input.kind !== "salary") {
    const party = await createParty({ name: `طبيب ${seq}`, kind: "doctor", phone: null, commissionPercent: input.percent ?? 30, note: null });
    partyId = party.id;
    const [user] = await q<{ id: number }>(
      `INSERT INTO users (username, display_name, password_hash, role, party_id) VALUES ($1, $1, 'x', 'doctor', $2) RETURNING id`,
      [`hr-int-doc-${seq}`, partyId],
    );
    await q(`UPDATE hr_staff SET user_id = $1 WHERE id = $2`, [user.id, created.id]);
  }
  return { staffId: created.id, partyId };
}

/** عقدٌ فعّال بالأجر المذكور (يمرّ بالمسار الحقيقي للعقود). */
async function activeContract(input: {
  staffId: number; kind: Kind; salary?: number; currency?: "YER" | "SAR" | "USD"; start?: string; end?: string | null;
  percent?: number; partyId?: number | null; period?: "monthly" | "weekly" | "daily" | "per_shift";
}) {
  const c = await contracts.createContract({
    staffId: input.staffId, templateKind: input.kind === "salary" ? "support_staff" : input.kind === "commission" ? "doctor_percentage" : "doctor_hybrid",
    title: `عقد ${seq}`, startDate: input.start ?? "2025-01-01", endDate: input.end ?? null,
    compensationKind: input.kind,
    baseSalaryMinor: input.kind === "commission" ? undefined : (input.salary ?? 100_000),
    salaryCurrency: input.kind === "commission" ? undefined : (input.currency ?? "YER"),
    salaryPeriod: input.kind === "commission" ? undefined : (input.period ?? "monthly"),
    commissionRatePercent: input.kind === "salary" ? undefined : (input.percent ?? 30),
    doctorPartyId: input.partyId ?? undefined,
  } as never, admin);
  await contracts.transitionContractStatus(c.id, "active", "اعتماد للاختبار", admin);
  return c;
}

/** يولّد عمولةً حقيقية للطبيب عبر فاتورة ودفعة داخل الفترة. */
async function earnCommission(partyId: number, amount: number, at = IN_PERIOD): Promise<void> {
  seq += 1;
  const [patient] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`HR-P-${seq}`, `مريض ${seq}`]);
  const [invoice] = await q<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, $3, 0, 'YER', 'test', $4::timestamptz) RETURNING id`, [`HR-I-${seq}`, patient.id, amount, at]);
  await q(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor, doctor_id) VALUES ($1, 'بند', 1, $2, $2, $3)`,
    [invoice.id, amount, partyId]);
  await q(`INSERT INTO visits (patient_name, patient_id, doctor_id, status, invoice_id, arrived_at, signed_at, signed_by)
           VALUES ('مريض', $1, $2, 'done', $3, $4::timestamptz, $4::timestamptz, 'test')`, [patient.id, partyId, invoice.id, at]);
  await q(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
           VALUES ($1, $2, $3, $4, 'payment', $5, 'YER', 1, $5, 'YER', 'cash', 'test', $6::timestamptz)`, [`HR-R-${seq}`, patient.id, invoice.id, shiftId, amount, at]);
}

const doctorRow = async (partyId: number) =>
  (await commissionReport("2026-10-01", "2026-10-31")).find((r) => r.doctorId === partyId && r.currency === "YER");

async function approvedRun(currency: "YER" | "SAR" | "USD" = "YER") {
  const period = await payroll.getOrCreatePayrollPeriod(PERIOD, admin);
  const run = await payroll.calculatePayrollRun(period.id, currency, admin);
  const items = await payroll.listPayrollItems(run.id);
  return { period, run, items };
}
const approve = (runId: number) => payroll.approvePayrollRun(runId, admin);

const cashOut = async () => Number((await q<{ s: string }>(
  `SELECT COALESCE(SUM(amount_minor), 0)::text AS s FROM expenses WHERE shift_id = $1`, [shiftId]))[0].s);
const remainingOf = async (partyId: number, category: string) => {
  const statement = await partyStatement(partyId);
  return statement.payables.filter((p) => p.category === category).reduce((s, p) => s + p.remainingMinor, 0);
};

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await q(`INSERT INTO users (id, username, display_name, password_hash, role) VALUES (1, 'hr-int-admin', 'مدير', 'x', 'admin') ON CONFLICT DO NOTHING`);
}, 120_000);

beforeEach(async () => {
  await q(`TRUNCATE hr_staff, hr_payroll_periods, payments, expenses, payables, invoice_items, lab_orders, visits, invoices, patients,
                    cashier_shifts, parties, doctor_commission_history RESTART IDENTITY CASCADE`);
  await q(`DELETE FROM users WHERE id <> 1`);
  await openShiftNow();
});

afterAll(async () => { await resetPoolForTesting(); });

describe("١ — مصدر الأجر: العقد المعتمد والملف لا يتناقضان صامتين", () => {
  it("ملف براتب ١٠٠٬٠٠٠ وعقدٌ فعّال ١٢٠٬٠٠٠ ⇒ تعارض معلن يمنع الاعتماد (لا يُصرف أيٌّ من الرقمين تخمينًا)", async () => {
    const s = await staffWith({ kind: "salary", salary: 100_000 });
    await activeContract({ staffId: s.staffId, kind: "salary", salary: 120_000 });
    // Simulate an existing inconsistent record, bypassing the new application guard deliberately.
    // Normal contract activation must synchronize the profile (covered separately below).
    await q(`UPDATE hr_staff SET salary_amount_minor = 100000 WHERE id = $1`, [s.staffId]);
    const { run, items } = await approvedRun();
    const item = items.find((i) => i.staffId === s.staffId)!;
    expect(item.blockerCodes).toContain("terms_conflict");
    expect(item.baseSalaryMinor).toBe(0);
    await expect(approve(run.id)).rejects.toThrow("تعارض");
    // ولم يُنشأ أي التزام مالي
    expect((await q(`SELECT 1 FROM payables`)).length).toBe(0);
  });

  it("الاعتماد يستعمل العقد حين يتطابق الملف معه، ويحفظ لقطة الشروط (المصدر، رقم العقد، المبلغ)", async () => {
    const s = await staffWith({ kind: "salary", salary: 120_000 });
    const c = await activeContract({ staffId: s.staffId, kind: "salary", salary: 120_000 });
    const { items } = await approvedRun();
    const item = items[0];
    expect(item.blockerCodes).toEqual([]);
    expect(item.baseSalaryMinor).toBe(120_000);
    expect(item.payTermsSnapshot).toMatchObject({ source: "contract", contractId: c.id, baseSalaryMinor: 120_000, currency: "YER", salaryPeriod: "monthly" });
  });

  it("بلا عقد: يُستعمل الملف مصدرًا ويُسجَّل ذلك في اللقطة", async () => {
    const s = await staffWith({ kind: "salary", salary: 90_000 });
    const { items } = await approvedRun();
    const item = items.find((i) => i.staffId === s.staffId)!;
    expect(item.baseSalaryMinor).toBe(90_000);
    expect(item.payTermsSnapshot).toMatchObject({ source: "staff_profile" });
  });

  it("تعديل العقد (ملحق بأجر جديد) بعد اعتماد المسير لا يعيد كتابة استحقاقٍ سابق ولا لقطته", async () => {
    const s = await staffWith({ kind: "salary", salary: 100_000 });
    const c = await activeContract({ staffId: s.staffId, kind: "salary", salary: 100_000 });
    const { run, items } = await approvedRun();
    await approve(run.id);
    const addendum = await contracts.createContractAddendum(c.id, {
      title: "ملحق زيادة", startDate: "2026-11-01", addendumReason: "زيادة", baseSalaryMinor: 150_000,
    } as never, admin);
    await contracts.transitionContractStatus(addendum.id, "active", "اعتماد الملحق", admin);
    const after = await payroll.listPayrollItems(run.id);
    expect(after[0].baseSalaryMinor).toBe(100_000);
    expect(after[0].netDueMinor).toBe(items[0].netDueMinor);
    expect(after[0].payTermsSnapshot).toMatchObject({ contractId: c.id, baseSalaryMinor: 100_000 });
    await expect(payroll.calculatePayrollRun(run.periodId, "YER", admin)).rejects.toThrow("معتمد");
  });

  it("أجرٌ يتغير أثناء الفترة (ملحق من ١٥ أكتوبر) ⇒ بند محجوب لا يُقسَّم تخمينًا", async () => {
    const s = await staffWith({ kind: "salary", salary: 100_000 });
    const c = await activeContract({ staffId: s.staffId, kind: "salary", salary: 100_000 });
    const addendum = await contracts.createContractAddendum(c.id, {
      title: "ملحق", startDate: "2026-10-15", addendumReason: "زيادة", baseSalaryMinor: 160_000,
    } as never, admin);
    await contracts.transitionContractStatus(addendum.id, "active", "اعتماد", admin);
    const { run, items } = await approvedRun();
    expect(items[0].blockerCodes).toContain("terms_changed_in_period");
    expect(items[0].baseSalaryMinor).toBe(0);
    await expect(approve(run.id)).rejects.toThrow("قرار");
  });

  it("دورية غير شهرية (أسبوعية) لا تُحتسب كراتب شهري", async () => {
    await staffWith({ kind: "salary", salary: 30_000, period: "weekly" });
    const { items } = await approvedRun();
    expect(items[0].blockerCodes).toContain("unsupported_salary_period");
    expect(items[0].baseSalaryMinor).toBe(0);
  });

  it("التحاقٌ منتصف الفترة ⇒ لا تقسيم تخمينًا (محجوب)، وموظفٌ التحق بعد الفترة لا يظهر أصلًا", async () => {
    await staffWith({ kind: "salary", salary: 100_000, hireDate: "2026-10-12", effectiveOn: "2026-10-12" });
    const later = await staffWith({ kind: "salary", salary: 100_000, hireDate: "2026-12-01", effectiveOn: "2026-12-01" });
    const { items } = await approvedRun();
    expect(items.find((i) => i.staffId === later.staffId)).toBeUndefined();
    expect(items.length).toBe(1);
    expect(items[0].blockerCodes).toContain("partial_period_employment");
  });

  it("ملفٌ بأجرٍ سارٍ بعد بداية الفترة وبلا عقد ⇒ لا يُعرف الأجر السابق، محجوب", async () => {
    await staffWith({ kind: "salary", salary: 100_000, effectiveOn: "2026-10-20" });
    const { items } = await approvedRun();
    expect(items[0].blockerCodes).toContain("profile_terms_effective_after_period_start");
  });

  it("تعديل أجر الملف بما يخالف عقدًا فعّالًا مرفوض؛ وبما يطابقه مسموح", async () => {
    const s = await staffWith({ kind: "salary", salary: 100_000 });
    await activeContract({ staffId: s.staffId, kind: "salary", salary: 100_000 });
    const refused = await hr.updateStaff(s.staffId, {
      payTerms: { amountMinor: 130_000, currency: "YER", period: "monthly", effectiveOn: "2026-10-01" }, reason: "تجربة",
    }, admin);
    expect(refused.ok).toBe(false);
    if (!refused.ok) { expect(refused.status).toBe(409); expect(refused.error).toMatch(/عقد/); }
    const allowed = await hr.updateStaff(s.staffId, { note: "ملاحظة" }, admin);
    expect(allowed.ok).toBe(true);
  });

  it("تفعيل عقدٍ ساريّ الآن يزامن ملف الموظف إليه (سجل تغيير موثّق) فلا يبقى مصدران", async () => {
    const s = await staffWith({ kind: "salary", salary: 100_000 });
    await activeContract({ staffId: s.staffId, kind: "salary", salary: 125_000 });
    const [row] = await q<{ salary_amount_minor: string }>(`SELECT salary_amount_minor FROM hr_staff WHERE id = $1`, [s.staffId]);
    expect(Number(row.salary_amount_minor)).toBe(125_000);
    const changes = await q(`SELECT 1 FROM hr_staff_changes WHERE staff_id = $1 AND action = 'pay_terms'`, [s.staffId]);
    expect(changes.length).toBe(1);
  });

  it("راتب وعملتان: YER وSAR منفصلان بلا جمع", async () => {
    await staffWith({ kind: "salary", salary: 100_000, currency: "YER" });
    await staffWith({ kind: "salary", salary: 2_500_00, currency: "SAR" });
    const yer = await approvedRun("YER");
    const sar = await payroll.calculatePayrollRun(yer.period.id, "SAR", admin);
    expect(yer.run.totalNetDueMinor).toBe(100_000);
    expect(sar.totalNetDueMinor).toBe(250_000);
    expect(sar.currency).toBe("SAR");
  });
});

describe("نسبة العقد المرجعية وسياسة العمولات القائمة",()=>{
  it("لا يعتمد مسيرًا عندما تختلف نسبة العقد عن سياسة المحرك السارية",async()=>{
    const s=await staffWith({kind:"commission",percent:30});
    await activeContract({staffId:s.staffId,kind:"commission",percent:40,partyId:s.partyId!});
    await earnCommission(s.partyId!,40_000);
    const {run,items}=await approvedRun();
    expect(items[0].blockerCodes).toContain("commission_policy_conflict");
    await expect(approve(run.id)).rejects.toThrow("العمولات");
  });
});

describe("٢ — صرف النظام المختلط عبر محرك العمولات والالتزامات", () => {
  async function hybrid(salary = 100_000, collected = 40_000, percent = 30, approveNow = true) {
    const s = await staffWith({ kind: "salary_commission", salary, percent });
    await earnCommission(s.partyId!, collected);
    const { run, items } = await approvedRun();
    if (approveNow) await approve(run.id);
    const item = (await payroll.listPayrollItems(run.id)).find((i) => i.staffId === s.staffId)!;
    return { ...s, run, item, items };
  }

  it("الصرف من HR يمنع صرف العمولة نفسها ثانية من كشف الطبيب", async () => {
    const h = await hybrid();
    await payroll.disbursePayrollItem(h.item.id,{amountMinor:112_000,clientRequestId:"hr-first-direct-0001"},admin);
    const direct = await recordExpense({category:"commission",partyId:h.partyId,payeeText:null,amountMinor:12_000,currency:"YER",baseCurrency:"YER",exchangeRate:1,payableId:null,note:"محاولة مكررة",createdBy:admin.username});
    expect(direct.expense).toBeNull();expect(direct.reason).toBe("exceeds_party_balance");
    expect(await cashOut()).toBe(112_000);expect((await doctorRow(h.partyId!))?.dueMinor).toBe(0);
  });
  it("صرف عمولة أكتوبر في نوفمبر وعكسها يبقيان مرتبطين بفترة الاستحقاق الأصلية", async () => {
    const h = await hybrid();
    const d = await payroll.disbursePayrollItem(h.item.id,{amountMinor:112_000,clientRequestId:"later-month-0001"},admin);
    for (const part of d.parts) await q("UPDATE expenses SET created_at='2026-11-02 10:00+03' WHERE id=$1",[part.expenseId]);
    expect((await doctorRow(h.partyId!))?.paidMinor).toBe(12_000);
    expect((await doctorRow(h.partyId!))?.dueMinor).toBe(0);
    await payroll.reversePayrollDisbursement(d.id,{reason:"تصحيح الصرف المؤجل"},admin);
    expect((await doctorRow(h.partyId!))?.dueMinor).toBe(12_000);expect(await cashOut()).toBe(0);
  });
  it("رفض التدقيق يتراجع عن السندين وأجزاء الصرف والذمم بالكامل", async () => {
    const h = await hybrid();
    await q(`CREATE FUNCTION hr_int_audit_fail() RETURNS trigger AS $$ BEGIN IF NEW.action='hr.payroll.disburse' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await q("CREATE TRIGGER hr_int_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION hr_int_audit_fail()");
    try { await expect(payroll.disbursePayrollItem(h.item.id,{amountMinor:112_000,clientRequestId:"audit-rollback-001"},admin)).rejects.toThrow("synthetic audit failure"); }
    finally { await q("DROP TRIGGER hr_int_audit_fail ON audit_log");await q("DROP FUNCTION hr_int_audit_fail()"); }
    expect(await cashOut()).toBe(0);expect(await remainingOf(h.partyId!,"salary")).toBe(100_000);expect(await remainingOf(h.partyId!,"commission")).toBe(12_000);
    expect(await payroll.findDisbursementByRequestId("audit-rollback-001")).toBeNull();
    expect(await q("SELECT 1 FROM hr_payroll_disbursement_parts")).toHaveLength(0);
  });

  it("الاستحقاق: التزامان — راتب (category=salary) وعمولة (category=commission) — لجهة الطبيب نفسها", async () => {
    const h = await hybrid();
    expect(h.item.baseSalaryMinor).toBe(100_000);
    expect(h.item.commissionsMinor).toBe(12_000);
    const statement = await partyStatement(h.partyId!);
    const byCat = Object.fromEntries(statement.payables.map((p) => [p.category, p.amountMinor]));
    expect(byCat).toEqual({ salary: 100_000, commission: 12_000 });
    expect(h.item.commissionPayableId).not.toBeNull();
  });

  it("صرفٌ كامل: سندان (راتب + عمولة) بمجموع نقدٍ واحد، وكشف الطبيب يرى العمولة مدفوعة والالتزامان يتصفّران", async () => {
    const h = await hybrid();
    const before = await doctorRow(h.partyId!);
    expect(before?.dueMinor).toBe(12_000);

    const d = await payroll.disbursePayrollItem(h.item.id, { amountMinor: 112_000, clientRequestId: "full-hybrid-0001" }, admin);
    expect(d.amountMinor).toBe(112_000);
    expect(d.parts.map((p) => [p.component, p.amountMinor]).sort()).toEqual([["commission", 12_000], ["salary", 100_000]]);

    const expenses = await q<{ category: string; amount_minor: string; party_id: number; payable_id: number }>(
      `SELECT category, amount_minor, party_id, payable_id FROM expenses WHERE reversal_of_id IS NULL ORDER BY category`);
    expect(expenses.map((e) => [e.category, Number(e.amount_minor), e.party_id])).toEqual([
      ["commission", 12_000, h.partyId], ["salary", 100_000, h.partyId],
    ]);
    expect(await cashOut()).toBe(112_000); // النقد الخارج = المصروف فعليًا مرة واحدة

    const after = await doctorRow(h.partyId!);
    expect(after?.paidMinor).toBe(12_000);
    expect(after?.dueMinor).toBe(0);
    expect(await remainingOf(h.partyId!, "salary")).toBe(0);
    expect(await remainingOf(h.partyId!, "commission")).toBe(0);
  });

  it("دفعة جزئية بلا توزيعٍ صريح بين الراتب والعمولة ⇒ مرفوضة (السياسة غير محددة فلا تُخمَّن)", async () => {
    const h = await hybrid();
    await expect(payroll.disbursePayrollItem(h.item.id, { amountMinor: 50_000, clientRequestId: "partial-nopolicy-1" }, admin))
      .rejects.toThrow("توزيع");
    expect((await q(`SELECT 1 FROM expenses`)).length).toBe(0);
  });

  it("دفعة جزئية بتوزيعٍ صريح: عمولة ٥٬٠٠٠ ثم ٧٬٠٠٠، والزيادة بعد الاكتمال مرفوضة، وكشف الطبيب يتبع", async () => {
    const h = await hybrid();
    await payroll.disbursePayrollItem(h.item.id, { components: { commissionMinor: 5_000 }, clientRequestId: "part-comm-0001" }, admin);
    expect((await doctorRow(h.partyId!))?.paidMinor).toBe(5_000);
    expect((await doctorRow(h.partyId!))?.dueMinor).toBe(7_000);
    await payroll.disbursePayrollItem(h.item.id, { components: { commissionMinor: 7_000 }, clientRequestId: "part-comm-0002" }, admin);
    expect((await doctorRow(h.partyId!))?.dueMinor).toBe(0);
    await expect(payroll.disbursePayrollItem(h.item.id, { components: { commissionMinor: 1 }, clientRequestId: "part-comm-0003" }, admin))
      .rejects.toThrow("يتجاوز");
    expect(await cashOut()).toBe(12_000);
  });

  it("عمولة مسير معتمد لا تُسدّد بسند منفصل غير مرتبط يترك الالتزام معلقًا",async()=>{
    const h=await hybrid();
    const result=await recordExpense({category:"commission",partyId:h.partyId,payeeText:null,amountMinor:5000,currency:"YER",baseCurrency:"YER",exchangeRate:1,payableId:null,note:"Unlinked settlement",createdBy:admin.username});
    expect(result.expense).toBeNull();expect(result.reason).toBe("hr_payroll_settlement_required");
    expect(await cashOut()).toBe(0);expect(await remainingOf(h.partyId!,"commission")).toBe(12000);
  });

  it("صرفٌ سابق من كشف الطبيب (سند عمولة مباشر) يمنع صرف الجزء نفسه من المسير — لا ازدواج", async () => {
    const h = await hybrid(100_000,40_000,30,false);
    const direct = await recordExpense({
      category: "commission", partyId: h.partyId, payeeText: null, amountMinor: 12_000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, payableId: null, note: "من كشف الطبيب", createdBy: "hr-int-admin",
    });
    expect(direct.expense).not.toBeNull();
    await q("UPDATE expenses SET created_at='2026-10-12 10:00+03' WHERE id=$1",[direct.expense!.id]);
    // A direct payment before approval changes the engine balance; the draft must be recalculated.
    await expect(approve(h.run.id)).rejects.toThrow("تغيّر مستحق كشف الطبيب");
    await payroll.calculatePayrollRun(h.run.periodId,"YER",admin);
    await approve(h.run.id);
    const recalculated=(await payroll.listPayrollItems(h.run.id)).find(i=>i.staffId===h.staffId)!;
    expect(recalculated.commissionsMinor).toBe(0);
    expect(recalculated.netDueMinor).toBe(100_000);
    expect(await cashOut()).toBe(12_000); // السند المباشر وحده
  });

  it("فشل أحد جزأي الصرف يُرجع الآخر كاملًا (لا صرف جزئي صامت)", async () => {
    const h = await hybrid();
    // يمنع سند العمولة وحده: الجزء الثاني يفشل بعد نجاح الأول.
    await q(`CREATE OR REPLACE FUNCTION hr_int_block_commission() RETURNS trigger AS $$
             BEGIN IF NEW.category = 'commission' THEN RAISE EXCEPTION 'synthetic commission failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER hr_int_block BEFORE INSERT ON expenses FOR EACH ROW EXECUTE FUNCTION hr_int_block_commission()`);
    try {
      await expect(payroll.disbursePayrollItem(h.item.id, { amountMinor: 112_000, clientRequestId: "atomic-0001" }, admin)).rejects.toThrow();
    } finally {
      await q(`DROP TRIGGER hr_int_block ON expenses`);
    }
    expect((await q(`SELECT 1 FROM expenses`)).length).toBe(0);
    expect((await q(`SELECT 1 FROM hr_payroll_disbursements`)).length).toBe(0);
    expect(Number((await q<{ p: string }>(`SELECT paid_minor::text AS p FROM hr_payroll_items WHERE id = $1`, [h.item.id]))[0].p)).toBe(0);
  });

  it("الصرف بلا وردية مفتوحة مرفوض برسالة الصندوق ولا يترك أثرًا", async () => {
    const h = await hybrid();
    await q(`UPDATE cashier_shifts SET status = 'closed', closed_at = NOW(), closed_by = 'x' WHERE id = $1`, [shiftId]);
    await expect(payroll.disbursePayrollItem(h.item.id, { amountMinor: 112_000, clientRequestId: "noshift-0001" }, admin)).rejects.toThrow("وردية");
    expect((await q(`SELECT 1 FROM hr_payroll_disbursements`)).length).toBe(0);
  });

  it("العكس: يعيد المتبقي في الالتزامين وكشف الطبيب والبند، بقيدٍ معاكس في الوردية المفتوحة، ولا يتكرر", async () => {
    const h = await hybrid();
    const d = await payroll.disbursePayrollItem(h.item.id, { amountMinor: 112_000, clientRequestId: "rev-full-00001" }, admin);
    const reversed = await payroll.reversePayrollDisbursement(d.id, { reason: "خطأ في الصرف" }, admin);
    expect(reversed.reversedAt).not.toBeNull();
    expect(await cashOut()).toBe(0); // الأصل + المعاكس
    expect((await doctorRow(h.partyId!))?.paidMinor).toBe(0);
    expect((await doctorRow(h.partyId!))?.dueMinor).toBe(12_000);
    expect(await remainingOf(h.partyId!, "salary")).toBe(100_000);
    expect(await remainingOf(h.partyId!, "commission")).toBe(12_000);
    const [item] = await q<{ paid_minor: string; remaining_minor: string; status: string }>(`SELECT paid_minor::text, remaining_minor::text, status FROM hr_payroll_items WHERE id = $1`, [h.item.id]);
    expect([Number(item.paid_minor), Number(item.remaining_minor), item.status]).toEqual([0, 112_000, "accrued"]);
    // نقرة مزدوجة: لا قيد معاكس ثانٍ
    await payroll.reversePayrollDisbursement(d.id, { reason: "خطأ في الصرف" }, admin);
    expect((await q(`SELECT 1 FROM expenses WHERE reversal_of_id IS NOT NULL`)).length).toBe(2);
    // ثم يمكن الصرف من جديد بمفتاحٍ جديد
    await payroll.disbursePayrollItem(h.item.id, { amountMinor: 112_000, clientRequestId: "rev-full-00002" }, admin);
    expect(await cashOut()).toBe(112_000);
  });

  it("عكسٌ بلا وردية مفتوحة مرفوض ولا يغيّر شيئًا", async () => {
    const h = await hybrid();
    const d = await payroll.disbursePayrollItem(h.item.id, { amountMinor: 112_000, clientRequestId: "rev-noshift-001" }, admin);
    await q(`UPDATE cashier_shifts SET status = 'closed', closed_at = NOW(), closed_by = 'x' WHERE id = $1`, [shiftId]);
    await expect(payroll.reversePayrollDisbursement(d.id, { reason: "خطأ" }, admin)).rejects.toThrow("وردية");
    expect((await q(`SELECT 1 FROM expenses WHERE reversal_of_id IS NOT NULL`)).length).toBe(0);
  });

  it("طبيب بنسبة فقط: سند عمولة واحد يظهر في كشفه، وبراتب فقط: سند راتب واحد بلا أثر على العمولات", async () => {
    const doc = await staffWith({ kind: "commission", percent: 30 });
    const clerk = await staffWith({ kind: "salary", salary: 80_000 });
    await earnCommission(doc.partyId!, 20_000);
    const { run, items } = await approvedRun();
    await approve(run.id);
    const docItem = (await payroll.listPayrollItems(run.id)).find((i) => i.staffId === doc.staffId)!;
    const clerkItem = (await payroll.listPayrollItems(run.id)).find((i) => i.staffId === clerk.staffId)!;
    expect(items.length).toBe(2);
    await payroll.disbursePayrollItem(docItem.id, { amountMinor: 6_000, clientRequestId: "doc-only-000001" }, admin);
    await payroll.disbursePayrollItem(clerkItem.id, { amountMinor: 80_000, clientRequestId: "clerk-only-00001" }, admin);
    expect((await doctorRow(doc.partyId!))?.paidMinor).toBe(6_000);
    const cats = await q<{ category: string }>(`SELECT category FROM expenses ORDER BY id`);
    expect(cats.map((c) => c.category)).toEqual(["commission", "salary"]);
  });
});

describe("٣ — مفتاح الطلب: لا صرف مكرر من البداية للنهاية", () => {
  async function simple() {
    const s = await staffWith({ kind: "salary", salary: 100_000 });
    const { run } = await approvedRun();
    await approve(run.id);
    const item = (await payroll.listPayrollItems(run.id))[0];
    return { ...s, run, item };
  }

  it("ضياع تأكيد COMMIT بعد حفظه يستعيد العملية بنفس المفتاح ولا يصرف مجددًا", async () => {
    const h = await simple();
    const pool = getPool();
    const client = await pool.connect();
    const originalQuery = client.query.bind(client);
    const originalRelease = client.release.bind(client);
    client.query = (async (...args: unknown[]) => {
      const result = await (originalQuery as (...args: unknown[])=>Promise<unknown>)(...args);
      if(args[0]==="COMMIT") throw new Error("synthetic lost COMMIT response");
      return result;
    }) as typeof client.query;
    client.release = () => { client.query=originalQuery;client.release=originalRelease;originalRelease(); };
    const connect = vi.spyOn(pool,"connect").mockResolvedValueOnce(client as never);
    try {
      const d = await payroll.disbursePayrollItem(h.item.id,{amountMinor:40_000,clientRequestId:"lost-commit-00001"},admin);
      expect(d.replayed).toBe(true);
      expect((await payroll.findDisbursementByRequestId("lost-commit-00001"))?.id).toBe(d.id);
      expect(await cashOut()).toBe(40_000);
    } finally { connect.mockRestore(); }
  });
  it("المفتاح الجماعي الذي يحوي % أو _ لا يطابق طلبًا آخر", async () => {
    const h = await simple();
    const first = await payroll.disburseEntireRun(h.run.id,{clientRequestId:"batch_AX-0001"},admin);
    await expect(payroll.disburseEntireRun(h.run.id,{clientRequestId:"batch_%X-0001"},admin)).resolves.toEqual([]);
    expect(first).toHaveLength(1);expect(await cashOut()).toBe(100_000);
  });

  it("إعادة الطلب نفسه (المفتاح والمحتوى) تعيد النتيجة الأصلية ولا تنشئ سندًا ثانيًا", async () => {
    const s = await simple();
    const a = await payroll.disbursePayrollItem(s.item.id, { amountMinor: 40_000, clientRequestId: "idem-same-00001" }, admin);
    const b = await payroll.disbursePayrollItem(s.item.id, { amountMinor: 40_000, clientRequestId: "idem-same-00001" }, admin);
    expect(b.id).toBe(a.id);
    expect(b.replayed).toBe(true);
    expect((await q(`SELECT 1 FROM expenses`)).length).toBe(1);
    expect(await cashOut()).toBe(40_000);
  });

  it("المفتاح نفسه بمبلغٍ مختلف ⇒ مرفوض (لا يُعاد الأصل بصمت ولا يُنفَّذ الجديد)", async () => {
    const s = await simple();
    await payroll.disbursePayrollItem(s.item.id, { amountMinor: 40_000, clientRequestId: "idem-diff-00001" }, admin);
    await expect(payroll.disbursePayrollItem(s.item.id, { amountMinor: 50_000, clientRequestId: "idem-diff-00001" }, admin)).rejects.toThrow("مفتاح");
    expect(await cashOut()).toBe(40_000);
  });

  it("المفتاح نفسه على بندٍ آخر ⇒ مرفوض", async () => {
    const a = await simple();
    const other = await staffWith({ kind: "salary", salary: 70_000 });
    const period = await payroll.getOrCreatePayrollPeriod("2026-11", admin);
    const run2 = await payroll.calculatePayrollRun(period.id, "YER", admin);
    await approve(run2.id);
    const otherItem = (await payroll.listPayrollItems(run2.id)).find((i) => i.staffId === other.staffId)!;
    await payroll.disbursePayrollItem(a.item.id, { amountMinor: 10_000, clientRequestId: "idem-item-00001" }, admin);
    await expect(payroll.disbursePayrollItem(otherItem.id, { amountMinor: 10_000, clientRequestId: "idem-item-00001" }, admin)).rejects.toThrow("مفتاح");
  });

  it("تبويبان/نقرتان متزامنتان بالمفتاح نفسه: سند واحد وكلتاهما تعيدان النتيجة نفسها (لا خطأ قيدٍ خام)", async () => {
    const s = await simple();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () =>
      payroll.disbursePayrollItem(s.item.id, { amountMinor: 30_000, clientRequestId: "idem-race-000001" }, admin)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const ids = new Set(results.map((r) => (r as PromiseFulfilledResult<{ id: number }>).value.id));
    expect(ids.size).toBe(1);
    expect((await q(`SELECT 1 FROM expenses`)).length).toBe(1);
    expect(await cashOut()).toBe(30_000);
  });

  it("طلبان متزامنان بمفتاحين مختلفين يتجاوز مجموعهما المتبقي: ينجح أحدهما ويُرفض الآخر", async () => {
    const s = await simple();
    const results = await Promise.allSettled([
      payroll.disbursePayrollItem(s.item.id, { amountMinor: 60_000, clientRequestId: "idem-over-000001" }, admin),
      payroll.disbursePayrollItem(s.item.id, { amountMinor: 60_000, clientRequestId: "idem-over-000002" }, admin),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(await cashOut()).toBe(60_000);
  });

  it("سندٌ دون المفتاح مقبول للتوافق لكن الصرف الجماعي يشتق مفتاحًا ثابتًا من الطلب (لا Date.now)", async () => {
    const s = await simple();
    const first = await payroll.disburseEntireRun(s.run.id, { clientRequestId: "batch-stable-0001" }, admin);
    const again = await payroll.disburseEntireRun(s.run.id, { clientRequestId: "batch-stable-0001" }, admin);
    expect(first.length).toBe(1);
    expect(again.length).toBe(1);
    expect(again[0].id).toBe(first[0].id);
    expect(await cashOut()).toBe(100_000);
  });

  it("الاستعلام عن نتيجة مفتاح بعد ضياع الرد: يرجع الصرف المحفوظ، ومفتاحٌ مجهول لا يرجع شيئًا", async () => {
    const s = await simple();
    expect(await payroll.findDisbursementByRequestId("idem-lookup-0001")).toBeNull();
    const d = await payroll.disbursePayrollItem(s.item.id, { amountMinor: 20_000, clientRequestId: "idem-lookup-0001" }, admin);
    expect((await payroll.findDisbursementByRequestId("idem-lookup-0001"))?.id).toBe(d.id);
  });

  it("تجاوز المتبقي مرفوض، وفترة مقفلة لا تقبل صرفًا", async () => {
    const s = await simple();
    await expect(payroll.disbursePayrollItem(s.item.id, { amountMinor: 100_001, clientRequestId: "idem-excess-0001" }, admin)).rejects.toThrow("يتجاوز");
    await payroll.disbursePayrollItem(s.item.id, { amountMinor: 100_000, clientRequestId: "idem-excess-0002" }, admin);
    await payroll.closePayrollPeriod(s.run.periodId, admin);
    await expect(payroll.disbursePayrollItem(s.item.id, { amountMinor: 1, clientRequestId: "idem-closed-0001" }, admin)).rejects.toThrow("مقفل");
  });

  it("إقفال فترة بمتبقٍ غير مسدّد مرفوض", async () => {
    const s = await simple();
    await expect(payroll.closePayrollPeriod(s.run.periodId, admin)).rejects.toThrow("متبقٍ");
  });
});

describe("٤ — تعديل سياسات الموارد البشرية عملية واحدة مدققة", () => {
  it("session expiry while awaiting a real payroll lock rolls back vouchers and balances", async () => {
    const staff = await staffWith({kind:"salary"});
    const calculated = await approvedRun(); await approve(calculated.run.id);
    const s = {run:calculated.run,item:(await payroll.listPayrollItems(calculated.run.id)).find(item=>item.staffId===staff.staffId)!};
    const blocker = await getPool().connect();
    const expiring = {...admin,expiresAt:Date.now()+60_000};
    let pending: Promise<unknown> | undefined;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await blocker.query("BEGIN");
      const {rows:[identity]} = await blocker.query("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT id FROM hr_payroll_items WHERE id=$1 FOR UPDATE",[s.item.id]);
      pending = payroll.disbursePayrollItem(s.item.id,{amountMinor:1000,clientRequestId:"expiry-while-locked-001"},expiring);
      // Attach the rejection handler before releasing the barrier.
      const outcome = pending.then(value=>({value,error:null}),error=>({value:null,error}));
      await expect.poll(async()=>Number((await q<{n:number}>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",[identity.pid]))[0].n)).toBeGreaterThan(0);
      clock = vi.spyOn(Date,"now").mockReturnValue(expiring.expiresAt+1);
      await blocker.query("COMMIT");
      expect((await outcome).error).toMatchObject({code:"session_expired",status:401});
      expect(await payroll.findDisbursementByRequestId("expiry-while-locked-001")).toBeNull();
      expect(await cashOut()).toBe(0);
      expect((await payroll.listPayrollItems(s.run.id))[0].paidMinor).toBe(0);
    } finally {
      clock?.mockRestore();await blocker.query("ROLLBACK");await pending?.catch(()=>{});blocker.release();
    }
  });
  it("settings patch rolls back every policy if the second audit fails", async () => {
    const before = await payroll.getHrSettings();
    await q(`CREATE FUNCTION hr_settings_audit_fail() RETURNS trigger AS $$ BEGIN IF NEW.action='hr.settings.update' AND NEW.entity_id='leave_policy' THEN RAISE EXCEPTION 'synthetic settings audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await q("CREATE TRIGGER hr_settings_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION hr_settings_audit_fail()");
    try {
      await expect(payroll.updateHrSettings({payrollCycle:{defaultCurrency:"SAR",salaryDay:12,cutoffDay:8},leavePolicy:{annualDefaultDays:26,probationMonths:4}},admin)).rejects.toThrow("synthetic settings audit failure");
      expect(await payroll.getHrSettings()).toEqual(before);
      expect(await q("SELECT id FROM audit_log WHERE action='hr.settings.update'")).toHaveLength(0);
    } finally { await q("DROP TRIGGER hr_settings_audit_fail ON audit_log");await q("DROP FUNCTION hr_settings_audit_fail()"); }
  });
  it("settings writer refuses a forged non-manager actor", async () => {
    const before = await payroll.getHrSettings();
    await expect(payroll.updateHrSettings({leavePolicy:{annualDefaultDays:26,probationMonths:4}},{...admin,role:"doctor"})).rejects.toMatchObject({code:"forbidden",status:403});
    expect(await payroll.getHrSettings()).toEqual(before);
  });
});
