import { describe, expect, it } from "vitest";
import {
  isSameOrInside, resolveInsideBase, validateDestinationBatch, validateRelativePath,
} from "../lib/safe-path";

/**
 * اختبارات تحقق المسارات الآمنة (P1.13) — لا startsWith أبدًا.
 *
 * الحالات المفروضة تغطي: الخروج للأعلى، المطلق (posix وwindows)، null bytes،
 * المسارات المتشعبة، الأسماء التي تتشارك بادئة الأساس، والوجهات المكررة.
 */

const BASE = "/data/documents";

describe("تحقق المسار النسبي", () => {
  it("يقبل مسارًا نسبيًا عاديًا ويطبّعه", () => {
    const result = validateRelativePath("ab/cd/hash.png");
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe("ab/cd/hash.png");
  });

  it("يوحّد فواصل windows ويلغي النقاط الزائدة", () => {
    expect(validateRelativePath("ab\\cd\\hash.png").resolved).toBe("ab/cd/hash.png");
    expect(validateRelativePath("./ab/./cd/x.png").resolved).toBe("ab/cd/x.png");
    expect(validateRelativePath("ab//cd/x.png").resolved).toBe("ab/cd/x.png");
  });

  it("يرفض المسارات المطلقة بكل أشكالها", () => {
    expect(validateRelativePath("/etc/passwd").ok).toBe(false);
    expect(validateRelativePath("C:\\Windows\\system32").ok).toBe(false);
    expect(validateRelativePath("\\\\server\\share\\file").ok).toBe(false);
    expect(validateRelativePath("/etc/passwd").reason).toMatch(/مطلق/);
  });

  it("يرفع الخروج للأعلى (..) بمكانٍ واحد وكافٍ", () => {
    expect(validateRelativePath("../secret").ok).toBe(false);
    expect(validateRelativePath("ab/../../secret").ok).toBe(false);
    expect(validateRelativePath("a/..\\..\\b").ok).toBe(false);
    expect(validateRelativePath("..").ok).toBe(false);
    // نقطة داخل اسم ملف مشروعة
    expect(validateRelativePath("ab/file.name.tar.gz").ok).toBe(true);
  });

  it("يرفض null byte — حرف إنهاء C يقطع الفحص بعده", () => {
    expect(validateRelativePath("ab\0/../../../etc/passwd").ok).toBe(false);
    expect(validateRelativePath("ab/c\0d.png").ok).toBe(false);
  });

  it("يرفض الفارغ وبلا مكوّنات", () => {
    expect(validateRelativePath("").ok).toBe(false);
    expect(validateRelativePath("/").ok).toBe(false);
    expect(validateRelativePath(".").ok).toBe(false);
  });
});

describe("الحل داخل الأساس — بلا startsWith", () => {
  it("يحل مسارًا سليمًا داخل الأساس ويعيد المسار المطلق", () => {
    const result = resolveInsideBase(BASE, "ab/cd/hash.png");
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(`${BASE}/ab/cd/hash.png`);
  });

  it("الحالة التي يخدع فيها startsWith: أساس /data ومسار يخرج منه", () => {
    // /data-evil يقبل بstartsWith('/data') لكن الحل الصحيح يرفضه
    expect(isSameOrInside("/data", "/data-evil/x")).toBe(false);
    expect(isSameOrInside("/data", "/data/x")).toBe(true);
    // الخروج الفعلي من الأساس
    expect(resolveInsideBase(BASE, "x/../../../../etc/passwd").ok).toBe(false);
    expect(resolveInsideBase(BASE, "../../etc/passwd").ok).toBe(false);
  });

  it("ترميز traversal بالنص المكرر يُرفض بعد الحل", () => {
    expect(resolveInsideBase(BASE, "ab/..").ok).toBe(false);
    expect(resolveInsideBase(BASE, "a/b/c/../../../d").ok).toBe(false);
  });

  it("الوجهة = الأساس نفسه مرفوضة (دليل لا ملف)", () => {
    expect(resolveInsideBase(BASE, ".").ok).toBe(false);
  });
});

describe("دفعة الوجهات — كشف التكرار بعد الحل", () => {
  it("يمرر دفعة سليمة", () => {
    const batch = validateDestinationBatch(BASE, ["ab/cd/a.png", "ab/cd/b.png", "ef/gh/c.pdf"]);
    expect(batch.ok).toBe(true);
    if (batch.ok) expect(batch.resolved).toHaveLength(3);
  });

  it("يكشف التكرار بالنص المتطابق", () => {
    const batch = validateDestinationBatch(BASE, ["ab/cd/a.png", "ab/cd/a.png"]);
    expect(batch.ok).toBe(false);
    if (!batch.ok) expect(batch.reason).toMatch(/مكررة/);
  });

  it("يكشف التكرار بعد التطبيع: مسار بنقطة وفواصل مختلفة تصل نفس الملف", () => {
    const batch = validateDestinationBatch(BASE, ["ab/cd/a.png", "ab\\cd\\a.png", "./ab/./cd/a.png"]);
    expect(batch.ok).toBe(false);
    if (!batch.ok) {
      expect(batch.reason).toMatch(/مكررة/);
      expect(batch.index).toBe(1);
    }
  });

  it("يرفض الدفعة كلها عند أول مسار غير آمن (فشل مبكر بموقع معلن)", () => {
    const batch = validateDestinationBatch(BASE, ["ab/cd/a.png", "../escape", "ef/gh/c.pdf"]);
    expect(batch.ok).toBe(false);
    if (!batch.ok) expect(batch.index).toBe(1);
  });
});
