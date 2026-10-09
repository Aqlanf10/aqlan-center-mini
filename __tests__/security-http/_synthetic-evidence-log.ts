import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * Bounded, checksummed transport of fresh synthetic browser outputs into the CI log, in the established
 * `SYNTHETIC_PRINT_EVIDENCE_V1` BEGIN / CHUNK / END format (see `_daily-clinic-evidence.ts`). Used where a
 * journey's PNG/PDF bytes are not among the uploaded artifacts; CI gates and upload steps are unchanged.
 *
 * - Positive acceptance only: a suite calls `emitAcceptedEvidence` after every assertion of the journey
 *   passed, with the complete expected set. An incomplete, duplicate, unexpected, oversized or malformed
 *   set throws before a single byte is written, so a failed or partial run never looks accepted.
 * - Identity: GitHub run/attempt/ref/sha and the checked-out commit (and, for a PR merge checkout, its parents),
 *   so a reviewer can tie the files to the exact run and head.
 * - Synthetic only: callers pass buffers produced from isolated synthetic databases; no file paths are read here.
 */
export const EVIDENCE_PREFIX = "SYNTHETIC_PRINT_EVIDENCE_V1";
export const CHUNK_CHARS = 4096;
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");

export interface EvidenceFile { filename: string; mime: "image/png" | "application/pdf"; bytes: Buffer }
export interface EvidenceSet {
  scope: string;
  /** Exact expected members: filename → mime. */
  expected: ReadonlyMap<string, EvidenceFile["mime"]>;
  files: readonly EvidenceFile[];
  /** Aggregate byte bound for the whole set. */
  aggregateCap: number;
}

function checkoutIdentity() {
  const git = (...args: string[]) => {
    try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  };
  const parents = git("rev-list", "--parents", "-n", "1", "HEAD")?.split(" ").slice(1) ?? [];
  return {
    runId: process.env.GITHUB_RUN_ID ?? "local", runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
    ref: process.env.GITHUB_REF ?? "local", githubSha: process.env.GITHUB_SHA ?? "local",
    checkoutSha: git("rev-parse", "HEAD") ?? "unknown", checkoutParents: parents,
  };
}

/** Builds the log records for a complete, validated set. Exported for the protocol test. */
export function evidenceRecords(set: EvidenceSet, identity = checkoutIdentity()): string[] {
  const { scope, expected, files, aggregateCap } = set;
  if (!/^[a-z0-9-]{3,64}$/.test(scope)) throw new Error("Invalid evidence scope");
  if (files.length !== expected.size || new Set(files.map((file) => file.filename)).size !== expected.size) {
    throw new Error(`Incomplete or duplicate ${scope} evidence set`);
  }
  let total = 0;
  const prepared = files.map((file) => {
    if (expected.get(file.filename) !== file.mime || !Buffer.isBuffer(file.bytes)) throw new Error("Unexpected evidence member");
    const cap = file.mime === "application/pdf" ? 2 * 1024 * 1024 : 1024 * 1024;
    if (file.bytes.length === 0 || file.bytes.length > cap) throw new Error("Evidence member exceeds bound");
    if (file.mime === "application/pdf" ? file.bytes.subarray(0, 5).toString() !== "%PDF-" : !file.bytes.subarray(0, 8).equals(PNG_MAGIC)) {
      throw new Error("Evidence signature mismatch");
    }
    total += file.bytes.length;
    const encoded = file.bytes.toString("base64");
    const meta = { scope, acceptance: true, file: file.filename, mime: file.mime, bytes: file.bytes.length,
      sha256: createHash("sha256").update(file.bytes).digest("hex"), chunks: Math.ceil(encoded.length / CHUNK_CHARS),
      ...identity, synthetic: true };
    return { meta, encoded };
  });
  if (total > aggregateCap) throw new Error("Evidence set exceeds aggregate bound");
  const records: string[] = [];
  for (const { meta, encoded } of prepared) {
    records.push(`${EVIDENCE_PREFIX} BEGIN ${JSON.stringify(meta)}`);
    for (let index = 0; index < meta.chunks; index++) {
      records.push(`${EVIDENCE_PREFIX} CHUNK ${meta.file} ${index + 1}/${meta.chunks} ${encoded.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS)}`);
    }
    records.push(`${EVIDENCE_PREFIX} END ${JSON.stringify(meta)}`);
  }
  return records;
}

/**
 * Validates the complete set, then writes it to the log. Call only after the journey's assertions passed.
 * Written to process stdout directly: the test runner does not relay `console.log` here (verified locally).
 */
export async function emitAcceptedEvidence(set: EvidenceSet): Promise<void> {
  for (const record of evidenceRecords(set)) {
    await new Promise<void>((resolve, reject) => { process.stdout.write(`${record}\n`, (error) => error ? reject(error) : resolve()); });
  }
}

/** Decodes records back to files, verifying chunk order, byte count and SHA-256 (protocol test and local checks). */
export function decodeEvidence(lines: readonly string[]): Map<string, { meta: Record<string, unknown>; bytes: Buffer }> {
  const out = new Map<string, { meta: Record<string, unknown>; bytes: Buffer }>();
  let open: { meta: Record<string, unknown> & { file: string; chunks: number; bytes: number; sha256: string }; parts: string[] } | null = null;
  for (const line of lines) {
    if (!line.startsWith(`${EVIDENCE_PREFIX} `)) continue;
    const rest = line.slice(EVIDENCE_PREFIX.length + 1);
    if (rest.startsWith("BEGIN ")) {
      if (open) throw new Error("Nested evidence member");
      open = { meta: JSON.parse(rest.slice(6)), parts: [] };
    } else if (rest.startsWith("CHUNK ")) {
      const [file, position, data] = rest.slice(6).split(" ");
      if (!open || file !== open.meta.file || position !== `${open.parts.length + 1}/${open.meta.chunks}`) throw new Error("Out-of-order evidence chunk");
      open.parts.push(data);
    } else if (rest.startsWith("END ")) {
      const end = JSON.parse(rest.slice(4)) as Record<string, unknown>;
      if (!open || JSON.stringify(end) !== JSON.stringify(open.meta) || open.parts.length !== open.meta.chunks) throw new Error("Evidence member mismatch");
      const bytes = Buffer.from(open.parts.join(""), "base64");
      if (bytes.length !== open.meta.bytes || createHash("sha256").update(bytes).digest("hex") !== open.meta.sha256) throw new Error("Evidence checksum mismatch");
      out.set(open.meta.file, { meta: open.meta, bytes });
      open = null;
    }
  }
  if (open) throw new Error("Unterminated evidence member");
  return out;
}
