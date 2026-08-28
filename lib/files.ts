import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
    await mkdir(directory, { recursive: true });
    // كتابةٌ فعلية: مجلّدٌ موجود لا يعني مجلّدًا قابلًا للكتابة — والقرص المُلحق
    // قد يُركَّب للقراءة فقط بخطأٍ في الإعداد، فيفشل أول رفعٍ لا هذا الفحص.
    const probe = join(directory, ".write-probe");
    await writeFile(probe, "ok");
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
  const path = join(status.directory, key);

  try {
    const existing = await stat(path);
    return { sha256, key, sizeBytes: existing.size, deduplicated: true };
  } catch {
    // غير موجود — يُكتب.
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return { sha256, key, sizeBytes: bytes.length, deduplicated: false };
}

export async function readFileByKey(key: string): Promise<Buffer | null> {
  if (!isSafeKey(key)) return null;
  const status = await storageStatus();
  if (!status.directory) return null;
  try {
    return await readFile(join(status.directory, key));
  } catch {
    return null;
  }
}
