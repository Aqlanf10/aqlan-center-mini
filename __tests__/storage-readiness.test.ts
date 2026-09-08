import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateStorageDurability, isProductionRuntime } from "../lib/storage-readiness";

/**
 * اختبارات قرار جاهزية التخزين الدائم (P1.17) — قرار نقّي قابل للفحص بلا قرص.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("جاهزية التخزين الدائم", () => {
  it("بيئة تطوير بلا DOCUMENTS_DIR ⇒ unconfigured بتحذير لا حرج", () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.DOCUMENTS_DIR;
    const decision = evaluateStorageDurability();
    expect(decision.level).toBe("unconfigured");
    expect(decision.production).toBe(false);
    expect(decision.reasons[0]).toMatch(/تطوير/);
  });

  it("إنتاج (NODE_ENV) بلا DOCUMENTS_DIR ⇒ unconfigured برسالة حرج صريحة", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.DOCUMENTS_DIR;
    const decision = evaluateStorageDurability();
    expect(decision.level).toBe("unconfigured");
    expect(decision.production).toBe(true);
    expect(decision.durable).toBe(false);
    expect(decision.reasons[0]).toMatch(/حرج/);
  });

  it("إنتاج (Railway) بلا DOCUMENTS_DIR ⇒ نفس الحرج — داخل Railway يُكتشف بالمشروع", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RAILWAY_PROJECT_ID", "7f3b5a7b");
    delete process.env.DOCUMENTS_DIR;
    expect(evaluateStorageDurability().production).toBe(true);
    expect(evaluateStorageDurability().level).toBe("unconfigured");
  });

  it("إنتاج مع مسار دائم مطلق ⇒ ready", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DOCUMENTS_DIR", "/data/documents");
    const decision = evaluateStorageDurability();
    expect(decision.level).toBe("ready");
    expect(decision.durable).toBe(true);
  });

  it("مسار إلى tmpdir في الإنتاج ⇒ ephemeral مرفوض صراحة (لا سقوط صامت)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DOCUMENTS_DIR", "/tmp/documents");
    const decision = evaluateStorageDurability();
    expect(decision.level).toBe("ephemeral");
    expect(decision.durable).toBe(false);
    expect(decision.reasons[0]).toMatch(/مؤقّت|نسبي/);
  });

  it("مسار نسبي (يحل داخل الحاوية) في الإنتاج ⇒ ephemeral مرفوض", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DOCUMENTS_DIR", "documents");
    const decision = evaluateStorageDurability();
    expect(decision.level).toBe("ephemeral");
    expect(decision.durable).toBe(false);
  });

  it("مسار نسبي في التطوير ⇒ ephemeral أيضًا (قرار واحد لا يتلوّن بالبيئة)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCUMENTS_DIR", "docs-local");
    expect(evaluateStorageDurability().level).toBe("ephemeral");
  });

  it("كشف بيئة الإنتاج الصحيح", () => {
    vi.stubEnv("NODE_ENV", "test");
    process.env.RAILWAY_PROJECT_ID = "";
    expect(isProductionRuntime()).toBe(false);
    vi.stubEnv("RAILWAY_PROJECT_ID", "x");
    expect(isProductionRuntime()).toBe(true);
    delete process.env.RAILWAY_PROJECT_ID;
    vi.stubEnv("NODE_ENV", "production");
    expect(isProductionRuntime()).toBe(true);
  });
});
