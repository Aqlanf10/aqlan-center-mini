import { describe, expect, it } from "vitest";

/**
 * اختبارات مساعد السلامة الدوائية والولاية على المضادات الحيوية
 * (Medication CDS / Antibiotic Stewardship — مراجعة P0، Blocker 2).
 *
 * القاعدة الحاكمة: كلمة مثل «خراج/تورم/عدوى/abscess/swelling» لا تولّد
 * تلقائيًا Amoxicillin+Metronidazole+Ibuprofen أو أي regimen ثابت آخر.
 * الوضع الأساسي: الطبيب يحدد الأدوية، والمساعد يفحص — لا يختار.
 */

import {
  recommendPrescriptionAction,
  assessMedicationContext,
} from "../lib/ai-tools/clinical-action-tools";
import type { AiToolContext } from "../lib/ai-tools/types";

const DOCTOR_CTX: AiToolContext = {
  userId: 11,
  username: "dr.amjad",
  role: "doctor",
  doctorPartyId: 5,
  isDbConnected: false, /* وضع بلا قاعدة: الاختبار يركّز على منطق القرار الصرف */
  todayISO: "2026-09-08",
};

const CURRENT_YEAR = new Date().getFullYear();

describe("Stewardship — لا regimen تلقائي من كلمة مفتاحية", () => {
  it("«abscess» فقط: لا مضاد حيوي ولا جرعة — Missing Clinical Context", async () => {
    const res = await recommendPrescriptionAction(
      { patientName: "سالم", condition: "abscess" },
      DOCTOR_CTX,
    );
    expect(res.success).toBe(true);
    expect(res.textSummary).toContain("Missing Clinical Context");
    expect(res.textSummary).not.toContain("Amoxicillin");
    expect(res.textSummary).not.toContain("Metronidazole");
    expect(res.textSummary).not.toContain("500mg");
    expect(res.textSummary).not.toContain("500 mg");
  });

  it("«swelling» فقط: لا regimen — ولا للمصطلح العربي «خراج» أو «تورم»", async () => {
    for (const condition of ["swelling", "خراج سني", "تورم في الوجه"]) {
      const res = await recommendPrescriptionAction({ patientName: "سالم", condition }, DOCTOR_CTX);
      expect(res.textSummary, condition).toContain("بيانات سريرية ناقصة");
      expect(res.textSummary, condition).not.toContain("Amoxicillin");
      expect(res.textSummary, condition).not.toContain("Ibuprofen");
      expect(res.textSummary, condition).not.toContain("Metronidazole");
    }
  });

  it("«عدوى» مع أدوية الطبيب: الفحص يعمل ولا يُضاف regimen تلقائي", async () => {
    const res = await recommendPrescriptionAction(
      { patientName: "سالم", condition: "عدوى موضعية", requestedDrugs: ["Amoxicillin 500mg"] },
      DOCTOR_CTX,
    );
    /* دواء الطبيب يُفحص — ولا يُضاف دواء لم يذكره */
    expect(res.textSummary).toContain("Amoxicillin 500mg");
    expect(res.textSummary).not.toContain("Metronidazole");
    expect(res.textSummary).not.toContain("Ibuprofen");
  });

  it("أدوية الطبيب مع تعارض حرج (بنسلين): تحذير بصنفٍ بديل بعد تقييم الطبيب — لا نظام بديل بجرعات", async () => {
    const res = await recommendPrescriptionAction(
      {
        patientName: "سالم",
        condition: "حساسية بنسلين مؤكدة",
        requestedDrugs: ["Amoxicillin 500mg", "Brufen 400mg"],
      },
      DOCTOR_CTX,
    );
    expect(res.success).toBe(true);
    expect(res.textSummary).toContain("فحص السلامة الدوائية");
    expect(res.textSummary).toContain("صنف دوائي بديل");
    /* لا استبدال آلي بجرعة جاهزة */
    expect(res.textSummary).not.toContain("Clindamycin 300mg");
    expect(res.textSummary).not.toContain("Paracetamol 1g");
    /* لا يُقال إن المريض آمن */
    expect(res.textSummary).not.toMatch(/المريض\s+آمن|خالٍ من المخاطر/);
  });
});

describe("assessMedicationContext — نقص السياق (دالة نقية)", () => {
  it("بلا مريض: يُطلب العمر/الجنس/الحساسية/الحمل/الكلى/المميعات/الأدوية/التشخيص", () => {
    const assessment = assessMedicationContext({ condition: "خراج" }, null);
    const joined = assessment.missing.join(" | ");
    expect(joined).toContain("العمر");
    expect(joined).toContain("الحساسية");
    expect(joined).toContain("الحمل/الرضاعة");
    expect(joined).toContain("الكلى");
    expect(joined).toContain("مميعات");
    expect(joined).toContain("الأدوية الحالية");
  });

  it("أنثى في سن الإنجاب بلا حالة حمل موثقة → تنبيه نقص حالة الحمل", () => {
    const assessment = assessMedicationContext(
      { condition: "خراج سني" },
      { gender: "female", birthYear: CURRENT_YEAR - 28, medicalAlert: "حساسية بنسلين" },
    );
    expect(assessment.missing.some((m) => m.includes("الحمل/الرضاعة"))).toBe(true);
  });

  it("حالة الحمل مصرّح بها في الشرط → لا يُطلب سؤال الحمل مرة أخرى", () => {
    const assessment = assessMedicationContext(
      { condition: "خراج سني لمريضة حامل في الثلث الثاني" },
      { gender: "female", birthYear: CURRENT_YEAR - 28, medicalAlert: "حساسية بنسلين" },
    );
    expect(assessment.missing.some((m) => m.includes("الحمل/الرضاعة"))).toBe(false);
  });

  it("طفل بلا وزن مع دواء جرعته وزنية → طلب الوزن ولا جرعة وزنية", async () => {
    const assessment = assessMedicationContext(
      { condition: "خراج عند طفل", requestedDrugs: ["Amoxicillin suspension"] },
      { gender: "male", birthYear: CURRENT_YEAR - 6, medicalAlert: null },
    );
    expect(assessment.missing.some((m) => m.includes("الوزن"))).toBe(true);
    expect(assessment.notes.some((n) => n.includes("الجرعات الوزنية"))).toBe(true);
    /* وفي رد الأداة: لا جرعة وزنية تُصاغ */
    const res = await recommendPrescriptionAction(
      { patientName: "الطفل سالم", condition: "خراج", requestedDrugs: ["Amoxicillin suspension"] },
      DOCTOR_CTX,
    );
    expect(res.textSummary).not.toContain("mg/kg");
  });

  it("علامات عدوى في الوصف → اعتبار سريري يطلب الاستطباب والانتشار والمصدر — لا regimen", () => {
    const assessment = assessMedicationContext(
      { condition: "خراج منتشر مع حمى" },
      { gender: "male", birthYear: 1990, medicalAlert: "سكري" },
    );
    expect(assessment.notes.some((n) => n.includes("الاستطباب"))).toBe(true);
    expect(assessment.notes.some((n) => n.includes("source control") || n.includes("ضبط المصدر"))).toBe(true);
  });
});

describe("«لا تنبيه مسجل ≠ مريض سليم» — الملف الفارغ ليس إثبات سلامة", () => {
  it("ملف فارغ: لا يُقال «المريض سليم» أو «آمن» — بل طلب التحقق", async () => {
    const res = await recommendPrescriptionAction(
      { patientName: "سالم", requestedDrugs: ["Ibuprofen 400mg"] },
      DOCTOR_CTX,
    );
    expect(res.success).toBe(true);
    expect(res.textSummary).not.toMatch(/المريض\s*(سليم|آمن)/);
    expect(res.textSummary).not.toContain("لا يوجد أي خطر");
    /* بطاقة التنبيهات: نص التحقق لا نص الاطمئنان */
    const alertsCard = res.cards?.find((c) => c.title.includes("التنبيهات السريرية"));
    expect(alertsCard).toBeDefined();
    expect(alertsCard!.value).toContain("لا يعني خلو");
    expect(alertsCard!.value).not.toMatch(/سليم|آمن تمامًا/);
  });

  it("تنبيه مسجل: يظهر في الفحص كقيمة محذورة", async () => {
    const res = await recommendPrescriptionAction(
      { patientName: "سالم", condition: "حساسية بنسلين", requestedDrugs: ["Augmentin 1g"] },
      DOCTOR_CTX,
    );
    const alertsCard = res.cards?.find((c) => c.title.includes("التنبيهات السريرية"));
    expect(alertsCard!.value).toContain("حساسية");
    expect(res.cards?.some((c) => c.tone === "bad")).toBe(true);
  });
});

describe("الاعتماد يبقى بيد الطبيب — الوصفة الرسمية من مسارها", () => {
  it("الرد يحصر الاعتماد في نافذة الوصفة الرسمية (المادة 214) — لا اعتماد آليًّا", async () => {
    const res = await recommendPrescriptionAction(
      { patientName: "سالم", requestedDrugs: ["Amoxicillin 500mg"] },
      DOCTOR_CTX,
    );
    expect(res.textSummary).toContain("المادة 214");
    expect(res.textSummary).toContain("لا يعتمد");
  });

  it("لا حفظ ولا إرسال واتساب من المساعد — زر التنقل لفتح الملف لإصدار الوصفة", async () => {
    const res = await recommendPrescriptionAction(
      { patientName: "سالم", patientId: 42, requestedDrugs: ["Amoxicillin 500mg"] },
      { ...DOCTOR_CTX, isDbConnected: false },
    );
    /* لا فعل واتساب — فقط التنقل لإصدار الوصفة الرسمية */
    expect(res.actions?.every((a) => a.actionType === "navigate")).toBe(true);
    expect(res.actions?.some((a) => a.actionType === "whatsapp")).toBe(false);
    expect(res.actions?.[0]?.href).toBe("/patients/42");
  });
});
