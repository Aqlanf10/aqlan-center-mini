/** Offline, synthetic application archive adapter. Not imported by a runtime route. */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseTarBytes } from "../../lib/restore/archive";
import { validateBackupArchive } from "../../lib/restore/validate";

const MAX_FIXTURE_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const BINDING = /^[0-9]{1,20}:[0-9]{1,10}$/;
const FORMAT = "aqlan-numbering-application-archive-review";
const V = 1;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

export type HeldNumberingWitness = Readonly<{
  binding: string;
  prefix: string;
  revision: string;
  lastValue: string;
  isCalled: boolean;
  syntheticNumberMapSha256: string;
}>;

type Attachment = Readonly<{
  format: typeof FORMAT;
  version: typeof V;
  archiveSha256: string;
  databaseSha256: string;
  witness: HeldNumberingWitness;
}>;

export type ReviewArchiveDecision =
  | { kind: "legacy-data-only"; management: "held" }
  | { kind: "recovery-candidate"; management: "held"; witness: HeldNumberingWitness }
  | { kind: "refused"; reason: "archive-invalid" | "numbering-evidence-invalid" };

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && Object.getPrototypeOf(raw) === Object.prototype
    ? raw as Record<string, unknown> : null;
}

function boundedBigint(value: unknown, minimum: bigint): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return false;
  const n = BigInt(value);
  return n >= minimum && n <= MAX_BIGINT;
}

function parseWitness(raw: unknown): HeldNumberingWitness | null {
  const w = record(raw);
  if (!w || Object.keys(w).length !== 6) return null;
  const { binding, prefix, revision, lastValue, isCalled, syntheticNumberMapSha256 } = w;
  if (typeof binding !== "string" || !BINDING.test(binding) || typeof prefix !== "string"
    || !/^[A-Z]{1,6}$/.test(prefix) || !boundedBigint(revision, 3n)
    || !boundedBigint(lastValue, 7000n) || typeof isCalled !== "boolean"
    || typeof syntheticNumberMapSha256 !== "string" || !SHA256.test(syntheticNumberMapSha256)) return null;
  return { binding, prefix, revision, lastValue, isCalled, syntheticNumberMapSha256 };
}

function digests(archive: Uint8Array): Pick<Attachment, "archiveSha256" | "databaseSha256"> | null {
  if (archive.byteLength === 0 || archive.byteLength > MAX_FIXTURE_ARCHIVE_BYTES) return null;
  try {
    const tar = gunzipSync(archive, { maxOutputLength: MAX_FIXTURE_ARCHIVE_BYTES });
    const result = validateBackupArchive(parseTarBytes(tar));
    return result.ok ? { archiveSha256: sha(archive), databaseSha256: result.sqlSha256 } : null;
  } catch { return null; }
}

function canonical(attachment: Attachment): Buffer {
  return Buffer.from(JSON.stringify(attachment), "utf8");
}

/** Before/after witnesses come from the same isolated held source as the archive.
 * Checking both plus the restored row digest catches mismatched capture sessions.
 * A checksum is integrity, not authorization. */
export function sealSyntheticApplicationArchive(
  archive: Uint8Array, witnessBefore: unknown, witnessAfter: unknown,
): { bytes: Buffer; sha256: string } | null {
  const before = parseWitness(witnessBefore), after = parseWitness(witnessAfter);
  const hashes = digests(archive);
  if (!before || !after || !hashes || JSON.stringify(before) !== JSON.stringify(after)) return null;
  const bytes = canonical({ format: FORMAT, version: V, ...hashes, witness: before });
  return { bytes, sha256: sha(bytes) };
}

/** Missing annex never breaks unchanged legacy application backup validation.
 * Present invalid/unapproved evidence is rejected, never silently downgraded.
 * expectedSidecarSha256 MUST come from independent trusted fixture control,
 * not from the received archive/attachment itself. Still no management authority. */
export function verifySyntheticApplicationArchive(
  archive: Uint8Array, annex?: { bytes: Uint8Array; expectedSidecarSha256: string },
): ReviewArchiveDecision {
  const hashes = digests(archive);
  if (!hashes) return { kind: "refused", reason: "archive-invalid" };
  if (!annex) return { kind: "legacy-data-only", management: "held" };
  if (annex.bytes.byteLength === 0 || annex.bytes.byteLength > MAX_SIDECAR_BYTES
    || !SHA256.test(annex.expectedSidecarSha256) || sha(annex.bytes) !== annex.expectedSidecarSha256) {
    return { kind: "refused", reason: "numbering-evidence-invalid" };
  }
  try {
    const raw = record(JSON.parse(Buffer.from(annex.bytes).toString("utf8")));
    const witness = parseWitness(raw?.witness);
    const normalized = witness && canonical({ format: FORMAT, version: V, ...hashes, witness });
    // Exact canonical representation also rejects duplicate/unknown keys,
    // mismatched archive bytes, version/format, and sloppy numeric types.
    if (!witness || !normalized || !normalized.equals(annex.bytes)) {
      return { kind: "refused", reason: "numbering-evidence-invalid" };
    }
    return { kind: "recovery-candidate", management: "held", witness };
  } catch { return { kind: "refused", reason: "numbering-evidence-invalid" }; }
}
