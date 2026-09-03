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
 * ترتيب طوبولوجي، والدورات — سلسلة جداول يشير آخرها إلى أولها، لا زوجًا فقط —
 * تُجمَّع بخوارزمية Tarjan في «عقدة» واحدة تُرتَّب داخليًا أبجديًا إذ لا ترتيب صحيح
 * لها أصلًا، ثم تُرتَّب العقد نفسها طوبولوجيًا فيما بينها.
 *
 * هذا يفرّق بين مشكلتين كانتا تُخلَطان في التنفيذ الأول: الدورة ذاتها (لا حلّ لها
 * غير كسرها)، وجدولٌ يعتمد على عضوٍ في دورة (له حلّ صحيح: بعد الدورة كاملة) — فكان
 * التنفيذ الأول يُسقط كل الجداول المتبقّية — الدورة وكل من يعتمد عليها، ولو بعيدًا —
 * في دفعة أبجدية واحدة، فيسبق أحيانًا جدولٌ معتمِدٌ جدوله المعتمَد عليها فعليًا.
 */
export function insertionOrder(dependencies: TableDependency[]): string[] {
  const known = new Set(dependencies.map((row) => row.table));
  const deps = new Map(
    dependencies.map((row) => [
      row.table,
      [...new Set(row.dependsOn)].filter((dep) => known.has(dep) && dep !== row.table),
    ]),
  );

  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let nextIndex = 0;

  // تكرارية بدل الاستدعاء الذاتي: عدد الجداول محدود، لكن سلامة المكدّس أولى من
  // إيجاز الاستدعاء الذاتي.
  function strongConnect(start: string): void {
    const callStack: { table: string; depIndex: number }[] = [{ table: start, depIndex: 0 }];
    indices.set(start, nextIndex);
    lowlink.set(start, nextIndex);
    nextIndex += 1;
    stack.push(start);
    onStack.add(start);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const tableDeps = deps.get(frame.table) ?? [];
      if (frame.depIndex < tableDeps.length) {
        const dep = tableDeps[frame.depIndex];
        frame.depIndex += 1;
        if (!indices.has(dep)) {
          indices.set(dep, nextIndex);
          lowlink.set(dep, nextIndex);
          nextIndex += 1;
          stack.push(dep);
          onStack.add(dep);
          callStack.push({ table: dep, depIndex: 0 });
        } else if (onStack.has(dep)) {
          lowlink.set(frame.table, Math.min(lowlink.get(frame.table)!, indices.get(dep)!));
        }
      } else {
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1];
          lowlink.set(parent.table, Math.min(lowlink.get(parent.table)!, lowlink.get(frame.table)!));
        }
        if (lowlink.get(frame.table) === indices.get(frame.table)) {
          const component: string[] = [];
          let member: string;
          do {
            member = stack.pop()!;
            onStack.delete(member);
            component.push(member);
          } while (member !== frame.table);
          components.push(component.sort());
        }
      }
    }
  }

  for (const table of [...known].sort()) if (!indices.has(table)) strongConnect(table);

  // Tarjan يُخرج كل عقدة بعد أن تُستكشف عقد كل من تعتمد عليه — أي بترتيبٍ
  // يضع المعتمَد عليه قبل المعتمِد مباشرة، فلا حاجة لعكسه.
  return components.flat();
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
