import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ORTHO_BASELINE_SQL } from "../lib/ortho-baseline-schema";
import {
  LEGACY_FINANCIAL_HINT, LEGACY_FINANCIAL_LABEL, LEGACY_FINANCIAL_MODES,
  checkBaselineDraft, checkOrthoSessionDraft, isLegacyFinancialMode, monthsBefore, monthsBetween,
} from "../lib/ortho-baseline";
import { UNIFIED_REPORT_IDS, canAccessUnifiedReport, reportIsAdminOnly } from "../lib/report-access";
import { AUDIT_LABEL } from "../lib/audit";

const TODAY = "2026-09-30";
const valid = { phase: "working", financialMode: "opening_balance", monthsElapsed: 8, monthsRemaining: 10 };

describe("(CASE-1) ortho baseline schema 0034", () => {
  it("keeps migration 0034 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0034_ortho_legacy_baseline.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(ORTHO_BASELINE_SQL.trim());
  });

  it("is additive only: nullable columns, no DROP/UPDATE/DELETE, and no unique index on adjustments", () => {
    expect(ORTHO_BASELINE_SQL).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i);
    expect(ORTHO_BASELINE_SQL).not.toMatch(/^\s*(DELETE|UPDATE)\s/im);
    expect(ORTHO_BASELINE_SQL).not.toMatch(/UNIQUE/i);
    const columns = ORTHO_BASELINE_SQL.split(";").filter((part) => /ADD COLUMN IF NOT EXISTS/.test(part));
    expect(columns).toHaveLength(6);
    for (const column of columns) expect(column).not.toMatch(/NOT NULL|DEFAULT/);
    for (const mode of LEGACY_FINANCIAL_MODES) expect(ORTHO_BASELINE_SQL).toContain(`'${mode}'`);
    expect(ORTHO_BASELINE_SQL).toMatch(/responsible_doctor_id INTEGER REFERENCES parties\(id\)/);
  });
});

describe("(CASE-1) baseline draft rules", () => {
  it("derives the start date from months elapsed, and the plan length from elapsed + remaining", () => {
    const result = checkBaselineDraft(valid, TODAY);
    expect(result).toEqual({ ok: true, value: expect.objectContaining({
      startDate: "2026-01-30", monthsElapsed: 8, monthsRemaining: 10, plannedMonths: 18,
      phase: "working", financialMode: "opening_balance", appliance: "fixed_metal", slot: "022",
    }) });
  });

  it("an explicit start date wins over months elapsed", () => {
    const result = checkBaselineDraft({ ...valid, startDate: "2025-09-30", monthsElapsed: 2 }, TODAY);
    expect(result.ok && result.value).toMatchObject({ startDate: "2025-09-30", monthsElapsed: 12, plannedMonths: 22 });
  });

  it("refuses with Arabic messages: no phase, no money mode, future start, bad months", () => {
    const message = (body: Record<string, unknown>) => {
      const result = checkBaselineDraft(body, TODAY);
      return result.ok ? null : result.message;
    };
    expect(message({ ...valid, phase: "magic" })).toBe("اختر المرحلة الحالية للعلاج.");
    expect(message({ ...valid, financialMode: "free" })).toBe("اختر كيف عومل المال قبل النظام.");
    expect(message({ ...valid, startDate: "2026-10-05" })).toContain("المستقبل");
    expect(message({ ...valid, startDate: "2026-02-30" })).toBe("تاريخ بدء العلاج غير صالح.");
    expect(message({ ...valid, monthsElapsed: 2.5 })).toContain("منذ كم شهرًا");
    expect(message({ ...valid, monthsRemaining: -1 })).toContain("الأشهر المتبقية");
    expect(message({ ...valid, responsibleDoctorId: "x" })).toBe("الطبيب المسؤول غير صالح.");
  });

  it("zero elapsed and zero remaining still yields a one-month plan; texts are trimmed and bounded", () => {
    const result = checkBaselineDraft({ ...valid, monthsElapsed: 0, monthsRemaining: 0, upperWire: "  019×025 SS  ", remainingObjectives: "x".repeat(2000) }, TODAY);
    expect(result.ok && result.value.plannedMonths).toBe(1);
    expect(result.ok && result.value.upperWire).toBe("019×025 SS");
    expect(result.ok && result.value.remainingObjectives?.length).toBe(1000);
  });

  it("month arithmetic clamps to the month's end and crosses years", () => {
    expect(monthsBefore("2026-05-31", 3)).toBe("2026-02-28");
    expect(monthsBefore("2026-01-15", 13)).toBe("2024-12-15");
    expect(monthsBetween("2025-09-30", TODAY)).toBe(12);
  });

  it("every financial mode has an Arabic label and a hint pointing at the existing money path", () => {
    for (const mode of LEGACY_FINANCIAL_MODES) {
      expect(isLegacyFinancialMode(mode)).toBe(true);
      expect(LEGACY_FINANCIAL_LABEL[mode]).toMatch(/[؀-ۿ]/);
      expect(LEGACY_FINANCIAL_HINT[mode]).toMatch(/[؀-ۿ]/);
    }
    expect(LEGACY_FINANCIAL_HINT.opening_balance).toContain("الرصيد الافتتاحي");
  });
});

describe("(CASE-1) orthodontic session sent with the sign", () => {
  it("absent is fine (a visit without an adjustment)", () => {
    expect(checkOrthoSessionDraft(undefined)).toEqual({ ok: true, value: null });
    expect(checkOrthoSessionDraft(null)).toEqual({ ok: true, value: null });
  });

  it("present must name the case and a sane interval", () => {
    expect(checkOrthoSessionDraft({ nextWeeks: 4 })).toEqual({ ok: false, message: "حالة التقويم غير محددة." });
    expect(checkOrthoSessionDraft({ caseId: 3, nextWeeks: 60 }).ok).toBe(false);
    expect(checkOrthoSessionDraft("x").ok).toBe(false);
    expect(checkOrthoSessionDraft({ caseId: 3, elastics: "weird", upperWire: " 016 NiTi " })).toEqual({
      ok: true,
      value: expect.objectContaining({ caseId: 3, elastics: "none", upperWire: "016 NiTi", nextWeeks: 4, phase: null }),
    });
  });
});

describe("(CASE-1) duplicate-adjustment report registration", () => {
  it("is a known report, admin-only (clinical), hidden from reception/accountant/doctor", () => {
    expect(UNIFIED_REPORT_IDS).toContain("ortho-duplicate-adjustments");
    expect(reportIsAdminOnly("ortho-duplicate-adjustments")).toBe(true);
    expect(canAccessUnifiedReport("admin", "ortho-duplicate-adjustments")).toBe(true);
    for (const role of ["reception", "accountant", "doctor", "cashier"]) {
      expect(canAccessUnifiedReport(role, "ortho-duplicate-adjustments")).toBe(false);
    }
    expect(readFileSync("app/reports/page.tsx", "utf8")).toContain('id: "ortho-duplicate-adjustments"');
  });

  it("new audit actions carry Arabic labels", () => {
    expect(AUDIT_LABEL["ortho.baseline"]).toMatch(/[؀-ۿ]/);
    expect(AUDIT_LABEL["ortho.adjustment"]).toMatch(/[؀-ۿ]/);
  });
});
