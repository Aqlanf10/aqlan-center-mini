/**
 * (P3-1) ترقيم المستندات المالية — البادئة من الإعدادات، والعدّاد من القاعدة.
 *
 * البادئة (INV/R/V/X افتراضيًّا) قرار العيادة لا الكود. تُقرأ **داخل عبارة الإدراج
 * نفسها** من جدول settings: لا خبيئة تؤخّر تغييرها، ولا سباق بين تغييرها وترقيم
 * مستندٍ في منتصف معاملة. والعدّاد لم يتغيّر: الأرقام تتابع بلا تكرار مهما تغيّرت
 * البادئة.
 *
 * لماذا حروف لاتينية كبيرة فقط (١–٦)؟ مزامنة العدّادات عند الإقلاع تنزع كل ما ليس
 * رقمًا من أرقام المستندات القائمة وتقرأ الباقي — فبادئةٌ فيها رقم («IN2026») تقفز
 * بالعدّاد إلى الملايين. والنمط نفسه مفروضٌ مرتين: في تحقق الإعدادات (الشاشة
 * والخادم)، وفي SQL هنا دفاعًا عمّن يكتب في القاعدة مباشرة — القيمة الفاسدة تعود
 * للافتراضي ولا تدخل رقم مستند.
 *
 * بادئة ملف المريض (P-) خارج هذا عمدًا: حجب أرقام الملفات قبل إرسال نصٍّ للمساعد
 * الذكي يتعرّف عليها بنمطها — وتغييرها يُفلت أرقام الملفات من الحجب.
 */

export type DocumentKind = "invoice" | "receipt" | "voucher" | "reversal";

export const DOCUMENT_PREFIX_SETTING = {
  invoice: "documents.invoice_prefix",
  receipt: "documents.receipt_prefix",
  voucher: "documents.voucher_prefix",
  reversal: "documents.reversal_prefix",
} as const satisfies Record<DocumentKind, string>;

export const DOCUMENT_PREFIX_DEFAULT: Record<DocumentKind, string> = {
  invoice: "INV",
  receipt: "R",
  voucher: "V",
  reversal: "X",
};

/** حروف لاتينية كبيرة من ١ إلى ٦ — لا أرقام ولا رموز ولا مسافات. */
export const DOCUMENT_PREFIX_PATTERN = /^[A-Z]{1,6}$/;
const DOCUMENT_PREFIX_SQL_PATTERN = "^[A-Z]{1,6}$";

const SEQUENCE: Record<DocumentKind, string> = {
  invoice: "invoice_number_seq",
  receipt: "receipt_number_seq",
  // سند الصرف وسند إبطاله يتقاسمان عدّادًا واحدًا (جدول expenses نفسه).
  voucher: "voucher_number_seq",
  reversal: "voucher_number_seq",
};

/**
 * تعبير SQL يولّد رقم المستند التالي: «البادئة-00042».
 *
 * نصٌّ ثابت من ثوابت هذا الملف وحده — لا مدخلات مستخدم تدخل النص، فلا حقن.
 */
export function documentNumberSql(kind: DocumentKind): string {
  const key = DOCUMENT_PREFIX_SETTING[kind];
  const fallback = DOCUMENT_PREFIX_DEFAULT[kind];
  return `COALESCE((SELECT s.value FROM settings s WHERE s.key = '${key}' AND s.value ~ '${DOCUMENT_PREFIX_SQL_PATTERN}'), '${fallback}')`
    + ` || '-' || LPAD(nextval('${SEQUENCE[kind]}')::text, 5, '0')`;
}

/** تحقق قيمة البادئة المكتوبة في الإعدادات — رسالة عربية أو null. */
export function documentPrefixProblem(value: string): string | null {
  if (!DOCUMENT_PREFIX_PATTERN.test(value.trim())) {
    return "البادئة حروف لاتينية كبيرة فقط، من حرف إلى ستة (مثل INV أو FAC) — بلا أرقام ولا رموز.";
  }
  return null;
}

/** نوع المستند الذي يملك مفتاح الإعداد — أو null لمفتاحٍ ليس بادئة. */
export function documentKindOfSetting(key: string): DocumentKind | null {
  const entry = (Object.entries(DOCUMENT_PREFIX_SETTING) as [DocumentKind, string][]).find(([, k]) => k === key);
  return entry ? entry[0] : null;
}

/**
 * أين تُبحث بادئةٌ في مستندات **الأنواع الأخرى** قبل أن تُعطى لهذا النوع.
 *
 * عدّادات الفاتورة وسند القبض مستقلة: لو صارت «INV» بادئةَ سند القبض بعد أن
 * كانت للفاتورة، لخرج سندٌ برقمٍ مطبوعٍ على فاتورةٍ قديمة حرفيًّا. سند الصرف
 * وسند الإبطال في جدولٍ واحد، فيُميَّزان بـ reversal_of_id. نصوصٌ ثابتة — لا مدخلات.
 */
export const OTHER_KINDS_NUMBERS_SQL: Record<DocumentKind, readonly string[]> = {
  invoice: [
    "SELECT receipt_number AS n FROM payments",
    "SELECT voucher_number AS n FROM expenses",
  ],
  receipt: [
    "SELECT invoice_number AS n FROM invoices",
    "SELECT voucher_number AS n FROM expenses",
  ],
  voucher: [
    "SELECT invoice_number AS n FROM invoices",
    "SELECT receipt_number AS n FROM payments",
    "SELECT voucher_number AS n FROM expenses WHERE reversal_of_id IS NOT NULL",
  ],
  reversal: [
    "SELECT invoice_number AS n FROM invoices",
    "SELECT receipt_number AS n FROM payments",
    "SELECT voucher_number AS n FROM expenses WHERE reversal_of_id IS NULL",
  ],
};

