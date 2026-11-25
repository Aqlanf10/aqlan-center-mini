/**
 * تصدير CSV — المنطق الخالص.
 *
 * الغرض ليس التقارير: التقارير في الشاشات. الغرض **نسخة احتياطية يقرأها إنسان** وملف
 * يُرحَّل به إلى برنامج آخر. بيانات عيادة تعمل أربعة أشهر بلا ملف يخرج منها رهانٌ على
 * ألّا يخطئ أحد — والرهان يُخسر.
 */

/**
 * يهيّئ خلية واحدة.
 *
 * ثلاثة أشياء تُفسد ملف CSV صامتًا: فاصلة داخل النص فتُقسم الخلية عمودين، وسطر جديد
 * داخل ملاحظة فيُقسم الصف صفّين، وعلامة اقتباس فتُنهي الخلية في منتصفها. الاقتباس
 * المزدوج يعالجها كلها.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  // Spreadsheet programs can interpret a quoted CSV cell as a formula.
  // Preserve canonical negative numbers (including PostgreSQL numeric strings),
  // but force formula-like text into a literal cell before CSV escaping.
  const negativeNumber = /^-\d+(?:\.\d+)?$/.test(raw);
  const dangerousText = /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]*[=+\-@\uff1d\uff0b\uff0d\uff20]/u.test(raw)
    || /^[\t\r\n]/.test(raw);
  const text = dangerousText && !negativeNumber ? "'" + raw : raw;
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * ملف CSV كامل — بعلامة ترتيب البايتات (BOM).
 *
 * بلا BOM تفتح Excel الملف العربي حروفًا مشوّهة («ÙØ±ÙŠØ¶»)، فيظنّ صاحب العيادة أن
 * البيانات تلفت. ثلاثة بايتات تمنع ذلك.
 *
 * ونهايات الأسطر `\r\n` لا `\n`: هي ما تتوقعه برامج الجداول على ويندوز، وهو نظام
 * الجهاز في العيادة.
 */
export function csvFile(headers: string[], rows: unknown[][]): string {
  const lines = [csvRow(headers), ...rows.map(csvRow)];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** اسم ملف آمن: بلا مسافات ولا حروف تكسر رأس التنزيل. */
export function exportFileName(table: string, from: string, to: string): string {
  return `aqlan-${table}-${from}-to-${to}.csv`;
}
