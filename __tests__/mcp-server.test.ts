import { describe, expect, it } from "vitest";
import { AI_TOOL_DEFINITIONS, executeAiTool } from "../lib/ai-tools/registry";
import type { AiToolContext } from "../lib/ai-tools/types";

describe("خادم بروتوكول سياق النموذج (Aqlan MCP Server)", () => {
  const testContext: AiToolContext = {
    userId: 1,
    username: "admin",
    role: "admin",
    doctorPartyId: null,
    canViewAllPatients: true,
    canViewClinicFinance: true,
    canViewOwnCommissions: true,
    canManageInventory: true,
    todayISO: "2026-09-07",
    isDbConnected: false,
  };

  it("يحتوي على كافة تعريفات أدوات MCP القياسية", () => {
    const tools = Object.values(AI_TOOL_DEFINITIONS);
    expect(tools.length).toBeGreaterThanOrEqual(10);
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_patient");
    expect(names).toContain("get_patient_summary");
    expect(names).toContain("get_today_collections");
    expect(names).toContain("generate_internal_report");
    expect(names).toContain("get_patient_receivables");
    expect(names).toContain("get_today_appointments");
    expect(names).toContain("get_inventory_summary");
    expect(names).toContain("get_lab_cases");
    expect(names).toContain("get_doctors");
    expect(names).toContain("get_service_prices");
    expect(names).toContain("get_system_guide");
  });

  it("ينفذ أداة دليل النظام get_system_guide عبر سياق MCP بنجاح", async () => {
    const res = await executeAiTool("get_system_guide", { query: "كيف أضيف مريض؟" }, testContext);
    expect(res.success).toBe(true);
    expect(res.textSummary).toContain("المرضى");
    expect(res.actions).toBeDefined();
    expect(res.actions?.length).toBeGreaterThan(0);
  });

  it("ينفذ أداة التحصيل اليومي get_today_collections بأمان في وضع عدم الاتصال", async () => {
    const res = await executeAiTool("get_today_collections", {}, testContext);
    expect(res.success).toBe(true);
    expect(res.textSummary).toContain("تقرير");
    expect(res.cards).toBeDefined();
  });

  it("يحظر تنفيذ الأدوات المالية لمن لا يملك الصلاحية عبر MCP", async () => {
    const restrictedContext: AiToolContext = {
      ...testContext,
      role: "reception",
      canViewClinicFinance: false,
    };

    const res = await executeAiTool("generate_internal_report", { reportType: "monthly", preset: "this_month" }, restrictedContext);
    expect(res.success).toBe(false);
    expect(res.textSummary).toContain("تنبيه أمني");
  });
});
