import { createHash } from "node:crypto";
import { documentEntryName, type ParsedArchive } from "./archive";
import { resolveInsideBase, validateDestinationBatch, validateRelativePath } from "../safe-path";

/**
 * التحقق الكامل من الأرشيف **قبل لمس أي قاعدة هدف** (P1.12).
 *
 * عشرة تحققات بالترتيب، وأي فشل فيها يعني: لا استعادة قاعدة أصلًا — الأرشيف
 * لا يُلمس به هدفٌ واحد. القاعدة القديمة كانت تبدأ باستعادة القاعدة ثم تتحقق
 * من المستندات وحدَها، فتحصل على «قاعدة استُعيدت ومستندات فشلت» — الحالة
 * الممنوعة في P1.15 (نصف استعادة).
 */

export interface ManifestDocument {
  id: number;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  title: string;
  patientId: number;
  removedAt?: string | null;
}

export interface BackupManifest {
  format: string;
  version: number;
  createdAt: string;
  databaseSha256: string;
  documents: ManifestDocument[];
}

export interface ValidatedDocument {
  manifest: ManifestDocument;
  bytes: Uint8Array;
  /** مسار الملف داخل دليل المستندات (مفتاح التخزين الأصلي). */
  relativePath: string;
  /** المسار المطلق داخل الأساس — يحسبه المستدعي بعد تمرير documentsDir. */
  sha256: string;
}

export interface ValidationOk {
  ok: true;
  manifest: BackupManifest;
  sql: Uint8Array;
  sqlSha256: string;
  documents: ValidatedDocument[];
}

export type ValidationResult =
  | ValidationOk
  | { ok: false; errors: string[] };

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function parseManifest(raw: unknown): { manifest: BackupManifest } | { errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { errors: ["manifest ليس كائن JSON سليمًا"] };
  }
  const manifest = raw as Record<string, unknown>;
  if (manifest.format !== "aqlan-full-backup") {
    errors.push(`صيغة الأرشيف غير معروفة: ${String(manifest.format)}`);
  }
  if (manifest.version !== 1) {
    errors.push(`إصدار الأرشيف غير مدعوم: ${String(manifest.version)}`);
  }
  if (typeof manifest.databaseSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.databaseSha256)) {
    errors.push("بصمة قاعدة البيانات في المفتاح غير صالحة");
  }
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
    errors.push("طابع إنشاء النسخة غير صالح");
  }
  if (!Array.isArray(manifest.documents)) {
    errors.push("قائمة المستندات في المفتاح غير صالحة");
    return { errors };
  }
  const documents: ManifestDocument[] = [];
  const seenKeys = new Set<string>();
  for (const [index, entry] of manifest.documents.entries()) {
    const doc = entry as Record<string, unknown>;
    const prefix = `مستند #${index + 1}`;
    if (typeof doc.storageKey !== "string" || doc.storageKey.length === 0) {
      errors.push(`${prefix}: مفتاح تخزين غير صالح`);
      continue;
    }
    if (seenKeys.has(doc.storageKey)) {
      errors.push(`${prefix}: مفتاح تخزين مكرر في المفتاح: ${doc.storageKey}`);
    }
    seenKeys.add(doc.storageKey);
    if (typeof doc.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(doc.sha256)) {
      errors.push(`${prefix}: بصمة غير صالحة`);
      continue;
    }
    if (typeof doc.sizeBytes !== "number" || !Number.isInteger(doc.sizeBytes) || doc.sizeBytes < 0) {
      errors.push(`${prefix}: حجم غير صالح`);
      continue;
    }
    documents.push({
      id: Number(doc.id ?? 0),
      storageKey: doc.storageKey,
      sha256: doc.sha256,
      sizeBytes: doc.sizeBytes,
      title: typeof doc.title === "string" ? doc.title : "",
      patientId: Number(doc.patientId ?? 0),
      removedAt: typeof doc.removedAt === "string" ? doc.removedAt : null,
    });
  }
  if (errors.length > 0) return { errors };
  return { manifest: manifest as unknown as BackupManifest };
}

/**
 * التحقق الكامل — كل شيء قبل أي كتابة:
 *
 *  ١) الأرشيف غير مبتر.
 *  ٢) البنية: database.sql موجود، manifest.json موجود **وآخر مدخل** (شهادة
 *     اكتمال التنزيل بحسب تصميم الكاتب).
 *  ٣) المفتاح سليم البنية (parseManifest أعلاه).
 *  ٤) بصمة SQL تطابق المفتاح.
 *  ٥) بصمة كل مستند تطابق المفتاح.
 *  ٦) حجم كل مستند يطابق المفتاح.
 *  ٧) أسماء الملفات/المسارات النسبية سليمة (لا مطلق، لا ..، لا null byte).
 *  ٨) رفض path traversal: كل مفتاح يظل داخل دليل المستندات بعد الحل.
 *  ٩) كشف الوجهات المكررة بعد الحل.
 * ١٠) كل ملف مطلوب موجود في الأرشيف (بالاسم المؤمَّن الذي يكتبه fullBackup).
 */
export function validateBackupArchive(
  archive: ParsedArchive,
  options: { documentsDir: string } = { documentsDir: "/documents" },
): ValidationResult {
  const errors: string[] = [];

  // ١) البتر
  if (archive.truncated) {
    errors.push("الأرشيف مبتر أو يحمل مدخلات مكررة — التنزيل انقطع أو الملف تالف.");
  }

  // ٢) البنية
  const sqlEntry = archive.entries.get("database.sql");
  if (!sqlEntry) errors.push("ملف البيانات database.sql غير موجود في الأرشيف.");
  const manifestEntry = archive.entries.get("manifest.json");
  if (!manifestEntry) {
    errors.push("manifest.json غير موجود — التنزيل انقطع قبل اكتماله (يُكتب أخيرًا عمدًا).");
  }
  if (manifestEntry && archive.order.length > 0 && archive.order[archive.order.length - 1] !== "manifest.json") {
    errors.push("manifest.json ليس آخر مدخل — الأرشيف لا يطابق صيغة الكاتب.");
  }
  if (errors.length > 0) return { ok: false, errors };

  const sql = sqlEntry!.data;

  // ٣) المفتاح
  let manifest: BackupManifest;
  try {
    const parsed = parseManifest(JSON.parse(Buffer.from(manifestEntry!.data).toString("utf8")));
    if ("errors" in parsed) return { ok: false, errors: parsed.errors };
    manifest = parsed.manifest;
  } catch {
    return { ok: false, errors: ["manifest.json ليس JSON سليمًا."] };
  }

  // ٤) بصمة SQL
  const sqlSha256 = sha256Hex(sql);
  if (sqlSha256 !== manifest.databaseSha256) {
    errors.push("بصمة ملف البيانات لا تطابق المفتاح — الأرشيف تالف أو مُعدَّل.");
  }
  if (!Buffer.from(sql).toString("utf8").includes("COMMIT;")) {
    errors.push("ملف البيانات بلا خاتمة COMMIT — لقطة غير مكتملة.");
  }

  // ٥-١٠) المستندات
  const documents: ValidatedDocument[] = [];
  const relativePaths: string[] = [];
  for (const doc of manifest.documents) {
    const entryName = documentEntryName(doc.storageKey);
    const entry = archive.entries.get(entryName);
    if (!entry) {
      errors.push(`مستند مفقود من الأرشيف: ${doc.storageKey} (${doc.title || "بلا عنوان"})`);
      continue;
    }
    const bytes = entry.data;
    if (bytes.length !== doc.sizeBytes) {
      errors.push(`حجم مستند لا يطابق المفتاح: ${doc.storageKey} — الأرشيف ${bytes.length} والمفتاح ${doc.sizeBytes}.`);
      continue;
    }
    const digest = sha256Hex(bytes);
    if (digest !== doc.sha256) {
      errors.push(`بصمة مستند لا تطابق المفتاح: ${doc.storageKey} — ملف تالف أو مُعدَّل.`);
      continue;
    }
    // ٧) اسم نسبي سليم
    const pathCheck = validateRelativePath(doc.storageKey);
    if (!pathCheck.ok || !pathCheck.resolved) {
      errors.push(`مسار مستند غير آمن: ${doc.storageKey} — ${pathCheck.reason}`);
      continue;
    }
    // ٨) الحل داخل الأساس يظل داخل الأساس (رفض traversal)
    const inside = resolveInsideBase(options.documentsDir, doc.storageKey);
    if (!inside.ok) {
      errors.push(`مسار مستند يخرج من دليل المستندات: ${doc.storageKey} — ${inside.reason}`);
      continue;
    }
    relativePaths.push(doc.storageKey);
    documents.push({ manifest: doc, bytes, relativePath: doc.storageKey, sha256: digest });
  }

  // ٩) وجهات مكررة بعد الحل
  const batch = validateDestinationBatch(options.documentsDir, relativePaths);
  if (!batch.ok) {
    errors.push(`وجهات مكررة أو غير آمنة في دفعة المستندات: ${batch.reason}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest, sql, sqlSha256, documents };
}
