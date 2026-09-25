#!/usr/bin/env node
/**
 * npm run backup:drill — (P0-3) تجربة استعادة مشهودة من النسخة الخارجية.
 *
 *   BACKUP_S3_ENDPOINT=… BACKUP_S3_BUCKET=… BACKUP_S3_ACCESS_KEY_ID=… BACKUP_S3_SECRET_ACCESS_KEY=… \
 *   BACKUP_ENCRYPTION_KEY=… DATABASE_URL=postgres://…(قاعدة فارغة للتجربة) DOCUMENTS_DIR=…(دليل staging) \
 *     npm run backup:drill -- --witness "اسم الشاهد" [--operator "المنفِّذ"] [--key aqlan-backups/….enc]
 *
 * لا يلمس الإنتاج: الهدف يُصنَّف قبل أي اتصال (lib/db-target) ويُرفض إن كان إنتاجًا
 * أو هدفًا بعيدًا غير مصنَّف — بالبوابة نفسها التي تحرس restore:full. يطبع التقرير
 * بالعربية ويحفظه JSON في الدليل الحالي باسم restore-drill-<الوقت>.json.
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<number> {
  const witness = (arg("witness") ?? "").trim();
  const operator = (arg("operator") ?? process.env.USER ?? "غير مذكور").trim();
  const targetUrl = process.env.DATABASE_URL ?? "";
  const stagingDir = process.env.DOCUMENTS_DIR ? path.resolve(process.env.DOCUMENTS_DIR) : null;
  const keyHex = (process.env.BACKUP_ENCRYPTION_KEY ?? "").trim();
  if (!witness || !targetUrl.trim() || !stagingDir || !keyHex) {
    console.error("الاستعمال: DATABASE_URL=…(فارغة) DOCUMENTS_DIR=… BACKUP_ENCRYPTION_KEY=… BACKUP_S3_*=… npm run backup:drill -- --witness \"اسم الشاهد\"");
    return 1;
  }

  const { classifyDbTarget } = await import("../lib/db-target");
  const target = classifyDbTarget(targetUrl, process.env);
  if (!target.allowsRestoreFull) {
    console.error(`رفض بنيوي: هدف التجربة مصنَّف «${target.environment}» — التجربة على قاعدةٍ فارغة معزولة فقط، لا على الإنتاج.`);
    for (const reason of target.reasons) console.error(`  • ${reason}`);
    return 1;
  }

  const { S3Client, s3ConfigFromEnv } = await import("../lib/s3-client");
  const config = s3ConfigFromEnv(process.env);
  if (!config.ok) {
    console.error(`ناقص في البيئة: ${config.missing.join("، ")}`);
    return 1;
  }
  const { runOffsiteRestoreDrill, drillReportText } = await import("../lib/backup-offsite-drill");
  const report = await runOffsiteRestoreDrill({
    client: new S3Client(config.config), keyHex, targetUrl, stagingDir, witness, operator, objectKey: arg("key"),
  });
  console.log(drillReportText(report));
  const file = `restore-drill-${report.startedAt.replace(/[:.]/g, "-")}.json`;
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nحُفظ التقرير: ${file}`);
  return report.ok ? 0 : 2;
}

main().then((code) => process.exit(code), (error) => {
  console.error(`✘ تعذّرت التجربة: ${error instanceof Error ? error.message : "خطأ غير متوقع"}`);
  process.exit(3);
});
