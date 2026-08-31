import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * حارس قائمة المرور في الوكيل.
 *
 * الوكيل بابٌ واحد: ما ليس في قائمته البيضاء يُغلق في الإنتاج خلف جلسة الطاقم.
 * وكل مسار بوابة مريض جديد يُنسى من القائمة يعمل في التطوير ويُغلق في النشر —
 * وهو أخطر صنف خطأ: يمرّ على جهاز المطوّر ويسقط أمام المريض. هذا الفحص يقرأ
 * مسارات البوابة من مجلدات الشيفرة نفسها ويطابقها مع نصّ الوكيل، فلا يمرّ مسارٌ
 * جديد إلا وهو مفتوح في القائمة عمدًا.
 */

const proxySource = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");

function portalApiRoutes(): string[] {
  const base = new URL("../app/api/portal", import.meta.url).pathname;
  if (!existsSync(base)) return [];
  const routes: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(`${dir}/${entry.name}`, `${prefix}/${entry.name}`);
      } else if (entry.name === "route.ts") {
        routes.push(`/api/portal${prefix}`);
      }
    }
  };
  walk(base, "");
  return routes;
}

describe("قائمة مرور الوكيل", () => {
  it("كل مسار بوابة مريض موجود في القائمة البيضاء", () => {
    const routes = portalApiRoutes();
    expect(routes.length).toBeGreaterThan(4);
    const missing = routes.filter((route) => !proxySource.includes(`"${route}"`));
    expect(missing).toEqual([]);
  });

  it("تشغيل الرسائل الصوتية مفتوح بالبادئة — يشترك فيه الطاقم والمرضى", () => {
    expect(proxySource).toContain('"/api/messages/voice/"');
  });

  it("مسارات الطاقم للمراسلة ليست في القائمة البيضاء — بابها كوكي الطاقم", () => {
    expect(proxySource).not.toContain('"/api/messages"');
  });
});
