#!/usr/bin/env node
import "./load-env.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * نسخة احتياطية من قاعدة البيانات.
 *
 * هذا ليس تحسينًا يُؤجَّل: بيانات عيادة موجودة في مكان واحد فقط مقامرة. المنصة قد
 * تُغلق الحساب لتأخّر دفعة، وقد يُحذف مشروع بالخطأ، وقد يُفسد خللٌ في ترقية قاعدةً
 * سليمة — وفي الحالات الثلاث لا يفيد أن تكون المنصة «موثوقة».
 *
 * والصيغة `custom` لا نصًّا عاديًا: مضغوطة، وتسمح باستعادة **جدول واحد** عند الحاجة
 * بدل استعادة كل شيء فوق قاعدة تعمل — وهو الفرق بين إصلاح خطأ وإيقاف يوم عمل.
 *
 *   الاستعمال:  DATABASE_URL=... node scripts/backup.mjs [مجلد]
 *   الاستعادة:  pg_restore --clean --if-exists -d "$DATABASE_URL" الملف.dump
 */

const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "";
if (!url.trim()) {
  console.error("خطأ: DATABASE_URL غير مضبوط.");
  process.exit(1);
}

const outputDir = resolve(process.argv[2] ?? "backups");
mkdirSync(outputDir, { recursive: true });

// التاريخ بتوقيت العيادة لا بتوقيت الخادم: نسخةٌ مؤرّخة بيوم غير اليوم الذي أُخذت
// فيه فعلًا تُربك من يبحث عنها بعد شهور — واليمن UTC+3 فالفرق يقع كل ليلة.
const timeZone = process.env.CLINIC_TIME_ZONE || "Asia/Aden";
const now = new Date();
const parts = new Intl.DateTimeFormat("en-CA", {
  timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
}).formatToParts(now).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
const stamp = `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}`;
const target = resolve(outputDir, `aqlan-center-${stamp}.dump`);

const child = spawn(
  "pg_dump",
  ["--format=custom", "--no-owner", "--no-privileges", "--file", target, url],
  { stdio: ["ignore", "inherit", "inherit"] },
);

child.on("error", (error) => {
  console.error(
    error.code === "ENOENT"
      ? "خطأ: الأمر pg_dump غير مثبّت على هذا الجهاز. ثبّت postgresql-client أولًا."
      : `خطأ: ${error.message}`,
  );
  process.exit(1);
});

child.on("close", (code) => {
  if (code !== 0) {
    console.error(`فشل pg_dump برمز ${code}. لم تُكتب نسخة صالحة.`);
    process.exit(code ?? 1);
  }
  // حجم صفر يعني ملفًا فارغًا يبدو نسخة وليس نسخة — وهو أخطر من فشلٍ ظاهر.
  const size = statSync(target).size;
  if (size === 0) {
    console.error("فشل: النسخة فارغة.");
    process.exit(1);
  }
  console.log(`تمت النسخة: ${target}`);
  console.log(`الحجم: ${(size / 1024).toFixed(1)} كيلوبايت`);
});
