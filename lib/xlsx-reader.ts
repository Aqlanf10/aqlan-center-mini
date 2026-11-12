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

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

const decoder = new TextDecoder("utf-8");
const MAX_XLSX_ZIP_ENTRIES = 2048;
const MAX_XLSX_XML_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_TOTAL_XML_BYTES = 32 * 1024 * 1024;
const MAX_XLSX_COLUMNS = 1024;
const MAX_XLSX_ROWS = 100_000;

function escapeXmlAttrRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSafeZipEntryPath(name: string): boolean {
  if (!name || name.length > 260 || name.includes("\\") || name.includes("\0")) return false;
  const parts = name.split("/");
  return parts.every((part) => part !== ".." && part !== ".");
}

function readZipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // نهاية الدليل المركزي: توقيع 0x06054b50 في آخر ٦٥٥٣٥+٢٢ بايت.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("الملف ليس ملف Excel (xlsx) سليمًا.");
  const count = view.getUint16(end + 10, true);
  if (count > MAX_XLSX_ZIP_ENTRIES) throw new Error("عدد عناصر أرشيف Excel يتجاوز الحد المسموح.");
  let pointer = view.getUint32(end + 16, true);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n += 1) {
    if (pointer + 46 > bytes.length || view.getUint32(pointer, true) !== 0x02014b50) {
      throw new Error("دليل ملف Excel تالف.");
    }
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const uncompressedSize = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    if (!isSafeZipEntryPath(name)) throw new Error("مسار داخلي غير آمن في ملف Excel.");
    if (localOffset + 30 > bytes.length) throw new Error("دليل ملف Excel تالف.");
    // بيانات الملف بعد ترويسته المحلية (طول اسمها وإضافاتها قد يختلف عن المركزية).
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localName + localExtra;
    if (
      compressedSize > MAX_XLSX_XML_BYTES ||
      uncompressedSize > MAX_XLSX_XML_BYTES ||
      dataOffset + compressedSize > bytes.length
    ) {
      throw new Error("حجم عنصر داخل ملف Excel يتجاوز الحد المسموح.");
    }
    entries.set(name, { name, method, compressedSize, uncompressedSize, offset: dataOffset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readEntry(
  bytes: Uint8Array,
  entries: Map<string, ZipEntry>,
  name: string,
  inflate: InflateRaw,
  budget: { usedBytes: number },
): Promise<string | null> {
  if (!isSafeZipEntryPath(name)) throw new Error("مسار ورقة بيانات غير آمن في ملف Excel.");
  const entry = entries.get(name);
  if (!entry) return null;
  const raw = bytes.subarray(entry.offset, entry.offset + entry.compressedSize);
  if (entry.method === 0) {
    if (raw.byteLength > MAX_XLSX_XML_BYTES) throw new Error("حجم محتوى ملف Excel يتجاوز الحد المسموح.");
    budget.usedBytes += raw.byteLength;
    if (budget.usedBytes > MAX_XLSX_TOTAL_XML_BYTES) {
      throw new Error("إجمالي محتوى ملف Excel يتجاوز الحد المسموح.");
    }
    return decoder.decode(raw);
  }
  if (entry.method === 8) {
    const inflated = await inflate(raw);
    if (inflated.byteLength > MAX_XLSX_XML_BYTES) {
      throw new Error("حجم محتوى ملف Excel بعد فك الضغط يتجاوز الحد المسموح.");
    }
    budget.usedBytes += inflated.byteLength;
    if (budget.usedBytes > MAX_XLSX_TOTAL_XML_BYTES) {
      throw new Error("إجمالي محتوى ملف Excel بعد فك الضغط يتجاوز الحد المسموح.");
    }
    return decoder.decode(inflated);
  }
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
  const budget = { usedBytes: 0 };
  const workbook = await readEntry(bytes, entries, "xl/workbook.xml", inflate, budget);
  if (!workbook) throw new Error("الملف ليس ملف Excel (xlsx) سليمًا.");
  const rels = (await readEntry(bytes, entries, "xl/_rels/workbook.xml.rels", inflate, budget)) ?? "";
  const firstSheetRid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  let sheetPath = "xl/worksheets/sheet1.xml";
  if (firstSheetRid) {
    const escapedRid = escapeXmlAttrRegExp(firstSheetRid);
    const target = new RegExp(`<Relationship\\b[^>]*\\bId="${escapedRid}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1]
      ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${escapedRid}"`).exec(rels)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = await readEntry(bytes, entries, sheetPath, inflate, budget);
  if (!sheet) throw new Error("لم تُوجد ورقة بيانات في ملف Excel.");

  const sharedXml = (await readEntry(bytes, entries, "xl/sharedStrings.xml", inflate, budget)) ?? "";
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textOf(match[1]));

  // الأنماط: رقم النمط (s) → هل هو تاريخ؟
  const stylesXml = (await readEntry(bytes, entries, "xl/styles.xml", inflate, budget)) ?? "";
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
    if (rows.length >= MAX_XLSX_ROWS) {
      throw new Error("عدد صفوف الورقة في ملف Excel يتجاوز الحد المسموح.");
    }
    const row: string[] = [];
    for (const cell of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1];
      const body = cell[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const index = ref ? columnIndex(ref) : row.length;
      if (index < 0 || index >= MAX_XLSX_COLUMNS) {
        throw new Error("عدد أعمدة الورقة في ملف Excel يتجاوز الحد المسموح.");
      }
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

/** فكّ الضغط في المتصفح — DecompressionStream المدمج مع قطع فوري عند تجاوز سقف الحجم لمنع قنابل الضغط. */
export const browserInflateRaw: InflateRaw = async (bytes) => {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_XLSX_XML_BYTES) {
        await reader.cancel();
        throw new Error("حجم محتوى ملف Excel بعد فك الضغط يتجاوز الحد المسموح.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/** صفوفٌ إلى CSV (RFC 4180) — لتمريرها إلى مسار الاستيراد القائم كما هو. */
export function rowsToCsv(rows: readonly string[][]): string {
  return rows.map((row) => row.map((value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value)).join(",")).join("\r\n");
}
