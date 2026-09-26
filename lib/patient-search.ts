/**
 * (PAT-1) بحثٌ عن المريض يتسامح مع الإملاء العربي — كما تفعل الأنظمة الرائدة.
 *
 * «احمد» يجد «أحمد»، و«فاطمه» تجد «فاطمة»، و«علي محمد» يجد «محمد علي عبدالله»، ورقم
 * الجوال بأي صيغة (0770… أو 770… أو 967770…) يجد صاحبه — وكذلك رقم الملف والهوية وجوال
 * وليّ الأمر واسمه. البحث الذي لا يجد المريض يُنشئ ملفًا مكررًا؛ وهذا أصل التكرار.
 *
 * التطبيع نفسه في مكانين متطابقين حرفًا بحرف: `normalizeSearchText` (للكلمات المكتوبة)
 * و`normalizedSql` (للحقول في القاعدة) — واختبار PG يُثبت تطابقهما.
 */

/** التشكيل والتطويل وألف الخنجرية — تُحذف. */
const MARKS = "ً-ٰٟـ";
/** الحروف التي تُوحَّد: الهمزات على الألف والألف الوصلية ← ا، ى ← ي، ة ← ه، ؤ ← و، ئ ← ي، والأرقام الهندية ← لاتينية. */
const FROM = "أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹";
const TO = "اااايهوي01234567890123456789";

const MARKS_PATTERN = new RegExp(`[${MARKS}]`, "g");
const TRANSLATE = new Map([...FROM].map((char, index) => [char, TO[index]]));

export function normalizeSearchText(text: string): string {
  let result = "";
  for (const char of text.replace(MARKS_PATTERN, "")) result += TRANSLATE.get(char) ?? char;
  return result.toLowerCase();
}

/** تعبير SQL يطبّع العمود نفسه بالقواعد ذاتها. */
export function normalizedSql(expression: string): string {
  return `lower(translate(regexp_replace(${expression}, '[${MARKS}]', '', 'g'), '${FROM}', '${TO}'))`;
}

/** كل ما يُبحث فيه عن المريض — مطبَّعًا ومضمومًا. */
export const PATIENT_HAYSTACK_SQL = normalizedSql(
  "concat_ws(' ', full_name, patient_number, phone, alt_phone, guardian_name, guardian_phone, national_id)",
);

/**
 * كلمات البحث مطبَّعة. رقم الجوال يُجرَّد من مقدّمته (00967 / 967 / 0) فيطابق المخزّن بأي
 * صيغة كجزءٍ منه.
 */
const stripPhonePrefix = (digits: string) => digits.replace(/^(00967|967|0)(?=\d{7,})/, "");

export function searchTokens(term: string): string[] {
  const normalized = normalizeSearchText(term).trim();
  // رقمٌ مكتوب بمسافات أو «+» (‎+967 770 123 456‎) رقمٌ واحد لا كلمات.
  const compact = normalized.replace(/[\s()+-]/g, "");
  if (/^\d{7,}$/.test(compact)) return [stripPhonePrefix(compact)];
  const tokens: string[] = [];
  for (const raw of normalized.split(/\s+/)) {
    if (!raw) continue;
    const digits = raw.replace(/[()+-]/g, "");
    tokens.push(/^\d{7,}$/.test(digits) ? stripPhonePrefix(digits) : raw);
  }
  return [...new Set(tokens)].slice(0, 6);
}

/** نمط LIKE آمن: `%` و`_` و`!` حرفيّة (ESCAPE '!'). */
export function likeContains(token: string): string {
  return `%${token.replace(/[!%_]/g, (char) => `!${char}`)}%`;
}

/**
 * شرط البحث: كل كلمة يجب أن تظهر في أي حقلٍ من حقول المريض (بأي ترتيب).
 * `firstParam` رقم أول معامل؛ ويُعاد المعاملات بالترتيب.
 */
export function patientSearchCondition(tokens: readonly string[], firstParam: number): { sql: string; params: string[] } {
  if (tokens.length === 0) return { sql: "FALSE", params: [] };
  const parts = tokens.map((_, index) => `${PATIENT_HAYSTACK_SQL} LIKE $${firstParam + index} ESCAPE '!'`);
  return { sql: `(${parts.join(" AND ")})`, params: tokens.map(likeContains) };
}
