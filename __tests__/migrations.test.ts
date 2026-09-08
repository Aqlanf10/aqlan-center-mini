import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * اختبارات نظام الهجرات (P1.22 — Migrations) على PGlite.
 *
 * الحالات الإلزامية الخمس:
 *  ١) قاعدة فارغة → كل الهجرات تطبَّق.
 *  ٢) قاعدة موجودة على خط الأساس (أنشأتها ensureSchema) → اعتماد بلا فقد بيانات.
 *  ٣) تشغيل ثانٍ → no-op.
 *  ٤) هجرة تفشل في المنتصف → تراجع كامل وحالة صحيحة وإعادة محاولة تنجح.
 *  ٥) بصمة لا تطابق → مكتشفة (fail closed).
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const { getPool, resetPoolForTesting, ensureSchema, listUsers } = await import("@/lib/db");
const {
  migrate, migrationStatus, loadMigrationFiles, checksumOf, BASELINE_VERSION,
} = await import("@/lib/migrations");

let realFiles: Awaited<ReturnType<typeof loadMigrationFiles>>;

beforeEach(async () => {
  await resetPoolForTesting();
  if (!realFiles) realFiles = await loadMigrationFiles();
});

afterEach(async () => {
  await resetPoolForTesting();
});

describe("نظام الهجرات المُرقَّمة", () => {
  it("يحمّل ملفات الهجرات بترتيب حتمي وبصمات صحيحة", async () => {
    expect(realFiles.length).toBeGreaterThanOrEqual(4);
    expect(realFiles[0].version).toBe(BASELINE_VERSION);
    const versions = realFiles.map((file) => file.version);
    expect([...versions].sort()).toEqual(versions);
    for (const file of realFiles) {
      expect(file.checksum).toBe(checksumOf(file.sql));
      expect(file.sql.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("قاعدة فارغة → تطبَّق كل الهجرات وينشأ المخطط كاملًا", async () => {
    const pool = getPool();
    const result = await migrate(pool, { apply: true, files: realFiles });
    expect(result.adoptedBaseline).toBe(false);
    expect(result.appliedVersions).toContain(BASELINE_VERSION);
    for (const file of realFiles) {
      expect(result.appliedVersions).toContain(file.version);
    }

    const status = await migrationStatus(pool, realFiles);
    expect(status.pending).toHaveLength(0);
    expect(status.consistent).toBe(true);
    expect(status.probe.ok).toBe(true);
    // المخطط فعلًا موجود: جدول حرج يعمل
    const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM users");
    expect(Number(rows[0].count)).toBe(0); // migrations لا تبذر بيانات
  });

  it("قاعدة موجودة من النظام الحالي (ensureSchema) → اعتماد خط الأساس بلا تنفيذ ولا فقد بيانات", async () => {
    // قاعدة «إنتاج حالي»: أنشأها ensureSchema (مع بذر الحسابات) قبل معرفة نظام الهجرات.
    await ensureSchema();
    const seeded = await listUsers();
    expect(seeded.length).toBeGreaterThan(0);

    const pool = getPool();
    const result = await migrate(pool, { apply: true, files: realFiles });
    expect(result.adoptedBaseline).toBe(true);

    // البيانات بقيت كما هي — الاعتماد لم يمس صفًّا واحدًا.
    expect(await listUsers()).toHaveLength(seeded.length);

    const status = await migrationStatus(pool, realFiles);
    expect(status.consistent).toBe(true);
    expect(status.pending).toHaveLength(0);
    const baseline = status.applied.find((row) => row.version === BASELINE_VERSION);
    expect(baseline?.adopted).toBe(true);
  });

  it("تشغيل ثانٍ → no-op كامل (idempotent)", async () => {
    const pool = getPool();
    await migrate(pool, { apply: true, files: realFiles });
    const again = await migrate(pool, { apply: true, files: realFiles });
    expect(again.alreadyUpToDate).toBe(true);
    expect(again.appliedVersions).toHaveLength(0);
    expect(again.adoptedBaseline).toBe(false);
  });

  it("هجرة تفشل في المنتصف → تراجع كامل، لا تسجيل، وإعادة المحاولة تنجح", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aqlan-mig-fail-"));
    try {
      const badFile = "9999_should_fail.sql";
      await writeFile(path.join(dir, badFile), [
        "CREATE TABLE IF NOT EXISTS mig_probe_will_rollback (id INTEGER PRIMARY KEY);",
        "INSERT INTO mig_probe_will_rollback VALUES (1);",
        "INSERT INTO nonexistent_table VALUES (1); -- يفشل هنا عمدًا",
      ].join("\n"));

      const { migrate: migrateWithDir, migrationStatus: statusWithDir } = await import("@/lib/migrations");
      const pool = getPool();
      await migrateWithDir(pool, { apply: true, files: realFiles });

      // محاولة تطبيق هجرة فاشلة عبر ملفات مخصصة
      const filesWithBad = [...realFiles, {
        version: "9999", name: "should_fail", filename: badFile,
        sql: await (await import("node:fs/promises")).readFile(path.join(dir, badFile), "utf8"),
        checksum: "",
      }];
      filesWithBad[filesWithBad.length - 1].checksum = checksumOf(filesWithBad[filesWithBad.length - 1].sql);

      await expect(migrateWithDir(pool, { apply: true, files: filesWithBad })).rejects.toThrow();

      // الحالة بعد الفشل: الهجرة غير مسجَّلة، والجدول الذي أنشأته تراجع بالكامل.
      const status = await statusWithDir(pool, filesWithBad);
      expect(status.pending.map((file) => file.version)).toContain("9999");
      const { rows } = await pool.query<{ exists: boolean }>(
        "SELECT to_regclass('public.mig_probe_will_rollback') IS NOT NULL AS exists",
      );
      expect(rows[0]?.exists).toBe(false); // تراجع الـDDL نفسه — DDL معاملاتي

      // إعادة المحاولة بهجرة سليمة بعد إصلاح الملف تنجح
      await writeFile(path.join(dir, badFile), [
        "CREATE TABLE IF NOT EXISTS mig_probe_will_rollback (id INTEGER PRIMARY KEY);",
        "INSERT INTO mig_probe_will_rollback VALUES (1);",
      ].join("\n"));
      const fixedSql = await (await import("node:fs/promises")).readFile(path.join(dir, badFile), "utf8");
      const fixedFiles = [...realFiles, {
        version: "9999", name: "should_fail", filename: badFile,
        sql: fixedSql, checksum: checksumOf(fixedSql),
      }];
      const retried = await migrateWithDir(pool, { apply: true, files: fixedFiles });
      expect(retried.appliedVersions).toContain("9999");
      const statusAfter = await statusWithDir(pool, fixedFiles);
      expect(statusAfter.consistent).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("بصمة لا تطابق ما طُبِّق → تُكتشف ويُرفض الاستمرار (fail closed)", async () => {
    const pool = getPool();
    await migrate(pool, { apply: true, files: realFiles });

    // ملف 0002 عُدِّل بعد التطبيق — بصمته تغيّرت.
    const tampered = realFiles.map((file) =>
      file.version === "0002"
        ? { ...file, sql: file.sql + "\n-- تعديل لاحق يفسد البصمة\n", checksum: "" }
        : file,
    );
    const tampered0002 = tampered.find((file) => file.version === "0002")!;
    tampered0002.checksum = checksumOf(tampered0002.sql);

    const status = await migrationStatus(pool, tampered);
    expect(status.checksumMismatches.map((entry) => entry.version)).toContain("0002");
    expect(status.consistent).toBe(false);

    // والتطبيق يرفض المتابعة فوقه
    await expect(migrate(pool, { apply: true, files: tampered })).rejects.toThrow();
  });

  it("صف هجرة مجهولة (من المستقبل) في القاعدة → تُبلَّغ كunknown لا كصامتة", async () => {
    const pool = getPool();
    await migrate(pool, { apply: true, files: realFiles });
    await pool.query(
      `INSERT INTO schema_migrations (version, name, checksum) VALUES ('9000', 'future', 'x')`,
    );
    const status = await migrationStatus(pool, realFiles);
    expect(status.unknownApplied.map((row) => row.version)).toContain("9000");
    expect(status.consistent).toBe(false);
  });

  it("انحراف حرج (جدول أساسي محذوف) → الفحص يفشل مغلقًا", async () => {
    const pool = getPool();
    await migrate(pool, { apply: true, files: realFiles });
    await pool.query("DROP TABLE IF EXISTS expenses CASCADE");
    const status = await migrationStatus(pool, realFiles);
    expect(status.probe.ok).toBe(false);
    expect(status.probe.missing).toContain("جدول expenses");
    expect(status.consistent).toBe(false);
  });

  it("dry-run بلا apply → لا يغيّر شيئًا ويعرض ما سيل", async () => {
    const pool = getPool();
    const dry = await migrate(pool, { apply: false, files: realFiles });
    expect(dry.appliedVersions.length).toBeGreaterThan(0);
    // لم يُنشئ حتى جدول التسجيل
    const { rows } = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
    );
    expect(rows[0]?.exists).toBe(false);
  });

  it("الملفات ذات الأسماء غير الصالحة تُتجاهل والقائمة تظل حتمية", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aqlan-mig-names-"));
    try {
      await writeFile(path.join(dir, "README.md"), "not a migration");
      await writeFile(path.join(dir, "0000_bad-name.sql"), "SELECT 1;");
      await writeFile(path.join(dir, "123_too-short.sql"), "SELECT 1;");
      await writeFile(path.join(dir, "0001_valid_one.sql"), "CREATE TABLE IF NOT EXISTS probe_valid (id INTEGER);");
      const fromDir = await loadMigrationFiles(dir);
      expect(fromDir).toHaveLength(1);
      expect(fromDir[0].version).toBe("0001");
      expect(fromDir[0].name).toBe("valid_one");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
