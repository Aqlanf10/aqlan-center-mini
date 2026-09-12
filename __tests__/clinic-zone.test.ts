import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { CLINIC_ZONE_FALLBACK, isKnownZone, resolveClinicZone } from "../lib/clinicZone";
import { clinicDateString } from "../lib/schedule";

/**
 * توقيت العيادة مصدرٌ واحد — وحارسه هنا.
 *
 * كان النصّ مكتوبًا في أربعةٍ وثلاثين موضعًا. توحيدُه مرّةً لا يكفي: الملفّ التالي
 * يُكتب بالنسخ من ملفٍ قديم، فيعود النصّ بهدوء ويعود معه الانقسام. فالحارس يمنع
 * عودته، لا يكتفي بإزالته.
 *
 * ويشمل الحارس شيفرة الإنتاج وحدها (app/ وcomponents/ وlib/): الاختبارات تُصرّح
 * بالمنطقة عمدًا لتُثبت سلوكًا عندها بعينها، وذاك تثبيتٌ مقصود لا تكرار.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUARDED_DIRS = ["app", "components", "lib"];
/** المصدر الوحيد المسموح له بكتابة الاسم. */
const SOURCE = "lib/clinicZone.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

describe("توقيت العيادة", () => {
  it("الاسم مكتوبٌ في مصدره وحده — لا في شيفرة الإنتاج", () => {
    /* بلا حصرٍ بنوع الاقتباس: "Asia/Aden" و'Asia/Aden' و`Asia/Aden` سواء. */
    const zone = /Asia\/Aden/;
    const offenders: string[] = [];
    for (const dir of GUARDED_DIRS) {
      for (const file of sourceFiles(dir)) {
        const rel = relative(ROOT, file);
        if (rel === SOURCE) continue;
        if (zone.test(readFileSync(file, "utf8"))) offenders.push(rel);
      }
    }
    expect(offenders, `التوقيت مكتوبٌ خارج مصدره في: ${offenders.join("، ")}`).toEqual([]);
  });

  it("الافتراضي توقيت اليمن — تعز داخل Asia/Aden وهي المنطقة المعتمدة", () => {
    expect(CLINIC_ZONE_FALLBACK).toBe("Asia/Aden");
    expect(isKnownZone(CLINIC_ZONE_FALLBACK)).toBe(true);
    // لا توجد Asia/Taiz في قاعدة المناطق العالمية — تثبيتٌ لئلا يُقترح لاحقًا.
    expect(isKnownZone("Asia/Taiz")).toBe(false);
  });

  it("المضبوط في البيئة يُحترم إن كان معروفًا", () => {
    expect(resolveClinicZone("Europe/Istanbul")).toBe("Europe/Istanbul");
    expect(resolveClinicZone("  Asia/Riyadh  ")).toBe("Asia/Riyadh");
  });

  it("ساعةُ الجهاز ليست يوم العيادة — وهذا هو الفرق الذي كان يمرّ صامتًا", () => {
    /* ٢١:٣٠ بتوقيت غرينتش = ٠٠:٣٠ من الغد في عدن. الجهاز المضبوط على UTC كان
       يقول «١٢ سبتمبر» والعيادة في «١٣ سبتمبر» — يومٌ كامل من الفرق في شاشةٍ
       تعرض مواعيد اليوم. */
    const moment = new Date("2026-09-12T21:30:00Z");
    expect(clinicDateString(moment, CLINIC_ZONE_FALLBACK)).toBe("2026-09-13");
    expect(moment.toISOString().slice(0, 10)).toBe("2026-09-12");
    expect(clinicDateString(moment, "UTC")).toBe("2026-09-12");
  });

  it("والمجهول يُردّ إلى الافتراضي ولا يُمرَّر فيُسقط كل حسابٍ لليوم", () => {
    expect(resolveClinicZone("Asia/Taiz")).toBe(CLINIC_ZONE_FALLBACK);
    expect(resolveClinicZone("خطأ مطبعي")).toBe(CLINIC_ZONE_FALLBACK);
    expect(resolveClinicZone("")).toBe(CLINIC_ZONE_FALLBACK);
    expect(resolveClinicZone(undefined)).toBe(CLINIC_ZONE_FALLBACK);
    expect(resolveClinicZone(null)).toBe(CLINIC_ZONE_FALLBACK);
  });
});
