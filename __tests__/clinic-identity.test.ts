import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTING_DEFAULTS } from "../lib/settings";

/**
 * حارس هوية المركز في مصدر المخطط.
 *
 * بذرٌ قديم زرع في lib/db.ts اسمًا آخر للمركز («مركز عقلان لطب وجراحة الفم
 * والأسنان») مختلفًا عن الافتراضيات الرسمية في lib/settings.ts — فقامت القاعدة
 * المزروعة به بتغليب اسمٍ خاطئ على كل سندٍ وتقرير. هذا الفحص يقف عند الباب:
 * أي نصّ اسم مركزٍ يُكتب في db.ts خارج قائمة الترحيلة المصحِّحة يُرفض هنا قبل
 * أن يصل قاعدة بياناتٍ حيّة.
 */

const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");

const KNOWN_LEGACY_BAD = "مركز عقلان لطب وجراحة الفم والأسنان";
const KNOWN_LEGACY_BAD_TITLE = "استشاري جراحة وزراعة وتقويم الأسنان";

describe("هوية المركز في المخطط", () => {
  it("البذر لا يكتب اسم مركز نصًّا — بل ينسخ SETTING_DEFAULTS", () => {
    // بذر الهوية يجب أن يُبنى من CLINIC_IDENTITY_KEYS + SETTING_DEFAULTS،
    // لا من قيمٍ نصية مستقلة تتشعب عن الأصل.
    expect(source).toContain("CLINIC_IDENTITY_KEYS.map((key) => SETTING_DEFAULTS[key])");
    const literalSeed = source.match(
      /INSERT INTO settings[\s\S]{0,200}?clinic\.name[\s\S]{0,80}?'[^']*مركز/,
    );
    expect(literalSeed).toBeNull();
  });

  it("الاسم الخاطئ التاريخي لا يظهر إلا في قائمة الترحيلة المصحِّحة", () => {
    // مرة واحدة بالضبط: داخل LEGACY_IDENTITY_FIXES ليُعرف ويُصحَّح في القواعد
    // القائمة. ظهوره ثانيةً في أي موضعٍ آخر يعني نسخةً جديدة من الشوء القديم.
    const occurrences = source.split(KNOWN_LEGACY_BAD).length - 1;
    expect(occurrences).toBe(1);
    const titleOccurrences = source.split(KNOWN_LEGACY_BAD_TITLE).length - 1;
    expect(titleOccurrences).toBe(1);
  });

  it("ترحيلة التصحيح تُحوّل الاسم واللقب الخاطئين إلى الافتراضيين الرسميين", () => {
    expect(source).toContain("LEGACY_IDENTITY_FIXES");
    expect(source).toContain("clinic.identity_fixed");
    // البذر القديم كتب الاسم واللقب معًا، فلكلٍّ نصُّه الخاطئ الخاص —
    // ومطابقة اللقب كانت تقارن بنصّ الاسم فلا تصحّح شيئًا أبدًا (عطلٌ وقع
    // في الصياغة الأولى للترحيلة، وهذا الفحص يمنع عودته).
    expect(source).toContain("badName:");
    expect(source).toContain("badTitle:");
    expect(source).toContain("[fix.badName, fix.goodName]");
    expect(source).toContain("[fix.badTitle, fix.goodTitle]");
    expect(source).toContain("WHERE key = 'clinic.lead_doctor_title' AND value = $1");
    expect(source).toContain('goodName: SETTING_DEFAULTS["clinic.name"]');
    expect(source).toContain('goodTitle: SETTING_DEFAULTS["clinic.lead_doctor_title"]');
    expect(SETTING_DEFAULTS["clinic.name"]).toContain("مركز الدكتور عقلان");
  });

  it("هاتف وعنوان التواصل مبذوران من الافتراضيات — لا هواتف مدنٍ أخرى", () => {
    // البذر الخاطئ القديم كان يكتب «+967 1 234567» و«صنعاء - شارع بغداد»
    // — هوية مركزٍ لم يقم يومًا. المفاتيح الخمسة كلها من الأصل الواحد.
    expect(source).toContain('"clinic.phone"');
    expect(source).toContain('"clinic.address"');
    expect(source).not.toContain("+967 1 234567");
    expect(source).not.toContain("صنعاء - شارع بغداد");
  });
});
