import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { isSameOrInside, resolveInsideBase } from "./safe-path";

/**
 * أساسات القرص الدائم لنظام النسخ الاحتياطي — مسارات، كتابة ذرّية، أقفال، وتحقق أرشيف.
 *
 * كل ما يلمس القرص الدائم في نظام النسخ يمر من هنا حتى تبقى القواعد الثلاث
 * في مكان واحد لا تتوزع فتُنسى:
 *
 * ١) **لا اسم نهائي لغير أرشيف مكتمل**: الملف المؤقت مخفي (‎.اسم.tmp‎) داخل
 *    مجلد النسخ نفسه، يُفحص فحصًا كاملًا ثم يُنقل ذرّيًّا (rename).
 * ٢) **لا كتابة خارج الجذر الدائم**: كل وجهة تُحلّ وتُفحص بالمكوّنات
 *    (path.relative عبر lib/safe-path) — ‎/data-evil ليست داخل ‎/data.
 * ٣) **لا قفل إلا ذرّيًّا**: open(…, "wx") يفوز مرة واحدة؛ القفل العجوز
 *    (بقايا عملية ماتت) يُستبدل، والقفل الحي يعني نسخةً قيد التشغيل.
 */

/** مجلد النسخ داخل جذر القرص الدائم — ابن مباشر باسم ثابت. */
export const BACKUP_DIR_NAME = "backups";

/** مجلد حالة النظام الفرعي (history/schedule/lock) داخل مجلد النسخ. */
export const BACKUP_STATE_DIR_NAME = ".backup-state";

/** مجلد حالة بوابة التفعيل الواحد — مساره محفوظ كما ورد في تصميم البوابة. */
export const BACKUP_ONCE_DIR_NAME = ".production-backup-once";

/** عمر القفل بعد يدوم بعده يُعدّ بقايا عملية ماتت — يُستبدل لا يُحترم. */
export const STALE_LOCK_MS = 2 * 60 * 60 * 1000;

/* ─── المسارات والاحتواء ────────────────────────────────────────────────────── */

/**
 * مجلد النسخ: ابنٌ حقيقي داخل جذر القرص الدائم — يُحلّ ويُفحص احتواؤه
 * بالمكوّنات. أي جذرٍ غير مطلق أو وجهة خارج الجذر تُرفض.
 */
export function resolveBackupDirectory(volumeRoot: string): string {
  const resolvedRoot = path.resolve(volumeRoot);
  const check = resolveInsideBase(resolvedRoot, BACKUP_DIR_NAME);
  if (!check.ok || !check.resolved) {
    throw new Error("مجلد النسخة داخل القرص الدائم غير صالح.");
  }
  return check.resolved;
}

/** مجلد حالة النظام الفرعي داخل مجلد النسخ. */
export function backupStateDir(backupDir: string): string {
  return path.join(backupDir, BACKUP_STATE_DIR_NAME);
}

/** مجلد حالة بوابة التفعيل الواحد داخل مجلد النسخ. */
export function backupOnceDir(backupDir: string): string {
  return path.join(backupDir, BACKUP_ONCE_DIR_NAME);
}

/** يجب أن يكون دليل المستندات داخل جذر القرص الدائم — ‎/data-evil ليست داخل ‎/data. */
export function assertDocumentsDirInsideVolume(
  documentsDir: string,
  volumeRoot: string,
): void {
  if (!isSameOrInside(volumeRoot, documentsDir)) {
    throw new Error("دليل المستندات خارج جذر القرص الدائم — النسخة مرفوضة.");
  }
}

/**
 * اسم ملف النسخة النهائي: production-activation-YYYYMMDD-HHmmss-<sha قصير>.
 * الطابع UTC ومكوّنات الاسم كلها من حروف آمنة — والSHA يُنقّح من أي حرف غريب.
 */
export function productionBackupFilename(now: Date, commitSha: string | null | undefined): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const short = (commitSha ?? "nohash").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "nohash";
  return `production-activation-${date}-${time}-${short}.tar.gz`;
}

/* ─── هوية الأرشيف — صلاحية الاسم قبل أن يلمس مسارًا ─────────────────────── */

/**
 * نمط اسم أرشيف النسخة المعتمد — ما تولّده productionBackupFilename وحده.
 * القاعدة: لا يُمرَّر backupId قادمٌ من سجلٍ أو طلبٍ إلى path.join قبل أن يجتاز
 * هذا النمط والفحوص البنيوية (isValidBackupArchiveId) ثم الاحتواء
 * (resolveBackupArchivePath) — «../documents/anything» لا يمر من هنا أبدًا.
 */
export const BACKUP_ARCHIVE_ID_PATTERN =
  /^production-[a-z0-9-]+-\d{8}-\d{6}-[a-z0-9]{1,16}\.tar\.gz$/;

/**
 * فحص بنيوي صارم لمعرّف أرشيف:
 * نصٌّ غير فارغ بحدٍّ أقصى، basename وحده (لا فواصل لا مطلق)، بلا backslash،
 * بلا بداية نقطة، ومطابق لنمط الأرشيف المعتمد. الرفض هنا قبل أي نظام ملفات.
 */
export function isValidBackupArchiveId(backupId: unknown): backupId is string {
  if (typeof backupId !== "string" || backupId.length === 0 || backupId.length > 128) return false;
  if (backupId !== path.basename(backupId)) return false; // يرفض / و.. والمطلق كله
  if (backupId.includes("\\")) return false;
  if (backupId.startsWith(".")) return false;
  return BACKUP_ARCHIVE_ID_PATTERN.test(backupId);
}

/**
 * مسار أرشيف داخل مجلد النسخ بعد فحصٍ مزدوج: البنية أعلاه **والاحتواء**
 * بالمكوّنات (path.relative لا startsWith) — الفحص الأول يمنع الخروج،
 * والثاني يمنع أي مستقبلٍ يوسّع النمط يومًا وينسى الاحتواء.
 */
export function resolveBackupArchivePath(backupDir: string, backupId: string): string {
  if (!isValidBackupArchiveId(backupId)) {
    throw new Error("معرّف أرشيف غير صالح — مرفوض قبل أي وصولٍ للقرص.");
  }
  const resolved = path.resolve(backupDir, backupId);
  const relative = path.relative(path.resolve(backupDir), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new Error("مسار أرشيف يخرج من مجلد النسخ — مرفوض.");
  }
  return resolved;
}

/* ─── كتابة ذرّية وقراءة JSON ───────────────────────────────────────────────── */

/**
 * لاحقة مؤقتة فريدة لكل كتابة — عمدًا لا اسم ثابت:
 * الاسم الثابت (‎.state.json.tmp‎) مع wx يعلق الكتابات إلى الأبد إن ماتت
 * عمليةٌ بين open وrename وبقي الملف المؤقت — كل محاولة لاحقة تصطدم بEEXIST.
 * الاسم الفريد لكل محاولة يعني أن بقايا عمليةٍ ماتت لا تحجب الكاتب الحيّ
 * أبدًا، وكل كاتب ينسّحب ببقايا نفسه وحده لا ببقايا غيره.
 */
function uniqueTmpPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(8).toString("hex")}.tmp`,
  );
}

/** مزامنة دليل الأب حيث يدعم النظام ذلك (POSIX) — الrename لا يثبت بلا fsync دليل. */
async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    // بعض الأنظمة/الأنظمة الملفات لا تسمح بفتح دليل — أفضل جهد مقصود.
  }
}

/**
 * كتابة JSON ذرّيًّا: مؤقّت فريد بنفس الدليل + fsync للملف + rename ذرّيّ
 * + fsync للدليل. الفشل في أي خطوة ينظّف المؤقت **الخاص بهذا الفشل** حصرًا —
 * لا يمسّ بقايا كاتبٍ آخر، ولا يعلق الكتابات القادمة أبدًا.
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmpPath = uniqueTmpPath(filePath);
  const payload = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  const file = await open(tmpPath, "wx", 0o600);
  try {
    await file.writeFile(payload);
    await file.sync();
  } finally {
    await file.close().catch(() => {});
  }
  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  await fsyncDirectory(path.dirname(filePath));
}

export type JsonReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; missing: true }
  | { ok: false; missing: false };

/** قراءة ملف JSON — الفرق صريح بين الغائب والتالف؛ التالف لا يُخمَّن محتواه. */
export async function readJsonFile<T>(filePath: string): Promise<JsonReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, missing: false };
  }
  try {
    return { ok: true, data: JSON.parse(raw) as T };
  } catch {
    return { ok: false, missing: false };
  }
}

/** إزالة ملفٍ بلا فشل إن كان غائبًا — للتنظيف الهادئ. */
export async function removeFileQuiet(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => {});
}

/* ─── القفل الذرّي عبر العمليات ─────────────────────────────────────────────── */

export interface AcquiredBackupLock { path: string; owned: true }

/**
 * قفل ذرّي عبر العمليات داخل الدليل المحدَّد: open(…, "wx") ينجح لمرة واحدة
 * فقط. قفلٌ قائم أصيل (أحدث من STALE_LOCK_MS) يعني نسخةً قيد التشغيل في
 * عملية أخرى ⇒ in-progress. قفلٌ عجوز بقايا عملية ماتت ⇒ يُستبدل — وإلا
 * لبقيت الحال مسدودة إلى الأبد بعد أول انهيار.
 */
export async function acquireBackupLock(
  directory: string,
  lockName: string,
): Promise<AcquiredBackupLock | "in-progress"> {
  const lockPath = path.join(directory, lockName);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, "wx", 0o600);
      await file.writeFile(
        Buffer.from(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), "utf8"),
      ).catch(() => {});
      await file.close().catch(() => {});
      return { path: lockPath, owned: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs < STALE_LOCK_MS) return "in-progress";
        await unlink(lockPath).catch(() => {});
      } catch {
        return "in-progress";
      }
    }
  }
  return "in-progress";
}

export async function releaseBackupLock(lock: AcquiredBackupLock | null): Promise<void> {
  if (!lock) return;
  await unlink(lock.path).catch(() => {});
}

/* ─── كتابة الأرشيف المؤقت + fsync ──────────────────────────────────────────── */

/**
 * كتابة ملف أرشيف مؤقت مخفي داخل نفس المجلد + fsync — لا اسم نهائي قبل الإتمام.
 * الاسم المؤقت فريد لكل محاولة (لا اسم ثابت يعلق بالبقايا): بقايا محاولةٍ ماتت
 * لا تحجب المحاولة التالية، وتنظّف لاحقًا بمسار تنظيف .tmp المستقل.
 */
export async function writeArchiveTmpWithFsync(
  directory: string,
  finalName: string,
  source: Readable,
): Promise<string> {
  const { createWriteStream } = await import("node:fs");
  const tmpPath = path.join(directory, `.${finalName}.${randomBytes(8).toString("hex")}.tmp`);
  // wx على اسمٍ فريد: فشلٌ نظيف لا يُشتبك مع بقايا كاتبٍ آخر أبدًا.
  const stream = createWriteStream(tmpPath, { flags: "wx", mode: 0o600 });
  try {
    await pipeline(source, createGzip({ level: 9 }), stream);
    // fsync عبر مقبض مؤقت: لا يحمل الاسم النهائي بياناتٍ لم تصل القرص بعد.
    const file = await open(tmpPath, "r+");
    try {
      await file.sync();
    } finally {
      await file.close().catch(() => {});
    }
    return tmpPath;
  } catch (error) {
    await removeFileQuiet(tmpPath);
    throw error;
  }
}

/* ─── التحقق الكامل من الأرشيف ──────────────────────────────────────────────── */

export interface VerifiedArchive {
  sha256: string;
  bytes: number;
  databaseSha256: string;
  documents: number;
}

/**
 * التحقق الكامل fail-closed من الأرشيف قبل اسمه النهائي (14 فحصًا):
 * الوجود والحجم، قابلية الفك، البنية (database.sql وmanifest.json أخيرًا)،
 * صلاحية المفتاح، بصمة وحجم SQL، وجود كل مستند وبصمته وحجمه، لا مسارات
 * مكررة ولا traversal، ثم بصمة وحجم الملف النهائي (gzip) نفسه.
 */
export async function verifyBackupArchiveFile(
  archivePath: string,
  documentsDir: string,
): Promise<VerifiedArchive> {
  const { readTarGzEntries } = await import("./restore/archive");
  const { validateBackupArchive } = await import("./restore/validate");

  const fileStat = await stat(archivePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error("ملف الأرشيف مفقود أو فارغ بعد الكتابة.");
  }
  const archiveBytes = await readFile(archivePath);
  if (archiveBytes.length !== fileStat.size) {
    throw new Error("حجم الأرشيف تغيّر أثناء القراءة.");
  }
  const sha256 = createHash("sha256").update(archiveBytes).digest("hex");

  const parsed = await readTarGzEntries(archivePath);
  const result = validateBackupArchive(parsed, { documentsDir });
  if (!result.ok) {
    throw new Error(`فشل التحقق من الأرشيف: ${result.errors[0] ?? "أخطاء متعددة"}`);
  }
  if (!Buffer.from(result.sql).toString("utf8").includes("COMMIT;")) {
    throw new Error("لقطة قاعدة البيانات غير مكتملة (لا COMMIT).");
  }
  return {
    sha256,
    bytes: fileStat.size,
    databaseSha256: result.sqlSha256,
    documents: result.documents.length,
  };
}
