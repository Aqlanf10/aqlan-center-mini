#!/usr/bin/env node
/**
 * عدّاء انحدار قارئات الأجسام الخام (P2-FIX-2 / S8) — يفشل CI فور ظهور
 * قارئ جسم غير محدود في أي مسار API:
 *
 *   request.json() / request.formData() / request.text()
 *   request.arrayBuffer() / request.blob()
 *
 * القاعدة: كل قراءة جسم في app/api تمر عبر القارئ المحدود المركزي
 * (lib/http-body.ts: readJsonBody / readBoundedFormData / readBoundedBody)
 * — الحد يُفرض حتى مع غياب Content-Length (chunked)، فالترويسة وحدها ليست
 * حارساً. الاستثناء الوحيد قائمة مُوثَّقة أدناه (allowlist) — إضافة عليها
 * تمر بمراجعة أمنية صريحة.
 *
 * التشغيل: node scripts/scan-raw-body-parsers.mjs (خطوة CI إلزامية).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const API_DIR = join(process.cwd(), "app", "api");

/**
 * الاستثناءات الموثقة — مسارات يجوز فيها (حالياً: لا شيء).
 * كل إدخال: { file: مسار نسبي، reason: سبب موثق للمراجعة }
 * ملاحظة: استدعاءات `.formData()` على Request **معاد بناؤه** من
 * readBoundedBody ليست قراءة خام — النمط يفحص `request.formData()`
 * حصراً، فلا تحتاج إدخالاً هنا.
 */
const ALLOWLIST = [
  // { file: "app/api/example/route.ts", reason: "..." },
];

const RAW_PATTERNS = [
  /\brequest\s*\.\s*(json|formData|text|arrayBuffer|blob)\s*\(/,
  /\breq\s*\.\s*(json|formData|text|arrayBuffer|blob)\s*\(/,
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && entry.endsWith("route.ts")) out.push(full);
  }
  return out;
}

const offenders = [];
const files = statSync(API_DIR) ? walk(API_DIR) : [];

for (const file of files) {
  const rel = relative(process.cwd(), file).replaceAll("\\", "/");
  const text = readFileSync(file, "utf8");
  for (const pattern of RAW_PATTERNS) {
    if (pattern.test(text)) {
      const allowed = ALLOWLIST.some((entry) => entry.file === rel);
      if (!allowed) {
        offenders.push(rel);
      }
      break;
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "بوابة قارئات الأجسام حمراء — قارئ خام خارج الحد المركزي في:\n" +
      offenders.map((f) => `  - ${f}`).join("\n") +
      "\n\nاستخدم readJsonBody(request, LIMIT) / readBoundedFormData / readBoundedBody " +
      "من lib/http-body.ts بحدّ من lib/security-limits.ts، أو وثّق استثناءً " +
      "صريحاً في ALLOWLIST بمراجعة أمنية.",
  );
  process.exit(1);
}

console.log(
  `بوابة قارئات الأجسام خضراء: ${files.length} مسار API بلا قارئ خام ` +
    `(${ALLOWLIST.length} استثناء موثق).`,
);
