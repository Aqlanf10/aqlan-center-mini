import { createHash } from "node:crypto";

const SCOPE = "daily-clinic";
const PREFIX = "SYNTHETIC_PRINT_EVIDENCE_V1";
const EXPECTED = new Map([
  ["daily-clinic-390.png", "image/png"],
  ["daily-clinic-1280.png", "image/png"],
  ["daily-clinic-full-a4.pdf", "application/pdf"],
  ["daily-clinic-extreme-a4.pdf", "application/pdf"],
]);
export interface DailyClinicEvidenceFile { filename: string; mime: "image/png" | "application/pdf"; bytes: Buffer }

/** Test-only transport for fresh synthetic browser buffers. No filesystem
 * traversal, network, real records, workflow changes or overwrite of older evidence. */
export function emitDailyClinicEvidence(files: readonly DailyClinicEvidenceFile[]): void {
  if (files.length !== EXPECTED.size || new Set(files.map((file) => file.filename)).size !== EXPECTED.size) {
    throw new Error("Incomplete or duplicate daily-clinic evidence set");
  }
  let total = 0;
  const prepared = files.map((file) => {
    if (EXPECTED.get(file.filename) !== file.mime || !Buffer.isBuffer(file.bytes)) throw new Error("Unexpected evidence member");
    const cap = file.mime === "application/pdf" ? 2 * 1024 * 1024 : 1024 * 1024;
    if (file.bytes.length === 0 || file.bytes.length > cap) throw new Error("Evidence member exceeds bound");
    if (file.mime === "application/pdf" ? file.bytes.subarray(0, 5).toString() !== "%PDF-"
      : !file.bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Evidence signature mismatch");
    total += file.bytes.length;
    const encoded = file.bytes.toString("base64");
    const meta = { scope: SCOPE, file: file.filename, mime: file.mime, bytes: file.bytes.length,
      sha256: createHash("sha256").update(file.bytes).digest("hex"), chunks: Math.ceil(encoded.length / 4096),
      runId: process.env.GITHUB_RUN_ID ?? "local", checkoutSha: process.env.GITHUB_SHA ?? "local", synthetic: true };
    return { meta, encoded };
  });
  if (total > 5 * 1024 * 1024) throw new Error("Evidence set exceeds aggregate bound");
  // Validate the complete set before emitting a single byte. Consumers require
  // every indexed chunk plus matching BEGIN/END byte count and SHA-256.
  for (const { meta, encoded } of prepared) {
    console.log(`${PREFIX} BEGIN ${JSON.stringify(meta)}`);
    for (let index = 0; index < meta.chunks; index++) {
      console.log(`${PREFIX} CHUNK ${meta.file} ${index + 1}/${meta.chunks} ${encoded.slice(index * 4096, (index + 1) * 4096)}`);
    }
    console.log(`${PREFIX} END ${JSON.stringify(meta)}`);
  }
}
