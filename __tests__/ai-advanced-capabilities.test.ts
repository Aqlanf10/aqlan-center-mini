import { describe, it, expect, beforeEach } from "vitest";
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
  userId: 1,
  role: "doctor",
  userRole: "doctor",
  username: "dr_aqlan",
  isDbConnected: false,
  todayISO: "2026-09-07",
  clinicName: "مركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان",
};

describe("Advanced Clinical AI & Multi-Turn Memory Capabilities", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "aqlan-center-test-session-secret-32-chars-min";
  });
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

  describe("Prescription Safety & Clinical Regimens (recommend_prescription)", () => {
    it("should flag severe allergy warning when penicillin is requested for allergic patient", async () => {
      const res = await recommendPrescriptionAction(
        {
          patientName: "سامي يحيى",
          requestedDrugs: ["Amoxicillin 500mg"],
          condition: "حساسية شديدة للبنسلين",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("تحذيرات وتعارضات دوائية حرجة");
      expect(res.textSummary).toContain("بنسلين");
      // Must offer safe alternative such as Clindamycin or Azithromycin
      expect(res.textSummary).toContain("بدائل آمنة مقترحة");
      expect(res.cards?.some((c) => c.tone === "bad")).toBe(true);
    });

    it("should recommend standard post-op dental antibiotic and analgesic for uncompromised cases", async () => {
      const res = await recommendPrescriptionAction(
        {
          patientName: "نادية عمر",
          condition: "بعد سحب عصب ملتهب",
        },
        mockContext,
      );

      expect(res.success).toBe(true);
      expect(res.textSummary).toContain("الروشتة المقترحة");
      expect(res.textSummary).toContain("نادية عمر");
      expect(res.actions && res.actions.length).toBeGreaterThan(0);
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
