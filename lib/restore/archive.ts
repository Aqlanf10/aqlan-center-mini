import { createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import { Transform, Writable } from "node:stream";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
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

/** Hash and parse the very same compressed byte stream. The decompressed tar
 * uses the existing temporary-file boundary rather than accumulating gzip
 * output chunks in memory. No new archive size limit is imposed. */
export async function readTarGzSnapshot(gzipPath: string): Promise<{ archive: ParsedArchive; sha256: string; bytes: number }> {
  // O_NONBLOCK ensures a substituted FIFO cannot hang the verification thread.
  // Inspect and stream the same open descriptor to avoid a path-swap race.
  const input = await open(gzipPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const source = await input.stat();
    if (!source.isFile() || source.size <= 0) throw new Error("Invalid archive file.");
    const stage = await mkdtemp(path.join(tmpdir(), "aqlan-restore-"));
    try {
      const tarPath = path.join(stage, "archive.tar"), hash = createHash("sha256");
      const tar = await open(tarPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      try {
        // The file is ours alone; on POSIX unlinking its private name prevents
        // another process from replacing or modifying the parsed tar by path.
        if (process.platform !== "win32") await unlink(tarPath);
        let bytes = 0;
        const witness = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        } });
        let tarOffset = 0;
        const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
          void (async () => {
            let offset = 0;
            while (offset < chunk.length) {
              const written = await tar.write(chunk, offset, chunk.length - offset, tarOffset);
              if (written.bytesWritten === 0) throw new Error("Incomplete tar snapshot write.");
              offset += written.bytesWritten;
              tarOffset += written.bytesWritten;
            }
          })().then(() => callback(), error => callback(error));
        } });
        await pipeline(input.createReadStream({ autoClose: false }), witness, createGunzip(), output);
        if (bytes !== source.size) throw new Error("Archive size changed during reading.");
        const size = (await tar.stat()).size;
        if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid tar size.");
        const body = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
          const read = await tar.read(body, offset, size - offset, offset);
          if (read.bytesRead === 0) throw new Error("Incomplete tar snapshot.");
          offset += read.bytesRead;
        }
        return { archive: parseTarBytes(body), sha256: hash.digest("hex"), bytes };
      } finally { await tar.close(); }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  } finally { await input.close(); }
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
