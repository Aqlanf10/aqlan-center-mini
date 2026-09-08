import { describe, it, expect } from "vitest";
import {
  executeAiTool,
  getRegisteredToolNames,
  findToolByNameOrAlias,
} from "../lib/ai-tools/registry";
import {
  draftConsentFormAction,
  draftTreatmentPlanFormAction,
  draftLabOrderFormAction,
  draftPatientIntakeFormAction,
  draftMedicalReportFormAction,
} from "../lib/ai-tools/form-drafting-tools";
import { processAssistantQuery } from "../lib/assistant-engine";
import type { AiToolContext, AssistantMessage } from "../lib/ai-tools/types";

const mockContext: AiToolContext = {
  role: "doctor",
  userRole: "doctor",
  username: "dr_aqlan",
  /* هوية سريرية صالحة: صياغة التقرير الطبي عبر السياسة تتطلب ربط جهة طبيب
     (مراجعة P0 — الأدوات السريرية الحساسة للطبيب المربوط). */
  doctorPartyId: 2,
  isDbConnected: false,
  todayISO: "2026-09-07",
  clinicName: "مركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان",
};

describe("Smart Form-Filling & Clinical Document Drafting Engine", () => {
  describe("1. Registry & Aliases", () => {
    it("should register all 5 form drafting tools and their Arabic/English aliases", () => {
      const registered = getRegisteredToolNames();
      expect(registered).toContain("draft_consent_form");
      expect(registered).toContain("draft_treatment_plan_form");
      expect(registered).toContain("draft_lab_order_form");
      expect(registered).toContain("draft_patient_intake_form");
      expect(registered).toContain("draft_medical_report_form");

      // Aliases
      expect(findToolByNameOrAlias("consent_form")?.name).toBe("draft_consent_form");
      expect(findToolByNameOrAlias("informed_consent")?.name).toBe("draft_consent_form");
      expect(findToolByNameOrAlias("treatment_plan_form")?.name).toBe("draft_treatment_plan_form");
      expect(findToolByNameOrAlias("lab_order_form")?.name).toBe("draft_lab_order_form");
      expect(findToolByNameOrAlias("intake_form")?.name).toBe("draft_patient_intake_form");
      expect(findToolByNameOrAlias("medical_report")?.name).toBe("draft_medical_report_form");
    });
  });

  describe("2. Informed Consent Drafting (draftConsentFormAction)", () => {
    it("should draft surgical extraction consent with patient details, tooth number, and print action", async () => {
      const res = await draftConsentFormAction(
        {
          patientName: "سامي يحيى",
          procedureType: "خلع جراحي لضرس العقل المنطمر",
          toothNumber: "48",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("سامي يحيى");
      expect(res.textSummary).toContain("خلع سن جراحي");
      expect(res.textSummary).toContain("48");
      expect(res.textSummary).toContain("المخاطر والمضاعفات المحتملة");
      expect(res.textSummary).toContain("توقيع المريض");
      expect(res.actions?.some((a) => a.actionType === "print")).toBe(true);
    });

    it("مراجعة الجولة الثانية — بلا تنبيه مسجل: صياغة «لا يوجد تنبيه مسجل — يجب التحقق» لا «لا موانع»", async () => {
      const res = await draftConsentFormAction(
        { patientName: "سامي يحيى", procedureType: "خلع جراحي", toothNumber: "48" },
        mockContext, /* isDbConnected=false ⇒ لا ملف ⇒ medicalAlert=null */
      );
      expect(res.textSummary).not.toContain("لا توجد موانع خاصة مسجلة");
      expect(res.textSummary).toContain("لا يوجد تنبيه أو مانع مسجل في الملف");
      expect(res.textSummary).toContain("يجب التحقق سريريًا");
    });

    it("مراجعة الجولة الثانية — لا ادّعاء معايير ADA بلا مصدر موثق", async () => {
      const res = await draftConsentFormAction(
        { patientName: "عادل الشميري", procedureType: "زراعة أسنان", toothNumber: "21" },
        mockContext,
      );
      expect(res.textSummary).not.toContain("ADA");
      expect(res.textSummary).not.toContain("الجمعية الأمريكية لطب الأسنان");
      /* بدلها صياغة صادقة: مسودة أولية للمراجعة والاعتماد النهائي بيد الطبيب. */
      expect(res.textSummary).toContain("مسودة أولية للمراجعة");
    });

    it("should draft dental implant consent when procedure mentions implant", async () => {
      const res = await draftConsentFormAction(
        {
          patientName: "عادل الشميري",
          procedureType: "زراعة أسنان فورية",
          toothNumber: "21",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("عادل الشميري");
      expect(res.textSummary).toContain("زراعة");
      expect(res.textSummary).toContain("الاندماج العظمي");
    });
  });

  describe("3. Treatment Plan & Installment Agreement Drafting (draftTreatmentPlanFormAction)", () => {
    it("should draft multi-phase plan and generate monthly installment breakdown", async () => {
      const res = await draftTreatmentPlanFormAction(
        {
          patientName: "منى خالد",
          planTitle: "خطة تقويم أسنان معدني فكين",
          totalCost: 400000,
          downPayment: 100000,
          installmentsCount: 4,
          currency: "YER",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("منى خالد");
      expect(res.textSummary).toContain("400,000");
      expect(res.textSummary).toContain("100,000");
      expect(res.textSummary).toContain("جدول الدفعات والأقساط الشهرية");
      expect(res.table?.rows.length).toBe(4);
      /* مراجعة الجولة الثانية — Blocker C: لا طباعة اتفاقية رسمية من مسودة
       * غير محفوظة؛ الرابط القديم فتح /print/plan/${patientId} وهو يتوقع
       * معرّف الخطة. البديل: زرّ فتح شاشة الإنشاء/المراجعة فقط. */
      expect(res.actions?.some((a) => a.actionType === "print")).toBe(false);
      expect(res.actions?.some((a) => a.actionType === "navigate" && a.href?.includes("/plans"))).toBe(true);
    });

    it("بلا مدخلات مالية: Missing Financial Inputs — لا 300000 مخترقة ولا دفعة 30%", async () => {
      const res = await draftTreatmentPlanFormAction(
        { patientName: "منى خالد", planTitle: "خطة تقويم" },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("Missing Financial Inputs");
      expect(res.textSummary).toContain("منى خالد");
      /* لا قيمة مخترقة: لا 300000 ولا 30% ولا جدول أقساط بأرقام لم يدخلها أحد. */
      expect(res.textSummary).not.toContain("300,000");
      expect(res.textSummary).not.toContain("300000");
      expect(res.textSummary).not.toContain("30%");
      expect(res.textSummary).not.toContain("جدول الدفعات والأقساط الشهرية");
      expect(res.table).toBeUndefined();
      expect(res.warnings?.length).toBeGreaterThan(0);
      /* ولا زرّ طباعة رسمية لمسودة بلا أرقام. */
      expect(res.actions?.some((a) => a.actionType === "print")).toBe(false);
    });

    it("مبلغ بلا دفعة مقدمة: لا يُخترع 30% — تُطلب الدفعة صراحة", async () => {
      const res = await draftTreatmentPlanFormAction(
        { patientName: "كمال عبدالملك", totalCost: 400000, installmentsCount: 4 },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("Missing Financial Inputs");
      expect(res.textSummary).toContain("الدفعة المقدّمة");
      /* 30% من 400000 = 120000 — لا تظهر قيمة مخترقة: */
      expect(res.textSummary).not.toContain("120,000");
      expect(res.textSummary).not.toContain("30%");
      expect(res.textSummary).not.toContain("جدول الدفعات والأقساط الشهرية");
    });

    it("الدفعة المقدمة = 0 صراحةً قيمةٌ صالحة (لا تُعدّ مفقودة)", async () => {
      const res = await draftTreatmentPlanFormAction(
        { patientName: "منى خالد", totalCost: 400000, downPayment: 0, installmentsCount: 4 },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("جدول الدفعات والأقساط الشهرية");
      expect(res.table?.rows.length).toBe(4);
    });

    it("لا إجراء طباعة رسمي في أي مسار — الرسمية للخطة المحفوظة بمعرّفها", async () => {
      const complete = await draftTreatmentPlanFormAction(
        { patientName: "منى خالد", totalCost: 400000, downPayment: 100000, installmentsCount: 4 },
        mockContext,
      );
      const missing = await draftTreatmentPlanFormAction(
        { patientName: "منى خالد" },
        mockContext,
      );
      for (const res of [complete, missing]) {
        expect(res.actions?.some((a) => a.actionType === "print")).toBe(false);
        /* ولا رابط print/plan بمعرّف مريض: */
        expect(res.actions?.some((a) => a.href?.includes("/print/plan"))).toBe(false);
        expect(res.actions?.some((a) => a.actionType === "navigate")).toBe(true);
      }
    });
  });

  describe("4. Lab Order Specification Drafting (draftLabOrderFormAction)", () => {
    it("should draft complete technical lab fabrication order sheet", async () => {
      const res = await draftLabOrderFormAction(
        {
          patientName: "بشير الأصبحي",
          toothCode: "16",
          restorationType: "تاج زركونيا كامل التشريح",
          shade: "A2",
          labName: "مختبر النخبة السني",
          targetDate: "2026-09-12",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("بشير الأصبحي");
      expect(res.textSummary).toContain("زركونيا");
      expect(res.textSummary).toContain("16");
      expect(res.textSummary).toContain("A2");
      expect(res.textSummary).toContain("مختبر النخبة السني");
      expect(res.table?.rows.length).toBeGreaterThan(3);
    });
  });

  describe("5. Patient Intake & Medical History Drafting (draftPatientIntakeFormAction)", () => {
    it("should extract medical alerts and categorize clinical risks in intake form", async () => {
      const res = await draftPatientIntakeFormAction(
        {
          fullName: "عمر سالم الكامل",
          phone: "777889900",
          gender: "male",
          birthYear: 1992,
          chiefComplaint: "ألم شديد ومفاجئ في الطواحن السفلية",
          medicalHistory: "حساسية بنسلين شديدة مع سكري من النوع الثاني",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("عمر سالم الكامل");
      expect(res.textSummary).toContain("777889900");
      expect(res.textSummary).toContain("حساسية بنسلين");
      expect(res.textSummary).toContain("داء السكري");
      expect(res.cards?.some((c) => c.tone === "bad")).toBe(true);
    });
  });

  describe("6. Medical Report & Certificate Drafting (draftMedicalReportFormAction)", () => {
    it("should draft official dental medical report certificate with sick leave", async () => {
      const res = await draftMedicalReportFormAction(
        {
          patientName: "ماجد توفيق",
          diagnosis: "خراج سني حاد بعد خلع جراحي",
          treatmentProvided: "تنظيف جراحي للسنخ وتصريف الخراج ووصف مضادات حيوية",
          sickLeaveDays: 3,
          addressedTo: "إدارة الموارد البشرية المحترمين",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("ماجد توفيق");
      expect(res.textSummary).toContain("إدارة الموارد البشرية");
      expect(res.textSummary).toContain("خراج سني حاد");
      expect(res.textSummary).toContain("3");
      expect(res.textSummary).toContain("تقرير طبي سني رسمي");
      expect(res.actions?.some((a) => a.actionType === "print")).toBe(true);
    });
  });

  describe("7. Natural Language & Multi-Turn Integration via assistant-engine", () => {
    it("should process natural consent form request directly", async () => {
      const response = await processAssistantQuery(
        "عبي استمارة إقرار خلع جراحي للسن 48 للمريض وليد قاسم",
        mockContext,
      );

      expect(response.answer).toContain("وليد قاسم");
      expect(response.answer).toContain("خلع");
      expect(response.toolsUsed).toContain("draft_consent_form");
    });

    it("should resolve implicit pronouns ('له') to previous patient when drafting treatment plan", async () => {
      const history: AssistantMessage[] = [
        {
          role: "user",
          content: "كم باقي على المريض كمال عبدالملك؟",
        },
        {
          role: "assistant",
          content: "المريض كمال عبدالملك لديه رصيد مسجل بالمركز.",
        },
      ];

      const response = await processAssistantQuery(
        "جهز له خطة علاج تقويم بمبلغ 400 الف على 4 أقساط",
        mockContext,
        history,
      );

      expect(response.answer).toContain("كمال عبدالملك");
      expect(response.answer).toContain("خطة");
      expect(response.toolsUsed).toContain("draft_treatment_plan_form");
    });

    it("should draft lab order with shade and tooth code from natural prompt", async () => {
      const response = await processAssistantQuery(
        "عبي أمر معمل تاج زيركون للسن 16 بلون A2 للمريض طارق الشرجبي",
        mockContext,
      );

      expect(response.answer).toContain("طارق الشرجبي");
      expect(response.answer).toContain("16");
      expect(response.answer).toContain("A2");
      expect(response.toolsUsed).toContain("draft_lab_order_form");
    });

    it("should draft official medical report addressed to work entity", async () => {
      const response = await processAssistantQuery(
        "اكتب تقرير طبي للمريض فؤاد سعيد لجهة العمل بإجازة 2 يوم",
        mockContext,
      );

      expect(response.answer).toContain("فؤاد سعيد");
      expect(response.answer).toContain("تقرير");
      expect(response.toolsUsed).toContain("draft_medical_report_form");
    });
  });
});
