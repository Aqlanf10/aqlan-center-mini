import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * حارسٌ على مصدر المخطط نفسه.
 *
 * نصّ SQL في `lib/db.ts` مكتوب داخل قالب نصّي، وعلامة الاقتباس الخلفية داخله تُنهي
 * السلسلة فيسقط البناء. وقد وقعتُ في هذا **ثلاث مرات** وأنا أكتب تعليقات عربية تشرح
 * جدولًا — وخطأٌ يتكرر ثلاث مرات لا يُعالَج بالانتباه، يُعالَج بفحص.
 *
 * والفحص على **أسطر تعليقات SQL** لا على كتل مستخرجة: العلامة الخلفية نفسها تكسر أي
 * استخراج (ينتهي عندها فلا تظهر فيه). وتعليق `--` في هذا الملف لا يقع إلا داخل قالب
 * SQL — فالتعليق في TypeScript يبدأ بـ`//`.
 */

const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
const sqlCommentLines = source
  .split("\n")
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => /^\s+--/.test(line));

describe("سلامة مصدر المخطط", () => {
  it("لا علامة اقتباس خلفية في أي تعليق SQL", () => {
    expect(sqlCommentLines.length).toBeGreaterThan(30);
    const offenders = sqlCommentLines
      .filter(({ line }) => line.includes("`"))
      .map(({ number, line }) => `${number}: ${line.trim().slice(0, 60)}`);
    expect(offenders).toEqual([]);
  });

  it("الحارس نفسه يمسك العلامة الخلفية — فحصٌ لا يسقط ليس فحصًا", () => {
    const broken = ["      CREATE TABLE x (", "      -- جدول `visits` هو الزيارة", "      );"];
    const caught = broken.filter((line) => /^\s+--/.test(line) && line.includes("`"));
    expect(caught).toHaveLength(1);
  });

  it("أنماط التعابير المنتظمة في SQL بشرطتين لا بواحدة", () => {
    // `\D` في المصدر تصل إلى بوستجرس حرفَ D، فيفشل الاستعلام على قاعدة فيها بيانات
    // وحدها — وهو ما وقع ولم تكشفه إلا قاعدة إنتاج.
    const uses = source.match(/regexp_replace\([^,]+, '([^']*)'/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toContain("\\\\D");
  });
});
