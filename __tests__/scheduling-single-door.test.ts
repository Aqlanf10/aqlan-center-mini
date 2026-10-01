import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * (TD-03 / TD-REG-011) ثلاثة أبواب للجدولة، حَكَمٌ واحد — حارسٌ ثابت.
 *
 * كل ما ينشئ موعدًا أو ينقله يمرّ بحكمٍ واحد (`judgeBookingInDay`: السعة، حجب الطبيب، تداخل المريض)
 * تحت قفل اليوم، ويُسجِّل تجاوز المخوَّل (`recordCapacityOverride`). هذا الحارس يمنع أن يظهر بابٌ
 * خامس بلا حكم:
 *  - `createAppointment` (إدراج خام بلا حكم) لا يُستدعى من أي ملف إنتاجٍ (app/ و lib/) — للسكربتات
 *    والاختبارات وحدها؛
 *  - كل مسارٍ ينفّذ كاتب مواعيد مقفلًا (`createNextSession` / `confirmBookingRequest` /
 *    `schedulePlannedVisit`) يستدعي `judgeBookingInDay` و`actorCanOverride` و`recordCapacityOverride`؛
 *  - كل إدراجٍ خام في `appointments` داخل lib/db.ts موجود في قائمةٍ معروفة مبرَّرة.
 */

const ROOT = process.cwd();

function files(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full, accept));
    else if (accept(entry.name)) out.push(full);
  }
  return out;
}

/** الشيفرة التنفيذية: بلا تعليقات وبلا أسطر import — فالاسم المستورد أو المذكور في تعليق ليس استدعاءً. */
function executable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/^\s*import[\s\S]*?;\s*$/gm, "");
}

const production = [
  ...files(join(ROOT, "app"), (name) => /\.(ts|tsx)$/.test(name)),
  ...files(join(ROOT, "lib"), (name) => name.endsWith(".ts")),
].map((file) => {
  const source = readFileSync(file, "utf8");
  return { file: relative(ROOT, file).replace(/\\/g, "/"), source, code: executable(source) };
});

const calls = (code: string, name: string) => new RegExp(`\\b${name}\\s*\\(`).test(code);

describe("TD-03: بابٌ واحد للحكم على المواعيد", () => {
  it("createAppointment الخام (بلا حكم) لا يُستدعى من ملف إنتاج", () => {
    const callers = production
      .filter(({ file, code }) => file !== "lib/db.ts" && calls(code, "createAppointment"))
      .map(({ file }) => file);
    expect(callers).toEqual([]);
    // وداخل db.ts لا يستدعيه أحد غير تعريفه.
    const db = production.find(({ file }) => file === "lib/db.ts")!.code;
    expect((db.match(/\bcreateAppointment\s*\(/g) ?? []).length).toBe(1);
  });

  it("كاتبو اليوم المقفل (createNextSession / confirmBookingRequest / schedulePlannedVisit) لا يُستدعون إلا من مسارٍ يحكم", () => {
    const writers = ["createNextSession", "confirmBookingRequest", "schedulePlannedVisit"];
    const callers = production
      .filter(({ code }) => writers.some((name) => calls(code, name)))
      .map(({ file }) => file).sort();
    // db.ts: أغلفته الداخلية تحت القفل نفسه؛ والبقية مساراتٌ تُثبَت أدناه — ملفٌّ جديد يستدعيهم يسقط هنا.
    expect(callers).toEqual([
      "app/api/booking-requests/[id]/route.ts",
      "app/api/planned-visits/[id]/schedule/route.ts",
      "app/api/visits/[id]/next/route.ts",
      "lib/db.ts",
    ]);
    for (const { file, code } of production.filter(({ file }) => file.startsWith("app/api/") && callers.includes(file))) {
      for (const required of ["judgeBookingInDay", "actorCanOverride", "recordCapacityOverride"]) {
        // استدعاءٌ تنفيذي لا اسمٌ مستورد أو مذكور في تعليق.
        expect({ file, required, called: calls(code, required) }).toEqual({ file, required, called: true });
      }
    }
  });

  it("الأبواب الأخرى (الموعد المباشر، النقل، قائمة الانتظار، المساعد الذكي) تمرّ من bookAppointment/rescheduleAppointment", () => {
    const callers = (name: string) => production
      .filter(({ file, code }) => file !== "lib/book-appointment.ts" && calls(code, name))
      .map(({ file }) => file).sort();
    expect(callers("bookAppointment")).toEqual([
      "app/api/appointments/route.ts",
      "lib/ai-tools/action-tools.ts",
      "lib/waiting-list-booking.ts",
    ]);
    expect(callers("rescheduleAppointment")).toEqual(["app/api/appointments/[id]/route.ts"]);
  });

  it("إدراجات appointments الخام: في lib/db.ts وحده، وفي كتّاب اليوم المقفل المعروفين فقط", () => {
    // أي ملفٍّ آخر فيه إدراجٌ خام ⇒ بابٌ جديد بلا حكم.
    const insertingFiles = production
      .filter(({ code }) => /INSERT\s+INTO\s+appointments\b/i.test(code)).map(({ file }) => file);
    expect(insertingFiles).toEqual(["lib/db.ts"]);
    const db = production.find(({ file }) => file === "lib/db.ts")!.code;
    const writers: string[] = [];
    for (const match of db.matchAll(/INSERT\s+INTO\s+appointments\b/gi)) {
      const before = db.slice(0, match.index);
      const fn = [...before.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)].pop()?.[1] ?? "?";
      writers.push(fn);
    }
    expect(writers.sort()).toEqual([
      "confirmBookingRequest",     // يُحكم عليه في مسار طلبات الحجز تحت القفل
      "createAppointment",        // خام — للسكربتات فقط (حارس أعلاه)
      "createNextSession",        // يُحكم عليه في مسار الزيارة التالية تحت القفل
      "insertAppointmentOnClient", // قلب bookAppointment
      "schedulePlannedVisit",     // يُحكم عليه عبر judge في مسار الجلسة المخطَّطة
    ]);
  });
});
