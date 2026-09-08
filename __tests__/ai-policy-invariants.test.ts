import { describe, expect, it } from "vitest";
import { AI_TOOL_DEFINITIONS, executeAiTool, getRegisteredToolNames } from "../lib/ai-tools/registry";
import {
  AI_TOOL_ALIAS_TO_CANONICAL,
  AI_TOOL_POLICIES,
  resolveToolPolicy,
  authorizeToolPolicy,
} from "../lib/ai-tools/policy";
import { verifyToolConfirmation, buildToolConfirmationPayload, signToolConfirmation } from "../lib/ai-confirmation";
import type { AiToolContext } from "../lib/ai-tools/types";

describe("ثوابت السياسة المركزية لأدوات الذكاء الاصطناعي (P0.1)", () => {
  it("كل أداة مسجلة في السجل لها سياسة مكتملة الحقول", () => {
    for (const name of Object.keys(AI_TOOL_DEFINITIONS)) {
      const policy = resolveToolPolicy(name);
      expect(policy, `الأداة «${name}» بلا سياسة`).not.toBeNull();
      expect(policy!.canonicalName.length).toBeGreaterThan(0);
      expect(Array.isArray(policy!.allowedRoles)).toBe(true);
      expect(policy!.allowedRoles.length).toBeGreaterThan(0);
      expect(["readOnly", "stateChanging", "clinicalDecisionSupport"]).toContain(policy!.access);
      expect(["none", "handle_patient_payment", "view_clinic_finance", "view_own_commission"]).toContain(policy!.financeScope);
      expect(["none", "view", "issue_out", "manage"]).toContain(policy!.inventoryScope);
      expect(["none", "view", "draft", "write"]).toContain(policy!.clinicalScope);
      expect(typeof policy!.patientScoped).toBe("boolean");
      expect(typeof policy!.requiresConfirmation).toBe("boolean");
    }
  });

  it("لا سياسة بلا تعريف: كل اسم كانوني في السياسة موجود في السجل", () => {
    for (const canonical of Object.keys(AI_TOOL_POLICIES)) {
      expect(AI_TOOL_DEFINITIONS[canonical], `سياسة «${canonical}» بلا تعريف`).toBeDefined();
    }
  });

  it("كل أداة تغيّر الحالة تتطلب تأكيدًا — لا استثناءات", () => {
    const stateChanging = Object.values(AI_TOOL_POLICIES).filter((p) => p.access === "stateChanging");
    expect(stateChanging.length).toBeGreaterThanOrEqual(7);
    for (const policy of stateChanging) {
      expect(policy.requiresConfirmation, `${policy.canonicalName} تغيّر حالة بلا تأكيد`).toBe(true);
    }
  });

  it("كل اسم بديل يرث سياسة الأداة الأساسية بالكامل — لا انحراف مرادف", () => {
    for (const [alias, canonical] of Object.entries(AI_TOOL_ALIAS_TO_CANONICAL)) {
      if (alias === canonical) continue;
      const aliasPolicy = resolveToolPolicy(alias);
      const canonicalPolicy = resolveToolPolicy(canonical);
      expect(aliasPolicy).toBe(canonicalPolicy); // نفس كائن السياسة: وراثة كاملة
      // والتعريف نفسه: المرادف والأصل نفس الأداة
      expect(AI_TOOL_DEFINITIONS[alias]).toBe(AI_TOOL_DEFINITIONS[canonical]);
    }
    /* عيّنة من المرادفات التاريخية لا تزال تحلّ لأصولها */
    expect(resolveToolPolicy("add_patient")!.canonicalName).toBe("create_patient");
    expect(resolveToolPolicy("record_receipt")!.canonicalName).toBe("record_patient_payment");
    expect(resolveToolPolicy("cancel_appointment")!.canonicalName).toBe("update_appointment_status");
    expect(resolveToolPolicy("suggest_drugs")!.canonicalName).toBe("recommend_prescription");
  });

  it("الأداة المجهولة مرفوضة — لا افتراض قراءة آمنة لمجهول", async () => {
    const context: AiToolContext = { role: "admin", userId: 1, username: "admin", isDbConnected: false };
    const res = await executeAiTool("run_arbitrary_sql", { query: "DROP TABLE patients" }, context);
    expect(res.success).toBe(false);
    expect(res.warnings?.[0]).toContain("رفض ضمني");
    expect(getRegisteredToolNames()).not.toContain("run_arbitrary_sql");
  });

  it("فصل المسك المالي عن رؤية مالية المركز في السياسات", () => {
    const payment = AI_TOOL_POLICIES.record_patient_payment;
    expect(payment.financeScope).toBe("handle_patient_payment");
    expect(payment.allowedRoles).not.toContain("doctor");
    const report = AI_TOOL_POLICIES.generate_internal_report;
    expect(report.financeScope).toBe("view_clinic_finance");
    expect(report.allowedRoles).not.toContain("reception");
    /* الاستقبال يمسك المال ولا يرى الربح؛ الطبيب لا هذا ولا ذاك بلا منح. */
    const receptionCtx: AiToolContext = { role: "reception", userId: 2, isDbConnected: false };
    const doctorCtx: AiToolContext = { role: "doctor", userId: 3, isDbConnected: false };
    expect(authorizeToolPolicy(payment, receptionCtx).allowed).toBe(true);
    expect(authorizeToolPolicy(report, receptionCtx).allowed).toBe(false);
    expect(authorizeToolPolicy(payment, doctorCtx).allowed).toBe(false);
    expect(authorizeToolPolicy(report, doctorCtx).allowed).toBe(false);
  });

  it("رمز التأكيد: التوقيع يقاوم التلاعب بالمعاملات والمستخدم والمريض", () => {
    const payload = buildToolConfirmationPayload({
      userId: 7, username: "dr.a", tool: "record_patient_payment",
      params: { patientId: 42, amount: "5000", currency: "YER" }, patientId: 42,
    });
    const token = signToolConfirmation(payload);
    expect(verifyToolConfirmation(token)).not.toBeNull();

    /* تلاعب بالحمولة: تعديل حرف واحد في الجسم يُبطل التوقيع */
    const [body, signature] = token.split(".");
    const tamperedBody = Buffer.from(
      JSON.stringify({ ...payload, params: { ...payload.params, amount: "900000" } }),
    ).toString("base64url");
    expect(verifyToolConfirmation(`${tamperedBody}.${signature}`)).toBeNull();

    /* تلاعب بالمستخدم */
    const tamperedUser = Buffer.from(
      JSON.stringify({ ...payload, userId: 99 }),
    ).toString("base64url");
    expect(verifyToolConfirmation(`${tamperedUser}.${signature}`)).toBeNull();

    /* تلاعب بالمريض */
    const tamperedPatient = Buffer.from(
      JSON.stringify({ ...payload, patientId: 43 }),
    ).toString("base64url");
    expect(verifyToolConfirmation(`${tamperedPatient}.${signature}`)).toBeNull();

    /* رمز منتهي العمر */
    const expired = buildToolConfirmationPayload({
      userId: 7, username: "dr.a", tool: "book_appointment", params: {},
      ttlMs: -1000,
    });
    expect(verifyToolConfirmation(signToolConfirmation(expired))).toBeNull();

    /* الرمز لا يُرسل في URL: مسار التأكيد POST فقط — يُفحص في اختبار المسار */
    expect(body.length).toBeGreaterThan(0);
    expect(signature.length).toBeGreaterThan(0);
  });

  it("أدوات المريض الموجهة كلها patientScoped وموارد BOLA معلّنة", () => {
    for (const name of [
      "get_patient_summary", "book_appointment", "update_appointment_status",
      "record_patient_payment", "add_patient_medical_alert", "create_lab_order",
      "generate_whatsapp_reminder", "recommend_prescription", "generate_post_op_care",
      "draft_consent_form", "draft_treatment_plan_form", "draft_lab_order_form",
      "draft_patient_intake_form", "draft_medical_report_form",
    ]) {
      expect(AI_TOOL_POLICIES[name]!.patientScoped, `${name} ليست patientScoped`).toBe(true);
    }
    expect(AI_TOOL_POLICIES.update_appointment_status.resourceKinds).toContain("appointment");
    expect(AI_TOOL_POLICIES.record_patient_payment.resourceKinds).toContain("invoice");
  });
});
