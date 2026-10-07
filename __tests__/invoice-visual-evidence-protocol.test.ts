import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CHUNK_CHAR_CAP, IMAGE_BYTE_CAP, VIEWPORT_HEIGHT, VISUAL_SCENES, visualEvidenceRecords,
  type CapturedScene } from "./security-http/_invoice-visual-evidence";

// Codec-only blank PNG fixtures are never emitted as visual evidence.
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const kind = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, crc]);
}
function blankPng(width: number, padding = 0): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(VIEWPORT_HEIGHT, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * VIEWPORT_HEIGHT))),
    ...(padding ? [chunk("npAD", Buffer.alloc(padding))] : []), chunk("IEND", Buffer.alloc(0))]);
}
const sources = { testSha256: "0".repeat(64), collectorSha256: "1".repeat(64) };
const batch = (padding = 0): CapturedScene[] => VISUAL_SCENES.map((scene) => ({ scene, png: blankPng(scene.endsWith("390") ? 390 : 1280, padding) }));

describe("bounded invoice screenshot stdout protocol", () => {
  it("has one terminal manifest, exact scene order, small numbered chunks and raw/encoded totals", () => {
    const captures = batch();
    const records = visualEvidenceRecords(captures, sources);
    const manifest = JSON.parse(records.at(-1)!.split(" MANIFEST ")[1]);
    expect(manifest.images.map((image: { scene: string }) => image.scene)).toEqual([...VISUAL_SCENES]);
    expect(manifest.totalBytes).toBe(captures.reduce((sum, capture) => sum + capture.png.length, 0));
    expect(manifest.totalEncodedChars).toBe(captures.reduce((sum, capture) => sum + capture.png.toString("base64").length, 0));
    expect(records.filter((record) => record.includes(" MANIFEST "))).toHaveLength(1);
    for (const record of records.filter((entry) => entry.includes(" CHUNK "))) {
      const value = JSON.parse(record.split(" CHUNK ")[1]);
      expect(value.data.length).toBeLessThanOrEqual(CHUNK_CHAR_CAP);
      expect(value.index).toBeGreaterThanOrEqual(1);
      expect(value.index).toBeLessThanOrEqual(value.count);
      expect(Buffer.byteLength(record)).toBeLessThanOrEqual(8192);
    }
  });
  it("rejects missing, duplicated and reordered scenes before any record can be emitted", () => {
    const captures = batch();
    expect(() => visualEvidenceRecords(captures.slice(1), sources)).toThrow();
    expect(() => visualEvidenceRecords([captures[0], captures[0], ...captures.slice(2)], sources)).toThrow();
    expect(() => visualEvidenceRecords([...captures].reverse(), sources)).toThrow();
  });
  it("rejects invalid PNG bytes, wrong dimensions, per-image overflow and aggregate overflow", () => {
    const captures = batch();
    expect(() => visualEvidenceRecords([{ ...captures[0], png: Buffer.from("not a screenshot") }, ...captures.slice(1)], sources)).toThrow();
    expect(() => visualEvidenceRecords([{ ...captures[0], png: blankPng(391) }, ...captures.slice(1)], sources)).toThrow();
    expect(() => visualEvidenceRecords([{ ...captures[0], png: Buffer.alloc(IMAGE_BYTE_CAP + 1) }, ...captures.slice(1)], sources)).toThrow();
    expect(() => visualEvidenceRecords(batch(190 * 1024), sources)).toThrow("aggregate");
  });
});
