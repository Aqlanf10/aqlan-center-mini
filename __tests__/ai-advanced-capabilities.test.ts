import { describe, it, expect } from "vitest";
import {
  executeAiTool,
  getRegisteredToolNames,
  findToolByNameOrAlias,
} from "../lib/ai-tools/registry";
import {
  recommendPrescriptionAction,
  generatePostOpCareAction,
  getServicePricingAction,
} from "../lib/ai-tools/clinical-action-tools";
import { processAssistantQuery } from "../lib/assistant-engine";
import type { AiToolContext, AssistantMessage } from "../lib/ai-tools/types";

const mockContext: AiToolContext = {
  role: "doctor",
  userRole: "doctor",
  username: "dr_aqlan",
  /* طبيب مربوط بجهة (هوية سريرية) مع منح رسمي لأسعار الخدمات — كما يليق
     بطبيب مالك النظام: الأدوات السريرية الحساسة تشترط الهوية، والأسعار تشترط
     canViewServicePrices (مراجعة P0 — AI ⊆ API). */
  doctorPartyId: 1,
  permissions: { canViewServicePrices: true },
  isDbConnected: false,
  todayISO: "2026-09-07",
  clinicName: "مركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان",
};

describe("Advanced Clinical AI & Multi-Turn Memory Capabilities", () => {
  describe("Tool Registration & Aliases", () => {
    it("should register clinical prescription, post-op care, and pricing tools", () => {
      const registered = getRegisteredToolNames();
      expect(registered).toContain("recommend_prescription");
      expect(registered).toContain("generate_post_op_care");
      expect(registered).toContain("get_service_pricing");

      // Aliases
      expect(findToolByNameOrAlias("prescription_safety")?.name).toBe("recommend_prescription");
      expect(findToolByNameOrAlias("check_prescription")?.name).toBe("recommend_prescription");
      expect(findToolByNameOrAlias("post_op_care")?.name).toBe("generate_post_op_care");
      expect(findToolByNameOrAlias("dental_prices")?.name).toBe("get_service_pricing");
      expect(findToolByNameOrAlias("price_list")?.name).toBe("get_service_pricing");
    });
  });

  describe("Prescription Safety Assistant (recommend_prescription) — مراجعة P0", () => {
    it("flags severe allergy warning when penicillin is requested for allergic patient — with alternative *class* only", async () => {
      const res = await recommendPrescriptionAction(
        {
          patientName: "سامي يحيى",
          requestedDrugs: ["Amoxicillin 500mg"],
          condition: "حساسية شديدة للبنسلين",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      /* فحص السلامة يعمل على أدوية الطبيب نفسه */
      expect(res.textSummary).toContain("فحص السلامة الدوائية");
      expect(res.textSummary).toContain("بنسلين");
      expect(res.cards?.some((c) => c.tone === "bad")).toBe(true);
      /* صنف بديل بعد تقييم الطبيب — لا نظام بديل كامل بجرعات جاهزة */
      expect(res.textSummary).toContain("صنف دوائي بديل");
      expect(res.textSummary).not.toContain("Clindamycin 300mg");
      expect(res.textSummary).not.toContain("Paracetamol 1g");
      /* لا اعتماد: الوصفة الرسمية من ملف المريض */
      expect(res.textSummary).toContain("المادة 214");
    });

    it("endodontic pain with no drugs supplied: Missing Clinical Context — no auto regimen (stewardship)", async () => {
      const res = await recommendPrescriptionAction(
        {
          patientName: "نادية عمر",
          condition: "بعد سحب عصب ملتهب",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("بيانات سريرية ناقصة");
      expect(res.textSummary).toContain("Missing Clinical Context");
      /* لا أسماء أدوية ولا جرعات جاهزة */
      expect(res.textSummary).not.toContain("Ibuprofen");
      expect(res.textSummary).not.toContain("Paracetamol");
      expect(res.textSummary).not.toContain("Chlorhexidine");
      expect(res.textSummary).toContain("الأدوية التي تفكر فيها");
    });
  });

  describe("Post-Operative Instructions & WhatsApp Guidance (generate_post_op_care)", () => {
    it("should generate surgical extraction instructions with diet, hygiene, and emergency warnings", async () => {
      const res = await generatePostOpCareAction(
        {
          patientName: "فؤاد قاسم",
          procedureType: "خلع جراحي لضرس العقل المنطمر",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("خلع");
      expect(res.textSummary).toContain("أول 24 ساعة");
      expect(res.textSummary).toContain("النظام الغذائي");
      expect(res.textSummary).toContain("الممنوع");
      expect(res.textSummary).toContain("متى تتواصل فوراً مع المركز");
    });

    it("should detect implant template when procedure mentions dental implant", async () => {
      const res = await generatePostOpCareAction(
        {
          patientName: "أحمد الشميري",
          procedureType: "زراعة أسنان فورية",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("زراعة");
    });
  });

  describe("Dental Services Catalog & Multi-Currency Pricing (get_service_pricing)", () => {
    it("should find and display prices for orthodontic treatments", async () => {
      const res = await getServicePricingAction(
        {
          serviceQuery: "تقويم",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("تقويم");
      expect(res.table?.rows.length).toBeGreaterThan(0);
      // Check currency display
      expect(res.textSummary).toContain("ر.ي");
    });

    it("should find teeth whitening prices with USD and SAR estimates", async () => {
      const res = await getServicePricingAction(
        {
          serviceQuery: "تبييض",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("تبييض");
      expect(res.table).toBeDefined();
    });

    it("should return full catalog breakdown when queried generally", async () => {
      const res = await getServicePricingAction(
        {},
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.cards?.length).toBeGreaterThan(0);
      expect(res.table?.rows.length).toBeGreaterThan(5);
    });
  });

  describe("Multi-Turn Memory & Pronoun Resolution via assistant-engine", () => {
    it("should resolve implicit pronouns like 'له' to the recent patient in conversation history", async () => {
      const history: AssistantMessage[] = [
        {
          role: "user",
          content: "كم باقي على المريض كمال عبدالملك؟",
        },
        {
          role: "assistant",
          content: "المريض كمال عبدالملك لديه رصيد متبقي 15,000 ريال يمني.",
        },
      ];

      // Second turn with implicit pronoun "احجز له موعد غداً"
      const response = await processAssistantQuery(
        "احجز له موعد غداً الساعة 4 عصراً",
        mockContext,
        history,
      );

      expect(response.answer).toContain("موعد");
      expect(response.answer).toContain("كمال عبدالملك");
    });

    it("should resolve post-op care request for 'المريض' referencing history", async () => {
      const history: AssistantMessage[] = [
        {
          role: "user",
          content: "سوينا عملية خلع للمريض باسم منير الخليدي",
        },
        {
          role: "assistant",
          content: "تم تسجيل الإجراء للمريض منير الخليدي بنجاح.",
        },
      ];

      // Second turn: "اعطني تعليمات ما بعد الخلع له"
      const response = await processAssistantQuery(
        "اعطني تعليمات ما بعد الخلع له عشان نرسلها واتساب",
        mockContext,
        history,
      );

      expect(response.answer).toContain("خلع");
      expect(response.answer).toContain("منير الخليدي");
    });

    it("should answer colloquial pricing requests with table and action cards", async () => {
      const response = await processAssistantQuery(
        "كم اسعار زراعة الاسنان عندكم في المركز؟",
        mockContext,
      );

      expect(response.answer).toContain("زراعة");
      expect(response.answer).toContain("ر.ي");
    });
  });
});
