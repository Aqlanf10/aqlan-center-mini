/**
 * (P-01) حارس تجميع المال — ماسحٌ ساكنٌ دلاليّ لا يجتمع عبر العملات.
 *
 * القاعدة المحاسبية التي يحرسها (D-1):
 *
 *   الفاتورة بلا سعر صرفٍ مسجَّل — فجمعُ قيمها خارج عملتها تزويرٌ محاسبي.
 *   والدفعات لكلٍّ منها عملتها؛ فجمع مبالغها بلا بعد العملة رقمٌ بلا معنى.
 *   والمكافئ الأساسي المسجَّل (base_amount_minor) بوحدات الأساس أصلًا فيُجمع
 *   حلالًا — هو العقد الموثَّق لا تحويلًا بسعر اليوم.
 *
 * يُمسح كل SUM على أعمدة المال:
 *   * total_minor / discount_minor / unit_price_minor (فواتير وبنودها وخططها):
 *     يلزم بعد العملة — GROUP BY base_currency، أو تجميعٌ لكل فاتورة/خطة
 *     بعينها (المجموعة الواحدة عملة واحدة)، أو فلتر عملةٍ واحدة.
 *   * amount_minor (دفعات ومصاريف): يلزم GROUP BY currency أو فلتر عملة.
 *   * base_amount_minor: معفى — وحدات الأساس بحكم البنية.
 *   * patient_opening_balances: (P1-5ب) صار بعملته — يلزم بعد العملة كالدفعات.
 *
 * هذا حراسة انحدارٍ لا تحليلًا كاملًا: الماسح يحذر عند أي جمعٍ جديدٍ بلا بعد
 * عملة، فلا يعود P0-1 من النافذة التي دخل منها أول مرة.
 */

export interface MoneyAggregationViolation {
  file: string;
  line: number;
  column: string;
  reason: string;
  /** مقتطفٌ موجزٌ للعرض (أول 200 حرف). */
  sqlExcerpt: string;
  /** نص الجملة SQL كاملًا — تُطابَق عليه الاستثناءات الموثَّقة؛ فالجملة
   * الطويلة قد يتجاوز فيها موضع الدفعات مقتطف العرض، فيفلت الاستثناء
   * الموثَّق من المطابقة ويُحاسَب البريء. المطابقة على النص الكامل لا
   * على المقتطف المقتطع. */
  sqlSegment: string;
}

/** أعمدة الفواتير وبنودها وخططها — تُقاس بعملتها (base_currency). */
const INVOICE_MONEY_COLUMNS = new Set(["total_minor", "discount_minor", "unit_price_minor"]);

/** أعمدة الدفعات والمصاريف — تُقاس بعملتها (currency). */
const PAYMENT_MONEY_COLUMNS = new Set(["amount_minor"]);

/** جداول الفواتير والبنود والخطط — كل صفٍّ منها بعملةٍ واحدة محدَّدة. */
const INVOICE_TABLES = new Set(["invoices", "invoice_items", "treatment_plans"]);

/** جداول الدفعات والمصاريف — الدفعة بعملتها والمصروف بعملته. */
const PAYMENT_TABLES = new Set(["payments", "expenses", "patient_opening_balances"]);

/** جداول أساسية بنيويًّا — لا عمود عملة فيها أصلًا فالجمع فيها حلال.
 *  (P1-5ب) الرصيد الافتتاحي خرج منها: صار صفًّا لكل (مريض، عملة). */
const STRUCTURALLY_BASE_TABLES = new Set<string>([]);

const SUM_PATTERN = /SUM\s*\(/g;
const TABLE_REFERENCE_PATTERN =
  /(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;

/** كلمات SQL المحجوزة — لا تُعدّ اسمًا مستعارًا لجدول (FROM x WHERE…). */
const SQL_KEYWORDS = new Set([
  "where", "on", "group", "order", "left", "right", "inner", "outer", "join", "having",
  "limit", "union", "select", "from", "and", "or", "not", "values", "set", "using",
  "when", "then", "case", "else", "as", "desc", "asc", "between", "in", "exists",
  "distinct", "filter", "over", "partition", "by", "cross", "full", "natural", "with",
  "returning", "conflict", "do", "nothing", "only",
]);

/** أعمدة المال كلها — لاكتشافها داخل عبارات SUM المركَّبة. */
const ALL_MONEY_COLUMNS = [...INVOICE_MONEY_COLUMNS, ...PAYMENT_MONEY_COLUMNS];

/** يجد قوس الإغلاق الموازي لقوس SUM المفتوح (مع تداخل الأقواس). */
function findClosingParen(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "(") depth++;
    if (source[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** أعمدة المال الواردة داخل نص عبارة SUM (مع مقدِّر الاسم أو بدونه). */
function moneyColumnsIn(expression: string): string[] {
  const columns: string[] = [];
  for (const column of ALL_MONEY_COLUMNS) {
    // النقطة قبل الاسم مقدِّرُ عمودٍ (it.total_minor) لا جزءٌ من اسمٍ آخر.
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${column}(?![A-Za-z0-9_])`, "i");
    if (pattern.test(expression)) columns.push(column);
  }
  return columns;
}

/** أسماء الجداول المُشار إليها في نص SQL مع كل أسمائها المستعارة ("" = مرجع بلا اسم). */
function referencedTables(sql: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const match of sql.matchAll(TABLE_REFERENCE_PATTERN)) {
    const table = match[1]?.toLowerCase() ?? "";
    const aliasRaw = (match[2] ?? "").toLowerCase();
    // كلمة محجوزة بعد اسم الجدول ليست اسمًا مستعارًا — `FROM invoices WHERE…`.
    const alias = SQL_KEYWORDS.has(aliasRaw) ? "" : aliasRaw;
    if (!table) continue;
    const list = tables.get(table) ?? [];
    if (alias && !list.includes(alias)) list.push(alias);
    if (!alias && !list.includes("")) list.push("");
    tables.set(table, list);
  }
  return tables;
}

/** نص GROUP BY / PARTITION BY كاملًا (أول بندٍ من كل نوع في الجملة). */
function groupingClause(sql: string): string {
  const match = sql.match(/GROUP\s+BY([^]+?)(?=\bHAVING\b|\bORDER\b|\bLIMIT\b|\bWHERE\b|\)|$)/i)
    ?? sql.match(/GROUP\s+BY([^]+)$/i);
  return (match?.[1] ?? "").trim();
}

function partitionClause(sql: string): string {
  const match = sql.match(/PARTITION\s+BY\s+([^]+?)(?=\)|ORDER\s+BY|$)/i);
  return (match?.[1] ?? "").trim();
}

/** فلتر عملة واحدة حرفي: WHERE base_currency = 'YER' ونحوه. */
function singleCurrencyFilter(sql: string, currencyColumn: "base_currency" | "currency"): boolean {
  const pattern = new RegExp(`${currencyColumn}\\s*=\\s*'[^']+'`, "i");
  return pattern.test(sql);
}

function clauseMentions(clause: string, token: string): boolean {
  // "currency" يقصد بها ذكر الاسم نفسه لا "base_currency" — فالمقارنة دقيقة اللفظ.
  const tokenPattern = new RegExp(`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`, "i");
  return tokenPattern.test(clause);
}

/**
 * هل التجميع لكل فاتورة/خطة بعينها؟ المجموعة الواحدة عملة واحدة حكامًا:
 * التجميع على مفتاح الفاتورة (invoice_id / <alias>.id) أو الخطة (plan_id).
 */
function groupsPerCurrencyEntity(sql: string, tables: Map<string, string[]>): boolean {
  const grouping = `${groupingClause(sql)} ${partitionClause(sql)}`;
  for (const [table, aliases] of tables) {
    if (table === "invoices" || table === "invoice_items") {
      if (clauseMentions(grouping, "invoice_id")) return true;
      if (table === "invoices") {
        for (const alias of aliases) {
          if (alias ? clauseMentions(grouping, `${alias}.id`) : clauseMentionsUnqualifiedId(grouping)) {
            return true;
          }
        }
      }
    }
    if (table === "treatment_plans") {
      if (clauseMentions(grouping, "plan_id")) return true;
      for (const alias of aliases) {
        if (alias ? clauseMentions(grouping, `${alias}.id`) : clauseMentionsUnqualifiedId(grouping)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** "id" مجردًا لا "<alias>.id" — مفتاح الجدول غير المسمّى. */
function clauseMentionsUnqualifiedId(clause: string): boolean {
  return /(?<![A-Za-z0-9_.])id(?![A-Za-z0-9_])/i.test(clause);
}

/** أوسع قوس نصيّ يحتوي الفهرس: أقرب علامة اقتباس قبل وبعد. */
function enclosingSegment(source: string, index: number): string {
  const backtickBefore = source.lastIndexOf("`", index);
  const backtickAfter = source.indexOf("`", index);
  if (backtickBefore >= 0 && backtickAfter >= 0) {
    const segment = source.slice(backtickBefore, backtickAfter + 1);
    if (looksLikeSql(segment)) return segment;
  }
  const quoteBefore = Math.max(source.lastIndexOf("'", index), source.lastIndexOf('"', index));
  const quoteAfter = Math.min(
    source.indexOf("'", index) === -1 ? source.length : source.indexOf("'", index),
    source.indexOf('"', index) === -1 ? source.length : source.indexOf('"', index),
  );
  if (quoteBefore >= 0 && quoteAfter >= 0 && quoteAfter > quoteBefore) {
    const segment = source.slice(quoteBefore, quoteAfter + 1);
    if (looksLikeSql(segment)) return segment;
  }
  // ليست داخل قوس نصيّ (تجميعٌ في JS أو كود آخر) — خارج نطاق حارس SQL هذا.
  return "";
}

function looksLikeSql(segment: string): boolean {
  return /\bSELECT\b|\bFROM\b|\bUPDATE\b/i.test(segment);
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * يمسح مصدر ملفٍ واحد بحثًا عن تجميع SUM على أعمدة المال بلا بعد العملة.
 * العبارة قد تكون مركَّبة (SUM(GREATEST(0, total_minor - discount_minor))) فيُفحص
 * داخلها عن أعمدة المال. يُعاد كشفٌ لكل مخالفة: ملف، سطر، أعمدة، سبب، ومقتطف.
 */
export function scanMoneyAggregation(source: string, filePath: string): MoneyAggregationViolation[] {
  const violations: MoneyAggregationViolation[] = [];
  for (const match of source.matchAll(SUM_PATTERN)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1;
    const closeIndex = findClosingParen(source, openIndex);
    if (closeIndex < 0) continue;
    const expression = source.slice(openIndex + 1, closeIndex);
    const columns = moneyColumnsIn(expression);
    if (columns.length === 0) continue;

    const index = match.index ?? 0;
    const segment = enclosingSegment(source, index);
    // المجموع خارج SQL نصيّ (تجميع JavaScript) — لا يُحرس هنا.
    if (!segment) continue;

    const tables = referencedTables(segment);
    const tableNames = new Set(tables.keys());
    const grouping = `${groupingClause(segment)} ${partitionClause(segment)}`;

    const touchesInvoiceTables = [...tableNames].some((table) => INVOICE_TABLES.has(table));
    const touchesPaymentTables = [...tableNames].some((table) => PAYMENT_TABLES.has(table));

    const invoiceColumns = columns.filter((column) => INVOICE_MONEY_COLUMNS.has(column));
    const paymentColumns = columns.filter((column) => PAYMENT_MONEY_COLUMNS.has(column));

    // رصيد افتتاحي أساسي وحده: جمعه حلال بنيويًّا.
    const onlyStructural = [...tableNames].every((table) => STRUCTURALLY_BASE_TABLES.has(table));
    if (onlyStructural) continue;

    if (invoiceColumns.length > 0 && touchesInvoiceTables) {
      const grouped = clauseMentions(grouping, "base_currency");
      const perEntity = groupsPerCurrencyEntity(segment, tables);
      const filtered = singleCurrencyFilter(segment, "base_currency");
      if (!grouped && !perEntity && !filtered) {
        violations.push({
          file: filePath,
          line: lineOf(source, index),
          column: invoiceColumns.join(", "),
          reason: "جمع أعمدة فواتير/بنود/خطط بلا بعد عملة: لا GROUP BY base_currency ولا تجميع لكل فاتورة/خطة ولا فلتر عملة واحدة",
          sqlExcerpt: segment.slice(0, 200).replace(/\s+/g, " "),
          sqlSegment: segment,
        });
      }
    }
    if (paymentColumns.length > 0 && touchesPaymentTables) {
      const grouped = clauseMentions(grouping, "currency");
      const filtered = singleCurrencyFilter(segment, "currency");
      if (!grouped && !filtered) {
        violations.push({
          file: filePath,
          line: lineOf(source, index),
          column: paymentColumns.join(", "),
          reason: "جمع مبالغ دفعات/مصاريف بلا بعد عملة: لا GROUP BY currency ولا فلتر عملة واحدة",
          sqlExcerpt: segment.slice(0, 200).replace(/\s+/g, " "),
          sqlSegment: segment,
        });
      }
    }
    // base_amount_minor وسواه: معفى — المكافئ المسجَّل بوحدات الأساس بحكم البنية.
  }
  return violations;
}

/**
 * الاستثناءات الموثَّقة — جمعٌ يبدو مخالفًا للقاعدة العامة لكنه سليمٌ لسببٍ
 * دلاليّ لا يبلغه التحليل الساكن، أو نطاقُه finding مسجَّل يُصلَح لاحقًا.
 * كل استثناءٍ بسببٍ مكتوب؛ وبلا سببٍ لا استثناء.
 */
export interface MoneyGuardAllowlistEntry {
  file: string;
  /** نمط نصيّ يميّز الموضع داخل الملف (يُطابق مقتطف SQL). */
  contains: string;
  reason: string;
}

export const MONEY_GUARD_ALLOWLIST: MoneyGuardAllowlistEntry[] = [
  {
    file: "lib/db.ts",
    contains: "FROM payments WHERE reversal_of_id = $1",
    reason: "(TD-05) سلسلة استردادٍ لأصلٍ واحد: كل الردود ترث عملة الدفعة الأصل تحت قفل السلسلة — عملة واحدة حكامًا، لا مزيج",
  },
  {
    file: "lib/db.ts",
    contains: "FROM payments y WHERE y.plan_id = t.id",
    reason: "(TD-05) استعلامٌ مرتبطٌ لكل خطةٍ على حدة: الدفعات تُسوَّى بدلو عملة الخطة نفسها (بمبلغها إن وافقت وبمكافئها المسجَّل وإلا) — دلو واحد حكامًا",
  },
  {
    file: "lib/reports.ts",
    contains: "FROM plan_items pi WHERE pi.plan_id = tp.id AND pi.status <> 'cancelled'",
    reason: "(Reports R4) أوزان تخصصات خطةٍ واحدة: بنودها كلها بعملة خطتها نفسها، والناتج نِسبٌ لتوزيع قيمة الخطة بعملتها — دلو واحد حكامًا",
  },
  {
    file: "lib/reports.ts",
    contains: "FROM plan_items pi WHERE pi.plan_id = tp.id AND pi.status = 'done'",
    reason: "(Reports R4) المنفّذ من خطةٍ واحدة: استعلامٌ مرتبط لكل خطة وبنودها بعملة الخطة نفسها، ويُحصر بقيمة الخطة — دلو واحد حكامًا",
  },
  {
    file: "scripts/verify-executive.mjs",
    contains: "SUM(total_minor),0)::bigint AS total",
    reason: "(P-01 finding: TD-REG-027) سلسلة الرصيد المشتق للوحة التنفيذية — مسجَّل كدينٍ تقنيّ لا يُصلَح ضمن P-01 (نطاق الـfindings المسجَّلة)",
  },
  {
    file: "scripts/verify-backup.mjs",
    contains: "FROM payments) AS paid",
    reason: "(رحلة النسخ الاحتياطي) بذرة الرحلة يمنيّة العملة حصرًا (YER) والمجموع إثباتُ استعادةٍ لا تقريرُ عملات — تُثبَّت البذرة كذلك في الرحلة",
  },
  {
    file: "scripts/verify-backup.mjs",
    contains: "FROM expenses)  AS spent",
    reason: "(رحلة النسخ الاحتياطي) بذرة الرحلة يمنيّة العملة حصرًا (YER) — إثبات استعادة لا تقرير عملات",
  },
];
