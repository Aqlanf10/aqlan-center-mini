import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decideTls, parseDatabaseHost, sslModeFromUrl } from "../lib/db-tls";

/**
 * اختبارات قرار TLS لاتصال PostgreSQL (P1.19).
 *
 * الهدف: التشفير والتحقق قرارٌ صريح مفهوم لا افتراض صامت — وكل حالة موثَّقة:
 * disable/محلي بلا TLS، CA مضبوط = تحقق كامل، بعيد بلا CA = تشفير مع تحذير،
 * وverify-full بلا CA = رفض فوري (لا يُخدَع الطلب الصريح).
 */

const LOCAL = "postgresql://ci@127.0.0.1:5433/aqlan_test?sslmode=disable";
const REMOTE = "postgresql://u:pw@db.example.com:5432/aqlan_prod";
const REMOTE_DISABLE = "postgresql://u:pw@db.example.com:5432/aqlan?sslmode=disable";

afterEach(() => {
  delete process.env.PGSSL_ROOT_CERT;
  vi.unstubAllEnvs();
});

describe("قرار TLS لاتصال PostgreSQL", () => {
  it("sslmode=disable ⇒ بلا تشفير مع مضيف بعيد خارج سياق الإنتاج، مع تحذير (P1-FIX-9)", () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.DATABASE_ENVIRONMENT;
    delete process.env.RAILWAY_PROJECT_ID;
    const decision = decideTls(REMOTE_DISABLE);
    expect(decision.mode).toBe("disabled");
    expect(decision.ssl).toBe(false);
    expect(decision.warning).toMatch(/غير مشفّرة/);
  });

  it("sslmode=disable على مضيف بعيد في سياق إنتاج ⇒ رفض فوري بنيوي (P1-FIX-9)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => decideTls(REMOTE_DISABLE)).toThrow(/سياسة TLS/);
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_ENVIRONMENT", "production");
    expect(() => decideTls(REMOTE_DISABLE)).toThrow(/sslmode=disable/);
    vi.unstubAllEnvs();
    vi.stubEnv("RAILWAY_PROJECT_ID", "proj-1");
    expect(() => decideTls(REMOTE_DISABLE)).toThrow(/مرفوض/);
    vi.unstubAllEnvs();
    // المحلي يبقى مسموحًا حتى في الإنتاج (قاعدة الجهاز نفسه)
    vi.stubEnv("NODE_ENV", "production");
    expect(decideTls(LOCAL).mode).toBe("disabled");
    expect(decideTls(LOCAL).warning).toBeNull();
  });

  it("productionRuntime الصريح يفتّح disable البعيد، وتعطيله الصريح يسمح (أدوات/اختبارات)", () => {
    expect(() => decideTls(REMOTE_DISABLE, { productionRuntime: true })).toThrow();
    expect(decideTls(REMOTE_DISABLE, { productionRuntime: false }).mode).toBe("disabled");
    expect(decideTls(LOCAL, { productionRuntime: true }).mode).toBe("disabled");
  });

  it("مضيف محلي ⇒ بلا تشفير (قاعدة على الجهاز نفسه)", () => {
    const localNoParam = "postgresql://ci@localhost:5432/aqlan";
    expect(decideTls(localNoParam).mode).toBe("disabled");
    expect(decideTls("postgresql://ci@[::1]:5432/aqlan").mode).toBe("disabled");
    expect(decideTls(LOCAL).mode).toBe("disabled");
  });

  it("بعيد بلا CA ⇒ تشفير بلا تحقق + تحذير مسجَّل بصوت عالٍ", () => {
    const decision = decideTls(REMOTE);
    expect(decision.mode).toBe("encrypted-unverified");
    expect(decision.ssl).toEqual({ rejectUnauthorized: false });
    expect(decision.warning).toMatch(/rejectUnauthorized=false/);
  });

  it("CA مضبوط وقابل للقراءة ⇒ تحقق كامل (rejectUnauthorized=true مع الشهادة)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aqlan-tls-"));
    try {
      const caPath = path.join(dir, "ca.pem");
      await writeFile(caPath, "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n");
      const decision = decideTls(REMOTE, { rootCertPath: caPath });
      expect(decision.mode).toBe("verified");
      expect(decision.ssl).toEqual({
        rejectUnauthorized: true,
        ca: ["-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n"],
      });
      expect(decision.warning).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("CA مضبوط لكن غير قابل للقراءة ⇒ خطأ فوري صريح (لا سقوط صامت إلى بلا تحقق)", async () => {
    const decision = () => decideTls(REMOTE, { rootCertPath: "/nonexistent/ca.pem" });
    expect(decision).toThrow(/PGSSL_ROOT_CERT/);
    expect(decision).toThrow(/مرفوض/);
  });

  it("PGSSL_ROOT_CERT من البيئة (المتغير المعتمد للتكوين) يُحترم", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aqlan-tls-"));
    try {
      const caPath = path.join(dir, "ca.pem");
      await writeFile(caPath, "CA-CONTENT");
      vi.stubEnv("PGSSL_ROOT_CERT", caPath);
      const decision = decideTls(REMOTE);
      expect(decision.mode).toBe("verified");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sslmode=verify-full بلا CA ⇒ رفض فوري — لا يُتعطَّل التحقق حين يُطلب صراحةً", () => {
    const verifyFull = "postgresql://u:pw@db.example.com:5432/aqlan?sslmode=verify-full";
    expect(() => decideTls(verifyFull)).toThrow(/verify-full/);
    expect(() => decideTls(verifyFull)).toThrow(/PGSSL_ROOT_CERT/);
    const verifyCa = "postgresql://u:pw@db.example.com:5432/aqlan?sslmode=verify-ca";
    expect(() => decideTls(verifyCa)).toThrow();
  });

  it("sslmode=require بعيد بلا CA ⇒ تشفير بلا تحقق (متطلب الطبقة الأولى)", () => {
    const requireOnly = "postgresql://u:pw@db.example.com:5432/aqlan?sslmode=require";
    expect(decideTls(requireOnly).mode).toBe("encrypted-unverified");
  });

  it("يستخرج sslmode من الرابط (حالة الأحرف)", () => {
    expect(sslModeFromUrl(REMOTE_DISABLE)).toBe("disable");
    expect(sslModeFromUrl("postgresql://u@h/db?sslmode=VERIFY-FULL")).toBe("verify-full");
    expect(sslModeFromUrl(REMOTE)).toBeNull();
  });

  it("يفكّ هوية الهدف بلا كلمة سر أبدًا (لعرض CLI)", () => {
    const identity = parseDatabaseHost(REMOTE);
    expect(identity).toEqual({ host: "db.example.com", port: "5432", database: "aqlan_prod", user: "u" });
    const localIdentity = parseDatabaseHost(LOCAL);
    expect(localIdentity?.host).toBe("127.0.0.1");
    expect(localIdentity?.port).toBe("5433");
    expect(parseDatabaseHost("not a url")).toBeNull();
  });
});
