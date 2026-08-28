/**
 * كاتب TAR — لأرشيف الأشعة.
 *
 * لماذا TAR لا ZIP: صيغته أبسط بما لا يقارن (رأسٌ من ٥١٢ بايتًا ثم المحتوى)،
 * فتُكتب في أربعين سطرًا **بلا تبعية**. وZIP يحتاج فهرسًا في آخر الملف وحسابات
 * CRC، فيعني مكتبةً كاملة — وتبعيةٌ جديدة في نظامٍ يُنشر كل يوم ثمنها أعلى من
 * راحة النقرة المزدوجة في ويندوز. و`tar.gz` يفتحه 7-Zip وWinRAR وكل نظام آخر.
 *
 * والملفّات تُكتب واحدًا واحدًا في تدفّق: أرشيفُ أشعةِ عيادةٍ كاملة قد يبلغ
 * غيغابايتات، وجمعُه في الذاكرة قبل الإرسال يُسقط الخادم.
 */

const BLOCK = 512;

const pad = (value: number, length: number): string =>
  value.toString(8).padStart(length - 1, "0") + "\0";

/**
 * رأسُ ملفٍّ في الأرشيف.
 *
 * يُستعمل تنسيق USTAR كي تُقبل الأسماء الطويلة والحروف العربية: الاسم يُكتب
 * بترميز UTF-8، وهو ما تفكّه أدوات فكّ الضغط الحديثة كما كُتب.
 */
export function tarHeader(name: string, size: number, modified: Date): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const encoder = new TextEncoder();
  const write = (text: string, offset: number, length: number) => {
    const bytes = encoder.encode(text).slice(0, length);
    header.set(bytes, offset);
  };

  const encodedName = encoder.encode(name);
  // الاسم الأطول من ١٠٠ بايت يُشقّ على الحقلين: البادئة ثم الاسم.
  if (encodedName.length <= 100) {
    write(name, 0, 100);
  } else {
    const cut = name.lastIndexOf("/", 100);
    write(name.slice(cut + 1), 0, 100);
    write(name.slice(0, cut), 345, 155);
  }

  write(pad(0o644, 8), 100, 8);        // الصلاحيات
  write(pad(0, 8), 108, 8);            // المالك
  write(pad(0, 8), 116, 8);            // المجموعة
  write(pad(size, 12), 124, 12);
  write(pad(Math.floor(modified.getTime() / 1000), 12), 136, 12);
  write("        ", 148, 8);           // خانة المجموع تُملأ فراغات ثم تُحسب
  write("0", 156, 1);                  // ملف عادي
  write("ustar\0", 257, 6);
  write("00", 263, 2);

  // المجموع يُحسب والخانة فراغات، ثم يُكتب بست خانات ثمانية يتبعها صفرٌ فمسافة —
  // وهو ما تتوقّعه أدوات الفكّ حرفيًّا.
  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return header;
}

/** الحشو إلى مضاعف ٥١٢ — شرط الصيغة. */
export function tarPadding(size: number): Uint8Array {
  const remainder = size % BLOCK;
  return new Uint8Array(remainder === 0 ? 0 : BLOCK - remainder);
}

/** نهاية الأرشيف: كتلتان صفريّتان. */
export function tarEnd(): Uint8Array {
  return new Uint8Array(BLOCK * 2);
}

/**
 * اسمٌ آمنٌ داخل الأرشيف.
 *
 * وصفُ المستند يكتبه إنسان، وقد يحمل `/` أو `..` — واسمٌ كهذا في أرشيف يجعل فكّه
 * يكتب خارج المجلّد المقصود على جهاز من يفكّه.
 */
export function safeEntryName(text: string, fallback: string): string {
  const cleaned = text
    .replace(/[\/\\]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/[\x00-\x1f]/g, "")
    .trim();
  return cleaned || fallback;
}
