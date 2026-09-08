#!/usr/bin/env node
/**
 * npm run restore:full — الاستعادة الكاملة بإعداد Staging (P1.12–P1.15 + P1.21).
 *
 * يستبدل scripts/restore-full.mjs القديم بنموذج «تحقّق كامل قبل أي لمس»:
 *  ١) يقرأ الأرشيف كاملًا وينفذ التحققيات العشر (بصمة SQL وكل مستند وحجم كل
 *     مستند والمسارات والوجهات المكررة وترتيب المفتاح...).
 *  ٢) أي فشل تحقق ⇒ **لا استعادة قاعدة أصلًا** (لم يعد اللمس يسبق التحقق).
 *  ٣) الهدف يجب أن يكون فارغًا (رفض غير الفارغ افتراضيًا).
 *  ٤) المستندات تُستعاد إلى دليل staging معزول — لا إلى دليل الإنتاج مباشرة.
 *  ٥) بعد كل شيء: READY FOR CUTOVER مع الخطوات موثَّقة لا منفَّذة.
 *
 * الاستعمال:
 *   DATABASE_URL=postgres://…(هدف فارغ) DOCUMENTS_DIR=…(staging) \
 *     npm run restore:full -- النسخة.tar.gz
 */
import path from "node:path";

async function main(): Promise<number> {
  const archivePath = process.argv[2];
  const targetUrl = process.env.DATABASE_URL ?? "";
  const stagingDir = process.env.DOCUMENTS_DIR
    ? path.resolve(process.env.DOCUMENTS_DIR)
    : null;
  const allowNonEmpty = process.argv.includes("--allow-non-empty-target");

  if (!archivePath || !targetUrl.trim() || !stagingDir) {
    console.error(
      "الاستعمال: DATABASE_URL=postgres://…(هدف فارغ) DOCUMENTS_DIR=…(دليل staging) npm run restore:full -- النسخة.tar.gz",
    );
    return 1;
  }

  const { stagedRestore } = await import("../lib/restore/staging");
  const result = await stagedRestore({
    archivePath,
    targetUrl,
    stagingDir,
    allowNonEmptyTarget: allowNonEmpty,
  });

  console.log("─".repeat(60));
  if (result.targetIdentity) {
    console.log(
      `الهدف: ${result.targetIdentity.database} على ${result.targetIdentity.host}:${result.targetIdentity.port} (user=${result.targetIdentity.user})`,
    );
  }
  console.log(`دليل staging: ${stagingDir}`);
  console.log("─".repeat(60));

  if (result.validationErrors.length > 0) {
    console.error("\n✖ فشل تحقق الأرشيف — لم تُستعاد قاعدة ولا مستندات (لا لمس قبل التحقق):");
    for (const error of result.validationErrors) console.error(`  • ${error}`);
    return 2;
  }

  if (!result.ok) {
    console.error("\n✖ فشلت الاستعادة:");
    for (const error of result.errors) console.error(`  • ${error}`);
    return 3;
  }

  console.log(`\n✔ استُعيدت القاعدة (هجرات: ${result.migrationsApplied.join("، ")})`);
  console.log(`✔ جمل بيانات مطبَّقة: ${result.sqlRowsStatementLines} (واستُبعدت ${result.skippedMigrationRecordLines} سطر تسجيل هجرات من النسخة)`);
  console.log(`✔ مستندات: ${result.documentsRestored} مستعادًا و${result.documentsVerified} متحققًا منه بعد الكتابة`);
  console.log(`✔ تحقق الهدف: فحص حرج=${result.verification.criticalProbeOk ? "سليم" : "فشل"}، جداول=${result.verification.tablesCount}`);

  if (result.readyForCutover) {
    console.log("\n═".repeat(60));
    console.log("READY FOR CUTOVER — التبديل إلى الإنتاج قرار بشري، خطواته:");
    for (const step of result.cutoverSteps) console.log(`  ${step}`);
    console.log("═".repeat(60));
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
