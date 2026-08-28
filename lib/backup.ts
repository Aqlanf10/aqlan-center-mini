/**
 * النسخة الاحتياطية الكاملة — بيانات لا مخطط.
 *
 * لماذا لا `pg_dump`؟ لأن من يحتاج النسخة هو صاحب العيادة لا مهندس: `pg_dump` يعني
 * تثبيت أدوات، وسطر أوامر، ونسخ رابط قاعدة يحمل كلمة السر. ونسخةٌ احتياطية تحتاج
 * كل ذلك لا تُؤخذ — وأسوأ نسخة هي التي لم تُؤخذ.
 *
 * فالنسخة هنا **من داخل البرنامج**: زرٌّ يُضغط فينزل ملف إلى الجهاز. ولا يُصدَّر معه
 * المخطط لأن البرنامج ينشئه بنفسه عند أول تشغيل — فالاستعادة: قاعدة فارغة، يفتحها
 * البرنامج فيبني جداولها، ثم يُشغَّل هذا الملف عليها.
 *
 * وترتيب الجداول يُحسب من **مفاتيح القاعدة نفسها** لا من قائمة مكتوبة بيد: قائمةٌ
 * يدوية تنسى جدولًا يُضاف غدًا، فتفشل الاستعادة بخطأ مفتاح أجنبي في أسوأ لحظة.
 */

export interface TableDependency {
  table: string;
  dependsOn: string[];
}

/**
 * ترتيب الإدراج: المرجوع إليه قبل من يشير إليه.
 *
 * ترتيب طوبولوجي بسيط. والدورات — جدولان يشير كلٌّ منهما إلى الآخر — تُكسَر بترك
 * الباقي على ترتيبه بدل الدوران إلى الأبد: أن تفشل الاستعادة برسالة واضحة خيرٌ من
 * أن تتجمّد بلا سبب ظاهر.
 */
export function insertionOrder(dependencies: TableDependency[]): string[] {
  const remaining = new Map(dependencies.map((row) => [row.table, new Set(row.dependsOn)]));
  const known = new Set(remaining.keys());
  for (const [, deps] of remaining) {
    for (const dep of [...deps]) if (!known.has(dep)) deps.delete(dep);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([table, deps]) => [...deps].every((dep) => placed.has(dep) || dep === table))
      .map(([table]) => table)
      .sort();

    // دورة: لا جدول جاهزًا. يُؤخذ الباقي بترتيب أبجدي ثابت بدل التوقّف.
    const batch = ready.length > 0 ? ready : [...remaining.keys()].sort();
    for (const table of batch) {
      ordered.push(table);
      placed.add(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

/** قيمة واحدة كما تُكتب في SQL. */
export function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Buffer.isBuffer(value)) return `'\\x${value.toString("hex")}'`;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // تضعيف علامة الاقتباس هو ما يمنع أن يكسر اسمٌ فيه فاصلة عليا — «عبدالله'» —
  // ملفَّ النسخة كله فيصير غير قابل للاستعادة.
  return `'${text.replace(/'/g, "''")}'`;
}

export function insertStatement(table: string, columns: string[], row: Record<string, unknown>): string {
  const values = columns.map((column) => sqlValue(row[column])).join(", ");
  return `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${values});`;
}

/**
 * إعادة ضبط العدّادات بعد الاستعادة.
 *
 * بلا هذا يبدأ العدّاد من واحد فوق بيانات مستعادة، فتصطدم أول فاتورة جديدة برقم
 * موجود — واستعادةٌ تبدو ناجحة ثم تنفجر عند أول عملية أسوأ من استعادة تفشل صراحةً.
 */
export function sequenceResets(tables: string[]): string[] {
  return tables.map((table) =>
    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), ` +
    `COALESCE((SELECT MAX(id) FROM ${table}), 1), ` +
    `(SELECT MAX(id) IS NOT NULL FROM ${table})) ` +
    `WHERE pg_get_serial_sequence('${table}', 'id') IS NOT NULL;`,
  );
}

export function backupFileName(clinicDate: string, clinicTime: string): string {
  return `aqlan-center-${clinicDate}_${clinicTime.replace(":", "")}.sql`;
}
