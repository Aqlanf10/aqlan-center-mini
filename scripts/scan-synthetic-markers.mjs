import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';

// Synthetic sentinel detector, not a secrets scanner. It emits only bounded
// counters or fixed error codes; neither marker content nor file paths leave it.
const DEFAULTS = Object.freeze({ maxFiles: 100000, maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024, maxDecodedBytes: 1024 * 1024 * 1024,
  maxDepth: 4, maxEntries: 100000, maxJsonNodes: 1000000 });
const HARD_MAX = Object.freeze({ ...DEFAULTS, maxDepth: 8 });
const CODES = new Set(['MARKER_FOUND', 'UNSAFE_LINK', 'LIMIT_EXCEEDED', 'INVALID_CONTENT', 'INVALID_INPUT']);
const fail = (code) => { throw new Error(code); };
const inside = (root, target) => target === root || (!path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target)));
const safeArchivePath = (name) => typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.startsWith('/') && !name.includes('\0')
  && name.replace(/\/$/, '').split('/').every(part => part !== '' && part !== '.' && part !== '..');
const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function scanMarkers({ roots, markers, limits = {} }) {
  if (!Array.isArray(roots) || roots.length === 0 || roots.some(x => typeof x !== 'string' || !path.isAbsolute(x)) ||
      !Array.isArray(markers) || markers.length === 0 || markers.length > 64 || markers.some(x => typeof x !== 'string' || Buffer.byteLength(x) < 8 || Buffer.byteLength(x) > 256) ||
      !limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(k => !(k in DEFAULTS))) fail('INVALID_INPUT');
  const cap = { ...DEFAULTS, ...limits };
  if (Object.entries(cap).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > HARD_MAX[key])) fail('INVALID_INPUT');
  const needles = markers.map(x => Buffer.from(x));
  let filesScanned = 0, decodedObjects = 0, totalBytes = 0, decodedBytes = 0, entriesSeen = 0, jsonNodes = 0;
  const checkBytes = (buf) => { for (const needle of needles) if (buf.includes(needle)) fail('MARKER_FOUND'); };
  const countDecoded = (n) => { decodedObjects++; decodedBytes += n; if (decodedBytes > cap.maxDecodedBytes) fail('LIMIT_EXCEEDED'); };
  const checkJson = (value, depth = 0) => {
    if (++jsonNodes > cap.maxJsonNodes || depth > 128) fail('LIMIT_EXCEEDED');
    if (typeof value === 'string') checkBytes(Buffer.from(value));
    else if (Array.isArray(value)) for (const item of value) checkJson(item, depth + 1);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { checkBytes(Buffer.from(key)); checkJson(item, depth + 1); }
  };
  const unpack = (fn, bytes) => {
    const remaining = Math.min(cap.maxFileBytes, cap.maxDecodedBytes - decodedBytes);
    if (remaining < 1) fail('LIMIT_EXCEEDED');
    try {
      const result = fn(bytes, { maxOutputLength: remaining, info: true });
      if (!result || !Buffer.isBuffer(result.buffer) || result.engine?.bytesWritten !== bytes.length) fail('INVALID_CONTENT');
      return result.buffer;
    } catch (e) { if (CODES.has(e?.message)) throw e; if (e?.code === 'ERR_BUFFER_TOO_LARGE') fail('LIMIT_EXCEEDED'); fail('INVALID_CONTENT'); }
  };
  function zip(bytes, level) {
    // Central-directory sizes permit bounded extraction without writing paths.
    // Reject ZIP64, multi-disk, encrypted, descriptors with ambiguity, and
    // unsupported compression rather than silently skipping content.
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(bytes, i) === 0x06054b50 && i + 22 + u16(bytes, i + 20) === bytes.length) { end = i; break; }
    }
    if (end < 0 || u16(bytes, end + 4) !== 0 || u16(bytes, end + 6) !== 0 || u16(bytes, end + 8) !== u16(bytes, end + 10)) fail('INVALID_CONTENT');
    const count = u16(bytes, end + 10), size = u32(bytes, end + 12), start = u32(bytes, end + 16);
    if (count === 0xffff || size === 0xffffffff || start === 0xffffffff || start + size !== end) fail('INVALID_CONTENT');
    if (entriesSeen + count > cap.maxEntries) fail('LIMIT_EXCEEDED');
    let p = start;
    const ranges = [];
    for (let i = 0; i < count; i++) {
      if (p + 46 > end || u32(bytes, p) !== 0x02014b50) fail('INVALID_CONTENT');
      const flags = u16(bytes, p + 8), method = u16(bytes, p + 10), crc = u32(bytes, p + 16), comp = u32(bytes, p + 20), plain = u32(bytes, p + 24);
      const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32), local = u32(bytes, p + 42);
      if ((flags & 0x09) !== 0 || ![0, 8].includes(method) || comp === 0xffffffff || plain === 0xffffffff || local + 30 > start || u32(bytes, local) !== 0x04034b50 || p + 46 + nameLen + extraLen + commentLen > end) fail('INVALID_CONTENT');
      const name = bytes.subarray(p + 46, p + 46 + nameLen);
      const archiveName = name.toString('utf8');
      const mode = u32(bytes, p + 38) >>> 16;
      if (!safeArchivePath(archiveName) || (mode & 0xf000) === 0xa000) fail('UNSAFE_LINK');
      const localNameLen = u16(bytes, local + 26), localExtraLen = u16(bytes, local + 28);
      const begin = local + 30 + localNameLen + localExtraLen, stop = begin + comp;
      if (!name.equals(bytes.subarray(local + 30, local + 30 + localNameLen)) || flags !== u16(bytes, local + 6) || method !== u16(bytes, local + 8) || crc !== u32(bytes, local + 14) || comp !== u32(bytes, local + 18) || plain !== u32(bytes, local + 22) || stop > start) fail('INVALID_CONTENT');
      ranges.push([local, stop]);
      checkBytes(name);
      if (plain > cap.maxFileBytes || decodedBytes + plain > cap.maxDecodedBytes) fail('LIMIT_EXCEEDED');
      const payload = bytes.subarray(begin, stop);
      const out = method === 0 ? Buffer.from(payload) : unpack(inflateRawSync, payload);
      if (out.length !== plain || crc32(out) !== crc) fail('INVALID_CONTENT');
      entriesSeen++;
      examine(out, archiveName, level + 1, true);
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (p !== end) fail('INVALID_CONTENT');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('INVALID_CONTENT');
  }
  function tar(bytes, level) {
    let p = 0, done = false;
    while (p + 512 <= bytes.length) {
      const block = bytes.subarray(p, p + 512);
      if (block.every(v => v === 0)) { done = true; if (!bytes.subarray(p).every(v => v === 0)) fail('INVALID_CONTENT'); break; }
      if (++entriesSeen > cap.maxEntries) fail('LIMIT_EXCEEDED');
      const sizeText = block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
      const sumText = block.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim();
      if (!/^[0-7]+$/.test(sizeText || '0') || !/^[0-7]+$/.test(sumText)) fail('INVALID_CONTENT');
      const size = parseInt(sizeText || '0', 8), expected = parseInt(sumText, 8);
      let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
      if (sum !== expected || !Number.isSafeInteger(size) || size > cap.maxFileBytes) fail('INVALID_CONTENT');
      const type = block[156]; if ([49, 50].includes(type)) fail('UNSAFE_LINK'); if (![0, 48, 53].includes(type)) fail('INVALID_CONTENT');
      const end = p + 512 + size; if (end > bytes.length || (type === 53 && size !== 0)) fail('INVALID_CONTENT');
      const leaf = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
      const name = prefix ? `${prefix}/${leaf}` : leaf;
      if (!safeArchivePath(name)) fail('UNSAFE_LINK');
      checkBytes(Buffer.from(name));
      if (type !== 53) examine(bytes.subarray(p + 512, end), name, level + 1, true);
      p += 512 + Math.ceil(size / 512) * 512;
    }
    if (!done) fail('INVALID_CONTENT');
  }
  function examine(bytes, name, level, decoded = false) {
    if (level > cap.maxDepth) fail('LIMIT_EXCEEDED');
    if (decoded) countDecoded(bytes.length);
    checkBytes(bytes);
    const lower = name.toLowerCase();
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return examine(unpack(gunzipSync, bytes), lower.replace(/\.(gz|tgz)$/, m => m === '.tgz' ? '.tar' : ''), level + 1, true);
    if (lower.endsWith('.gz') || lower.endsWith('.tgz')) fail('INVALID_CONTENT');
    if (lower.endsWith('.br')) return examine(unpack(brotliDecompressSync, bytes), lower.slice(0, -3), level + 1, true);
    // Unsupported known compression formats are never reported as clean.
    if (/\.(?:xz|zst|zstd|bz2?|7z|rar|lz4?)$/.test(lower)
        || bytes.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))
        || bytes.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
        || bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
        || bytes.subarray(0, 3).equals(Buffer.from('BZh'))
        || bytes.subarray(0, 4).equals(Buffer.from('Rar!'))) fail('INVALID_CONTENT');
    if ((bytes.length >= 4 && u32(bytes, 0) === 0x04034b50) || lower.endsWith('.zip')) return zip(bytes, level);
    if (lower.endsWith('.tar') || (bytes.length >= 262 && bytes.subarray(257, 262).toString('ascii') === 'ustar')) return tar(bytes, level);
    // RFC 1950 has a checkable header. Do not silently accept a corrupt stream.
    if (bytes.length >= 2 && (bytes[0] & 15) === 8 && (bytes[0] >> 4) <= 7 && ((bytes[0] << 8) + bytes[1]) % 31 === 0) {
      if (bytes[1] & 0x20) fail('INVALID_CONTENT');
      return examine(unpack(inflateSync, bytes), `${lower}.decoded`, level + 1, true);
    }
    const text = bytes.toString('utf8');
    const strictJson = lower.endsWith('.map') || lower.endsWith('.json');
    // Compressed or renamed JSON can conceal Unicode escapes as well. Parse
    // valid object/array/string JSON independent of filename; only declared
    // JSON must fail when parsing fails, since JavaScript can start similarly.
    if (strictJson || /^\s*[\[{\"]/.test(text)) {
      try { checkJson(JSON.parse(text)); }
      catch (e) { if (CODES.has(e?.message)) throw e; if (strictJson) fail('INVALID_CONTENT'); }
    }
    // Source maps may hide sourcesContent inside an inline data URI. Decode the
    // declared URI, not arbitrary base64-looking user text.
    for (const match of text.matchAll(/sourceMappingURL\s*=\s*(data:[^\s*]+)/g)) {
      const uri = match[1], comma = uri.indexOf(',');
      if (comma < 0 || !/^data:application\/json(?:;charset=[\w-]+)?(?:;base64)?$/i.test(uri.slice(0, comma))) fail('INVALID_CONTENT');
      const encoded = uri.slice(comma + 1);
      let out;
      try {
        if (/;base64$/i.test(uri.slice(0, comma))) {
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) fail('INVALID_CONTENT');
          out = Buffer.from(encoded, 'base64');
        } else out = Buffer.from(decodeURIComponent(encoded));
      } catch (e) { if (CODES.has(e?.message)) throw e; fail('INVALID_CONTENT'); }
      examine(out, 'inline.map', level + 1, true);
    }
    // Brotli has no magic signature. Probe otherwise opaque bytes, even if the
    // filename is misleading. Any valid decoded content is scanned as well.
    // Failed probes are not evidence that the data is uncompressed: this is a
    // bounded synthetic-canary witness, never a proof of absent secrets.
    if (bytes.length > 0) {
      const remaining = Math.min(cap.maxFileBytes, cap.maxDecodedBytes - decodedBytes);
      if (remaining < 1) fail('LIMIT_EXCEEDED');
      let out;
      try {
        const result = brotliDecompressSync(bytes, { maxOutputLength: remaining, info: true });
        if (!result || !Buffer.isBuffer(result.buffer) || result.engine?.bytesWritten !== bytes.length) fail('INVALID_CONTENT');
        out = result.buffer;
      } catch (e) { if (CODES.has(e?.message)) throw e; if (e?.code === 'ERR_BUFFER_TOO_LARGE') fail('LIMIT_EXCEEDED'); }
      if (out) examine(out, `${lower}.decoded`, level + 1, true);
    }
  }
  async function walk(root, item, ancestry) {
    const info = await lstat(item).catch(() => fail('INVALID_INPUT'));
    checkBytes(Buffer.from(path.basename(item)));
    let actual = item, target = info;
    if (info.isSymbolicLink()) {
      actual = await realpath(item).catch(() => fail('UNSAFE_LINK'));
      if (!inside(root, actual)) fail('UNSAFE_LINK');
      checkBytes(Buffer.from(await readlink(item).catch(() => fail('UNSAFE_LINK'))));
      target = await lstat(actual).catch(() => fail('UNSAFE_LINK'));
      if (target.isSymbolicLink()) fail('UNSAFE_LINK');
    }
    if (target.isDirectory()) {
      const canonical = await realpath(actual).catch(() => fail('UNSAFE_LINK'));
      if (!inside(root, canonical) || ancestry.has(canonical)) fail('UNSAFE_LINK');
      const next = new Set(ancestry); next.add(canonical);
      for (const entry of await readdir(actual)) { if (++entriesSeen > cap.maxEntries) fail('LIMIT_EXCEEDED'); await walk(root, path.join(actual, entry), next); }
    } else if (target.isFile()) {
      if (++filesScanned > cap.maxFiles || target.size > cap.maxFileBytes || totalBytes + target.size > cap.maxTotalBytes) fail('LIMIT_EXCEEDED');
      const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => fail('UNSAFE_LINK'));
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.size !== target.size || current.ino !== target.ino || current.dev !== target.dev) fail('UNSAFE_LINK');
        // Read at most the previously checked size plus one sentinel byte; a
        // concurrently growing file cannot induce an unbounded allocation.
        const bytes = Buffer.allocUnsafe(current.size + 1);
        let used = 0;
        while (used < bytes.length) {
          const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
          if (bytesRead === 0) break;
          used += bytesRead;
        }
        const end = await handle.stat();
        if (used !== current.size || end.size !== current.size || end.ino !== current.ino || end.dev !== current.dev || end.mtimeMs !== current.mtimeMs || end.ctimeMs !== current.ctimeMs) fail('INVALID_CONTENT');
        totalBytes += used; examine(bytes.subarray(0, used), actual, 0);
      } finally { await handle.close(); }
    } else fail('INVALID_CONTENT');
  }
  try {
    for (const entry of roots) {
      const info = await lstat(entry).catch(() => fail('INVALID_INPUT'));
      if (info.isSymbolicLink()) fail('UNSAFE_LINK');
      const actual = await realpath(entry).catch(() => fail('INVALID_INPUT'));
      await walk(info.isDirectory() ? actual : path.dirname(actual), actual, new Set());
    }
    return { filesScanned, decodedObjects };
  } catch (e) { if (CODES.has(e?.message)) throw e; fail('INVALID_CONTENT'); }
}

// The manifest is user-provided and must contain only synthetic markers and
// synthetic output paths. This tool never prints its contents or exceptions.
const own = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === own) {
  try {
    if (process.argv.length !== 3) fail('INVALID_INPUT');
    const handle = await open(process.argv[2], constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let input;
    try { const s = await handle.stat(); if (!s.isFile() || s.size > 65536) fail('INVALID_INPUT'); input = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
    const result = await scanMarkers(input);
    console.log(`SYNTHETIC_SCAN_OK files=${result.filesScanned} decoded=${result.decodedObjects}`);
  } catch (e) { console.error(CODES.has(e?.message) ? e.message : 'INVALID_INPUT'); process.exitCode = 1; }
}
