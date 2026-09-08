import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * اختبارات هجوم عزل الطبيب في المساعد الذكي (P0.2/P0.3/P0.16):
 * الطبيب A يحاول الوصول لمريض الطبيب B عبر كل المسارات: بحث، معرّف مباشر،
 * تصادم أسماء، سياق محادثة مسموم، ومعرّفات موارد غير مباشرة (BOLA).
 */

const mocks = vi.hoisted(() => ({
  searchPatients: vi.fn(),
  getPatient: vi.fn(),
  findUserByUsername: vi.fn(),
  doctorOwnsPatient: vi.fn(),
  getAppointment: vi.fn(),
  getInvoice: vi.fn(),
  getLabOrderById: vi.fn(),
  getPlan: vi.fn(),
  getClinicalVisit: vi.fn(),
  getPrescription: vi.fn(),
  getPatientFile: vi.fn(),
  patientLedger: vi.fn(),
  listPatientPlans: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    searchPatients: mocks.searchPatients,
    getPatient: mocks.getPatient,
    findUserByUsername: mocks.findUserByUsername,
    doctorOwnsPatient: mocks.doctorOwnsPatient,
    getAppointment: mocks.getAppointment,
    getInvoice: mocks.getInvoice,
    getLabOrderById: mocks.getLabOrderById,
    getPlan: mocks.getPlan,
    getClinicalVisit: mocks.getClinicalVisit,
    getPrescription: mocks.getPrescription,
    getPatientFile: mocks.getPatientFile,
    patientLedger: mocks.patientLedger,
    listPatientPlans: mocks.listPatientPlans,
    recordAudit: mocks.recordAudit,
  };
});

import { executeAiTool } from "../lib/ai-tools/registry";
import { applyPatientScoping, resolvePatientForTool } from "../lib/ai-tools/authorization";
import { resolveToolPolicy } from "../lib/ai-tools/policy";
import type { AiToolContext } from "../lib/ai-tools/types";

/** الطبيب A — party 5، يملك المريض 42 فقط. المريض 77 (وكل موارده) للطبيب B. */
const DOCTOR_A: AiToolContext = {
  userId: 11,
  username: "dr.amjad",
  role: "doctor",
  doctorPartyId: 5,
  permissions: { canViewAllPatients: false },
  isDbConnected: true,
  todayISO: "2026-09-08",
};

const PATIENT_A = { id: 42, fullName: "سالم عبدالله", patientNumber: "P-00042", phone: "770000001", medicalAlert: null };
const PATIENT_B = { id: 77, fullName: "سالم عبدالله", patientNumber: "P-00077", phone: "770000002", medicalAlert: "حساسية بنسلين" };

beforeEach(() => {
  vi.clearAllMocks();
  /* ملكية الطبيب A: المريض 42 فقط. */
  mocks.doctorOwnsPatient.mockImplementation(async (partyId: number, patientId: number) =>
    partyId === 5 && patientId === 42);
  mocks.findUserByUsername.mockImplementation(async (username: string) =>
    username === "dr.amjad"
      ? { id: 11, username, isActive: true, partyId: 5, permissions: { canViewAllPatients: false } }
      : { id: 99, username, isActive: true, partyId: null, permissions: {} });
  mocks.getPatient.mockImplementation(async (id: number) =>
    id === 42 ? PATIENT_A : id === 77 ? PATIENT_B : null);
  mocks.getPatientFile.mockImplementation(async (id: number) => ({
    patient: id === 42 ? PATIENT_A : id === 77 ? PATIENT_B : null,
    visits: [],
    plans: [],
    invoices: [],
    payments: [],
    documents: [],
  }));
  mocks.patientLedger.mockResolvedValue({ invoices: [], payments: [], opening: null });
  mocks.listPatientPlans.mockResolvedValue([]);
  /* البحث غير المقيّد كان سيجد كليهما — المجال يرشّح قبل العودة. */
  mocks.searchPatients.mockImplementation(async (term: string, limit: number, scope?: number | null) => {
    const all = term.includes("77") || term.includes("P-00077") ? [PATIENT_B] : [PATIENT_A, PATIENT_B];
    return scope === 5 ? all.filter((p) => p.id === 42).slice(0, limit) : all.slice(0, limit);
  });
});

describe("Doctor A ← مريض الطبيب B: كل المسارات مغلقة", () => {
  it("معرّف مريض مباشر (Direct patientId bypass) يُرفض", async () => {
    const result = await executeAiTool("get_patient_summary", { patientId: 77 }, DOCTOR_A);
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("عزل الكادر");
    /* ولم تُقرأ بيانات المريض B أصلاً. */
    expect(mocks.getPatient).not.toHaveBeenCalledWith(77);
  });

  it("البحث بالاسم في مجال الطبيب لا يكشف مرضى الزملاء", async () => {
    const result = await executeAiTool("search_patient", { term: "سالم عبدالله" }, DOCTOR_A);
    /* النتائج مسموحة بالكامل: لا 77 ولا هاتفه ولا تنبيهه الطبي في الرد. */
    expect(result.success).toBe(true);
    expect(result.textSummary).not.toContain("P-00077");
    expect(result.textSummary).not.toContain("770000002");
    expect(result.textSummary).not.toContain("حساسية بنسلين");
    expect(result.textSummary).toContain("P-00042");
  });

  it("تصادم الاسم نفسه بين مريضين: التوضيح من المسموح به فقط", async () => {
    const resolution = await resolvePatientForTool({ patientName: "سالم عبدالله" }, DOCTOR_A);
    /* ضمن مجال الطبيب A نتيجة واحدة (مريضه) — لا قائمة تضم مريض الزميل. */
    expect(resolution.kind).toBe("pinned");
    expect(resolution.kind === "pinned" && resolution.patientId).toBe(42);
  });

  it("تثبيت المريض بعد الحلّ: المعاملات تحمل رقمًا دقيقًا لا اسمًا للبحث اللاحق", async () => {
    const policy = resolveToolPolicy("book_appointment")!;
    const scoping = await applyPatientScoping(policy, { patientName: "سالم عبدالله" }, DOCTOR_A);
    expect(scoping.refusal).toBeUndefined();
    expect(scoping.patientId).toBe(42);
    expect(scoping.sanitizedParams.patientId).toBe(42);
    expect(scoping.sanitizedParams.patientName).toBe("سالم عبدالله");
  });

  it("appointmentId لموعد مريض B يُحلّ ثم يُرفض (BOLA)", async () => {
    mocks.getAppointment.mockResolvedValue({ id: 900, patientId: 77, doctorId: 6 });
    const result = await executeAiTool(
      "update_appointment_status",
      { appointmentId: 900, action: "cancel" },
      DOCTOR_A,
    );
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("عزل الكادر السريري");
    /* لم يصل إلى أي تنفيذ — لا claim ولا تنفيذ (أداة كتابة تتطلب تأكيدًا أصلًا،
       لكن العزل يسبق العرض نفسه). */
  });

  it("الطبيب ممنوع من أداة الدفع أصلًا — الدور يُرفض قبل أي حلّ موارد", async () => {
    mocks.getInvoice.mockResolvedValue({ id: 555, patientId: 77 });
    const result = await executeAiTool(
      "record_patient_payment",
      { invoiceId: 555, amount: "1000", currency: "YER" },
      DOCTOR_A,
    );
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("غير مصرح");
    /* ولم يُستهلك شيء ولا حُلّ مورد — الرفض في البوابة قبل كل شيء. */
  });

  it("labOrderId لأمر معمل مريض B في صياغة النموذج يُرفض", async () => {
    mocks.getLabOrderById.mockResolvedValue({ id: 321, patientId: 77 });
    const result = await executeAiTool(
      "draft_lab_order_form",
      { labOrderId: 321, tooth: "16", shade: "A2" },
      DOCTOR_A,
    );
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("عزل الكادر السريري");
  });

  it("treatmentPlanId لخطة مريض B في صياغة الخطة يُرفض", async () => {
    mocks.getPlan.mockResolvedValue({ id: 88, patientId: 77 });
    const result = await executeAiTool(
      "draft_treatment_plan_form",
      { treatmentPlanId: 88, totalAmount: "400000" },
      DOCTOR_A,
    );
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("عزل الكادر السريري");
  });

  it("معرّف غير موجود لا يسرب شيئًا — رسالة عامة بلا كشف وجود المورد", async () => {
    mocks.getAppointment.mockResolvedValue(null);
    const result = await executeAiTool(
      "update_appointment_status",
      { appointmentId: 424242, action: "cancel" },
      DOCTOR_A,
    );
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("لم أجد الموعد");
  });
});

describe("conversationPatientId مُسَمّم — حارس المسار", () => {
  it("سياق مريض الزميل يُسقط عند مدخل المحرك", async () => {
    /* عبر resolvePatientForTool — نفس ما يفعله مسار المحادثة قبل تمريره. */
    const resolution = await resolvePatientForTool({ patientId: 77 }, DOCTOR_A);
    expect(resolution.kind).toBe("denied");
  });

  it("مريض الطبيب نفسه يعبر — السلوك الطبيعي لا يُكسر", async () => {
    const result = await executeAiTool("get_patient_summary", { patientId: 42 }, DOCTOR_A);
    expect(result.success).toBe(true);
    expect(result.textSummary).toContain("سالم عبدالله");
  });
});

describe("مسؤول إضافي: canViewAllPatients يفتح الرؤية الموثوقة فقط", () => {
  it("الطبيب بمنحٍ عامة يرى مريض الزميل — المنحة الصريحة تعمل", async () => {
    mocks.findUserByUsername.mockImplementation(async () => ({
      id: 11, username: "dr.amjad", isActive: true, partyId: 5,
      permissions: { canViewAllPatients: true },
    }));
    const broad: AiToolContext = { ...DOCTOR_A, canViewAllPatients: true, permissions: { canViewAllPatients: true } };
    const result = await executeAiTool("get_patient_summary", { patientId: 77 }, broad);
    expect(result.success).toBe(true);
  });
});
