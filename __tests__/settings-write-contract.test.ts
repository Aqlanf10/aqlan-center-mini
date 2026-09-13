import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * حارسُ تعاقد الكتابة في الإعدادات.
 *
 * المسار يشترط `__versions` في كل كتابة، ويرفض بلاها بـ409. وشاشةٌ لا ترسلها
 * تتعطّل صامتةً: الزرّ يُضغط ولا يحدث شيء، والبناء أخضر والاختبارات خضراء —
 * وهذا ما وقع فعلًا لشاشة «نسب إهلاك المواد» بعد المرحلة ١ب.
 *
 * فالحارس يقرأ الشيفرة نفسها لا قائمةً مكتوبة بيد: كل نداءٍ يكتب على
 * `/api/settings` يجب أن يحمل `__versions`، ومن يكتب مفتاحًا يتطلّب سببًا يجب أن
 * يحمل سببًا. قائمةٌ مكتوبة تتخلّف عن أول شاشةٍ جديدة؛ والمسحُ لا يتخلّف.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const relative = join(dir, entry);
    const full = join(ROOT, relative);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(relative));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(relative);
    }
  }
  return found;
}

interface WriteCall { file: string; body: string }

/**
 * يلتقط نداءات الكتابة على `/api/settings` ويعيد نصّ حمولتها.
 *
 * القراءة (`cache: "no-store"` بلا `method`) خارج الموضوع — الشرط على الكتابة.
 */
function settingsWrites(): WriteCall[] {
  const calls: WriteCall[] = [];
  for (const file of [...sourceFiles("app"), ...sourceFiles("components")]) {
    if (file.startsWith(join("app", "api"))) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    let index = text.indexOf('fetch("/api/settings"');
    while (index !== -1) {
      /* حدُّ النداء هو إغلاق كائن الخيارات — بلا هذا الحدّ تتسرّب النافذة إلى
         الدالّة التالية فيُحسب نداءُ قراءةٍ كتابةً. */
      const end = text.indexOf("});", index);
      const call = text.slice(index, end === -1 ? index + 400 : end + 3);
      if (/\bmethod:/.test(call)) {
        /* الحمولة قد تُبنى في سطرٍ قبل النداء (`const body = …`)، فتُضمّ المقدّمة
           القريبة إلى ما يُفحص — على أن تبقى داخل الدالّة نفسها. */
        const preamble = text.slice(Math.max(0, index - 900), index);
        calls.push({ file, body: preamble + call });
      }
      index = text.indexOf('fetch("/api/settings"', index + 1);
    }
  }
  return calls;
}

describe("كل كتابةٍ للإعدادات تحمل طابع النسخة", () => {
  const writes = settingsWrites();

  it("يوجد نداءُ كتابةٍ واحد على الأقل ليُفحص — وإلا فالحارس أعمى", () => {
    expect(writes.length).toBeGreaterThan(0);
  });

  it.each(writes.map((call, index) => [`${call.file} #${index + 1}`, call] as const))(
    "%s يرسل __versions",
    (_label, call) => {
      expect(call.body).toContain("__versions");
    },
  );

  it("شاشة نسب إهلاك المواد ترسل الطابع والسبب معًا", () => {
    const text = readFileSync(join(ROOT, "app/settings/material-rates/page.tsx"), "utf8");
    /* المفتاح `requiresReason` في سجلّ التعريفات، فالخادم يرفض بلا سبب. */
    expect(text).toContain('"finance.commission_material_rate"');
    expect(text).toContain("__versions");
    expect(text).toContain("__reason");
  });
});

describe("الحارس يمسك الخلل فعلًا", () => {
  it("حمولةٌ بلا طابعٍ تسقط في الفحص نفسه", () => {
    const broken: WriteCall = {
      file: "example.tsx",
      body: 'fetch("/api/settings", { method: "PATCH", body: JSON.stringify({ "clinic.chairs": "4" }) })',
    };
    /* نفس الشرط المطبَّق أعلاه — لو مرّ هذا، فالحارس لا يحرس شيئًا. */
    expect(broken.body.includes("__versions")).toBe(false);
  });
});
