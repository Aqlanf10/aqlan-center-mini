import { createHash } from "node:crypto";

export const EVIDENCE_MARKER = "AQLAN_INVOICE_UI_PNG_V1";
export const VISUAL_SCENES = [
  "invoice-shared-chart-390", "invoice-provider-ready-390", "invoice-refusal-390",
  "invoice-shared-chart-1280", "invoice-provider-ready-1280", "invoice-refusal-1280",
] as const;
export type VisualScene = typeof VISUAL_SCENES[number];
export const VIEWPORT_HEIGHT = 1000;
export const IMAGE_BYTE_CAP = 256 * 1024;
export const TOTAL_BYTE_CAP = 1024 * 1024;
export const CHUNK_CHAR_CAP = 4096;
export const VISUAL_TEST_PATH = "__tests__/security-http/invoice-visual-evidence-journey.test.ts";
export const COLLECTOR_PATH = "__tests__/security-http/_invoice-visual-evidence.ts";
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface CapturedScene { scene: VisualScene; png: Buffer }

/** No pixels or arbitrary input are logged until the complete fixed batch passes every bound. */
export function visualEvidenceRecords(captures: readonly CapturedScene[], sources: { testSha256: string; collectorSha256: string }): string[] {
  if (captures.length !== VISUAL_SCENES.length || !/^[a-f0-9]{64}$/.test(sources.testSha256)
    || !/^[a-f0-9]{64}$/.test(sources.collectorSha256)) throw new Error("Invalid invoice evidence batch identity");
  let totalBytes = 0;
  const images = captures.map(({ scene, png }, index) => {
    if (scene !== VISUAL_SCENES[index]) throw new Error("Missing, duplicate, or out-of-order invoice scene");
    const width = scene.endsWith("-390") ? 390 : 1280;
    if (!Buffer.isBuffer(png) || png.length < 45 || png.length > IMAGE_BYTE_CAP
      || !png.subarray(0, 8).equals(PNG_MAGIC) || png.readUInt32BE(8) !== 13
      || png.toString("ascii", 12, 16) !== "IHDR"
      || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== VIEWPORT_HEIGHT
      || !png.subarray(png.length - 12).equals(Buffer.from("0000000049454e44ae426082", "hex"))) {
      throw new Error(`Invalid or oversized required PNG: ${scene}`);
    }
    totalBytes += png.length;
    const base64Length = 4 * Math.ceil(png.length / 3);
    return { scene, width, height: VIEWPORT_HEIGHT, bytes: png.length, sha256: sha256(png),
      base64Length, chunks: Math.ceil(base64Length / CHUNK_CHAR_CAP) };
  });
  if (totalBytes > TOTAL_BYTE_CAP) throw new Error("Invoice evidence exceeds aggregate PNG byte cap");
  const identity = { protocol: 1, suite: VISUAL_TEST_PATH, collector: COLLECTOR_PATH, testSha256: sources.testSha256, collectorSha256: sources.collectorSha256,
    chunkCharCap: CHUNK_CHAR_CAP, imageByteCap: IMAGE_BYTE_CAP, totalByteCap: TOTAL_BYTE_CAP, totalBytes, totalEncodedChars: images.reduce((sum, image) => sum + image.base64Length, 0), images };
  const batch = sha256(JSON.stringify(identity));
  const records = [`${EVIDENCE_MARKER} BEGIN ${JSON.stringify({ batch, scenes: images.length })}`];
  for (const [position, { scene, png }] of captures.entries()) {
    const data = png.toString("base64");
    for (let index = 0; index < images[position].chunks; index++) {
      records.push(`${EVIDENCE_MARKER} CHUNK ${JSON.stringify({ batch, scene, index: index + 1,
        count: images[position].chunks, data: data.slice(index * CHUNK_CHAR_CAP, (index + 1) * CHUNK_CHAR_CAP) })}`);
    }
  }
  records.push(`${EVIDENCE_MARKER} MANIFEST ${JSON.stringify({ batch, ...identity })}`);
  if (records.some((line) => Buffer.byteLength(line) > 8192)
    || records.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0) > 1536 * 1024) {
    throw new Error("Invoice evidence exceeds stdout transport cap");
  }
  return records;
}

export async function emitVisualEvidence(captures: readonly CapturedScene[], sources: { testSha256: string; collectorSha256: string }): Promise<void> {
  const records = visualEvidenceRecords(captures, sources);
  for (const record of records) {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${record}\n`, (error) => error ? reject(error) : resolve());
    });
  }
}
