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
 *
 * ويقرأ `.env.local` كما تقرؤه رحلات التحقق — أداةٌ للمطوّر تسأله عن رابطٍ ضبطه
 * مرّةً في ملفٍ واحد أداةٌ تُهجر. والقراءة لا تطغى على بيئةٍ صريحة أبدًا، فيبقى
 * توجيهها إلى قاعدةٍ أخرى بسطرٍ واحد، ولا تتسرّب قيمةٌ محلّية إلى CI الذي يضبط
 * رابطه بنفسه.
 */
import "./load-env.mjs";
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

  const { decideTls } = await import("../lib/db-tls");
  const { classifyDbTarget } = await import("../lib/db-target");
  const target = classifyDbTarget(raw, process.env);
  let tlsMode: string;
  try {
    tlsMode = decideTls(raw).mode;
  } catch (error) {
    console.error(`رفض سياسة TLS قبل أي اتصال: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log("─".repeat(60));
  console.log(`هدف الفحص: host=${target.host} port=${target.port} database=${target.database} user=${target.user}`);
  console.log(`          tls=${tlsMode}  بيئة_الهدف=${target.environment}  (قراءة فقط — لا كتابة)`);
  console.log("─".repeat(60));
  for (const reason of target.reasons) console.log(`  • ${reason}`);

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

    /* (P1-FIX-1) مجسّ خط الأساس القوي: لمرشّح الاعتماد (قاعدة قائمة بلا
       تسجيل) يعرض الفرق الحقيقي — جداول/أعمدة/أنواع/قيود/فهارس/triggers
       — بدل «أسماء الجداول موجودة تقريبًا». */
    if (status.baselineDiff) {
      const { describeBaselineDiff } = await import("../lib/baseline-probe");
      console.log("\nمجسّ توافق خط الأساس (0001):");
      if (status.baselineDiff.ok) {
        console.log(`  سليم ✅ — فُحص: ${status.baselineDiff.checked.tables} جدولًا / ${status.baselineDiff.checked.columns} عمودًا / ${status.baselineDiff.checked.constraints} قيدًا / ${status.baselineDiff.checked.indexes} فهرسًا / ${status.baselineDiff.checked.triggers} trigger`);
        console.log(`  بصمة المتوقَّع ${status.baselineDiff.expectedFingerprint.slice(0, 16)}… / الفعلي ${status.baselineDiff.actualFingerprint.slice(0, 16)}…`);
      } else {
        console.log("  ❌ BASELINE_SCHEMA_MISMATCH — الاختلاف الحقيقي:");
        for (const line of describeBaselineDiff(status.baselineDiff)) console.log(`    ${line}`);
      }
    }

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
