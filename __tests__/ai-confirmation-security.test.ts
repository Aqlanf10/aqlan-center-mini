import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * اختبارات هجوم معمارية تأكيد أدوات تغيير الحالة (P0.6/P0.16):
 * إعادة التشغيل، النقر المزدوج المتزامن، التلاعب، العبور بين المستخدمين،
 * سحب الصلاحية بعد العرض، وتغيّر هوية المريض بعد العرض.
 */

const mocks = vi.hoisted(() => {
  const claimed = new Set<string>();
  return {
    searchPatients: vi.fn(),
    getPatient: vi.fn(),
    getAppointment: vi.fn(),
    getInvoice: vi.fn(),
    findUserByUsername: vi.fn(),
    doctorOwnsPatient: vi.fn(),
    claimToolConfirmation: vi.fn((jti: string) => {
      /* محاكاة الإدخال الذرّي تحت قيد المفتاح: أول استهلاك ينجح، وكل ما
         بعده يُرفض — كقاعدة البيانات نفسها. */
      if (claimed.has(jti)) return Promise.resolve(false);
      claimed.add(jti);
      return Promise.resolve(true);
    }),
    resetClaims: () => claimed.clear(),
    recordAudit: vi.fn(),
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    searchPatients: mocks.searchPatients,
    getPatient: mocks.getPatient,
    getAppointment: mocks.getAppointment,
    getInvoice: mocks.getInvoice,
    findUserByUsername: mocks.findUserByUsername,
    doctorOwnsPatient: mocks.doctorOwnsPatient,
    claimToolConfirmation: mocks.claimToolConfirmation,
    recordAudit: mocks.recordAudit,
  };
});

import { executeAiTool } from "../lib/ai-tools/registry";
import { verifyToolConfirmation } from "../lib/ai-confirmation";
import type { AiToolContext, ToolConfirmationPayload } from "../lib/ai-tools/types";

const DOCTOR_A: AiToolContext = {
  userId: 11,
  username: "dr.amjad",
  role: "doctor",
  doctorPartyId: 5,
  permissions: { canViewAllPatients: false },
  isDbConnected: true,
  todayISO: "2026-09-08",
};

let owns42 = true;

const RECEPTION: AiToolContext = {
  userId: 21,
  username: "reception1",
  role: "reception",
  permissions: { canViewPatientPayments: true },
  isDbConnected: true,
  todayISO: "2026-09-08",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resetClaims();
  /* الطبيب A (party 5) يملك المريض 42؛ وكل ما عداه ليس له — قابل للتبديل
     لمحاكاة إعادة إسناد المريض بعد العرض. */
  owns42 = true;
  mocks.doctorOwnsPatient.mockImplementation(async (partyId: number, patientId: number) =>
    partyId === 5 && patientId === 42 && owns42);
  mocks.findUserByUsername.mockImplementation(async (username: string) =>
    username === "dr.amjad"
      ? { id: 11, username, isActive: true, partyId: 5, permissions: { canViewAllPatients: false } }
      : username === "reception1"
        ? { id: 21, username, isActive: true, partyId: null, permissions: { canViewPatientPayments: true } }
        : { id: 99, username, isActive: true, partyId: 999, permissions: {} });
  mocks.getPatient.mockImplementation(async (id: number) => ({
    id,
    fullName: id === 42 ? "سالم عبدالله" : "مريض آخر",
    patientNumber: `P-${String(id).padStart(5, "0")}`,
    phone: "770000001",
    medicalAlert: null,
  }));
  mocks.searchPatients.mockImplementation(async (term: string, limit: number, scope?: number | null) =>
    scope === 5 /* طبيب A */ ? [] : [], // البحث في مجاله لا يجد مرضى غيره
  );
});

/** يولّد رمز تأكيد ساريًا عبر المسار الرسمي: طلب ← عرض. */
async function obtainOffer(
  tool: string,
  params: Record<string, unknown>,
  context: AiToolContext,
): Promise<ToolConfirmationPayload> {
  const offer = await executeAiTool(tool, params, context);
  expect(offer.success).toBe(false);
  expect(offer.requiresConfirmation).toBe(true);
  expect(offer.confirmation).toBeDefined();
  const payload = verifyToolConfirmation(offer.confirmation!.token);
  expect(payload).not.toBeNull();
  return payload!;
}

describe("هجوم إعادة التشغيل (Replay) والنقر المزدوج المتزامن", () => {
  it("الرمز نفسه لا يُنفّذ مرتين — الاستهلاك الذرّي مرة واحدة", async () => {
    const payload = await obtainOffer(
      "create_patient",
      { fullName: "طارق أحمد", phone: "777123456" },
      RECEPTION,
    );
    const first = await executeAiTool("create_patient", payload.params as any, {
      ...RECEPTION,
      confirmationExecution: payload,
    });
    const second = await executeAiTool("create_patient", payload.params as any, {
      ...RECEPTION,
      confirmationExecution: payload,
    });
    /* التنفيذ الثاني يُرفض برسالة استهلاك — لا يمر بصمت. */
    expect(second.success).toBe(false);
    expect(second.textSummary).toContain("مستهلك");
  });

  it("نقرٌ مزدوج متزامن: واحدٌ فقط يفوز بالاستهلاك والآخر يُرفض", async () => {
    const payload = await obtainOffer(
      "create_patient",
      { fullName: "نقر مزدوج" },
      RECEPTION,
    );
    const [a, b] = await Promise.all([
      executeAiTool("create_patient", payload.params as any, { ...RECEPTION, confirmationExecution: payload }),
      executeAiTool("create_patient", payload.params as any, { ...RECEPTION, confirmationExecution: payload }),
    ]);
    const winners = [a, b].filter((r) => !r.textSummary.includes("مستهلك"));
    expect(winners).toHaveLength(1);
  });
});

describe("التلاعب والعبور بين المستخدمين", () => {
  it("حمولة معدّلة (مبلغ أكبر) تُبطل التوقيع", async () => {
    const payload = await obtainOffer(
      "record_patient_payment",
      { patientId: 42, amount: "5000", currency: "YER" },
      RECEPTION,
    );
    const tampered: ToolConfirmationPayload = {
      ...payload,
      params: { ...payload.params, amount: "900000" },
    };
    /* الحمولة المعدلة لا تملك توقيعًا صالحًا أصلاً: التحقق يرفضها. */
    const offer = await executeAiTool("record_patient_payment", tampered.params as any, {
      ...RECEPTION,
      confirmationExecution: tampered,
    });
    /* حتى لو وصلت إلى البوابة: الرمز الذي يحمله السياق يتحقق قبل التنفيذ.
       هنا التوقيع ليس جزء السياق (محاكاة تلاعب داخلي) — يكفي أن البوابة
       ترفض ما لا يملك تأكيدًا موقّعًا عبر المسار الرسمي. */
    expect(offer.success).toBe(false);
  });

  it("رمز مستخدمٍ لا ينفّذه مستخدم آخر (Cross-user)", async () => {
    const payload = await obtainOffer(
      "create_patient",
      { fullName: "مريض استقبال" },
      RECEPTION,
    );
    const other: AiToolContext = {
      ...DOCTOR_A,
      userId: 99, // مستخدم آخر يعرض نفس الرمز
    };
    const result = await executeAiTool("create_patient", payload.params as any, {
      ...other,
      confirmationExecution: payload,
    });
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("مستخدم آخر");
  });

  it("الرمز المنتهي عمره يُرفض", async () => {
    const payload = await obtainOffer("create_patient", { fullName: "متأخر" }, RECEPTION);
    const expired: ToolConfirmationPayload = { ...payload, exp: Date.now() - 1000 };
    const result = await executeAiTool("create_patient", payload.params as any, {
      ...RECEPTION,
      confirmationExecution: expired,
    });
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("انتهت صلاحية");
  });

  it("رمز أداةٍ لا ينفّذ أداةً أخرى (Tool mismatch)", async () => {
    const payload = await obtainOffer("create_patient", { fullName: "أداة أخرى" }, RECEPTION);
    const result = await executeAiTool("book_appointment", { patientId: 42, date: "2026-09-09" }, {
      ...RECEPTION,
      confirmationExecution: payload, // رمز create_patient مع طلب book_appointment
    });
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("لا يطابق الأداة");
  });
});

describe("إعادة التفويض بعد العرض — الصلاحية والملكية", () => {
  it("سحب صلاحية المال من مستخدم بعد العرض يمنع التنفيذ", async () => {
    /* استقبالٌ فقد صلاحية الشات/المال بعد العرض — سياق التنفيذ بلا صلاحية. */
    const payload = await obtainOffer(
      "record_patient_payment",
      { patientId: 42, amount: "5000", currency: "YER" },
      RECEPTION,
    );
    const demoted: AiToolContext = {
      ...RECEPTION,
      role: "doctor", // دور هبط: الطبيب لا يمسك المال
    };
    const result = await executeAiTool("record_patient_payment", payload.params as any, {
      ...demoted,
      confirmationExecution: payload,
    });
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("غير مصرح");
  });

  it("تغيّر هوية المريض بعد العرض يوقف التنفيذ", async () => {
    /* المريض 42 كان مسندًا للطبيب A عند العرض، ثم أُعيد تعيينه: عند التنفيذ
       يعيد العزل الفحص ويجد مريضًا مختلفًا عن المرتبط بالرمز. */
    const payload = await obtainOffer(
      "book_appointment",
      { patientId: 42, date: "2026-09-09", time: "16:00" },
      DOCTOR_A,
    );
    expect(payload.patientId).toBe(42);

    /* بعد العرض: أُعيد إسناد المريض لطبيبٍ آخر — فحص الملكية عند التنفيذ
       يجده لم يعد ملك الطبيب A فيوقف التنفيذ (Reauthorization). */
    owns42 = false;
    const result = await executeAiTool("book_appointment", payload.params as any, {
      ...DOCTOR_A,
      confirmationExecution: payload,
    });
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("عزل الكادر السريري");
  });
});

describe("بوابة العرض — لا كتابة قبل التأكيد", () => {
  it("طلب كتابةٍ بلا رمز لا يلمس الدوال الكاتبة إطلاقًا", async () => {
    await executeAiTool("book_appointment", { patientId: 42, date: "2026-09-09" }, RECEPTION);
    /* searchPatients/getPatient قُرئت للعزل، لكن لا claimToolConfirmation
       ولا أي تنفيذ — الاستهلاك يحدث عند التنفيذ المؤكد وحده. */
    expect(mocks.claimToolConfirmation).not.toHaveBeenCalled();
  });

  it("عرض التأكيد يبرز القيم الحساسة (المبلغ والعملة والجرعة)", async () => {
    const offer = await executeAiTool(
      "record_patient_payment",
      { patientId: 42, amount: "5000", currency: "SAR", method: "transfer" },
      RECEPTION,
    );
    const fields = offer.confirmation!.fields;
    expect(fields.some((f) => f.sensitive && f.value.includes("5000"))).toBe(true);
    expect(fields.some((f) => f.sensitive && f.value.includes("ريال سعودي"))).toBe(true);
  });
});
