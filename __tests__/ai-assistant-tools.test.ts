import { describe, it, expect } from "vitest";
import { executeAiTool, aiToolRegistry } from "../lib/ai-tools/registry";
import { AiToolContext } from "../lib/ai-tools/types";
import { systemFeatureRegistry, SystemFeature } from "../lib/ai-tools/system-feature-registry";

describe("Aqlan AI Assistant - Tool Registry & Execution", () => {
  const adminContext: AiToolContext = {
    role: "admin",
    userRole: "admin",
    userId: 1,
    userName: "د. عقلان الكامل",
    canViewClinicFinance: true,
    isDbConnected: false,
    clinicName: "مركز عقلان",
  };

  const doctorContext: AiToolContext = {
    role: "doctor",
    userRole: "doctor",
    userId: 2,
    doctorPartyId: 2,
    userName: "د. أحمد",
    canViewClinicFinance: false,
    isDbConnected: false,
    clinicName: "مركز عقلان",
  };

  const receptionContext: AiToolContext = {
    role: "reception",
    userRole: "reception",
    userId: 3,
    userName: "موظف الاستقبال",
    canViewClinicFinance: false,
    isDbConnected: false,
    clinicName: "مركز عقلان",
  };

  it("contains all required clinic tools in registry", () => {
    const requiredTools = [
      "generate_internal_report",
      "get_today_collections",
      "get_patient_receivables",
      "get_debt_aging",
      "get_doctor_commission",
      "search_patient",
      "get_patient_summary",
      "get_today_appointments",
      "get_ortho_followups_due",
      "get_cephalometric_summary",
      "get_inventory_summary",
      "get_lab_cases",
      "get_doctors",
      "get_services",
      "get_clinic_statistics",
      "get_system_feature_guide",
    ];

    for (const tool of requiredTools) {
      expect(aiToolRegistry[tool], `Missing required tool: ${tool}`).toBeDefined();
    }
  });

  describe("Permission & Role Guards in Tool Registry", () => {
    it("blocks reception from executing financial report tools", async () => {
      const res = await executeAiTool("generate_internal_report", { reportType: "revenue" }, receptionContext);
      expect(res.success).toBe(false);
      expect(res.message).toContain("غير مصرح");
      expect(res.warnings).toBeDefined();
    });

    it("blocks doctor from executing clinic-wide collections report", async () => {
      const res = await executeAiTool("get_today_collections", {}, doctorContext);
      expect(res.success).toBe(false);
      expect(res.message).toContain("غير مصرح");
    });

    it("allows admin to execute financial tools", async () => {
      const res = await executeAiTool("get_today_collections", {}, adminContext);
      expect(res.success).toBe(true);
      expect(res.data).toBeDefined();
    });

    it("allows doctor to view their own commission report", async () => {
      const res = await executeAiTool("get_doctor_commission", { doctorId: 2 }, doctorContext);
      expect(res.success).toBe(true);
    });

    it("blocks doctor from viewing another doctor's commission", async () => {
      const res = await executeAiTool("get_doctor_commission", { doctorId: 99 }, doctorContext);
      expect(res.success).toBe(false);
      expect(res.message).toContain("غير مصرح");
    });
  });

  describe("Offline & CI Safety (Graceful fallback when DB is disconnected)", () => {
    it("returns friendly offline notice for patient search without throwing unhandled exceptions", async () => {
      const res = await executeAiTool("search_patient", { term: "محمد" }, adminContext);
      expect(res.success).toBe(true);
      expect(res.message).toContain("غير متصلة");
      expect(res.warnings?.length).toBeGreaterThan(0);
    });

    it("returns friendly offline notice for appointments", async () => {
      const res = await executeAiTool("get_today_appointments", {}, adminContext);
      expect(res.success).toBe(true);
      expect(res.message).toContain("غير متصلة");
    });

    it("returns friendly offline notice for inventory", async () => {
      const res = await executeAiTool("get_inventory_summary", {}, adminContext);
      expect(res.success).toBe(true);
      expect(res.message).toContain("غير متصلة");
    });

    it("returns friendly offline notice for lab cases", async () => {
      const res = await executeAiTool("get_lab_cases", {}, adminContext);
      expect(res.success).toBe(true);
      expect(res.message).toContain("غير متصلة");
    });
  });

  describe("System Feature Registry (How-to guides)", () => {
    it("has comprehensive entries for key clinic modules", () => {
      expect(systemFeatureRegistry.length).toBeGreaterThanOrEqual(10);

      const modules = systemFeatureRegistry.map((f: SystemFeature) => f.id);
      expect(modules).toContain("patients");
      expect(modules).toContain("billing_invoices");
      expect(modules).toContain("appointments");
      expect(modules).toContain("treatment_plans");
      expect(modules).toContain("tooth_chart");
      expect(modules).toContain("ortho_ceph");
      expect(modules).toContain("inventory");
      expect(modules).toContain("lab");
      expect(modules).toContain("reports");
      expect(modules).toContain("doctor_permissions");
      expect(modules).toContain("backup");
    });

    it("returns specific how-to instructions for adding a patient", async () => {
      const res = await executeAiTool("get_system_feature_guide", { query: "إضافة مريض" }, adminContext);
      expect(res.success).toBe(true);
      expect(res.message).toContain("المرضى");
      expect(res.data.steps).toBeDefined();
      expect(res.data.path).toBe("/patients");
    });

    it("returns how-to instructions for creating an invoice", async () => {
      const res = await executeAiTool("get_system_feature_guide", { query: "فاتورة" }, adminContext);
      expect(res.success).toBe(true);
      expect(res.message).toContain("الفواتير");
      expect(res.data.steps.length).toBeGreaterThan(0);
    });

    it("returns how-to instructions for cephalometric analysis", async () => {
      const res = await executeAiTool("get_system_feature_guide", { query: "سيفالومتري" }, adminContext);
      expect(res.success).toBe(true);
      expect(res.message).toContain("التقويم");
      expect(res.data.path).toBe("/orthodontics");
    });
  });
});
