import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbPool, QueryResult } from "../lib/db";
import type { BaselineSchemaManifest } from "../lib/schema-manifest";
import manifestJson from "../schema/baseline-schema-manifest.pg18.json";

/**
 * اختبارات تحقق خط أساس الإنتاج (وحدة — بلا قاعدة).
 *
 * الفيكسر يُعاد بناؤه من المرجع الملتزم نفسه (معكوس إسقاط الكتالوج) فيثبت:
 * مرجع سليم ⇒ compatible=true، وأي انحراف مفرد ⇒ fail-closed مع عدّاد صحيح،
 * وأن مسار runtime كله SELECT فقط (5 استعلامات كتالوج).
 */

const manifest = manifestJson as unknown as BaselineSchemaManifest;

interface CatalogFixture {
  tables: { table_name: string }[];
  columns: Record<string, unknown>[];
  constraints: Record<string, unknown>[];
  indexes: { indexdef: string }[];
  triggers: Record<string, unknown>[];
}

function constraintContype(def: string): string {
  if (def.startsWith("PRIMARY KEY")) return "p";
  if (def.startsWith("FOREIGN KEY")) return "f";
  if (def.startsWith("UNIQUE")) return "u";
  if (def.startsWith("NOT NULL")) return "n";
  return "c";
}

/** معكوس الإسقاط: manifest ⇒ صفوف كتالوج تُعيد نفس الإسقاط حرفيًّا. */
function fixtureFromManifest(target: BaselineSchemaManifest): CatalogFixture {
  const columns = Object.entries(target.columns).flatMap(([table, perTable]) =>
    Object.entries(perTable).map(([column, signature]) => {
      const parts = signature.split("|");
      const [data_type, charMax, numPrec, numScale, dtPrec, isNullable] = parts;
      const columnDefault = parts.length > 7 ? parts.slice(6).join("|") : (parts[6] || null);
      return {
        table_name: table,
        column_name: column,
        data_type,
        character_maximum_length: charMax === "" ? null : Number(charMax),
        numeric_precision: numPrec === "" ? null : Number(numPrec),
        numeric_scale: numScale === "" ? null : Number(numScale),
        datetime_precision: dtPrec === "" ? null : Number(dtPrec),
        is_nullable: isNullable,
        column_default: columnDefault,
      };
    }),
  );

  const constraints = target.constraints.map((entry, index) => {
    const separator = entry.indexOf("|");
    const table = entry.slice(0, separator);
    const def = entry.slice(separator + 1);
    return {
      table_name: table,
      conname: `fixture_c_${index}`,
      contype: constraintContype(def),
      def,
    };
  });

  const triggers = target.triggers.flatMap((entry) => {
    const [table, name, timing, events, statement] = entry.split("|");
    return events.split(",").map((event) => ({
      trigger_name: name,
      event_object_table: table,
      action_timing: timing,
      event_manipulation: event,
      action_statement: statement,
    }));
  });

  return {
    tables: target.tables.map((table) => ({ table_name: table })),
    columns,
    constraints,
    indexes: target.indexes.map((indexdef) => ({ indexdef })),
    triggers,
  };
}

function fixturePool(
  fixture: CatalogFixture,
  options: { failOnCall?: number; failTimes?: number } = {},
): { pool: DbPool; sql: string[] } {
  const sql: string[] = [];
  const answer = (statement: string): QueryResult => {
    if (/information_schema\.tables/i.test(statement)) return { rows: fixture.tables };
    if (/information_schema\.columns/i.test(statement)) return { rows: fixture.columns };
    if (/pg_constraint/i.test(statement)) return { rows: fixture.constraints };
    if (/pg_indexes/i.test(statement)) return { rows: fixture.indexes };
    if (/information_schema\.triggers/i.test(statement)) return { rows: fixture.triggers };
    throw new Error(`fixture pool: استعلام غير متوقع: ${statement}`);
  };
  const query = vi.fn(async (statement: string) => {
    sql.push(statement);
    if (options.failTimes !== undefined && sql.length <= options.failTimes) {
      throw new Error("connection lost"); // فشل عابر: أول N استدعاء فقط
    }
    if (options.failOnCall !== undefined && sql.length >= options.failOnCall) {
      throw new Error("connection lost");
    }
    return answer(statement);
  });
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as unknown as DbPool;
  return { pool, sql };
}

afterEach(() => {
  delete process.env.SCHEMA_BASELINE_VERIFY_ONCE;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("committed baseline manifest reference", () => {
  it("loads the committed manifest with sound invariants and freezes it", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const reference = mod.committedBaselineManifest();

    expect(reference.format).toBe("aqlan-baseline-schema-manifest");
    expect(reference.formatVersion).toBe(1);
    expect(reference.migrationVersion).toBe("0001");
    expect(reference.postgresMajor).toBe(18);
    expect(reference.baselineSqlSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reference.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(reference.checked.tables).toBeGreaterThan(40);
    expect(reference.checked.columns).toBeGreaterThan(200);
    expect(Object.isFrozen(reference)).toBe(true);
  });
});

describe("verifySchemaBaseline (SELECT-only production gate)", () => {
  it("reports compatible=true with exact counts and only 5 catalog SELECTs", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const { pool, sql } = fixturePool(fixtureFromManifest(manifest));

    const result = await mod.verifySchemaBaseline(pool);

    expect(result.compatible).toBe(true);
    expect(result.postgresMajor).toBe(18);
    expect(result.checked).toEqual(manifest.checked);
    expect(result.missingTables).toBe(0);
    expect(result.columnProblems).toBe(0);
    expect(result.missingConstraints).toBe(0);
    expect(result.missingIndexes).toBe(0);
    expect(result.missingTriggers).toBe(0);
    expect(sql).toHaveLength(5);
    expect(sql.every((statement) => /^SELECT\b/i.test(statement.trim()))).toBe(true);
    expect(sql.join("\n")).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|COMMENT|CALL)\b/i,
    );
  });

  it("fails closed with a counted diff when an index is missing", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const fixture = fixtureFromManifest(manifest);
    const dropped = fixture.indexes.splice(3, 1)[0];

    const { pool, sql } = fixturePool(fixture);
    const result = await mod.verifySchemaBaseline(pool);

    expect(result.compatible).toBe(false);
    expect(result.missingIndexes).toBe(1);
    const droppedName = String((dropped as { indexdef: string }).indexdef).match(/INDEX ([a-z_]+)/i)?.[1] ?? "";
    expect(result.samples.missingIndexes.some((entry) => entry.includes(droppedName))).toBe(true);
    expect(sql).toHaveLength(5);
  });

  it("fails closed with a counted diff when a table and its columns are missing", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const fixture = fixtureFromManifest(manifest);
    const victim = fixture.tables[10].table_name;
    fixture.tables.splice(10, 1);
    fixture.columns = fixture.columns.filter((column) => column.table_name !== victim);

    const { pool } = fixturePool(fixture);
    const result = await mod.verifySchemaBaseline(pool);

    expect(result.compatible).toBe(false);
    expect(result.missingTables).toBe(1);
    expect(result.samples.missingTables).toContain(victim);
    expect(result.columnProblems).toBe(0); // أعمدة الجدول الناقص لا تُعد مرتين
  });

  it("logs counts only and never throws — one-shot under an explicit production flag", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const { pool, sql } = fixturePool(fixtureFromManifest(manifest));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "production");
    // بلا علم صريح ⇒ لا شيء إطلاقًا.
    await mod.logSchemaBaselineVerifyOnce(pool);
    expect(sql).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();

    // بالعلم ⇒ يعمل مرة واحدة ويسجل compatible=true بعدّادات فقط.
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "true");
    await mod.logSchemaBaselineVerifyOnce(pool);
    expect(sql).toHaveLength(5);
    expect(info).toHaveBeenCalledTimes(1);
    const logged = String(info.mock.calls[0][0]);
    expect(logged).toContain("[schema-baseline] compatible=true");
    expect(logged).toContain("tables=55");
    expect(logged).not.toContain("postgresql://");

    // المرة الثانية ⇒ صفر استعلامات (one-shot).
    await mod.logSchemaBaselineVerifyOnce(pool);
    expect(sql).toHaveLength(5);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not run when the flag is false or not exactly \"true\" (strict opt-in)", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const { pool, sql } = fixturePool(fixtureFromManifest(manifest));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "production");

    // flag=false صراحةً ⇒ لا شيء.
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "false");
    await mod.logSchemaBaselineVerifyOnce(pool);
    expect(sql).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();

    // أي قيمة غير الحرفية "true" لا تفعّل الفحص (opt-in صارم، لا "1" ولا "TRUE").
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "1");
    await mod.logSchemaBaselineVerifyOnce(pool);
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "TRUE");
    await mod.logSchemaBaselineVerifyOnce(pool);
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "yes");
    await mod.logSchemaBaselineVerifyOnce(pool);
    expect(sql).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();
  });

  it("never runs outside a production runtime even with the flag set", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const { pool, sql } = fixturePool(fixtureFromManifest(manifest));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "true");
    delete process.env.DATABASE_ENVIRONMENT;
    delete process.env.RAILWAY_PROJECT_ID;

    await mod.logSchemaBaselineVerifyOnce(pool);
    expect(sql).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();
  });

  it("records a fail-closed drift report without throwing or altering health", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const fixture = fixtureFromManifest(manifest);
    fixture.tables.splice(10, 1);
    const { pool } = fixturePool(fixture);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "true");

    await expect(mod.logSchemaBaselineVerifyOnce(pool)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = String(error.mock.calls[0][0]);
    expect(logged).toContain("[schema-baseline] compatible=false");
    expect(logged).toContain("missing_tables=1");
  });

  it("swallows verification errors into a warning (health path stays intact)", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const { pool } = fixturePool(fixtureFromManifest(manifest), { failOnCall: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "true");

    await expect(mod.logSchemaBaselineVerifyOnce(pool)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[schema-baseline] verification failed");
    // الخطأ البريء يمر كما هو (sanitizeErrorMessage لا يفسده) — وهذا يثبت أن
    // الخطأ لا يُستهلك الone-shot (يُغطى في اختبار إعادة المحاولة أدناه).
    expect(String(warn.mock.calls[0][0])).toContain("connection lost");
  });

  it("sanitizes verification errors — no DB URLs, no credentials, no file paths in the log", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "true");

    const sensitive: Error[] = [
      new Error("DATABASE_URL is invalid: postgresql://user:secret@db.internal:5432/aqlan"),
      new Error("connection refused for postgresql://admin:hunter2@db.internal:5432/aqlan"),
      new Error("ENOENT: no such file or directory, open '/app/.next/trace'"),
      new Error("permission denied reading '/var/lib/postgresql/data/PG_VERSION'"),
    ];
    for (const error of sensitive) {
      const failing = { query: async () => { throw error; } } as unknown as DbPool;
      await mod.logSchemaBaselineVerifyOnce(failing);
    }

    const joined = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(joined).toContain("[schema-baseline] verification failed");
    expect(joined).toContain("تعذّر التحقق من مخطط قاعدة البيانات");
    expect(joined).not.toContain("postgresql://");
    expect(joined).not.toContain("hunter2");
    expect(joined).not.toContain("DATABASE_URL");
    expect(joined).not.toContain("/app/");
    expect(joined).not.toContain("/var/");

    // الخطأ البريء بلا أسرار/مسارات يُسمح له بالمرور كما هو.
    const harmless = { query: async () => { throw new Error("connection lost"); } } as unknown as DbPool;
    await mod.logSchemaBaselineVerifyOnce(harmless);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("connection lost");
  });

  it("transient failure does not consume the one-shot — retry runs and logs compatible=true", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    // failTimes: 1 ⇒ الاستعلام الأول فقط يفشل، ثم كل شيء ينجح.
    const { pool, sql } = fixturePool(fixtureFromManifest(manifest), { failTimes: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "true");

    // (A) أول استدعاء: استعلام أول يفشل "connection lost" ⇒ تحذير معقّم فقط.
    await mod.logSchemaBaselineVerifyOnce(pool);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[schema-baseline] verification failed");
    expect(info).not.toHaveBeenCalled();

    // (B) الاستدعاء الثاني يعمل من جديد — العطل العابر لم يستهلك الفرصة.
    await mod.logSchemaBaselineVerifyOnce(pool);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("[schema-baseline] compatible=true");
    // استعلام المحاولة الفاشلة + 5 المحاولة الناجحة.
    expect(sql).toHaveLength(6);
  });

  it("drift is a real completed result — logged once, never rerun", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const fixture = fixtureFromManifest(manifest);
    fixture.tables.splice(10, 1);
    const { pool, sql } = fixturePool(fixture);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "true");

    await mod.logSchemaBaselineVerifyOnce(pool);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("[schema-baseline] compatible=false");

    // الانحراف نتيجة حقيقية سُجّلت ⇒ completed — بلا rerun ولا استعلامات إضافية.
    await mod.logSchemaBaselineVerifyOnce(pool);
    await mod.logSchemaBaselineVerifyOnce(pool);
    expect(error).toHaveBeenCalledTimes(1);
    expect(sql).toHaveLength(5);
  });

  it("concurrent calls share one attempt — 5 catalog SELECTs total, not 10", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const { pool, sql } = fixturePool(fixtureFromManifest(manifest));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SCHEMA_BASELINE_VERIFY_ONCE", "true");

    await Promise.all([
      mod.logSchemaBaselineVerifyOnce(pool),
      mod.logSchemaBaselineVerifyOnce(pool),
      mod.logSchemaBaselineVerifyOnce(pool),
    ]);

    expect(sql).toHaveLength(5);
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("committed manifest deep immutability", () => {
  it("deep-freezes the manifest root and every nested structure", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const reference = mod.committedBaselineManifest();

    expect(Object.isFrozen(reference)).toBe(true);
    expect(Object.isFrozen(reference.tables)).toBe(true);
    expect(Object.isFrozen(reference.constraints)).toBe(true);
    expect(Object.isFrozen(reference.indexes)).toBe(true);
    expect(Object.isFrozen(reference.triggers)).toBe(true);
    expect(Object.isFrozen(reference.columns)).toBe(true);
    expect(Object.isFrozen(reference.checked)).toBe(true);
    for (const perTable of Object.values(reference.columns)) {
      expect(Object.isFrozen(perTable)).toBe(true);
    }
  });

  it("mutation attempts cannot alter the reference or verification results", async () => {
    vi.resetModules();
    const mod = await import("../lib/schema-baseline-verify");
    const reference = mod.committedBaselineManifest();
    const tablesBefore = [...reference.tables];
    const constraintsCount = reference.constraints.length;
    const indexesCount = reference.indexes.length;

    // الوضع الصارم يرمي على المجمّد؛ وإن لم يرمِ فالمحتوى يجب ألا يتغير.
    const attempt = (mutate: () => void) => {
      try {
        mutate();
      } catch { /* مقصود: التجميد يمنع الكتابة */ }
    };
    attempt(() => (reference.tables as unknown as string[]).push("__evil_table"));
    attempt(() => (reference.constraints as unknown as string[]).splice(0, 1));
    attempt(() => ((reference.columns as Record<string, Record<string, string>>).__evil = { id: "text" }));
    attempt(() => (reference.indexes as unknown as string[]).pop());

    expect([...reference.tables]).toEqual(tablesBefore);
    expect(reference.tables).not.toContain("__evil_table");
    expect(reference.constraints).toHaveLength(constraintsCount);
    expect(reference.indexes).toHaveLength(indexesCount);
    expect((reference.columns as Record<string, unknown>).__evil).toBeUndefined();
    expect(reference.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // نتيجة التحقق لم تتأثر بمحاولات الفسخ.
    const { pool, sql } = fixturePool(fixtureFromManifest(manifest));
    const result = await mod.verifySchemaBaseline(pool);
    expect(result.compatible).toBe(true);
    expect(result.checked).toEqual(manifest.checked);
    expect(sql).toHaveLength(5);
  });
});
