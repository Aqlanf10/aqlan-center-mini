import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client, Pool } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { loadMigrationFiles, migrate, MIGRATION_ADVISORY_LOCK_KEY } from "../../lib/migrations";

/**
 * اختبارات قفل advisory للمهاجرين المتزامنين (P1-FIX-2) — PostgreSQL حقيقي.
 *
 * المطلوب من المراجعة المستقلة:
 *  * مهاجران متزامنان ⇒ واحد يمسك القفل ويطبّق، والثاني ينتظر ثم يرى الحالة
 *    محدَّثة، وSQL الهجرة يُنفَّذ مرة واحدة بالضبط.
 *  * القفل يُفكّ في finally حتى مع الخطأ (الهجرة الفاشلة لا تعلّق من بعدها).
 */

assertRealPostgresUrl();
stubPostgresEnv();

/** نسخة من ملفات الهجرات الحقيقية + هجرة «كناري» تعدّ صفًّا واحدًا — عدّاد التنفيذ. */
async function filesWithCanary(dir: string, canarySql: string, version = "0009"): Promise<ReturnType<typeof loadMigrationFiles>> {
  const realDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../migrations");
  await cp(realDir, dir, { recursive: true });
  await writeFile(path.join(dir, `${version}_concurrency_canary.sql`), canarySql);
  return loadMigrationFiles(dir);
}

function poolFor(url: string): Pool {
  return new Pool({ connectionString: url, ssl: false, max: 2 });
}

/** غلاف pool حقيقي بشكل DbPool الذي تتوقعه migrationStatus. */
function poolAsDbPool(pool: Pool) {
  return {
    query: (sql: string, values?: unknown[]) => pool.query(sql, values as never[]),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql: string, values?: unknown[]) => client.query(sql, values as never[]),
        release: () => client.release(),
      };
    },
  } as unknown as Parameters<typeof import("../../lib/migrations").migrationStatus>[0];
}

afterAll(async () => {
  // القواعد المعزولة تُنشأ بلا إسقاط يدوي — بيئة اختبار فقط.
});

describe("قفل advisory للمهاجرين (P1-FIX-2) — PostgreSQL حقيقي", () => {
  it("المفتاح ثابت خاص بالمشروع (حتمي، لا مرتجل)", () => {
    expect(Number.isInteger(MIGRATION_ADVISORY_LOCK_KEY)).toBe(true);
    expect(MIGRATION_ADVISORY_LOCK_KEY).toBeGreaterThan(0);
    expect(MIGRATION_ADVISORY_LOCK_KEY).toBeLessThan(2 ** 48);
  });

  it("مهاجران متزامنان ⇒ واحد يطبّق والثاني ينتظر ثم يرى up-to-date، والكناري نُفِّذ مرة واحدة", async () => {
    const url = await createIsolatedDatabase("aqlan_p1_lock_race");
    const dir = await mkdtemp(path.join(tmpdir(), "aqlan-mig-lock-"));
    try {
      const canary = [
        "CREATE TABLE IF NOT EXISTS migration_canary (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);",
        "INSERT INTO migration_canary (id, n) VALUES (1, 1);",
      ].join("\n");
      const files = await filesWithCanary(dir, canary);
      expect(files.map((file) => file.version)).toContain("0009");

      const poolA = poolFor(url);
      const poolB = poolFor(url);
      try {
        // إطلاق مهاجرين متزامنين فعليًّا على قاعدة فارغة
        const [runA, runB] = await Promise.all([
          migrate(poolA, { apply: true, files }),
          migrate(poolB, { apply: true, files }),
        ]);

        // واحد طبَّق كل شيء، والثاني رأى الحالة محدَّثة فلم ينفّذ شيئًا
        const applied = [runA, runB].filter((run) => run.appliedVersions.length > 0);
        const upToDate = [runA, runB].filter((run) => run.alreadyUpToDate);
        expect(applied).toHaveLength(1);
        expect(upToDate).toHaveLength(1);
        expect(applied[0].appliedVersions.length).toBe(files.length);

        // SQL الهجرة نُفِّذ مرة واحدة بالضبط: الكناري صفّ واحد
        const client = new Client({ connectionString: url, ssl: false });
        await client.connect();
        try {
          const { rows: canaryRows } = await client.query<{ n: number }>(
            "SELECT COUNT(*)::int AS n FROM migration_canary",
          );
          expect(canaryRows[0].n).toBe(1);

          // وكل نسخة مسجَّلة مرة واحدة — لا صفوف ازدواج
          const { rows: versions } = await client.query<{ version: string; n: number }>(
            "SELECT version, COUNT(*)::int AS n FROM schema_migrations GROUP BY version",
          );
          expect(versions).toHaveLength(files.length);
          for (const row of versions) expect(row.n).toBe(1);
        } finally {
          await client.end();
        }
      } finally {
        await poolA.end();
        await poolB.end();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("القفل يُفكّ بعد فشل الهجرة — المهاجر التالي يعمل فورًا بلا تعليق", async () => {
    const url = await createIsolatedDatabase("aqlan_p1_lock_error");
    const dir = await mkdtemp(path.join(tmpdir(), "aqlan-mig-err-"));
    try {
      const badCanary = [
        "CREATE TABLE IF NOT EXISTS mig_err_probe (id INTEGER PRIMARY KEY);",
        "INSERT INTO nonexistent_table VALUES (1); -- فشل متعمَّد",
      ].join("\n");
      const files = await filesWithCanary(dir, badCanary);

      const poolA = poolFor(url);
      try {
        // المحاولة الأولى: تفشل داخل الهجرة — والقفل يجب أن يُفكّ في finally
        await expect(migrate(poolA, { apply: true, files })).rejects.toThrow();
        // جدول الفشل تراجع بالكامل (معاملة)
        const client = new Client({ connectionString: url, ssl: false });
        await client.connect();
        try {
          const { rows } = await client.query<{ exists: boolean }>(
            "SELECT to_regclass('public.mig_err_probe') IS NOT NULL AS exists",
          );
          expect(rows[0].exists).toBe(false);
        } finally {
          await client.end();
        }
      } finally {
        await poolA.end();
      }

      // المحاولة الثانية (بعد إصلاح الملف): تعمل فورًا — القفل غير معلَّق
      await writeFile(path.join(dir, "0009_concurrency_canary.sql"), "SELECT 1;");
      const fixedFiles = await loadMigrationFiles(dir);
      const poolB = poolFor(url);
      try {
        const run = await migrate(poolB, { apply: true, files: fixedFiles });
        // 0001–0005 بقيت مثبَّتة من المحاولة الفاشلة (كل هجرة معاملة مستقلة
        // تراجعت وحدها) — المتبقي الوحيد هو الكناري بعد إصلاحه: القفل غير معلَّق.
        expect(run.appliedVersions).toEqual(["0009"]);
        const status = await (await import("../../lib/migrations")).migrationStatus(
          poolAsDbPool(poolB),
          fixedFiles,
        );
        expect(status.consistent).toBe(true);
      } finally {
        await poolB.end();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("قفل الجلسة نفسه: اتصالان، lock ثم محاولة lock الثانية تنتظر (سلوك advisory الحقيقي)", async () => {
    const url = await createIsolatedDatabase("aqlan_p1_lock_semantics");
    const a = new Client({ connectionString: url, ssl: false });
    const b = new Client({ connectionString: url, ssl: false });
    await a.connect();
    await b.connect();
    try {
      await a.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      const acquired = await b.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked", [MIGRATION_ADVISORY_LOCK_KEY],
      );
      expect(acquired.rows[0].locked).toBe(false); // الثاني لا يمسكه — ينتظر
      // والفك من نفس الاتصال الذي أمسكه
      await a.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      const acquiredNow = await b.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked", [MIGRATION_ADVISORY_LOCK_KEY],
      );
      expect(acquiredNow.rows[0].locked).toBe(true);
      await b.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    } finally {
      await a.end();
      await b.end();
    }
  });
});
