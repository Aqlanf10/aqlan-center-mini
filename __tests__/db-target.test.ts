import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyDbTarget, explicitDatabaseEnvironment } from "../lib/db-target";

/**
 * اختبارات تصنيف بيئة هدف قاعدة البيانات (P1-FIX-8) — القرار على الهدف لا على
 * جهاز التشغيل: production وunknown-remote ⇒ رفض بنيوي لأي كتابة (apply/restore)
 * مهما كانت بيئة الجهاز أو أعلام الأمر.
 */

const LOCAL = "postgresql://ci@127.0.0.1:5433/aqlan_test?sslmode=disable";
const REMOTE = "postgresql://u:pw@db.example.com:5432/aqlan_prod";

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.RAILWAY_PROJECT_ID;
  delete process.env.RAILWAY_SERVICE_ID;
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
});

describe("تصنيف بيئة الهدف", () => {
  it("DATABASE_ENVIRONMENT=production على هدف بعيد ⇒ production ورفض بنيوي للكتابة", () => {
    vi.stubEnv("DATABASE_ENVIRONMENT", "production");
    vi.stubEnv("NODE_ENV", "development"); // جهاز التطوير لا يفتح الإنتاج
    const target = classifyDbTarget(REMOTE);
    expect(target.environment).toBe("production");
    expect(target.explicit).toBe(true);
    expect(target.allowsMigrateApply).toBe(false);
    expect(target.allowsRestoreFull).toBe(false);
    expect(target.allowsReadOnlyStatus).toBe(true);
  });

  it("مضيف محلي مع DATABASE_ENVIRONMENT=production ⇒ التصنيف الصريح يُحترم (نفق محلي لإنتاج)", () => {
    vi.stubEnv("DATABASE_ENVIRONMENT", "production");
    const target = classifyDbTarget(LOCAL);
    expect(target.environment).toBe("production");
    expect(target.allowsMigrateApply).toBe(false);
  });

  it("DATABASE_ENVIRONMENT=staging على بعيد ⇒ مسموح وفق أعلام CLI المعتادة", () => {
    vi.stubEnv("DATABASE_ENVIRONMENT", "staging");
    const target = classifyDbTarget(REMOTE);
    expect(target.environment).toBe("staging");
    expect(target.allowsMigrateApply).toBe(true);
    expect(target.allowsRestoreFull).toBe(true);
  });

  it("DATABASE_ENVIRONMENT=test ⇒ مسموح (قاعدة اختبار معزولة)", () => {
    vi.stubEnv("DATABASE_ENVIRONMENT", "test");
    expect(classifyDbTarget(REMOTE).environment).toBe("test");
    expect(classifyDbTarget(REMOTE).allowsMigrateApply).toBe(true);
  });

  it("قيمة تصنيف غير صالحة ⇒ خطأ فوري (قيمة غلط ليست «غير مصنَّف»)", () => {
    vi.stubEnv("DATABASE_ENVIRONMENT", "prod-ish");
    expect(() => classifyDbTarget(REMOTE)).toThrow(/DATABASE_ENVIRONMENT/);
    expect(() => explicitDatabaseEnvironment({ DATABASE_ENVIRONMENT: "prod-ish" } as never)).toThrow();
  });

  it("بلا تصنيف + مضيف محلي ⇒ local/development مسموح", () => {
    delete process.env.DATABASE_ENVIRONMENT;
    const target = classifyDbTarget(LOCAL);
    expect(target.environment).toBe("local");
    expect(target.localHost).toBe(true);
    expect(target.allowsMigrateApply).toBe(true);
    expect(target.allowsRestoreFull).toBe(true);
  });

  it("بلا تصنيف + بعيد + بلا Railway ⇒ unknown-remote ورفض الكتابة حتى يُصنَّف", () => {
    delete process.env.DATABASE_ENVIRONMENT;
    vi.stubEnv("NODE_ENV", "development");
    const target = classifyDbTarget(REMOTE);
    expect(target.environment).toBe("unknown-remote");
    expect(target.allowsMigrateApply).toBe(false);
    expect(target.allowsRestoreFull).toBe(false);
    expect(target.allowsReadOnlyStatus).toBe(true);
    expect(target.reasons[0]).toMatch(/unknown-remote|يُصنَّف/);
  });

  it("بلا تصنيف + بعيد + العملية داخل Railway ⇒ production افتراضًا", () => {
    delete process.env.DATABASE_ENVIRONMENT;
    vi.stubEnv("RAILWAY_PROJECT_ID", "proj-1");
    const target = classifyDbTarget(REMOTE);
    expect(target.environment).toBe("production");
    expect(target.allowsMigrateApply).toBe(false);
  });

  it("توقيع RAILWAY_SERVICE_ID وحده يكفي لكشف بيئة Railway", () => {
    delete process.env.DATABASE_ENVIRONMENT;
    vi.stubEnv("RAILWAY_SERVICE_ID", "svc-1");
    expect(classifyDbTarget(REMOTE).environment).toBe("production");
  });

  it("القراءة الآمنة مسموحة لكل تصنيف — status/dry-run لا يكتبان", () => {
    for (const envValue of ["production", "staging", "test", "development"]) {
      vi.stubEnv("DATABASE_ENVIRONMENT", envValue);
      expect(classifyDbTarget(REMOTE).allowsReadOnlyStatus).toBe(true);
    }
  });

  it("هوية الهدف تُفكّ بلا كلمة سر للعرض", () => {
    vi.stubEnv("DATABASE_ENVIRONMENT", "production");
    const target = classifyDbTarget(REMOTE);
    expect(target.host).toBe("db.example.com");
    expect(target.port).toBe("5432");
    expect(target.database).toBe("aqlan_prod");
    expect(target.user).toBe("u");
    expect(String(JSON.stringify(target))).not.toContain("pw");
  });
});
