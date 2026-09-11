import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * تشفير النسخة قبل النسخ إلى وجهة خارجية — واجهة معتمدة بمعيار مُجرَّب.
 *
 * ### تقييم الصيغة الحالية (قرار موثَّق)
 *
 * أرشيف النسخة الكاملة يحمل `database.sql` — كل مرضى المركز وماله وسجلاته
 * سريريًّا — وكل المستندات. أي نسخٌ منه إلى وجهة خارجية (Google Drive أو
 * وكيل العيادة أو S3 لاحقًا) يعني خروج السجل الطبي كله من القرص الدائم.
 * لذلك: **التشفير شرطٌ سابق لكل نسخٍ خارجي** — بلوكِر معماري، لا تفضيل.
 *
 * ### المعيار المختار: AES-256-GCM
 *
 * تشفير مُصادَق (AEAD) من مكتبة node:crypto القياسية — لا كريبتو مُخترع
 * هنا: التغليف `AQLANENC1` (سحر + إصدار) ثم IV مُعلن (12 بايت) ثم
 * ciphertext + auth tag. سلامة المحتوى يتحقق منها GCM نفسه — أي تبديل
 * بايتٍ يُفشل الفك كله، ولا يُقبل ملفٌ مبتر كنسخة صالحة.
 *
 * ### المفتاح
 *
 * يأتي من البيئة (`BACKUP_ENCRYPTION_KEY` — 64 خانة hex = 256 بت) ولا يُخزَّن
 * في الأرشيف ولا في manifest ولا في history ولا في أي سجل. تدوير المفتاح:
 * نسخٌ جديد بمفتاحٍ جديد (الأرشيفات القديمة تُفك بمفتاحها القديم طوال مدة
 * retention) — والاسترجاع هو حفظ المفتاح في مدير أسرارٍ خارج النظام.
 * فقدان المفتاح = فقدان قابلية فك النسخ المشفَّرة (مُوثَّق في
 * docs/PRODUCTION_BACKUP_GATE.md).
 */

/** سطر البيئة الذي يحمل مفتاح التشفير — لا يُسجَّل أبدًا. */
export const BACKUP_ENCRYPTION_KEY_ENV = "BACKUP_ENCRYPTION_KEY";

/** الترويسة السحرية للتغليف — تُحدِّد الصيغة والإصدار معًا. */
const MAGIC = Buffer.from("AQLANENC1", "utf8");
/** إصدار التغليف — بايت واحد بعد السحر. */
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** أطول ترويسة يمكن أن يقرأها فاحص الصيغة قبل البيانات. */
export const ENVELOPE_HEADER_BYTES = MAGIC.length + 1 + IV_BYTES + 16;

/** هل مفتاح التشفير مضبوطٌ وبصيغة صحيحة (64 خانة hex)؟ */
export function isBackupEncryptionConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return /^[0-9a-fA-F]{64}$/.test(env[BACKUP_ENCRYPTION_KEY_ENV]?.trim() ?? "");
}

/** بصمة المفتاح لعرضها في الحالة — لا المفتاح نفسه أبدًا. */
export function encryptionKeyFingerprint(keyHex: string): string {
  return createHash("sha256").update(keyHex.trim().toLowerCase(), "utf8").digest("hex").slice(0, 16);
}

function keyBuffer(keyHex: string): Buffer {
  const trimmed = keyHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("مفتاح تشفير النسخ غير صالح — 64 خانة hex مطلوبة.");
  }
  return Buffer.from(trimmed, "hex");
}

/**
 * تشفير أرشيف النسخة كاملًا قبل نسخه إلى وجهة خارجية.
 * الناتج: سحر + إصدار + IV عشوائي + ciphertext (GCM يتضمن auth tag).
 * المفتاح لا يدخل الناتج ولا يُشتق منه شيء.
 */
export function encryptArchiveBuffer(plain: Uint8Array, keyHex: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer(keyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), iv, tag, ciphertext]);
}

/**
 * فك أرشيف مشفَّر — فحص الصيغة أولًا ثم فك GCM: مفتاحٌ خطأ أو تبديلُ بايتٍ
 * واحد يرمي خطأً (fail-closed) ولا يعيد بياناتٍ تالفة صامتة.
 */
export function decryptArchiveBuffer(encrypted: Uint8Array, keyHex: string): Buffer {
  if (encrypted.length < MAGIC.length + 1 + IV_BYTES + 16) {
    throw new Error("الملف المشفَّر مبتر أو ليس بتغليف النسخ المعروف.");
  }
  const bytes = Buffer.from(encrypted);
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("الملف ليس بتغليف تشفير النسخ المعروف.");
  }
  if (bytes[MAGIC.length] !== FORMAT_VERSION) {
    throw new Error("إصدار تغليف التشفير غير مدعوم.");
  }
  const offset = MAGIC.length + 1;
  const iv = bytes.subarray(offset, offset + IV_BYTES);
  const tag = bytes.subarray(offset + IV_BYTES, offset + IV_BYTES + 16);
  const ciphertext = bytes.subarray(offset + IV_BYTES + 16);
  const decipher = createDecipheriv("aes-256-gcm", keyBuffer(keyHex), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("فك التشفير فشل — مفتاح خطأ أو محتوى مُعدَّل.");
  }
}

/**
 * هل يبدأ الملف بتغليف التشفير المعروف؟ — للتمييز في السجلات والحالة دون فك.
 */
export function looksEncrypted(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  return Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC);
}

/** مقارنة بصمة مفتاحٍ معروضة مع بصمة مضبوطة بزمنٍ ثابت (للواجهات لاحقًا). */
export function keyFingerprintMatches(keyHex: string, fingerprint: string): boolean {
  const actual = Buffer.from(encryptionKeyFingerprint(keyHex), "utf8");
  const expected = Buffer.from(fingerprint, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * شرط البلوكِر للنسخ الخارجي — الدالة المرجعية التي يفحصها كل مزوّد خارجي
 * قبل أول رفع: لا تشفير مهيَّأ ⇒ لا نسخ خارجي، مهما كانت بقية التكوين سليمة.
 */
export function assertExternalReplicationAllowed(
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isBackupEncryptionConfigured(env)) {
    throw new Error("النسخ إلى وجهة خارجية ممنوع قبل تهيئة تشفير النسخة (AES-256-GCM).");
  }
}
