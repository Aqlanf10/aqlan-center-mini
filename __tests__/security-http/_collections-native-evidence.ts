import { createHash } from "node:crypto";

export interface CollectionsNativeEvidenceMember {
  filename: string;
  mime: "image/png" | "application/pdf";
  bytes: Buffer;
}

const FILES = [
  "collections-native-screen.png",
  "collections-native-print.png",
  "collections-native.pdf",
  "collections-native-filtered-screen.png",
  "collections-native-filtered-print.png",
  "collections-native-filtered.pdf",
  "collections-native-mobile.png",
] as const;
const PREFIX = "SYNTHETIC_COLLECTIONS_NATIVE_EVIDENCE_V1";
const CHUNK_CHARACTERS = 4096;
const MAX_TOTAL_BYTES = 9 * 1024 * 1024;

/** Exact synthetic browser buffers, validated together before emitting any frame.
 * No filesystem reads, globbing, cookies, exports, network or CI workflow changes.
 * Call only after all content, no-write and browser-teardown assertions succeed.
 */
export function emitCollectionsNativeEvidence(members: readonly CollectionsNativeEvidenceMember[]): void {
  if (members.length !== FILES.length) throw new Error("Synthetic collections evidence requires exactly seven allowlisted files");
  const byName = new Map<string, CollectionsNativeEvidenceMember>();
  let totalBytes = 0;
  for (const member of members) {
    if (!FILES.some(filename => filename === member.filename) || byName.has(member.filename)) {
      throw new Error("Synthetic collections evidence has an unknown or duplicate filename");
    }
    const pdf = member.filename.endsWith(".pdf");
    const expectedMime = pdf ? "application/pdf" : "image/png";
    if (member.mime !== expectedMime || !Buffer.isBuffer(member.bytes) || member.bytes.length === 0
      || member.bytes.length > (pdf ? 2 : 1) * 1024 * 1024) {
      throw new Error(`Synthetic collections evidence MIME/byte limit rejected: ${member.filename}`);
    }
    if (pdf ? member.bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
      || !member.bytes.subarray(-1024).toString("ascii").includes("%%EOF")
      : member.bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`Synthetic collections evidence signature rejected: ${member.filename}`);
    }
    totalBytes += member.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Synthetic collections evidence exceeds the 9 MiB aggregate limit");
    byName.set(member.filename, member);
  }
  // Provenance cannot expand a bounded frame or accidentally include arbitrary env text.
  const runId = /^\d{1,24}$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : "unavailable";
  const checkoutSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "unavailable";
  const prepared = FILES.map(filename => {
    const member = byName.get(filename);
    if (!member) throw new Error(`Synthetic collections evidence missing: ${filename}`);
    const base64 = member.bytes.toString("base64");
    return { base64, metadata: {
      scope: "collections-native", file: filename, mime: member.mime, bytes: member.bytes.length,
      sha256: createHash("sha256").update(member.bytes).digest("hex"),
      chunks: Math.ceil(base64.length / CHUNK_CHARACTERS), runId, checkoutSha, synthetic: true,
    } };
  });
  for (const { base64, metadata } of prepared) {
    const identity = JSON.stringify(metadata);
    console.log(`${PREFIX} BEGIN ${identity}`);
    for (let index = 0; index < metadata.chunks; index++) {
      console.log(`${PREFIX} CHUNK ${metadata.file} ${index + 1}/${metadata.chunks} ${base64.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS)}`);
    }
    console.log(`${PREFIX} END ${identity}`);
  }
}
