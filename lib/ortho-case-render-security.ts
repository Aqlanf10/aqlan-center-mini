import { createHash } from "node:crypto";
import { inflateSync, inflateRawSync } from "node:zlib";

/** One canonical source-only export boundary. No paths, URLs, or network access. */
export const CASE_RENDER_LIMITS = Object.freeze({
  panels: 600, media: 512, sources: 4000, text: 240_000, metadataBytes: 4 * 1024 * 1024,
  pngBytes: 4 * 1024 * 1024, imageBytes: 64 * 1024 * 1024, imagePixels: 128_000_000,
  dimension: 8192, slides: 1024, outputBytes: 32 * 1024 * 1024,
});
export class CaseRenderError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "CaseRenderError"; }
}
export function refuse(code: string): never { throw new CaseRenderError(code); }
export function hashBytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) refuse("invalid_hash");
}
export function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) refuse("invalid_record");
  const record = value as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(record, k)) || Object.keys(record).some(k => !required.includes(k) && !optional.includes(k))) refuse("invalid_record_keys");
}
export function textValue(value: unknown, max = 20_000): asserts value is string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) refuse("invalid_text");
  // Reject unpaired surrogates instead of silently replacing authored characters.
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) refuse("invalid_unicode");
  }
}
export function idValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value)) refuse("invalid_id");
}
export function canonicalJson(value: unknown): string {
  let nodes = 0;
  function visit(v: unknown, depth: number): string {
    if (++nodes > 100_000 || depth > 24) refuse("projection_limit_exceeded");
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "string") { textValue(v, CASE_RENDER_LIMITS.text); return JSON.stringify(v); }
    if (typeof v === "number") { if (!Number.isFinite(v)) refuse("invalid_number"); return JSON.stringify(v); }
    if (Array.isArray(v)) return "[" + v.map(x => visit(x, depth + 1)).join(",") + "]";
    if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) refuse("invalid_json");
    return "{" + Object.keys(v).sort().map(k => {
      textValue(k, 200); return JSON.stringify(k) + ":" + visit((v as Record<string, unknown>)[k], depth + 1);
    }).join(",") + "}";
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > CASE_RENDER_LIMITS.metadataBytes) refuse("projection_limit_exceeded");
  return result;
}
export const hashJson = (value: unknown): string => hashBytes(canonicalJson(value));
export function snapshotJson<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Only processed, opaque 8-bit RGB/RGBA PNG. Text, EXIF, ICC and hidden frames are refused. */
export function validateCasePng(input: Uint8Array): { width: number; height: number; pixels: number; sha256: string } {
  const b = Buffer.from(input);
  if (b.length > CASE_RENDER_LIMITS.pngBytes || b.length < 57 || b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") refuse("invalid_processed_png");
  let offset = 8, width = 0, height = 0, channels = 0, seenData = false, ended = false;
  const chunks: Buffer[] = [], ancillary = new Set<string>();
  while (offset < b.length) {
    if (offset + 12 > b.length) refuse("invalid_processed_png");
    const size = b.readUInt32BE(offset), type = b.toString("ascii", offset + 4, offset + 8), end = offset + 12 + size;
    if (end > b.length || crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4)) refuse("invalid_processed_png");
    if (type === "IHDR") {
      if (offset !== 8 || size !== 13) refuse("invalid_processed_png");
      width = b.readUInt32BE(offset + 8); height = b.readUInt32BE(offset + 12);
      const depth = b[offset + 16], color = b[offset + 17];
      if (!width || !height || width > CASE_RENDER_LIMITS.dimension || height > CASE_RENDER_LIMITS.dimension ||
          width * height > 4_000_000 || depth !== 8 || (color !== 2 && color !== 6) ||
          b[offset + 18] !== 0 || b[offset + 19] !== 0 || b[offset + 20] !== 0) refuse("invalid_processed_png");
      channels = color === 2 ? 3 : 4;
    } else if (type === "IDAT") {
      if (!channels || ended) refuse("invalid_processed_png");
      seenData = true; chunks.push(b.subarray(offset + 8, end - 4));
    } else if (type === "IEND") {
      if (size !== 0 || !seenData || end !== b.length) refuse("invalid_processed_png");
      ended = true;
    } else {
      const expectedSizes: Record<string, number> = { sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9 };
      if (!Object.hasOwn(expectedSizes, type) || size !== expectedSizes[type] || ancillary.has(type) || seenData) refuse("png_metadata_refused");
      ancillary.add(type);
    }
    offset = end;
  }
  if (!ended) refuse("invalid_processed_png");
  const stride = width * channels, expected = (stride + 1) * height;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected }); }
  catch { refuse("invalid_processed_png"); }
  if (raw!.length !== expected) refuse("invalid_processed_png");
  let previous = Buffer.alloc(stride);
  const paeth = (a: number, c: number, d: number): number => {
    const p = a + c - d, pa = Math.abs(p - a), pc = Math.abs(p - c), pd = Math.abs(p - d);
    return pa <= pc && pa <= pd ? a : pc <= pd ? c : d;
  };
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1), filter = raw![base], row = Buffer.alloc(stride);
    if (filter > 4) refuse("invalid_processed_png");
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0, up = previous[x], upperLeft = x >= channels ? previous[x - channels] : 0;
      const correction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      row[x] = (raw![base + 1 + x] + correction) & 255;
      if (channels === 4 && x % 4 === 3 && row[x] !== 255) refuse("nonopaque_processed_png");
    }
    previous = row;
  }
  return { width, height, pixels: width * height, sha256: hashBytes(b) };
}

const allowedPart = /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:app|core)\.xml|ppt\/(?:presentation\.xml|presProps\.xml|viewProps\.xml|tableStyles\.xml|_rels\/presentation\.xml\.rels|theme\/theme[0-9]+\.xml|slides\/(?:slide[0-9]+\.xml|_rels\/slide[0-9]+\.xml\.rels)|slideLayouts\/(?:slideLayout[0-9]+\.xml|_rels\/slideLayout[0-9]+\.xml\.rels)|slideMasters\/(?:slideMaster[0-9]+\.xml|_rels\/slideMaster[0-9]+\.xml\.rels)|media\/image-?[0-9]+(?:-[0-9]+)?\.png))$/;
export type CaseZipPart = { name: string; bytes: Buffer };
/** Inspection helper shares the same parser as final admission; never a general ZIP importer. */
export function inspectCasePackage(input: Uint8Array, allowGeneratedNotes = false): CaseZipPart[] {
  const b = Buffer.from(input);
  if (b.length > CASE_RENDER_LIMITS.outputBytes || b.length < 22) refuse("pptx_output_limit_exceeded");
  const eocd = b.length - 22;
  if (b.readUInt32LE(eocd) !== 0x06054b50 || b.readUInt16LE(eocd + 20) !== 0 ||
      b.readUInt16LE(eocd + 4) !== 0 || b.readUInt16LE(eocd + 6) !== 0) refuse("invalid_pptx");
  const count = b.readUInt16LE(eocd + 10), centralSize = b.readUInt32LE(eocd + 12), centralStart = b.readUInt32LE(eocd + 16);
  if (!count || count > 10_000 || count !== b.readUInt16LE(eocd + 8) || centralStart + centralSize !== eocd) refuse("invalid_pptx");
  let p = centralStart, expanded = 0;
  const names = new Set<string>(), parts: CaseZipPart[] = [], spans: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || b.readUInt32LE(p) !== 0x02014b50) refuse("invalid_pptx");
    const flags = b.readUInt16LE(p + 8), method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16),
      compressed = b.readUInt32LE(p + 20), size = b.readUInt32LE(p + 24), nameLen = b.readUInt16LE(p + 28),
      extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32), local = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    if (p + 46 + nameLen + extraLen + commentLen > eocd || (flags & ~0x0808) || ![0, 8].includes(method) ||
        b.readUInt16LE(p + 34) !== 0 || size > 16 * 1024 * 1024 || compressed > b.length ||
        names.has(name) || !/^[\x20-\x7e]+$/.test(name) || name.includes("..") || name.includes("\\")) refuse("invalid_pptx");
    names.add(name);
    if (local + 30 > centralStart || b.readUInt32LE(local) !== 0x04034b50 || b.readUInt16LE(local + 6) !== flags ||
        b.readUInt16LE(local + 8) !== method) refuse("invalid_pptx");
    const ln = b.readUInt16LE(local + 26), le = b.readUInt16LE(local + 28), dataStart = local + 30 + ln + le;
    if (b.toString("utf8", local + 30, local + 30 + ln) !== name || dataStart + compressed > centralStart) refuse("invalid_pptx");
    if (!(flags & 8) && (b.readUInt32LE(local + 14) !== crc || b.readUInt32LE(local + 18) !== compressed || b.readUInt32LE(local + 22) !== size)) refuse("invalid_pptx");
    spans.push([local, dataStart + compressed]);
    let data: Buffer;
    try { data = method === 0 ? Buffer.from(b.subarray(dataStart, dataStart + compressed)) : inflateRawSync(b.subarray(dataStart, dataStart + compressed), { maxOutputLength: Math.max(1, size) }); }
    catch { refuse("invalid_pptx"); }
    expanded += size;
    if (data!.length !== size || crc32(data!) !== crc || expanded > 96 * 1024 * 1024) refuse("invalid_pptx");
    if (name.endsWith("/")) { if (size !== 0) refuse("invalid_pptx"); }
    else {
      if (!allowedPart.test(name) && !(allowGeneratedNotes && /^ppt\/notes(?:Slides|Masters)\/(?:notes(?:Slide|Master)\d+\.xml|_rels\/notes(?:Slide|Master)\d+\.xml\.rels)$/.test(name))) refuse("pptx_private_part_refused");
      parts.push({ name, bytes: data! });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  spans.sort((a, c) => a[0] - c[0]);
  if (p !== eocd || spans.some((s, i) => i > 0 && s[0] < spans[i - 1][1])) refuse("invalid_pptx");
  return parts;
}
function storeZip(parts: CaseZipPart[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const part of parts.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const name = Buffer.from(part.name), crc = crc32(part.bytes), l = Buffer.alloc(30), c = Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x0800, 6); l.writeUInt16LE(33, 12);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(part.bytes.length, 18); l.writeUInt32LE(part.bytes.length, 22); l.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(part.bytes.length, 20); c.writeUInt32LE(part.bytes.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    local.push(l, name, part.bytes); central.push(c, name); offset += l.length + name.length + part.bytes.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...local, cd, end]);
  if (result.length > CASE_RENDER_LIMITS.outputBytes) refuse("pptx_output_limit_exceeded");
  return result;
}
export function validateAndNormalizePackage(input: Uint8Array, capturedAt: string, slideCount: number): Buffer {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(capturedAt) || !Number.isFinite(Date.parse(capturedAt))) refuse("invalid_capture_time");
  const rawParts = inspectCasePackage(input, true);
  // PptxGenJS 4.0.1 emits blank notes automatically. Reject authored notes,
  // then remove every note/master part and every corresponding relationship.
  for (const part of rawParts.filter(p => p.name.startsWith("ppt/notes"))) {
    const xml = part.bytes.toString("utf8");
    if (/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External/i.test(xml)) refuse("pptx_private_part_refused");
    if (/\.xml$/.test(part.name)) {
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => m[1]);
      const number = /notesSlide(\d+)\.xml$/.exec(part.name)?.[1];
      const expected = number ? ["", number] : ["7/23/19", "Click to edit Master text styles", "Second level", "Third level", "Fourth level", "Fifth level", "‹#›"];
      if (JSON.stringify(texts) !== JSON.stringify(expected)) refuse("pptx_authored_notes_refused");
    }
  }
  const parts = rawParts.filter(p => !p.name.startsWith("ppt/notes"));
  for (const part of parts.filter(p => p.name.endsWith(".xml") || p.name.endsWith(".rels"))) {
    let xml = part.bytes.toString("utf8");
    if (part.name.endsWith(".rels")) xml = xml.replace(/<Relationship\s+[^>]*\bType="[^"]*\/notes(?:Slide|Master)"[^>]*\/\s*>/g, "");
    if (part.name === "[Content_Types].xml") xml = xml.replace(/<Override\s+[^>]*PartName="\/ppt\/notes[^"]*"[^>]*\/\s*>/g, "");
    if (part.name === "ppt/presentation.xml") xml = xml.replace(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/g, "");
    part.bytes = Buffer.from(xml);
  }
  if (parts.filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p.name)).length !== slideCount) refuse("pptx_slide_count_mismatch");
  for (const part of parts) {
    if (part.name.endsWith(".png")) { validateCasePng(part.bytes); continue; }
    const xml = part.bytes.toString("utf8");
    if (/<p:sld\s[^>]*\bshow="0"/.test(xml)) refuse("pptx_hidden_slide_refused");
    if (Buffer.from(xml).compare(part.bytes) !== 0 || /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<[^>]*(?:script|oleObj|videoFile|audioFile|snd|hlinkClick|hlinkMouseOver|custData|extLst)\b/i.test(xml)) refuse("pptx_active_content_refused");
    if (part.name.endsWith(".rels")) {
      for (const rel of xml.matchAll(/<Relationship\s+([^>]+)\/?\s*>/g)) {
        const attrs = rel[1];
        if (/TargetMode\s*=\s*["']External/i.test(attrs)) refuse("pptx_external_relationship_refused");
        const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
        if (!target || /[&\\:#?\u0000]/.test(target) || target.startsWith("/")) refuse("pptx_external_relationship_refused");
        const base = part.name === "_rels/.rels" ? [] : part.name.split("/").slice(0, -2);
        for (const item of target.split("/")) { if (item === "..") { if (!base.length) refuse("invalid_pptx_relationship"); base.pop(); } else if (item !== ".") base.push(item); }
        if (!parts.some(p => p.name === base.join("/"))) refuse("invalid_pptx_relationship");
      }
    }
  }
  const core = parts.find(p => p.name === "docProps/core.xml");
  if (!core) refuse("invalid_pptx");
  core.bytes = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Clinical case renderer</dc:creator><cp:lastModifiedBy>Clinical case renderer</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">' + capturedAt + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + capturedAt + '</dcterms:modified></cp:coreProperties>');
  return storeZip(parts);
}
