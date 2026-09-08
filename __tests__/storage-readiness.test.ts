import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateStorageDurability, isProductionRuntime, readProcMounts,
} from "../lib/storage-readiness";

/**
 * اختبارات قرار جاهزية التخزين الدائم (P1.17 + P1-FIX-7) — قرار نقّي قابل
 * للفحص بلا قرص: مصدر /proc/mounts قابل للحقن، والجذر الموثَّق إما صريح
 * (DURABLE_STORAGE_ROOT) أو قرص مثبت فعليًّا.
 */

const RAILWAY_MOUNTS = [
  "overlay / overlay rw,relatime 0 0",
  "tmpfs /etc/resolv.conf tmpfs ro 0 0",
  "/dev/vdb /data ext4 rw,relatime 0 0",
  "proc /proc proc rw 0 0",
].join("\n");

const RAILWAY_MOUNTS_TMPFS_DATA = [
  "overlay / overlay rw,relatime 0 0",
  "tmpfs /data tmpfs rw 0 0",
].join("\n");

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.DURABLE_STORAGE_ROOT;
  delete process.env.RAILWAY_PROJECT_ID;
  delete process.env.RAILWAY_SERVICE_ID;
  delete process.env.RAILWAY_ENVIRONMENT_NAME;
  delete process.env.DOCUMENTS_DIR;
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

  it("مسار إلى tmpdir في الإنتاج ⇒ ephemeral مرفوض صراحة (لا سقوط صامت)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DOCUMENTS_DIR", "/tmp/documents");
    const decision = evaluateStorageDurability();
    expect(decision.level).toBe("ephemeral");
    expect(decision.durable).toBe(false);
    expect(decision.reasons[0]).toMatch(/مؤقّت|نسبي/);
  });

  it("مسار نسبي في الإنتاج ⇒ ephemeral مرفوض", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DOCUMENTS_DIR", "documents");
    const decision = evaluateStorageDurability();
    expect(decision.level).toBe("ephemeral");
    expect(decision.durable).toBe(false);
  });

  it("إنتاج بجذر صريح DURABLE_STORAGE_ROOT والمسار داخله ⇒ ready بجذر موثَّق", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DURABLE_STORAGE_ROOT", "/data");
    vi.stubEnv("DOCUMENTS_DIR", "/data/documents");
    const decision = evaluateStorageDurability();
    expect(decision.level).toBe("ready");
    expect(decision.durable).toBe(true);
    expect(decision.verifiedRoot).toBe("/data");
  });

  it("جذر صريح لكن المسار خارجه ⇒ غير دائم (احتواء حقيقي لا startsWith)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DURABLE_STORAGE_ROOT", "/data");
    vi.stubEnv("DOCUMENTS_DIR", "/data-evil/documents");
    expect(evaluateStorageDurability().durable).toBe(false);
    // وعبور النقاط للخروج من الجذر مرفوض أيضًا
    vi.stubEnv("DOCUMENTS_DIR", "/data/../etc/documents");
    expect(evaluateStorageDurability().durable).toBe(false);
    expect(evaluateStorageDurability().level).toBe("ephemeral");
  });

  it("إنتاج على Railway: قرص ext4 مثبت على /data يحتوي المسار ⇒ ready بجذر التركيب", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAILWAY_PROJECT_ID", "7f3b5a7b");
    vi.stubEnv("DOCUMENTS_DIR", "/data/documents");
    const decision = evaluateStorageDurability({ mountsSource: RAILWAY_MOUNTS });
    expect(decision.level).toBe("ready");
    expect(decision.durable).toBe(true);
    expect(decision.verifiedRoot).toBe("/data");
  });

  it("إنتاج على Railway: /app/data/documents بلا قرص مثبت ⇒ NOT durable (P1-FIX-7 الحالة المركزية)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAILWAY_PROJECT_ID", "7f3b5a7b");
    vi.stubEnv("DOCUMENTS_DIR", "/app/data/documents");
    const decision = evaluateStorageDurability({ mountsSource: RAILWAY_MOUNTS });
    expect(decision.level).toBe("ephemeral");
    expect(decision.durable).toBe(false);
    expect(decision.reasons[0]).toMatch(/لا دليل على دوامه|DURABLE_STORAGE_ROOT/);
  });

  it("المسار خارج القرص المثبت (قرص /data والمسار /srv/documents) ⇒ غير دائم", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAILWAY_PROJECT_ID", "7f3b5a7b");
    vi.stubEnv("DOCUMENTS_DIR", "/srv/documents");
    const decision = evaluateStorageDurability({ mountsSource: RAILWAY_MOUNTS });
    expect(decision.durable).toBe(false);
  });

  it("القرص «المثبت» tmpfs ليس دائمًا — نوع نظام الملفات يُفحص لا مجرد وجود السطر", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAILWAY_PROJECT_ID", "7f3b5a7b");
    vi.stubEnv("DOCUMENTS_DIR", "/data/documents");
    const decision = evaluateStorageDurability({ mountsSource: RAILWAY_MOUNTS_TMPFS_DATA });
    expect(decision.durable).toBe(false);
    expect(decision.level).toBe("ephemeral");
  });

  it("إنتاج محلي (بلا Railway) بلا DURABLE_STORAGE_ROOT ⇒ غير دائم — الجذر الصريح هو الطريق", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.RAILWAY_PROJECT_ID;
    vi.stubEnv("DOCUMENTS_DIR", "/home/clinic/documents");
    const decision = evaluateStorageDurability({ mountsSource: RAILWAY_MOUNTS });
    expect(decision.durable).toBe(false);
    expect(decision.reasons[0]).toMatch(/DURABLE_STORAGE_ROOT/);
  });

  it("تطوير: مسار مطلق خارج المناطق المؤقّتة يبقى ready كما كان (بلا إلزام جذر)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCUMENTS_DIR", "/home/user/documents");
    const decision = evaluateStorageDurability();
    expect(decision.level).toBe("ready");
    expect(decision.durable).toBe(true);
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

  it("قراءة /proc/mounts: تفكيك الأسطر والهروب الثماني لمسارات فيها مسافة", () => {
    const mounts = readProcMounts(
      "/dev/vdb /vol\\040ume ext4 rw 0 0\noverlay / overlay rw 0 0\n",
    );
    expect(mounts).toHaveLength(2);
    expect(mounts[0].mountPoint).toBe("/vol ume");
    expect(mounts[0].fsType).toBe("ext4");
    expect(mounts[1].fsType).toBe("overlay");
    expect(readProcMounts("")).toEqual([]);
  });
});
