import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decryptArchiveBuffer, encryptionKeyFingerprint } from "./backupEncryption";
import { S3_BACKUP_PREFIX } from "./backupDestinations";
import { stagedRestore } from "./restore/staging";
import { type S3Client, sha256Hex } from "./s3-client";

/**
 * (P0-3) تجربة الاستعادة من النسخة الخارجية — «النسخة التي لم تُستعد ليست نسخة».
 *
 * تنزّل أحدث نسخة (أو نسخةً بعينها) من الحاوية، وتتحقق قبل أي لمس:
 *   ١) بصمة المشفَّر مطابقة لما سُجِّل عند الرفع،
 *   ٢) بصمة المفتاح مطابقة (المفتاح الصحيح بيد من يستعيد)،
 *   ٣) فكّ التشفير ينجح وبصمة الأرشيف المفكوك مطابقة،
 * ثم تستعيد إلى قاعدةٍ **فارغة معزولة** بالمسار الموثَّق نفسه (stagedRestore:
 * التحققات العشر قبل اللمس، المستندات إلى دليل staging). والتقرير يحمل اسم الشاهد.
 *
 * لا تلمس الإنتاج: الهدف يُصنَّف قبل أي اتصال ويُرفض إن كان إنتاجًا (في السكربت).
 */

export interface DrillReport {
  ok: boolean;
  witness: string;
  operator: string;
  startedAt: string;
  finishedAt: string;
  objectKey: string | null;
  encryptedBytes: number;
  archiveSha256: string | null;
  checks: {
    encryptedHashMatches: boolean;
    keyFingerprintMatches: boolean;
    archiveHashMatches: boolean;
  };
  restore: {
    tablesCount: number;
    documentsRestored: number;
    documentsVerified: number;
    criticalProbeOk: boolean;
    migrationConsistent: boolean;
  } | null;
  errors: string[];
}

export async function runOffsiteRestoreDrill(opts: {
  client: S3Client;
  keyHex: string;
  targetUrl: string;
  stagingDir: string;
  witness: string;
  operator: string;
  objectKey?: string | null;
  now?: () => Date;
}): Promise<DrillReport> {
  const now = opts.now ?? (() => new Date());
  const report: DrillReport = {
    ok: false, witness: opts.witness, operator: opts.operator, startedAt: now().toISOString(), finishedAt: "",
    objectKey: null, encryptedBytes: 0, archiveSha256: null,
    checks: { encryptedHashMatches: false, keyFingerprintMatches: false, archiveHashMatches: false },
    restore: null, errors: [],
  };
  const finish = () => { report.finishedAt = now().toISOString(); return report; };

  if (!opts.witness.trim()) {
    report.errors.push("اسم الشاهد مطلوب — تجربة الاستعادة تُشهَد ولا تُفترض.");
    return finish();
  }

  let key = opts.objectKey ?? null;
  if (!key) {
    const objects = (await opts.client.listObjects(S3_BACKUP_PREFIX)).filter((object) => object.key.endsWith(".enc"));
    objects.sort((a, b) => b.lastModified.localeCompare(a.lastModified) || b.key.localeCompare(a.key));
    key = objects[0]?.key ?? null;
  }
  if (!key) {
    report.errors.push("لا توجد أي نسخة في الحاوية الخارجية — النسخ خارج المنصة لم يعمل بعد.");
    return finish();
  }
  report.objectKey = key;

  const head = await opts.client.headObject(key);
  if (!head) {
    report.errors.push("النسخة المطلوبة غير موجودة في الحاوية.");
    return finish();
  }
  const encrypted = await opts.client.getObject(key);
  report.encryptedBytes = encrypted.length;
  report.checks.encryptedHashMatches = sha256Hex(encrypted) === head.metadata["encrypted-sha256"];
  report.checks.keyFingerprintMatches = encryptionKeyFingerprint(opts.keyHex) === head.metadata["key-fingerprint"];
  if (!report.checks.encryptedHashMatches) report.errors.push("بصمة الملف المنزَّل لا تطابق بصمة الرفع — الملف تغيّر أو تلف.");
  if (!report.checks.keyFingerprintMatches) report.errors.push("مفتاح التشفير المستعمل ليس المفتاح الذي شُفّرت به النسخة.");
  if (report.errors.length > 0) return finish();

  let archive: Buffer;
  try {
    archive = decryptArchiveBuffer(encrypted, opts.keyHex);
  } catch {
    report.errors.push("تعذّر فكّ تشفير النسخة بالمفتاح المعطى.");
    return finish();
  }
  report.archiveSha256 = sha256Hex(archive);
  report.checks.archiveHashMatches = report.archiveSha256 === head.metadata["archive-sha256"];
  if (!report.checks.archiveHashMatches) {
    report.errors.push("بصمة الأرشيف بعد فكّ التشفير لا تطابق بصمته عند النسخ.");
    return finish();
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), "offsite-drill-"));
  try {
    const archivePath = path.join(workDir, path.basename(key).replace(/\.enc$/, ""));
    await writeFile(archivePath, archive);
    const restored = await stagedRestore({ archivePath, targetUrl: opts.targetUrl, stagingDir: opts.stagingDir });
    report.restore = {
      tablesCount: restored.verification.tablesCount,
      documentsRestored: restored.documentsRestored,
      documentsVerified: restored.documentsVerified,
      criticalProbeOk: restored.verification.criticalProbeOk,
      migrationConsistent: restored.verification.migrationConsistent,
    };
    report.errors.push(...restored.validationErrors, ...restored.errors);
    report.ok = restored.ok && restored.validationErrors.length === 0 && restored.verification.criticalProbeOk;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  return finish();
}

/** التقرير مقروءًا بالعربية — يُطبع ويُحفظ مع ملف JSON للأرشيف. */
export function drillReportText(report: DrillReport): string {
  const yes = (value: boolean) => (value ? "✔" : "✘");
  return [
    `تجربة استعادة من النسخة الخارجية — ${report.ok ? "نجحت ✔" : "لم تنجح ✘"}`,
    `الشاهد: ${report.witness} · المنفِّذ: ${report.operator}`,
    `من ${report.startedAt} إلى ${report.finishedAt}`,
    `النسخة: ${report.objectKey ?? "—"} (${report.encryptedBytes} بايت مشفّرة)`,
    `${yes(report.checks.encryptedHashMatches)} بصمة الملف المنزَّل مطابقة`,
    `${yes(report.checks.keyFingerprintMatches)} المفتاح هو مفتاح النسخة`,
    `${yes(report.checks.archiveHashMatches)} بصمة الأرشيف بعد فكّ التشفير مطابقة (${report.archiveSha256 ?? "—"})`,
    report.restore
      ? `الاستعادة: ${report.restore.tablesCount} جدولًا، فحص حرج ${yes(report.restore.criticalProbeOk)}، هجرات متسقة ${yes(report.restore.migrationConsistent)}، مستندات ${report.restore.documentsRestored} مستعادة و${report.restore.documentsVerified} متحققًا منها`
      : "الاستعادة: لم تُنفَّذ",
    ...report.errors.map((error) => `  • ${error}`),
  ].join("\n");
}
