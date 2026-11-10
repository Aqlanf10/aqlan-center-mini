import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isSafeKey, storageKey } from "./storage";

/**
 * القرص — سائقُ التخزين الوحيد اليوم.
 *
 * الواجهة هنا صغيرة عمدًا (`put` و`read` و`ready`) كي يكون الانتقال إلى تخزينٍ
 * كائنيّ (S3 أو R2) **تبديلَ سائقٍ لا إعادةَ كتابة**: لا شيء خارج هذا الملف يعرف
 * أن الملفّات على قرص.
 *
 * ### الفقد الصامت — وهو الخطر الحقيقي هنا
 *
 * حاويةُ النشر مؤقّتة: ما يُكتب على قرصها يزول عند أول إعادة نشر. فلو رُفعت أشعةٌ
 * إلى قرصٍ مؤقّت لبدا كل شيء ناجحًا — ثم تختفي أشعة المرضى في أول تحديث، ولا أحد
 * يعرف متى ولا لماذا.
 *
 * فالبرنامج **يرفض الرفع** ما لم يُضبط `DOCUMENTS_DIR` صراحةً على مجلّدٍ دائم
 * (قرصٌ ملحق بالخدمة). ورفضٌ بصوتٍ عالٍ خيرٌ من فقدٍ صامت: الأول يُصلَح في دقيقة،
 * والثاني يُكتشف بعد شهور حين تُطلب الأشعة ولا تُوجد.
 */

/**
 * رسالةُ التهيئة تقول **الخطوات** لا الشرط.
 *
 * «اضبط DOCUMENTS_DIR» جملةٌ تفترض أن قارئها يعرف أين يضبطه وبأيّ قيمة — وقارئها
 * طبيبٌ أمام مريض. فتُكتب الخطوات كما تُنقر على الشاشة، فيحلّها بنفسه في دقيقة بدل
 * أن ينتظر من يشرحها له.
 */
export const STORAGE_SETUP = [
  "تخزين الأشعة غير مهيَّأ بعد، ولذلك يُرفض الرفع — وبلا قرصٍ دائم تضيع الصور عند أول تحديث للبرنامج.",
  "الحلّ في لوحة Railway، خطوتان:",
  "١) في خدمة البرنامج ← Volumes ← أضف قرصًا واجعل مساره /data",
  "٢) في Variables ← أضف: DOCUMENTS_DIR = /data/documents",
  "ستُعيد الخدمة تشغيل نفسها، ثم يعمل الرفع.",
].join("\n");

export interface StorageStatus {
  ready: boolean;
  directory: string | null;
  message: string;
}

function configuredDirectory(): string | null {
  const raw = process.env.DOCUMENTS_DIR?.trim();
  return raw ? resolve(raw) : null;
}

export async function storageStatus(): Promise<StorageStatus> {
  const directory = configuredDirectory();
  if (!directory) {
    return {
      ready: false,
      directory: null,
      message: STORAGE_SETUP,
    };
  }
  try {
    await mkdir(/*turbopackIgnore: true*/ directory, { recursive: true });
    // كتابةٌ فعلية: مجلّدٌ موجود لا يعني مجلّدًا قابلًا للكتابة — والقرص المُلحق
    // قد يُركَّب للقراءة فقط بخطأٍ في الإعداد، فيفشل أول رفعٍ لا هذا الفحص.
    const probe = join(/*turbopackIgnore: true*/ directory, ".write-probe");
    await writeFile(/*turbopackIgnore: true*/ probe, "ok");
    return { ready: true, directory, message: "جاهز" };
  } catch {
    return {
      ready: false,
      directory,
      message: "مجلّد التخزين غير قابل للكتابة. تحقّق من القرص الملحق وصلاحياته.",
    };
  }
}

export interface StoredFile {
  sha256: string;
  key: string;
  sizeBytes: number;
  /** صحيحٌ إن كان الملف مخزَّنًا من قبل — نفس المحتوى يُخزَّن مرة. */
  deduplicated: boolean;
}

export async function putFile(bytes: Buffer, extension: string): Promise<StoredFile> {
  const status = await storageStatus();
  if (!status.ready || !status.directory) throw new Error(status.message);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = storageKey(sha256, extension);
  const path = join(/*turbopackIgnore: true*/ status.directory, key);

  try {
    const existing = await stat(/*turbopackIgnore: true*/ path);
    return { sha256, key, sizeBytes: existing.size, deduplicated: true };
  } catch {
    // غير موجود — يُكتب.
  }

  await mkdir(/*turbopackIgnore: true*/ dirname(path), { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ path, bytes);
  return { sha256, key, sizeBytes: bytes.length, deduplicated: false };
}

export async function readFileByKey(key: string): Promise<Buffer | null> {
  if (!isSafeKey(key)) return null;
  const status = await storageStatus();
  if (!status.directory) return null;
  try {
    return await readFile(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ status.directory, key));
  } catch {
    return null;
  }
}

/** Bounded read for native image processors. Check and read the same handle,
 * then probe one extra byte so growth cannot defeat the allocation limit. No
 * original file is changed and no browser-supplied path is accepted. */
export async function readFileByKeyBounded(key: string, maximumBytes: number): Promise<Buffer | null> {
  if (!isSafeKey(key) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 25 * 1024 * 1024) return null;
  const directory = configuredDirectory(); if (!directory) return null;
  let file;
  try {
    file = await open(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ directory, key), "r");
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > maximumBytes) return null;
    const bytes = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break; offset += result.bytesRead;
    }
    return offset === info.size ? bytes.subarray(0, offset) : null;
  } catch { return null; } finally { await file?.close().catch(() => undefined); }
}

/**
 * (إعادة الضبط) حذف ملفٍّ بمفتاحه — بعد مسح كل سجلٍّ يشير إليه. مفتاحٌ غير آمن أو
 * ملفٌ غائب لا يُعدّ خطأً: الغاية ألّا يبقى، لا أن يكون موجودًا.
 */
export async function removeFileByKey(key: string): Promise<boolean> {
  if (!isSafeKey(key)) return false;
  const directory = configuredDirectory();
  if (!directory) return false;
  try {
    await rm(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ directory, key), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Archive roots are provisioned by deployment, never by the first export.
 * Their directory entries must already be durable on the configured volume.
 * This preflight deliberately does not create directories or run upload probes. */
export async function immutableStorageRootIsProvisioned(): Promise<boolean> {
  const directory = configuredDirectory();
  if (!directory) return false;
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink() && await realpath(directory) === directory;
  } catch { return false; }
}

/** Immutable export storage. Existing upload helpers intentionally retain their
 * behavior. The storage root must be application-owned; no user-supplied paths
 * are accepted. Reject symlink roots, shards and leaves before accessing bytes. */
async function immutableParent(key: string, create: boolean): Promise<string> {
  const directory = configuredDirectory();
  if (!directory || !isSafeKey(key) || await realpath(directory) !== directory) throw new Error("IMMUTABLE_FILE_INVALID");
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("IMMUTABLE_FILE_INVALID");
  let parent = directory;
  for (const part of key.split("/").slice(0, -1)) {
    parent = join(parent, part);
    if (create) try { await mkdir(parent, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) throw new Error("IMMUTABLE_FILE_INVALID");
    if (create) {
      // Sync even an existing shard: it may have just been made by a concurrent
      // writer, or left by a previous attempt whose parent fsync failed.
      const ancestor = await open(dirname(parent), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await ancestor.sync(); } finally { await ancestor.close(); }
    }
  }
  return parent;
}

async function verifiedHandleBytes(file: Awaited<ReturnType<typeof open>>, sha256: string, sizeBytes: number): Promise<Buffer> {
  const before = await file.stat();
  if (!before.isFile() || before.size !== sizeBytes) throw new Error("IMMUTABLE_FILE_INVALID");
  const bytes = Buffer.alloc(sizeBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!read.bytesRead) break;
    offset += read.bytesRead;
  }
  const after = await file.stat();
  // Publishing/unlinking another hardlink changes ctime without changing bytes.
  // Do not reject a valid concurrent dedup on link-count metadata alone.
  if (offset !== sizeBytes || after.size !== sizeBytes || after.mtimeMs !== before.mtimeMs ||
      createHash("sha256").update(bytes.subarray(0, offset)).digest("hex") !== sha256) throw new Error("IMMUTABLE_FILE_INVALID");
  return bytes.subarray(0, offset);
}

function immutableReferenceValid(key: string, sha256: string, sizeBytes: number): boolean {
  return isSafeKey(key) && /^[0-9a-f]{64}$/.test(sha256) && key.split("/").at(-1)?.split(".")[0] === sha256 &&
    key.startsWith(`${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/`) && Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && sizeBytes <= 25 * 1024 * 1024;
}

/** Same-handle, no-follow read with an exact bounded length and digest check. */
export async function readImmutableFileByKey(key: string, sha256: string, sizeBytes: number): Promise<Buffer> {
  if (!immutableReferenceValid(key, sha256, sizeBytes)) throw new Error("IMMUTABLE_FILE_INVALID");
  const parent = await immutableParent(key, false);
  const file = await open(join(parent, key.split("/").at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return await verifiedHandleBytes(file, sha256, sizeBytes); } finally { await file.close(); }
}

/** Publish complete bytes once. A collision is accepted only after reading and
 * verifying the existing file. Never replace or remove a final file, even if
 * publication succeeded but a later fsync failed. */
export async function putImmutableFile(bytes: Uint8Array, extension: string): Promise<StoredFile> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 25 * 1024 * 1024 || !/^[a-z0-9]{1,8}$/.test(extension)) throw new Error("IMMUTABLE_FILE_INVALID");
  const snapshot = Buffer.from(bytes);
  const sha256 = createHash("sha256").update(snapshot).digest("hex");
  const key = storageKey(sha256, extension);
  const parent = await immutableParent(key, true);
  const destination = join(parent, key.split("/").at(-1)!);
  const temporary = join(parent, `.export-${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    created = true;
    await file.writeFile(snapshot);
    await file.sync();
    await verifiedHandleBytes(file, sha256, snapshot.length);
    await file.close(); file = undefined;
    // Recheck shard safety before linking; roots/shards are application-owned.
    await immutableParent(key, false);
    let deduplicated = false;
    try { await link(temporary, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      deduplicated = true;
    }
    await readImmutableFileByKey(key, sha256, snapshot.length);
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return { key, sha256, sizeBytes: snapshot.length, deduplicated };
  } finally {
    await file?.close().catch(() => undefined);
    if (created) await unlink(temporary).catch(() => undefined);
  }
}
