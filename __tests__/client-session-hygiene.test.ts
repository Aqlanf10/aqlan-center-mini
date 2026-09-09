import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * عدّاء انحدار معمارية الجلسة (P2-FIX-1) — يفشل البناء فور عودة أي نمطٍ
 * كان يسرّب التوكن إلى JavaScript في المتصفح:
 *
 *  1. `aqlan_session_token` — مفتاح التخزين المحلي للتوكن بجميع صوره
 *     (getItem / setItem / removeItem المسموح فقط في سياق التنظيف داخل
 *     SessionProvider نفسها).
 *  2. حقن Authorization: Bearer تلقائياً في طلبات المتصفح (monkey-patch
 *     لـfetch أو ترويسة Authorization في كود client).
 *  3. ترويسة `x-session-user` المزوَّرة من العميل — لا مستهلك شرعي لها.
 *  4. localStorage كمصدر جلسة/دور — أي استعادة حالة جلسة من التخزين المحلي.
 *
 * هذا فحص مصدري (CI regression) لا اختبار سلوك: النمط ذاته محظور حتى لو
 * بدا غير مُفعَّل، فالمسار الميت اليوم يُعاد تشغيله غداً.
 */

const ROOT = process.cwd();

function walkClientSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkClientSources(full, out);
    } else if (/\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function isClientComponent(source: string): boolean {
  return /^\s*[\"']use client[\"']/m.test(source);
}

const clientFiles = [
  ...walkClientSources(join(ROOT, "components")),
  ...walkClientSources(join(ROOT, "app")),
].filter((file) => {
  const text = readFileSync(file, "utf8");
  return isClientComponent(text) || file.includes(`${join("app", "login")}`);
});

describe("(P2-FIX-1) انحدار جلسة المتصفح — لا توكن في JavaScript ولا حقن تلقائي", () => {
  it("مفاتيح التوكن في localStorage محذوفة من كود العميل (لا setItem/getItem للتوكن إطلاقاً)", () => {
    const offenders = clientFiles.filter((file) => {
      const text = readFileSync(file, "utf8");
      // القراءة والكتابة محظورتان؛ التنظيف (removeItem) وحده مسموح — في
      // SessionProvider فقط لمحو بقايا النسخ السابقة.
      return /localStorage\.(setItem|getItem)\([^)]*aqlan_session_token/i.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("لا حقن Authorization تلقائي لطلبات /api في كود العميل (لا monkey-patch بـBearer)", () => {
    const offenders = clientFiles.filter((file) => {
      const text = readFileSync(file, "utf8");
      // أي توليد ترويسة Authorization بقيمة Bearer في كود client — يكفي النمط
      // ذاته ولو بدا غير مُفعَّل (المسارات الميتة تُعاد تشغيلها).
      return /Authorization[\"']?\s*[,:]=?\s*[\"'`]\s*Bearer|headers\.set\(\s*[\"']Authorization/i.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("ترويسة x-session-user المزوَّرة من العميل لا تُحقن من أي مكان", () => {
    const offenders = clientFiles.filter((file) =>
      /x-session-user/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("لا استعادة جلسة/دور من localStorage (التخزين المحلي ليس مصدر هوية)", () => {
    const offenders = clientFiles.filter((file) => {
      const text = readFileSync(file, "utf8");
      // أي getItem لعناوين جلسة/دور/توكن — الاستعادة من الخادم حصراً
      // (/api/auth/me بالكوكي أو التخطيط الجذري). استثناء التنظيف الوحيد
      // removeItem في SessionProvider.
      return /localStorage\.getItem\(\s*["'](aqlan_session|.*_?session_?token|aqlan_flow)/i.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("كود العميل لا يملك أي وصول لقيمة كوكي الجلسة (HttpOnly بلا قراءة JS)", () => {
    const offenders = clientFiles.filter((file) => {
      const text = readFileSync(file, "utf8");
      return /document\.cookie/.test(text) && /aqlan_flow_session/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("المنظف: SessionProvider يمحو بقايا النسخ السابقة (removeItem لا getItem)", () => {
    const providerPath = join(ROOT, "components", "SessionProvider.tsx");
    const text = readFileSync(providerPath, "utf8");
    expect(text).toContain('localStorage.removeItem("aqlan_session_token")');
    expect(text).not.toContain("localStorage.getItem");
    expect(text).not.toContain("localStorage.setItem");
  });
});
