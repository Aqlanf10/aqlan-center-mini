import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  allowedAiToolGroupsForUser,
  checkAiExternalBudget,
  recordAiUsageLedger,
} from "../lib/ai-budget-governance";
import { validateExternalGeminiPayload } from "../lib/aqlan-ai-local";
import { SETTING_DEFAULTS } from "../lib/settings";

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const { ensureSchema, getPool, resetPoolForTesting } = await import("../lib/db");

describe("Charter §21 & TD-12: Default-OFF External AI, Zero-PHI Boundary, Per-Staff Tool Groups, and 0142 Budget Cap", () => {
  beforeAll(async () => {
    await ensureSchema();
    const sql0142 = fs.readFileSync(
      path.join(process.cwd(), "migrations/proposals/0142_ai_governance_budget_and_ledger.sql"),
      "utf8",
    );
    await getPool().query(sql0142);
  }, 60_000);

  afterAll(async () => {
    await resetPoolForTesting();
  });

  it("defaults ai.external_assistant to false and contains zero unverified placeholder model IDs", () => {
    expect(SETTING_DEFAULTS["ai.external_assistant"]).toBe("false");
    const registrySource = fs.readFileSync(
      path.join(process.cwd(), "lib/ai-providers/registry.ts"),
      "utf8",
    );
    expect(registrySource).not.toContain("3.6-flash");
    expect(registrySource).not.toContain("projects/774730465825");
  });

  it("isolates AI tool groups strictly by staff role and explicit Deny > Allow permissions", () => {
    const receptionGroups = allowedAiToolGroupsForUser("reception", null);
    expect(receptionGroups.has("clinic_finance")).toBe(false);
    expect(receptionGroups.has("clinical_guidance")).toBe(false);
    expect(receptionGroups.has("own_commissions")).toBe(false);
    expect(receptionGroups.has("appointments_schedule")).toBe(true);

    const deniedDoctor = allowedAiToolGroupsForUser("doctor", {
      canUseAiAssistant: false,
      canViewOwnCommissions: true,
    });
    expect(deniedDoctor.size).toBe(0);
  });

  it("rejects any patient identifiers, images, or clinical workspace keys in external AI payloads (Structural Zero-PHI)", () => {
    expect(validateExternalGeminiPayload({ patientId: 7001, intent: "admin_template", query: "تلخيص إداري" }).ok).toBe(false);
    expect(validateExternalGeminiPayload({ intent: "admin_template", query: "ملف رقم P-07001 جوال 777123456" }).ok).toBe(false);
    expect(validateExternalGeminiPayload({ intent: "admin_template", query: "data:image/png;base64,iVBORw0KGgo=" }).ok).toBe(false);
    expect(validateExternalGeminiPayload({ intent: "admin_template", query: "صياغة رسالة ترحيب عامة بمواعيد الدوام في رمضان" }).ok).toBe(true);
  });

  it("enforces atomic 0142 daily/monthly external AI budget caps and append-only ledger immutability", async () => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO ai_budget_policies (scope, daily_limit_minor, monthly_limit_minor, currency, enabled)
       VALUES ('test-scope', 5, 20, 'USD', TRUE)
       ON CONFLICT (scope) DO UPDATE SET daily_limit_minor = 5, monthly_limit_minor = 20, enabled = TRUE`,
    );

    const before = await checkAiExternalBudget(pool, "test-scope", 3);
    expect(before.allowed).toBe(true);

    await recordAiUsageLedger(pool, {
      userId: 1,
      username: "admin",
      role: "admin",
      scope: "test-scope",
      providerId: "test-provider",
      model: "verified-model",
      estimatedCostMinor: 4,
      currency: "USD",
      localOnly: false,
    });

    // Next request costing 2 exceeds daily cap of 5 => blocked with AI_BUDGET_EXCEEDED!
    const exceeded = await checkAiExternalBudget(pool, "test-scope", 2);
    expect(exceeded.allowed).toBe(false);
    expect(exceeded.code).toBe("AI_BUDGET_EXCEEDED");

    // Append-only trigger rejects UPDATE and DELETE on ai_usage_ledger
    await expect(
      pool.query("DELETE FROM ai_usage_ledger WHERE scope = 'test-scope'"),
    ).rejects.toThrow(/append-only/);
  });
});
