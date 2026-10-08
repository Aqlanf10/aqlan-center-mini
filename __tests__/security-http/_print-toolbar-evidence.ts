import { createHash } from "node:crypto";

export interface PrintToolbarEvidenceMember {
  filename: string;
  mime: "image/png" | "application/pdf";
  bytes: Buffer;
}

const FILES = [
  "print-toolbar-invoice-screen.png",
  "print-toolbar-invoice-print.png",
  "print-toolbar-invoice.pdf",
  "print-toolbar-receipt-screen.png",
  "print-toolbar-receipt-print.png",
  "print-toolbar-receipt.pdf",
] as const;
const PREFIX = "SYNTHETIC_PRINT_EVIDENCE_V1";
const CHUNK_CHARACTERS = 4096;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Exact synthetic browser-returned buffers only; no path reads or directory scans.
 * Call once after every browser/PDF/DB/teardown assertion has passed. All members
 * are validated before the first log frame, so a bad sixth file emits nothing.
 * Existing CI logs transport these bounded frames; no workflow/upload is changed.
 */
export function emitPrintToolbarEvidence(members: readonly PrintToolbarEvidenceMember[]): void {
  if (members.length !== FILES.length) throw new Error("Synthetic print evidence requires exactly six allowlisted files");
  const byName = new Map<string, PrintToolbarEvidenceMember>();
  let totalBytes = 0;
  for (const member of members) {
    if (!FILES.some(filename => filename === member.filename) || byName.has(member.filename)) {
      throw new Error("Synthetic print evidence has an unknown or duplicate filename");
    }
    const pdf = member.filename.endsWith(".pdf");
    const expectedMime = pdf ? "application/pdf" : "image/png";
    const limit = (pdf ? 2 : 1) * 1024 * 1024;
    if (member.mime !== expectedMime || !Buffer.isBuffer(member.bytes) || member.bytes.length === 0 || member.bytes.length > limit) {
      throw new Error(`Synthetic print evidence MIME/byte limit rejected: ${member.filename}`);
    }
    if (pdf ? member.bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
      || !member.bytes.subarray(-1024).toString("ascii").includes("%%EOF")
      : member.bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`Synthetic print evidence signature rejected: ${member.filename}`);
    }
    totalBytes += member.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Synthetic print evidence exceeds the 8 MiB aggregate limit");
    byName.set(member.filename, member);
  }
  const prepared = FILES.map(filename => {
    const member = byName.get(filename);
    if (!member) throw new Error(`Synthetic print evidence missing: ${filename}`);
    const base64 = member.bytes.toString("base64");
    return { base64, metadata: {
      scope: "print-toolbar", file: filename, mime: member.mime, bytes: member.bytes.length,
      sha256: createHash("sha256").update(member.bytes).digest("hex"),
      chunks: Math.ceil(base64.length / CHUNK_CHARACTERS),
      runId: process.env.GITHUB_RUN_ID ?? "local",
      checkoutSha: process.env.GITHUB_SHA ?? "unavailable",
      synthetic: true,
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

/** Failure-only diagnostic, never a positive acceptance frame. The caller must rethrow. */
export function emitPrintToolbarFailedPdf(kind: "invoice" | "receipt", bytes: Buffer): void {
  if ((kind !== "invoice" && kind !== "receipt") || !Buffer.isBuffer(bytes)
    || bytes.length === 0 || bytes.length > 2 * 1024 * 1024
    || bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
    || !bytes.subarray(-1024).toString("ascii").includes("%%EOF")) {
    throw new Error("Synthetic failed-print PDF diagnostic rejected");
  }
  const base64 = bytes.toString("base64");
  const prefix = "SYNTHETIC_PRINT_DIAGNOSTIC_V1";
  const metadata = {
    scope: "print-toolbar", file: `print-toolbar-${kind}-failed.pdf`, mime: "application/pdf",
    bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    chunks: Math.ceil(base64.length / CHUNK_CHARACTERS),
    runId: process.env.GITHUB_RUN_ID ?? "local", checkoutSha: process.env.GITHUB_SHA ?? "unavailable",
    synthetic: true, diagnosticOnly: true, acceptance: "failed",
  };
  const identity = JSON.stringify(metadata);
  console.log(`${prefix} BEGIN ${identity}`);
  for (let index = 0; index < metadata.chunks; index++) {
    console.log(`${prefix} CHUNK ${metadata.file} ${index + 1}/${metadata.chunks} ${base64.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS)}`);
  }
  console.log(`${prefix} END ${identity}`);
}
