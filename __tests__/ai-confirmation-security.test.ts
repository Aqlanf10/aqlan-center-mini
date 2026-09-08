import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * اختبارات هجوم معمارية تأكيد أدوات تغيير الحالة (P0.6/P0.16 + مراجعة P0):
 * إعادة التشغيل، النقر المزدوج المتزامن، **التلاعب الحقيقي بالتوقيع**،
 * التلاعب بالمستخدم/المريض/الأداة، العبور بين المستخدمين، سحب الصلاحية بعد
 * العرض، وتغيّر هوية المريض بعد العرض.
 *
 * مراجعة P0 (دفاع في العمق): المنفّذ المركزي `executeAiTool` لا يقبل حمولة
 * محلولة — يقبل **الرمز الخام الموقّع** (confirmationToken) ويتحقق بنفسه من
 * التوقيع والعمر والأداة والمستخدم. كل اختبارات التلاعب هنا تُنشئ رمزًا
 * ساريًا قانونيًا ثم تُعدّل جسمه مع إبقاء التوقيع القديم — فيجب أن يفشل
 * التحقق **قبل** أي استدعاء للدوال الكاتبة.
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
    recordPayment: vi.fn(),
    createPatient: vi.fn(),
    recordAudit: vi.fn(),
    resetClaims: () => claimed.clear(),
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
    recordPayment: mocks.recordPayment,
    createPatient: mocks.createPatient,
    recordAudit: mocks.recordAudit,
  };
});

import { executeAiTool } from "../lib/ai-tools/registry";
import { verifyToolConfirmation } from "../lib/ai-confirmation";
import type { AiToolContext } from "../lib/ai-tools/types";

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
    gender: "male",
    birthYear: 1990,
  }));
  mocks.searchPatients.mockImplementation(async (term: string, limit: number, scope?: number | null) =>
    scope === 5 /* طبيب A */ ? [] : [],
  );
});

/** يولّد رمز تأكيد ساريًا عبر المسار الرسمي: طلب ← عرض — ويعيد الرمز الخام. */
async function obtainOfferToken(
  tool: string,
  params: Record<string, unknown>,
  context: AiToolContext,
): Promise<string> {
  const offer = await executeAiTool(tool, params, context);
  expect(offer.success).toBe(false);
  expect(offer.requiresConfirmation).toBe(true);
  expect(offer.confirmation).toBeDefined();
  const payload = verifyToolConfirmation(offer.confirmation!.token);
  expect(payload).not.toBeNull();
  return offer.confirmation!.token;
}

/** يبني نسخة معدّلة الجسم بنفس التوقيع القديم — هجوم التلاعب الكلاسيكي. */
function tamperToken(token: string, mutate: (parsed: Record<string, unknown>) => void): string {
  const dot = token.lastIndexOf(".");
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  mutate(parsed);
  const tamperedBody = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
  return `${tamperedBody}.${signature}`;
}

describe("هجوم إعادة التشغيل (Replay) والنقر المزدوج المتزامن", () => {
  it("الرمز نفسه لا يُنفّذ مرتين — الاستهلاك الذرّي مرة واحدة", async () => {
    const token = await obtainOfferToken(
      "create_patient",
      { fullName: "طارق أحمد", phone: "777123456" },
      RECEPTION,
    );
    const payload = verifyToolConfirmation(token)!;
    const first = await executeAiTool("create_patient", payload.params as any, {
      ...RECEPTION,
      confirmationToken: token,
    });
    const second = await executeAiTool("create_patient", payload.params as any, {
      ...RECEPTION,
      confirmationToken: token,
    });
    /* التنفيذ الثاني يُرفض برسالة استهلاك — لا يمر بصمت. */
    expect(second.success).toBe(false);
    expect(second.textSummary).toContain("مستهلك");
  });

  it("نقرٌ مزدوج متزامن: واحدٌ فقط يفوز بالاستهلاك والآخر يُرفض", async () => {
    const token = await obtainOfferToken(
      "create_patient",
      { fullName: "نقر مزدوج" },
      RECEPTION,
    );
    const payload = verifyToolConfirmation(token)!;
    const [a, b] = await Promise.all([
      executeAiTool("create_patient", payload.params as any, { ...RECEPTION, confirmationToken: token }),
      executeAiTool("create_patient", payload.params as any, { ...RECEPTION, confirmationToken: token }),
    ]);
    const winners = [a, b].filter((r) => !r.textSummary.includes("مستهلك"));
    expect(winners).toHaveLength(1);
  });
});

describe("التلاعب بالتوقيع — تعديل الجسم مع إبقاء التوقيع القديم", () => {
  it("تعديل المبلغ داخل الجسم مع التوقيع القديم: التحقق يفشل ولا يُستدعى التنفيذ", async () => {
    const token = await obtainOfferToken(
      "record_patient_payment",
      { patientId: 42, amount: "5000", currency: "YER" },
      RECEPTION,
    );
    /* هجوم حقيقي: جسم معدّل (900000) + توقيع العرض الأصلي. */
    const tampered = tamperToken(token, (parsed) => {
      (parsed.params as Record<string, unknown>).amount = "900000";
    });
    /* التوقيع مكسور أصلًا: verifyToolConfirmation يرفضه. */
    expect(verifyToolConfirmation(tampered)).toBeNull();

    const result = await executeAiTool("record_patient_payment",
      { patientId: 42, amount: "900000", currency: "YER" },
      { ...RECEPTION, confirmationToken: tampered });
    /* البوابة المركزية ترفضه قبل أي كتابة — الدالة الكاتبة لم تُستدعَ. */
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("غير صالح");
    expect(mocks.recordPayment).not.toHaveBeenCalled();
    expect(mocks.claimToolConfirmation).not.toHaveBeenCalled();
  });

  it("تلاعب بالمستخدم (userId) مع التوقيع القديم: رفض بلا تنفيذ", async () => {
    const token = await obtainOfferToken(
      "record_patient_payment",
      { patientId: 42, amount: "5000", currency: "YER" },
      RECEPTION,
    );
    const tampered = tamperToken(token, (parsed) => {
      parsed.userId = 99; /* انتحال مستخدم آخر */
    });
    expect(verifyToolConfirmation(tampered)).toBeNull();
    const result = await executeAiTool("record_patient_payment",
      { patientId: 42, amount: "5000", currency: "YER" },
      { ...RECEPTION, confirmationToken: tampered });
    expect(result.success).toBe(false);
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });

  it("تلاعب بالمريض (patientId) مع التوقيع القديم: رفض بلا تنفيذ", async () => {
    const token = await obtainOfferToken(
      "record_patient_payment",
      { patientId: 42, amount: "5000", currency: "YER" },
      RECEPTION,
    );
    const tampered = tamperToken(token, (parsed) => {
      (parsed.params as Record<string, unknown>).patientId = 77;
      parsed.patientId = 77;
    });
    expect(verifyToolConfirmation(tampered)).toBeNull();
    const result = await executeAiTool("record_patient_payment",
      { patientId: 77, amount: "5000", currency: "YER" },
      { ...RECEPTION, confirmationToken: tampered });
    expect(result.success).toBe(false);
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });

  it("تلاعب بالأداة داخل الجسم مع التوقيع القديم: رفض بلا تنفيذ", async () => {
    const token = await obtainOfferToken(
      "record_patient_payment",
      { patientId: 42, amount: "5000", currency: "YER" },
      RECEPTION,
    );
    const tampered = tamperToken(token, (parsed) => {
      parsed.tool = "add_patient_medical_alert"; /* تحويل الرمز لأداة أشد خطرًا */
    });
    expect(verifyToolConfirmation(tampered)).toBeNull();
    const result = await executeAiTool("record_patient_payment",
      { patientId: 42, amount: "5000", currency: "YER" },
      { ...RECEPTION, confirmationToken: tampered });
    expect(result.success).toBe(false);
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });

  it("حمولة غير موقعة (JSON خام بلا توقيع) لا تُقبل مهما كان مصدرها", async () => {
    const token = await obtainOfferToken(
      "record_patient_payment",
      { patientId: 42, amount: "5000", currency: "YER" },
      RECEPTION,
    );
    const payload = verifyToolConfirmation(token)!;
    /* caller داخلي يحاول تمرير حمولة جاهزة بلا توقيع — مرفوضة في الشكل. */
    const unsigned = JSON.stringify({ ...payload, params: { ...payload.params, amount: "999999" } });
    const result = await executeAiTool("record_patient_payment",
      payload.params as any,
      { ...RECEPTION, confirmationToken: unsigned });
    expect(result.success).toBe(false);
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });

  it("الرمز المنتهي عمره يُرفض (توقيع صحيح لكنه متأخر)", async () => {
    const token = await obtainOfferToken("create_patient", { fullName: "متأخر" }, RECEPTION);
    const expired = tamperToken(token, (parsed) => {
      parsed.exp = Date.now() - 1000;
    });
    /* انتهاء العمر يرفضه التحقق المركزي حتى لو ظل التوقيع سليمًا منطقيًا. */
    expect(verifyToolConfirmation(expired)).toBeNull();
    const result = await executeAiTool("create_patient",
      verifyToolConfirmation(token)!.params as any,
      { ...RECEPTION, confirmationToken: expired });
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("غير صالح");
  });
});

describe("العبور بين المستخدمين وعدم تطابق الأداة", () => {
  it("رمز مستخدمٍ لا ينفّذه مستخدم آخر (Cross-user)", async () => {
    const token = await obtainOfferToken(
      "create_patient",
      { fullName: "مريض استقبال" },
      RECEPTION,
    );
    const payload = verifyToolConfirmation(token)!;
    const other: AiToolContext = {
      ...DOCTOR_A,
      userId: 99, /* مستخدم آخر يعرض نفس الرمز */
    };
    const result = await executeAiTool("create_patient", payload.params as any, {
      ...other,
      confirmationToken: token,
    });
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("مستخدم آخر");
  });

  it("رمز أداةٍ لا ينفّذ أداةً أخرى (Tool mismatch — توقيع صحيح)", async () => {
    const token = await obtainOfferToken("create_patient", { fullName: "أداة أخرى" }, RECEPTION);
    const payload = verifyToolConfirmation(token)!;
    const result = await executeAiTool("book_appointment", { patientId: 42, date: "2026-09-09" }, {
      ...RECEPTION,
      confirmationToken: token, /* رمز create_patient مع طلب book_appointment */
    });
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("لا يطابق الأداة");
  });
});

describe("إعادة التفويض بعد العرض — الصلاحية والملكية", () => {
  it("سحب صلاحية المال من مستخدم بعد العرض يمنع التنفيذ", async () => {
    /* استقبالٌ فقد صلاحية الشات/المال بعد العرض — سياق التنفيذ بلا صلاحية. */
    const token = await obtainOfferToken(
      "record_patient_payment",
      { patientId: 42, amount: "5000", currency: "YER" },
      RECEPTION,
    );
    const payload = verifyToolConfirmation(token)!;
    const demoted: AiToolContext = {
      ...RECEPTION,
      role: "doctor", /* دور هبط: الطبيب لا يمسك المال */
    };
    const result = await executeAiTool("record_patient_payment", payload.params as any, {
      ...demoted,
      confirmationToken: token,
    });
    expect(result.success).toBe(false);
    expect(result.textSummary).toContain("غير مصرح");
  });

  it("تغيّر هوية المريض بعد العرض يوقف التنفيذ", async () => {
    /* المريض 42 كان مسندًا للطبيب A عند العرض، ثم أُعيد تعيينه: عند التنفيذ
       يعيد العزل الفحص ويجد مريضًا مختلفًا عن المرتبط بالرمز. */
    const token = await obtainOfferToken(
      "book_appointment",
      { patientId: 42, date: "2026-09-09", time: "16:00" },
      DOCTOR_A,
    );
    const payload = verifyToolConfirmation(token)!;
    expect(payload.patientId).toBe(42);

    /* بعد العرض: أُعيد إسناد المريض لطبيبٍ آخر — فحص الملكية عند التنفيذ
       يجده لم يعد ملك الطبيب A فيوقف التنفيذ (Reauthorization). */
    owns42 = false;
    const result = await executeAiTool("book_appointment", payload.params as any, {
      ...DOCTOR_A,
      confirmationToken: token,
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
    expect(mocks.recordPayment).not.toHaveBeenCalled();
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
