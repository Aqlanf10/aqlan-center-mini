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
      expect(res.actions?.some((a) => a.actionType === "print")).toBe(true);
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
