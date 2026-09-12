import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authedGet, harness } from "./_server";

/**
 * هل تُرسَم شاشات العمل فعلًا؟
 *
 * شاشةٌ تنهار أثناء الرسم تُرجع 500 — فلا تُفتح أصلًا يوم الزحمة، وصفحة الخطأ
 * تكشف ما لا يُكشف. ولا يمسك ذلك اختبارُ وحدة ولا `next build`: كلاهما يمرّ على
 * كودٍ ينهار عند أول تنفيذٍ حقيقي (استدعاء hook خارج المكوّن مثلًا — وقد وقع هذا
 * فعلًا في شاشة اليوم في المستودع الشقيق، ولم يكشفه إلا طلبُ HTTP حقيقيّ).
 *
 * فهذه الفقرة تطلب الشاشات كما يطلبها المستخدم: تطبيقٌ مبنيّ بوضع الإنتاج خلف
 * HTTP، بجلسةٍ حقيقية. وهي هنا لأن هذه هي المنصّة الوحيدة في المستودع التي
 * تُشغّل تطبيقًا مبنيًّا فعليًّا.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
}, 240_000);

/*
 * القائمة تُشتقّ من مجلّد `app/` لا تُكتب باليد: قائمةٌ مكتوبة تتخلّف عن كل شاشةٍ
 * جديدة، فتُضاف شاشةٌ تنهار ويبقى الفحص أخضر — وهو بالضبط ما كان يحدث في رحلات
 * التحقق قبل ربطها. وتُستثنى المسارات الديناميكية (تحتاج معرّفًا حقيقيًّا) وما ليس
 * شاشةَ طاقم: الـAPI والدخول والتهيئة وبوّابة المريض والحجز وشاشة الصالة والطباعة.
 */
const NOT_STAFF_SCREENS = new Set([
  "api", "login", "setup", "portal", "book", "display", "checkin", "print", "fonts",
]);

function staffScreens(): string[] {
  const appDir = fileURLToPath(new URL("../../app", import.meta.url));
  const paths: string[] = ["/"];
  for (const entry of readdirSync(appDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (NOT_STAFF_SCREENS.has(entry.name) || entry.name.startsWith("[")) continue;
    if (!existsSync(join(appDir, entry.name, "page.tsx"))) continue;
    paths.push(`/${entry.name}`);
  }
  return paths.sort();
}

const STAFF_SCREENS = staffScreens();

describe("رسم شاشات الطاقم على HTTP حقيقي", () => {
  it("القائمة مشتقّة من المجلّد لا مكتوبة — فلا تفوتها شاشة", () => {
    expect(STAFF_SCREENS).toContain("/");
    expect(STAFF_SCREENS.length).toBeGreaterThan(8);
  });

  it("كل شاشة تُرجع 200 للمدير", async () => {
    const failures: string[] = [];
    for (const path of STAFF_SCREENS) {
      const response = await authedGet(path, h.sessions.admin);
      if (response.status !== 200) failures.push(`${path} → ${response.status}`);
    }
    expect(failures, `شاشات لم تُرسم: ${failures.join("، ")}`).toEqual([]);
  }, 120_000);

  it("شاشة اليوم تحمل فقرة المُنتظَرين — لا تُحذف بهدوء", async () => {
    const response = await authedGet("/", h.sessions.admin);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("مُنتظَرو اليوم");
  }, 60_000);
});
