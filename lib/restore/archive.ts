import { createGunzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * قراءة أرشيف النسخة الكاملة (tar.gz) كاملًا في الذاكرة (P1.12).
 *
 * القراءة الكاملة قبل أي لمس لقاعدة هدف هي جوهر المتطلب: لا يبدأ أي شيء
 * قبل أن يكون الأرشيف كلُّه مفكوكًا ومفهومًا. الكشف عن البتر صريح: أرشيف
 * أقصر من مبتغاه (تنزيل مقطوع) يُرفض بلا غموض.
 */

export interface TarEntry {
  name: string;
  data: Uint8Array;
  order: number;
}

export interface ParsedArchive {
  entries: Map<string, TarEntry>;
  order: string[];
  truncated: boolean;
}

export async function readTarGzEntries(gzipPath: string): Promise<ParsedArchive> {
  const stage = await mkdtemp(path.join(tmpdir(), "aqlan-restore-"));
  try {
    const tarPath = path.join(stage, "archive.tar");
    await pipeline(
      createReadStream(gzipPath),
      createGunzip(),
      createWriteStream(tarPath),
    );
    const bytes = await readFile(tarPath);
    return parseTarBytes(bytes);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export function parseTarBytes(bytes: Buffer | Uint8Array): ParsedArchive {
  const entries = new Map<string, TarEntry>();
  const order: string[] = [];
  let offset = 0;
  let entryIndex = 0;
  const decoder = new TextDecoder();
  let truncated = false;
  let sawEndMarker = false;

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    if (!name) { sawEndMarker = true; break; } // مدخل النهاية — اكتمل الأرشيف سليمًا
    const sizeField = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField || "0", 8);
    const type = header[156];
    const dataEnd = offset + 512 + size;
    if (!Number.isFinite(size) || size < 0) {
      truncated = true;
      break;
    }
    if (dataEnd > bytes.length) {
      // الرأس يقول إن للملف حجمًا لا يملكه الأرشيف — بترٌ مؤكد.
      truncated = true;
      break;
    }
    const data = bytes.subarray(offset + 512, dataEnd);
    const normalized = name.replace(/^\.\//, "");
    if ((type === 48 || type === 0) && normalized) {
      if (entries.has(normalized)) {
        // مدخل مكرر باسم واحد — الأرشيف مشبوه؛ نعلّم ونرفض لاحقًا في التحقق.
        truncated = true;
      } else {
        entries.set(normalized, { name: normalized, data, order: entryIndex });
        order.push(normalized);
      }
      entryIndex += 1;
    }
    offset = dataEnd + (512 - (size % 512)) % 512;
  }

  // الأرشيف الكامل ينتهي بعلامة نهاية (كتلتان صفريّتان) — غيابها = بتر، حتى
  // لو بدت المداخل الأخيرة سليمة: كاتبنا يكتب العلامة دائمًا، فغيابها دليل قصّ.
  if (!sawEndMarker) truncated = true;

  return { entries, order, truncated };
}

/**
 * اسم مدخل آمن للأرشيف — **نفس الدالة التي يكتب بها fullBackup** مداخله.
 *
 * اكتشاف P1: النسخة القديمة من restore-full.mjs كانت تبحث عن المستند بمفتاحه
 * الأصلي (`documents/ab/cd/<sha>.<ext>`) بينما الكاتب يحفظ الاسم بعد تطبيع
 * الفواصل (`documents/ab_cd_<sha>.<ext>`) — فلم تكن استعادة المستندات تعمل
 * أصلًا. توحيد الدالة في مكان واحد يجعل الكاتب والقارئ متطابقين بالبنية.
 */
export function safeTarName(key: string): string {
  const clean = key.replace(/[^A-Za-z0-9._-]/g, "_");
  return clean.startsWith(".") ? `d${clean}` : clean;
}

/** اسم مدخل المستند في الأرشيف كما يكتبه fullBackup. */
export function documentEntryName(storageKey: string): string {
  return `documents/${safeTarName(storageKey)}`;
}
