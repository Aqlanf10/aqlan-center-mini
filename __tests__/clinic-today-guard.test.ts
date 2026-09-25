import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * «اليوم» بتوقيت المركز لا بـ UTC.
 *
 * `new Date().toISOString().slice(0, 10)` يعطي يوم الغد بعد التاسعة مساءً في تعز
 * (UTC+3): تاريخ إرسال أمر المختبر، وتاريخ صورة الموافقة والسيفالو، وتاريخ العلامات
 * الحيوية، وتاريخ تسعير المختبر — كلها كانت تُسجَّل بيوم الغد في مناوبة المساء.
 * هذا الحارس يمنع عودة الصيغة. المستثنى مسارات احتياطية فقط، تُستعمل حين يتعذّر
 * يوم القاعدة نفسها (dbTodayISO) — مع سببٍ مكتوب لكلٍّ منها.
 */
const ALLOWED_FALLBACKS = new Set([
  "app/api/ai/chat/route.ts",          // احتياطٌ بعد dbTodayISO()
  "app/api/ai/confirmation/route.ts",  // احتياطٌ بعد dbTodayISO()
  "lib/ai-tools/appointment-tools.ts", // احتياطٌ بعد context.todayISO من القاعدة
  "lib/ai-tools/form-drafting-tools.ts",
  "lib/ai-tools/patient-tools.ts",
  "lib/ai-tools/ortho-tools.ts",
  "lib/assistant-engine.ts",
  "lib/db.ts",                         // احتياطٌ بعد يوم القاعدة بتوقيت المركز
]);

function sources(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full.replaceAll("\\", "/"));
  }
  return out;
}

describe("clinic 'today' guard", () => {
  it("no screen or route computes today from UTC", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap(sources)
      .filter((file) => !ALLOWED_FALLBACKS.has(file))
      .filter((file) => readFileSync(file, "utf8").includes("new Date().toISOString().slice(0, 10)"));
    expect(offenders).toEqual([]);
  });
});
