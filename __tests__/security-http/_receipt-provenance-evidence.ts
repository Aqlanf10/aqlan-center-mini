import { createHash } from "node:crypto";

export const RECEIPT_PROVENANCE_EVIDENCE_FILES = [
  "receipt-provenance-patient-1280.png",
  "receipt-provenance-patient-390.png",
  "receipt-provenance-cash-1280.png",
  "receipt-provenance-cash-390.png",
  "receipt-provenance-original-screen.png",
  "receipt-provenance-reversal-screen.png",
  "receipt-provenance-original.pdf",
  "receipt-provenance-reversal.pdf",
  "receipt-provenance-replacement.pdf",
  "receipt-provenance-void.pdf",
] as const;
export interface ReceiptProvenanceEvidenceMember {
  filename: typeof RECEIPT_PROVENANCE_EVIDENCE_FILES[number];
  mime: "image/png" | "application/pdf";
  bytes: Buffer;
}
const PREFIX = "SYNTHETIC_RECEIPT_PROVENANCE_EVIDENCE_V1";
const CHUNK_CHARACTERS = 4096;

/** Exact synthetic browser buffers only. Call after all PDF, no-write and
 * route-retirement assertions pass. No filesystem reads or CI workflow changes.
 * All members are validated before emitting any frame. */
export function emitReceiptProvenanceEvidence(members: readonly ReceiptProvenanceEvidenceMember[]): void {
  if (members.length !== RECEIPT_PROVENANCE_EVIDENCE_FILES.length) {
    throw new Error("Receipt provenance evidence requires exactly ten allowlisted files");
  }
  const byName = new Map<string, ReceiptProvenanceEvidenceMember>();
  let totalBytes = 0;
  for (const member of members) {
    if (!RECEIPT_PROVENANCE_EVIDENCE_FILES.some(name => name === member.filename) || byName.has(member.filename)) {
      throw new Error("Receipt provenance evidence has an unknown or duplicate filename");
    }
    const pdf = member.filename.endsWith(".pdf");
    if (member.mime !== (pdf ? "application/pdf" : "image/png")
      || !Buffer.isBuffer(member.bytes) || member.bytes.length === 0
      || member.bytes.length > (pdf ? 2 : 1) * 1024 * 1024
      || (pdf ? member.bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
        || !member.bytes.subarray(-1024).toString("ascii").includes("%%EOF")
        : member.bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")) {
      throw new Error("Receipt provenance evidence MIME, size or signature rejected");
    }
    totalBytes += member.bytes.length;
    if (totalBytes > 14 * 1024 * 1024) throw new Error("Receipt provenance evidence exceeds 14 MiB");
    byName.set(member.filename, member);
  }
  const runId = /^\d{1,24}$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : "unavailable";
  const checkoutSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "unavailable";
  const prepared = RECEIPT_PROVENANCE_EVIDENCE_FILES.map(file => {
    const member = byName.get(file)!;
    const base64 = member.bytes.toString("base64");
    return { base64, metadata: { scope: "receipt-provenance", file, mime: member.mime,
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

/** Failure-only native PDF diagnosis, never an acceptance frame. Caller rethrows. */
export function emitReceiptProvenanceFailedPdf(scene: "original" | "reversal" | "replacement" | "void", bytes: Buffer): void {
  if (!["original", "reversal", "replacement", "void"].includes(scene) || !Buffer.isBuffer(bytes)
    || bytes.length === 0 || bytes.length > 2 * 1024 * 1024
    || bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
    || !bytes.subarray(-1024).toString("ascii").includes("%%EOF")) {
    throw new Error("Receipt provenance failed PDF diagnostic rejected");
  }
  const base64 = bytes.toString("base64");
  const metadata = { scope: "receipt-provenance", file: `receipt-provenance-${scene}-failed.pdf`, mime: "application/pdf",
    bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    chunks: Math.ceil(base64.length / CHUNK_CHARACTERS), synthetic: true, acceptance: false, diagnosticOnly: true,
    runId: /^\d{1,24}$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : "unavailable",
    checkoutSha: /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "unavailable" };
  const prefix = "SYNTHETIC_RECEIPT_PROVENANCE_DIAGNOSTIC_V1";
  const identity = JSON.stringify(metadata);
  console.log(`${prefix} BEGIN ${identity}`);
  for (let index = 0; index < metadata.chunks; index++) {
    console.log(`${prefix} CHUNK ${metadata.file} ${index + 1}/${metadata.chunks} ${base64.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS)}`);
  }
  console.log(`${prefix} END ${identity}`);
}
