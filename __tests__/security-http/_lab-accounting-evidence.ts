import { createHash } from "node:crypto";

export const LAB_ACCOUNTING_EVIDENCE_FILES = [
  "lab-accounting-saved-fx-1280.png",
  "lab-accounting-saved-fx-390.png",
] as const;
export interface LabAccountingEvidenceMember {
  filename: typeof LAB_ACCOUNTING_EVIDENCE_FILES[number];
  mime: "image/png";
  bytes: Buffer;
}
const PREFIX = "SYNTHETIC_LAB_ACCOUNTING_EVIDENCE_V1";
const CHUNK_CHARACTERS = 4096;

/** Only exact buffers captured by Chromium from the isolated built /lab page.
 * Validate the entire fixed set before emitting any frame. Never read files,
 * cookies, credentials or arbitrary paths. Caller emits only after all journey,
 * persistence, route-retirement and settings-restoration assertions pass. */
export function emitLabAccountingEvidence(members: readonly LabAccountingEvidenceMember[]): void {
  if (members.length !== LAB_ACCOUNTING_EVIDENCE_FILES.length) {
    throw new Error("Lab accounting evidence requires exactly two allowlisted PNG files");
  }
  const byName = new Map<string, LabAccountingEvidenceMember>();
  let totalBytes = 0;
  for (const member of members) {
    if (!LAB_ACCOUNTING_EVIDENCE_FILES.some(name => name === member.filename) || byName.has(member.filename)) {
      throw new Error("Lab accounting evidence has an unknown or duplicate filename");
    }
    if (member.mime !== "image/png" || !Buffer.isBuffer(member.bytes)
      || member.bytes.length <= 8 || member.bytes.length > 1024 * 1024
      || member.bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("Lab accounting evidence MIME, size or signature rejected");
    }
    totalBytes += member.bytes.length;
    if (totalBytes > 2 * 1024 * 1024) throw new Error("Lab accounting evidence exceeds 2 MiB");
    byName.set(member.filename, member);
  }
  const runId = /^\d{1,24}$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : "unavailable";
  const checkoutSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "unavailable";
  const prepared = LAB_ACCOUNTING_EVIDENCE_FILES.map(file => {
    const member = byName.get(file)!;
    const base64 = member.bytes.toString("base64");
    return { base64, metadata: { scope: "lab-accounting", file, mime: member.mime,
      state: "saved-fx", captureRegion: "visible-saved-fx-area", viewportWidth: file.endsWith("-390.png") ? 390 : 1280,
      bytes: member.bytes.length, sha256: createHash("sha256").update(member.bytes).digest("hex"),
      chunks: Math.ceil(base64.length / CHUNK_CHARACTERS), runId, checkoutSha, synthetic: true } };
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
