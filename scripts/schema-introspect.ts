/**
 * استخراج عقد المخطط الحالي من قاعدةٍ حيّة — مصدرُ حقيقةٍ واحد للتوليد والتحقّق.
 *
 * لِمَ لا نصّ الـSQL الخام للقيود والفهارس؟ لأن صياغة PostgreSQL لها تتغيّر بين
 * الإصدارات الكبرى، فيصير الفحص حسّاسًا لترقية الخادم لا لتغيّر المخطط: يحمرّ في CI
 * على PG18 وقد وُلِّد العقد على PG16 بلا أن يتبدّل حرفٌ في `lib/db.ts`. فالمحفوظ هنا
 * البنية لا الصياغة: اسم النوع الداخلي (`udt_name`) وقابليةُ العدم، وأعمدةُ المفتاح
 * والفرادة والإشارة، وأسماءُ قيود الفحص، وأعمدةُ الفهارس وفرادتها، وتوقيتُ
 * المُشغِّلات وأحداثها.
 */

export interface TableContract {
  columns: Record<string, { type: string; nullable: boolean }>;
  primaryKey: string[];
  unique: string[][];
  checks: string[];
  foreignKeys: { columns: string[]; refTable: string; refColumns: string[] }[];
  indexes: Record<string, { columns: string[]; unique: boolean }>;
  triggers: Record<string, { timing: string; events: string[] }>;
}

export interface SchemaContract {
  format: "aqlan-current-schema-contract";
  formatVersion: 1;
  generatedBy: string;
  /** إصدار الخادم الذي وُلّد عليه العقد — يُقال ولا يُخفى. */
  generatedOnServerVersion: string;
  counts: { tables: number; columns: number; constraints: number; indexes: number; triggers: number };
  tables: Record<string, TableContract>;
}

interface Queryable { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }

const sortColumns = (a: string[], b: string[]) => a.join(",").localeCompare(b.join(","));

export async function introspectSchema(client: Queryable): Promise<SchemaContract> {
  const { rows: versionRows } = await client.query("SHOW server_version");
  const { rows: tableRows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const tables: Record<string, TableContract> = {};
  for (const { table_name: name } of tableRows) {
    tables[name] = {
      columns: {}, primaryKey: [], unique: [], checks: [], foreignKeys: {} as never, indexes: {}, triggers: {},
    } as TableContract;
    tables[name].foreignKeys = [];
  }

  const { rows: columnRows } = await client.query(
    `SELECT table_name, column_name, udt_name, is_nullable
       FROM information_schema.columns WHERE table_schema = 'public'
      ORDER BY table_name, column_name`,
  );
  for (const row of columnRows) {
    const table = tables[row.table_name];
    if (!table) continue;
    table.columns[row.column_name] = { type: row.udt_name, nullable: row.is_nullable === "YES" };
  }

  /* القيود من الفهرس النظاميّ مباشرة: أعمدةٌ بترتيبها للمفتاح الأساسي، ومجموعاتٌ
     مرتّبة للفرادة والإشارة — فلا يقلب اختلافُ الترتيب نتيجةَ المقارنة. */
  const { rows: constraintRows } = await client.query(
    `SELECT c.conname::text AS conname, c.contype, t.relname::text AS table_name,
            COALESCE(ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                           ORDER BY k.ord), '{}'::text[]) AS cols,
            ft.relname::text AS ref_table,
            COALESCE(ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                            JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                           ORDER BY k.ord), '{}'::text[]) AS ref_cols
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
       LEFT JOIN pg_class ft ON ft.oid = c.confrelid
      WHERE ns.nspname = 'public' AND t.relkind = 'r'
      ORDER BY t.relname, c.conname`,
  );
  let constraintCount = 0;
  for (const row of constraintRows) {
    const table = tables[row.table_name];
    if (!table) continue;
    constraintCount += 1;
    if (row.contype === "p") table.primaryKey = row.cols;
    else if (row.contype === "u") table.unique.push(row.cols);
    else if (row.contype === "c") table.checks.push(row.conname);
    else if (row.contype === "f") {
      table.foreignKeys.push({ columns: row.cols, refTable: row.ref_table, refColumns: row.ref_cols });
    }
  }

  const { rows: indexRows } = await client.query(
    `SELECT t.relname::text AS table_name, i.relname::text AS index_name, ix.indisunique AS is_unique,
            ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                  ORDER BY k.ord) AS cols
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
      WHERE ns.nspname = 'public' AND t.relkind = 'r'
      ORDER BY t.relname, i.relname`,
  );
  let indexCount = 0;
  for (const row of indexRows) {
    const table = tables[row.table_name];
    if (!table) continue;
    indexCount += 1;
    table.indexes[row.index_name] = { columns: row.cols, unique: row.is_unique };
  }

  const { rows: triggerRows } = await client.query(
    `SELECT t.relname::text AS table_name, tg.tgname::text AS trigger_name, tg.tgtype
       FROM pg_trigger tg
       JOIN pg_class t ON t.oid = tg.tgrelid
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
      WHERE ns.nspname = 'public' AND NOT tg.tgisinternal
      ORDER BY t.relname, tg.tgname`,
  );
  let triggerCount = 0;
  for (const row of triggerRows) {
    const table = tables[row.table_name];
    if (!table) continue;
    triggerCount += 1;
    const type = Number(row.tgtype);
    const events: string[] = [];
    if (type & 4) events.push("INSERT");
    if (type & 8) events.push("DELETE");
    if (type & 16) events.push("UPDATE");
    if (type & 32) events.push("TRUNCATE");
    table.triggers[row.trigger_name] = {
      timing: (type & 2) ? "BEFORE" : (type & 64) ? "INSTEAD OF" : "AFTER",
      events,
    };
  }

  /* ترتيبٌ ثابت للمجموعات — الملف المولَّد يجب أن يكون نفسه بايتًا ببايت في كل
     توليد، وإلا صار كل توليدٍ فرقًا كاذبًا في المراجعة. */
  let columnCount = 0;
  const ordered: Record<string, TableContract> = {};
  for (const name of Object.keys(tables).sort()) {
    const table = tables[name];
    columnCount += Object.keys(table.columns).length;
    ordered[name] = {
      columns: Object.fromEntries(Object.entries(table.columns).sort(([a], [b]) => a.localeCompare(b))),
      primaryKey: table.primaryKey,
      unique: table.unique.sort(sortColumns),
      checks: table.checks.sort(),
      foreignKeys: table.foreignKeys.sort((a, b) =>
        (a.refTable + a.columns.join(",")).localeCompare(b.refTable + b.columns.join(","))),
      indexes: Object.fromEntries(Object.entries(table.indexes).sort(([a], [b]) => a.localeCompare(b))),
      triggers: Object.fromEntries(Object.entries(table.triggers).sort(([a], [b]) => a.localeCompare(b))),
    };
  }

  return {
    format: "aqlan-current-schema-contract",
    formatVersion: 1,
    generatedBy: "ensureSchema()",
    generatedOnServerVersion: String(versionRows[0]?.server_version ?? "unknown"),
    counts: {
      tables: Object.keys(ordered).length,
      columns: columnCount,
      constraints: constraintCount,
      indexes: indexCount,
      triggers: triggerCount,
    },
    tables: ordered,
  };
}
