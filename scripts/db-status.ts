#!/usr/bin/env node
/**
 * npm run db:status / db:verify — كشف انحراف المخطط (P1.2) fail-closed.
 *
 * يعرض:
 *  ١) الهجرات المطبَّقة (مع بصماتها وأزمنتها وطريقة التطبيق: تنفيذ أم اعتماد).
 *  ٢) الهجرات الناقصة.
 *  ٣) بصمات لا تطابق (ملف عُدِّل بعد التطبيق).
 *  ٤) صفوف مجهولة (تطبيق من إصدار أحدث من الكود الحالي).
 *  ٥) انحراف حرج (جدول/عمود أساسي مفقود).
 *
 * exit 0 = متسقة | exit 1 = غير متسقة (أي انحراف مهم) — بوابة CI/تشغيل fail-closed.
 * قراءة فقط: لا يكتب شيئًا ولا يصلح شيئًا — «الإصلاح التلقائي لاختلاف مجهول
 * في الإنتاج» ممنوع بنيويًّا (P1.2).
 */
import { Client } from "pg";

async function main(): Promise<number> {
  const raw = process.env.DATABASE_URL ?? "";
  if (!raw.trim()) {
    console.error("DATABASE_URL غير مضبوط — الفحص يحتاج قاعدة PostgreSQL حقيقية.");
    return 1;
  }
  if (process.env.USE_LOCAL_DB === "true") {
    console.error("USE_LOCAL_DB=true (PGlite) — الفحص لقاعدة حقيقية.");
    return 1;
  }

  const { decideTls, parseDatabaseHost } = await import("../lib/db-tls");
  const identity = parseDatabaseHost(raw);
  console.log("─".repeat(60));
  console.log(`هدف الفحص: host=${identity?.host} port=${identity?.port} database=${identity?.database} user=${identity?.user}`);
  console.log(`          tls=${decideTls(raw).mode}  (قراءة فقط — لا كتابة)`);
  console.log("─".repeat(60));

  const { loadMigrationFiles, migrationStatus } = await import("../lib/migrations");
  const files = await loadMigrationFiles();

  const client = new Client({
    connectionString: raw,
    ssl: decideTls(raw).ssl === false ? false : { ...(decideTls(raw).ssl as object) },
  });
  try {
    await client.connect();
    const pool = {
      query: (sql: string, values?: unknown[]) => client.query(sql, values as never[]),
      connect: async () => ({
        query: (sql: string, values?: unknown[]) => client.query(sql, values as never[]),
        release: () => {},
      }),
    };
    const status = await migrationStatus(pool, files);

    console.log("\nالهجرات المطبَّقة:");
    for (const row of status.applied) {
      console.log(
        `  ${row.version}  ${row.name}  ${row.applied_at}${row.adopted ? "  [معتمدة بلا تنفيذ — قاعدة قائمة]" : ""}`,
      );
      console.log(`        checksum=${row.checksum.slice(0, 16)}…`);
    }
    if (status.applied.length === 0) console.log("  (لا شيء — القاعدة لم تعرف نظام الهجرات بعد)");

    if (status.pending.length) {
      console.log(`\n⚠️ هجرات ناقصة: ${status.pending.map((file) => file.version).join("، ")}`);
      console.log("   نفّذ: npm run db:migrate -- --apply");
    }
    if (status.unknownApplied.length) {
      console.log(`\n⚠️ صفوف تطبيق مجهولة (أحدث من الكود): ${status.unknownApplied.map((row) => row.version).join("، ")}`);
      console.log("   يعني أن القاعدة هُجِّرت بإصدار كود أحدث — تراجع الكود أو أكمل الترقية.");
    }
    if (status.checksumMismatches.length) {
      console.log(`\n⚠️ بصمات مخالفة (ملفات عُدِّلت بعد التطبيق):`);
      for (const entry of status.checksumMismatches) {
        console.log(`   ${entry.version}: المسجَّلة ${entry.appliedChecksum.slice(0, 12)}… ≠ الملف ${entry.fileChecksum.slice(0, 12)}…`);
      }
      console.log("   لا يُعدَّل ما طُبِّق أبدًا — استعد الملف الأصلي أو اكتب هجرة جديدة.");
    }
    if (!status.probe.ok) {
      console.log(`\n⚠️ انحراف حرج — عناصر أساسية مفقودة: ${status.probe.missing.join("، ")}`);
    }

    console.log("\n" + "─".repeat(60));
    if (status.consistent) {
      console.log("الحالة: متسقة ✅ (كل الهجرات مطبَّقة، البصمات مطابقة، الفحص الحرج سليم)");
      return 0;
    }
    console.log("الحالة: غير متسقة ⚠️ — fail closed. لا يُصلَح تلقائيًّا، والقرار البشري إلزامي.");
    return 1;
  } catch (error) {
    console.error(`فشل الفحص: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
