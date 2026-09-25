/**
 * (P1-5ج) قارئ ملفات Excel (.xlsx) بلا مكتبة — ليرفع المالك ملفات النظام القديم كما هي.
 *
 * ملف xlsx أرشيف zip فيه XML: جدول الأوراق، والنصوص المشتركة، والأنماط (لمعرفة أيّ
 * رقمٍ تاريخ)، وخلايا الورقة. هنا ما يلزم لقراءة **الورقة الأولى** إلى مصفوفة نصوص
 * لا أكثر: لا صيغ تُحسب (تُقرأ قيمتها المحفوظة)، ولا تنسيق يُعرض.
 *
 * بلا مكتبة لأن مكتبات xlsx المعروفة ثقيلة أو ثغراتها قديمة، وحاجتنا ضيقة ومختبرة.
 * وفكّ الضغط يُمرَّر من الخارج: المتصفح يستعمل `DecompressionStream("deflate-raw")`،
 * والاختبار يستعمل zlib — فالمنطق نفسه يُختبر كما يعمل.
 */

export type InflateRaw = (bytes: Uint8Array) => Promise<Uint8Array>;

interface ZipEntry { name: string; method: number; compressedSize: number; offset: number }

const decoder = new TextDecoder("utf-8");

function readZipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // نهاية الدليل المركزي: توقيع 0x06054b50 في آخر ٦٥٥٣٥+٢٢ بايت.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("الملف ليس ملف Excel (xlsx) سليمًا.");
  const count = view.getUint16(end + 10, true);
  let pointer = view.getUint32(end + 16, true);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) throw new Error("دليل ملف Excel تالف.");
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    // بيانات الملف بعد ترويسته المحلية (طول اسمها وإضافاتها قد يختلف عن المركزية).
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    entries.set(name, { name, method, compressedSize, offset: localOffset + 30 + localName + localExtra });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readEntry(bytes: Uint8Array, entries: Map<string, ZipEntry>, name: string, inflate: InflateRaw): Promise<string | null> {
  const entry = entries.get(name);
  if (!entry) return null;
  const raw = bytes.subarray(entry.offset, entry.offset + entry.compressedSize);
  if (entry.method === 0) return decoder.decode(raw);
  if (entry.method === 8) return decoder.decode(await inflate(raw));
  throw new Error("ضغطٌ غير مدعوم في ملف Excel.");
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

/** نص عنصرٍ غني أو بسيط: كل <t> داخله متصلة (النص الغني يُقسَّم إلى أجزاء). */
function textOf(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => unescapeXml(match[1])).join("");
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** هل صيغة الرقم صيغة تاريخ؟ (d أو m أو y خارج النصوص المقتبسة والمهرَّبة) */
function isDateFormat(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[dmy]/i.test(stripped) && !/^[#0.,%\s]+$/.test(stripped);
}

/** رقم Excel التسلسلي إلى YYYY-MM-DD (نظام 1900 بخطئه التاريخي في 1900-02-29). */
export function excelSerialToDate(serial: number): string {
  const utc = Math.round((serial - 25569) * 86_400_000);
  return new Date(utc).toISOString().slice(0, 10);
}

/**
 * يقرأ الورقة الأولى من ملف xlsx إلى صفوف نصوص.
 * الأرقام تُعاد بصيغتها المخزَّنة (بلا تقريب)، والتواريخ YYYY-MM-DD، والفراغات "".
 */
export async function readFirstSheet(bytes: Uint8Array, inflate: InflateRaw): Promise<string[][]> {
  const entries = readZipEntries(bytes);
  const workbook = await readEntry(bytes, entries, "xl/workbook.xml", inflate);
  if (!workbook) throw new Error("الملف ليس ملف Excel (xlsx) سليمًا.");
  const rels = (await readEntry(bytes, entries, "xl/_rels/workbook.xml.rels", inflate)) ?? "";
  const firstSheetRid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  let sheetPath = "xl/worksheets/sheet1.xml";
  if (firstSheetRid) {
    const target = new RegExp(`<Relationship\\b[^>]*\\bId="${firstSheetRid}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1]
      ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstSheetRid}"`).exec(rels)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = await readEntry(bytes, entries, sheetPath, inflate);
  if (!sheet) throw new Error("لم تُوجد ورقة بيانات في ملف Excel.");

  const sharedXml = (await readEntry(bytes, entries, "xl/sharedStrings.xml", inflate)) ?? "";
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textOf(match[1]));

  // الأنماط: رقم النمط (s) → هل هو تاريخ؟
  const stylesXml = (await readEntry(bytes, entries, "xl/styles.xml", inflate)) ?? "";
  const customFormats = new Map<number, string>();
  for (const match of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    customFormats.set(Number(match[1]), unescapeXml(match[2]));
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  const dateStyles = [...cellXfs.matchAll(/<xf\b([^>]*)\/?>/g)].map((match) => {
    const id = Number(/numFmtId="(\d+)"/.exec(match[1])?.[1] ?? "0");
    return BUILTIN_DATE_FORMATS.has(id) || (customFormats.has(id) && isDateFormat(customFormats.get(id)!));
  });

  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const row: string[] = [];
    for (const cell of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const body = cell[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const index = ref ? columnIndex(ref) : row.length;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? "0");
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = textOf(body);
      else if (type === "str" || type === "e") value = raw === undefined ? "" : unescapeXml(raw);
      else if (type === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
      else if (raw !== undefined && raw !== "") {
        value = dateStyles[style] && Number.isFinite(Number(raw)) ? excelSerialToDate(Number(raw)) : raw;
      }
      while (row.length < index) row.push("");
      row[index] = value;
    }
    rows.push(row);
  }
  // أسطرٌ فارغة تمامًا (تنسيقٌ بلا بيانات) لا تُعدّ.
  return rows.filter((row) => row.some((value) => value.trim() !== ""));
}

/** فكّ الضغط في المتصفح — DecompressionStream المدمج. */
export const browserInflateRaw: InflateRaw = async (bytes) => {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** صفوفٌ إلى CSV (RFC 4180) — لتمريرها إلى مسار الاستيراد القائم كما هو. */
export function rowsToCsv(rows: readonly string[][]): string {
  return rows.map((row) => row.map((value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value)).join(",")).join("\r\n");
}
