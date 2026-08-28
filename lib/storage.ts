/**
 * تخزين الملفّات — الأشعة والمستندات.
 *
 * **الدستور، المحظور الثامن: لا Blobs للصور داخل PostgreSQL.** وليست قاعدةً شكلية:
 * صورة أشعة بانورامية تُقاس بالميغابايتات، ومئةُ مريضٍ في الشهر تعني قاعدةً تنتفخ
 * حتى تصير كل نسخةٍ احتياطية عمليةً تستغرق ساعة — فلا تُؤخذ. وأسوأ نسخة هي التي
 * لم تُؤخذ.
 *
 * فالملفّ على القرص، والقاعدة تحمل **وصفه** فقط: من رفعه، ومتى، ولأيّ مريض، وأين
 * هو، وبصمته.
 *
 * ### لماذا العنونة بالمحتوى (content addressing)
 *
 * اسم الملف على القرص هو `sha256` لمحتواه. وفي هذا ثلاث فوائد:
 *
 * ١) **لا تصادم**: مريضان يرفعان ملفًّا اسمه `IMG_0001.jpg` لا يدهس أحدهما الآخر.
 * ٢) **لا تكرار**: نفس الأشعة تُرفع مرتين فتُخزَّن مرة — والصفّان في القاعدة
 *    يشيران إليها. وحذفُ أحدهما لا يمسّ الآخر.
 * ٣) **لا يُخمَّن المسار**: اسمٌ من ٦٤ حرفًا لا يُحزر، فلا تُقرأ أشعةُ مريضٍ بتخمين
 *    رابط. وهذا حارسٌ ثانٍ خلف حراسة الجلسة، لا بديلٌ عنها.
 */

/** ما يقبله البرنامج — قائمة مغلقة عمدًا. */
export const ALLOWED_TYPES: Record<string, { extension: string; label: string; image: boolean }> = {
  "image/jpeg": { extension: "jpg", label: "صورة JPEG", image: true },
  "image/png": { extension: "png", label: "صورة PNG", image: true },
  "image/webp": { extension: "webp", label: "صورة WebP", image: true },
  "application/pdf": { extension: "pdf", label: "مستند PDF", image: false },
};

export type DocumentKind = "xray" | "photo" | "report" | "consent" | "other";

export const KIND_LABEL: Record<DocumentKind, string> = {
  xray: "أشعة",
  photo: "صورة سريرية",
  report: "تقرير",
  consent: "موافقة موقَّعة",
  other: "أخرى",
};

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === "string" && value in KIND_LABEL;
}

/**
 * الحدّ الأعلى لحجم الملف.
 *
 * عشرون ميغابايت تكفي أشعةً بانورامية بجودةٍ عالية، وتردّ ملفًّا رُفع بالخطأ —
 * مقطعَ فيديو مثلًا — قبل أن يملأ القرص. والقيمة قابلة للتهيئة من الإعدادات:
 * ما يكفي عيادةً اليوم قد لا يكفيها بعد جهازٍ جديد.
 */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export interface RejectedUpload {
  ok: false;
  message: string;
}

export interface AcceptedUpload {
  ok: true;
  extension: string;
  isImage: boolean;
}

/** هل يُقبل هذا الملف؟ — والرسالة عربية تقول **لماذا** لا «تعذّر الرفع». */
export function validateUpload(input: {
  mimeType: string;
  sizeBytes: number;
  maxBytes?: number;
}): AcceptedUpload | RejectedUpload {
  const allowed = ALLOWED_TYPES[input.mimeType];
  if (!allowed) {
    const names = [...new Set(Object.values(ALLOWED_TYPES).map((type) => type.extension.toUpperCase()))];
    return { ok: false, message: `نوع الملف غير مقبول. المقبول: ${names.join("، ")}.` };
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    return { ok: false, message: "الملف فارغ." };
  }
  const max = input.maxBytes && input.maxBytes > 0 ? input.maxBytes : DEFAULT_MAX_BYTES;
  if (input.sizeBytes > max) {
    return { ok: false, message: `الملف أكبر من الحدّ المسموح (${formatBytes(max)}).` };
  }
  return { ok: true, extension: allowed.extension, isImage: allowed.image };
}

/** حجمٌ يقرؤه إنسان — «٢٫٤ ميغابايت» لا «2516582». */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} كيلوبايت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ميغابايت`;
}

/**
 * مسار الملف من بصمته.
 *
 * يُشقّ إلى مجلّدين من حرفين: `ab/cd/abcd…`. ومجلّدٌ واحد يضمّ عشرات الآلاف من
 * الملفّات يُبطئ كل عمليةٍ عليه على أنظمة الملفّات الشائعة — والتقسيم يوزّعها.
 */
export function storageKey(sha256: string, extension: string): string {
  const clean = sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("بصمة غير صالحة.");
  const safeExtension = /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin";
  return `${clean.slice(0, 2)}/${clean.slice(2, 4)}/${clean}.${safeExtension}`;
}

/**
 * يمنع الخروج من مجلّد التخزين.
 *
 * المفتاح يأتي من القاعدة لا من الطلب، لكن الحارس يبقى: خللٌ يومًا ما يجعل قيمةً
 * فيها `../../etc/passwd` تصل إلى هنا، وحينها يكون الفرق بين خطأٍ في سجل وتسريبِ
 * ملفّات النظام سطرًا واحدًا.
 */
export function isSafeKey(key: string): boolean {
  return /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(key);
}
