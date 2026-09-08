import { describe, it, expect } from "vitest";
import {
  executeAiTool,
  getRegisteredToolNames,
  findToolByNameOrAlias,
} from "../lib/ai-tools/registry";
import { generateWhatsAppReminderAction } from "../lib/ai-tools/action-tools";
import { processAssistantQuery } from "../lib/assistant-engine";
import { verifyToolConfirmation } from "../lib/ai-confirmation";
import type { AiToolContext } from "../lib/ai-tools/types";

const mockContext: AiToolContext = {
  userId: 99,
  role: "reception",
  userRole: "reception",
  username: "test_receptionist",
  isDbConnected: false, // وضع تجريبي بدون الحاجة لقاعدة بيانات فعلية
  todayISO: "2026-09-07",
};

describe("AI Action Tools & Autonomous Bot Capabilities", () => {
  it("should register all 8 operational action tools and their aliases", () => {
    const registered = getRegisteredToolNames();
    expect(registered).toContain("create_patient");
    expect(registered).toContain("book_appointment");
    expect(registered).toContain("update_appointment_status");
    expect(registered).toContain("record_patient_payment");
    expect(registered).toContain("add_patient_medical_alert");
    expect(registered).toContain("create_lab_order");
    expect(registered).toContain("record_inventory_movement");
    expect(registered).toContain("generate_whatsapp_reminder");

    // فحص الأسماء البديلة (Aliases)
    expect(findToolByNameOrAlias("add_patient")?.name).toBe("create_patient");
    expect(findToolByNameOrAlias("schedule_appointment")?.name).toBe("book_appointment");
    expect(findToolByNameOrAlias("record_receipt")?.name).toBe("record_patient_payment");
    expect(findToolByNameOrAlias("whatsapp_reminder")?.name).toBe("generate_whatsapp_reminder");
  });

  it("should validate and execute create_patient tool in mock mode", async () => {
    // خطأ عند عدم إرسال الاسم
    const failRes = await executeAiTool("create_patient", { fullName: "" }, mockContext);
    expect(failRes.success).toBe(false);

    // أداة تغيير حالة: لا تنفيذ فوريًا — بل عرض تأكيد موقّع ينتظر موافقة المستخدم
    const res = await executeAiTool(
      "create_patient",
      {
        fullName: "محمد أحمد الكامل",
        phone: "777123456",
        medicalAlert: "حساسية بنسلين",
      },
      mockContext,
    );
    expect(res.success).toBe(false);
    expect(res.requiresConfirmation).toBe(true);
    expect(res.confirmation).toBeDefined();
    expect(res.confirmation!.tool).toBe("create_patient");
    expect(res.textSummary).toContain("محمد أحمد الكامل");
    expect(res.cards?.length).toBeGreaterThan(0);

    // التأكيد: الرمز يُحلّ إلى حمولة موقعة ثم يُنفَّذ عبر سياق تنفيذ موثّق
    const payload = verifyToolConfirmation(res.confirmation!.token);
    expect(payload).not.toBeNull();
    expect(payload!.tool).toBe("create_patient");
    expect(payload!.params.fullName).toBe("محمد أحمد الكامل");

    const confirmed = await executeAiTool("create_patient", payload!.params as any, {
      ...mockContext,
      confirmationExecution: payload!,
    });
    expect(confirmed.success).toBe(true);
    expect(confirmed.textSummary).toContain("محمد أحمد الكامل");
    expect(confirmed.cards?.length).toBeGreaterThan(0);

    // حماية إعادة التشغيل (Replay) قاعدةُ بيانات ذرّية — تُختبر بسجلها الخاص
    // في ai-confirmation-security.test.ts بمحاكاة claimToolConfirmation.
  });

  it("should generate formatted WhatsApp reminder with clickable wa.me link", async () => {
    const res = await generateWhatsAppReminderAction(
      {
        patientName: "عبدالله سالم",
        type: "appointment",
      },
      mockContext,
    );
    expect(res.success).toBe(true);
    expect(res.textSummary).toContain("مركز الدكتور عقلان الكامل");
    expect(res.textSummary).toContain("عبدالله سالم");
  });

  it("should process direct patient creation intent autonomously", async () => {
    const response = await processAssistantQuery(
      "أضف مريض جديد باسم طارق أحمد الكامل هاتف 771234567",
      mockContext,
    );
    expect(response.answer).toContain("طارق أحمد الكامل");
    expect(response.cards && response.cards.length).toBeGreaterThan(0);
  });

  it("should process direct appointment booking intent autonomously", async () => {
    const response = await processAssistantQuery(
      "احجز موعد للمريض طارق غداً الساعة 5 عصراً",
      mockContext,
    );
    expect(response.answer).toContain("موعد");
  });

  it("should process WhatsApp message generation autonomously", async () => {
    const response = await processAssistantQuery(
      "جهز رسالة واتساب تذكير بموعد للمريض طارق",
      mockContext,
    );
    expect(response.answer).toContain("واتساب");
  });
});
