import { gzipSync, gunzipSync } from "node:zlib";
import { tarEnd, tarHeader, tarPadding } from "../../lib/tar";

/** مساعدات بناء أرشيفات اختبارية — نفس كاتب lib/tar الحقيقي. */

export function concatUint8(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of arrays) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface TarTestEntry {
  name: string;
  data: Buffer | Uint8Array;
}

export function tarBytes(entries: TarTestEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const size = entry.data.length;
    chunks.push(tarHeader(entry.name, size, new Date()));
    chunks.push(entry.data as Uint8Array);
    chunks.push(tarPadding(size));
  }
  chunks.push(tarEnd());
  return concatUint8(chunks);
}

export function tarGzBytes(entries: TarTestEntry[]): Uint8Array {
  return gzipSync(tarBytes(entries));
}

export function gunzipBuffer(gz: Uint8Array): Uint8Array {
  return gunzipSync(gz);
}
