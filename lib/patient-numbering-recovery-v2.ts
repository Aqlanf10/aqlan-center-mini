/** Private, data-only v2 checkpoint. This is not a product backup/restore
 * adapter and never grants permission to cut over or replay any attachment. */
import { createHash } from "node:crypto";
import { canonicalizeLegacyNumberingRecovery, NUMBERING_RECOVERY_MAX_BYTES, NUMBERING_RECOVERY_MAX_ROWS, type NumberingRecoveryPayload } from "./patient-numbering-recovery";
import { parseTarBytes } from "./restore/archive";
import { tarEnd, tarHeader, tarPadding } from "./tar";

export const MANAGED_NUMBERING_ENTRY = "numbering-recovery-v2.json";
const ATTACHMENT = "application-checkpoint.bin";
const MANIFEST = "manifest.json";
const MAX_ATTACHMENT = 8 * 1024 * 1024; // Only the bounded private witness; no full product archive support.
const MAX_CHECKPOINT = NUMBERING_RECOVERY_MAX_BYTES + MAX_ATTACHMENT + 16 * 1024;
const id = /^[A-Za-z0-9_-]{16,128}$/;
const lineageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const pgMax = 9223372036854775807n;
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const utf8 = (input: unknown) => Buffer.from(JSON.stringify(input), "utf8");
function invalid(): never { throw new Error("Invalid or incomplete managed numbering checkpoint"); }
function obj(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) return invalid();
  return value as Record<string, unknown>;
}
function txt(value: unknown, re: RegExp): string {
  return typeof value === "string" && re.test(value) ? value : invalid();
}
function decimal(value: unknown, maximum = pgMax): string {
  const v = txt(value, /^[1-9][0-9]{0,18}$/);
  return BigInt(v) <= maximum ? v : invalid();
}
function parse(bytes: Uint8Array) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

export interface ManagedRecoveryGeneration { phase: "MANAGED"; lineage: string; generation: string }
export interface ManagedRecoveryDisposition {
  lineage: string;
  enrollment: string;
  actor: string;
  request: string;
  expiresAtMs: string;
  state: "issued" | "committed" | "retired";
}
export interface ManagedNumberingPayload {
  version: 2;
  managed: ManagedRecoveryGeneration;
  numbering: NumberingRecoveryPayload;
  dispositions: ManagedRecoveryDisposition[];
}
type FileDescriptor<Name extends string> = { entry: Name; bytes: number; sha256: string };
export type ManagedNumberingDescriptor = { version: 2 } & FileDescriptor<typeof MANAGED_NUMBERING_ENTRY>;
interface CheckpointManifest {
  version: 2;
  numberingRecovery: ManagedNumberingDescriptor;
  attachment: FileDescriptor<typeof ATTACHMENT>;
}
function canonicalize(input: unknown): ManagedNumberingPayload {
  const r = obj(input, ["version", "managed", "numbering", "dispositions"]);
  if (r.version !== 2 || !Array.isArray(r.dispositions) || r.dispositions.length > NUMBERING_RECOVERY_MAX_ROWS) invalid();
  const gs = obj(r.managed, ["phase", "lineage", "generation"]);
  if (gs.phase !== "MANAGED") invalid();
  const lineage = txt(gs.lineage, lineageId), generation = decimal(gs.generation);
  const numbering = canonicalizeLegacyNumberingRecovery(r.numbering);
  if (lineage !== numbering.lineage) invalid();

  // v1 canonicalization establishes the receipt↔audit/revision bijection.
  // v2 additionally requires a global request-ID bijection from committed
  // ledger entries to those receipts. No unrecorded legacy receipt adoption.
  const unmatched = new Map<string, string>();
  for (const receipt of numbering.receipts) {
    if (unmatched.has(receipt.request)) invalid();
    unmatched.set(receipt.request, receipt.actor);
  }
  const seen = new Set<string>();
  const dispositions = r.dispositions.map((input): ManagedRecoveryDisposition => {
    const state = obj(input, ["lineage", "enrollment", "actor", "request", "expiresAtMs", "state"]);
    if (txt(state.lineage, lineageId) !== lineage) invalid();
    const enrollment = txt(state.enrollment, id), request = txt(state.request, id);
    const actor = decimal(state.actor, BigInt(Number.MAX_SAFE_INTEGER));
    const expiresAtMs = decimal(state.expiresAtMs, BigInt(Number.MAX_SAFE_INTEGER));
    if (seen.has(request) || (state.state !== "issued" && state.state !== "committed" && state.state !== "retired")) invalid();
    seen.add(request);
    if (state.state === "committed") {
      if (unmatched.get(request) !== actor) invalid();
      unmatched.delete(request);
    } else if (unmatched.has(request)) invalid();
    return { lineage, enrollment, actor, request, expiresAtMs, state: state.state };
  }).sort((a, b) => a.request < b.request ? -1 : 1);
  if (unmatched.size !== 0) invalid();
  return { version: 2, managed: { phase: "MANAGED", lineage, generation }, numbering, dispositions };
}
function descriptor<Name extends string>(entry: Name, bytes: Uint8Array): FileDescriptor<Name> {
  return { entry, bytes: bytes.byteLength, sha256: digest(bytes) };
}
export function encodeManagedNumberingSidecar(input: unknown): { manifest: ManagedNumberingDescriptor; bytes: Buffer } {
  const bytes = utf8(canonicalize(input));
  if (bytes.length > NUMBERING_RECOVERY_MAX_BYTES) invalid();
  return { manifest: { version: 2, ...descriptor(MANAGED_NUMBERING_ENTRY, bytes) }, bytes };
}
const epoch = new Date(0);
function bundle(archiveManifest: CheckpointManifest, state: Uint8Array, attachment: Uint8Array): Buffer {
  const chunks: Uint8Array[] = [];
  for (const [name, bytes] of [[MANIFEST, utf8(archiveManifest)], [MANAGED_NUMBERING_ENTRY, state], [ATTACHMENT, attachment]] as const) {
    chunks.push(tarHeader(name, bytes.byteLength, epoch), bytes, tarPadding(bytes.byteLength));
  }
  return Buffer.concat([...chunks, tarEnd()]);
}
/** Builds a bounded exact-byte witness for a private caller. Attachment is
 * opaque; it is neither parsed nor represented as an already validated backup. */
export function encodeManagedNumberingCheckpoint(input: unknown, attachment: Uint8Array): Buffer {
  if (!(attachment instanceof Uint8Array) || !attachment.length || attachment.length > MAX_ATTACHMENT) invalid();
  const copied = Buffer.from(attachment);
  const sidecar = encodeManagedNumberingSidecar(input);
  return bundle({ version: 2, numberingRecovery: sidecar.manifest, attachment: descriptor(ATTACHMENT, copied) }, sidecar.bytes, copied);
}
function decodeCheckpoint(input: Uint8Array) {
  if (!(input instanceof Uint8Array) || input.length === 0 || input.length > MAX_CHECKPOINT) invalid();
  // One owned copy supplies both checks, even across an async custody lookup.
  const bytes = Buffer.from(input);
  const parsed = parseTarBytes(bytes);
  if (parsed.truncated || parsed.order.join("\0") !== [MANIFEST, MANAGED_NUMBERING_ENTRY, ATTACHMENT].join("\0")) invalid();
  const m = parsed.entries.get(MANIFEST)!.data, sidecar = parsed.entries.get(MANAGED_NUMBERING_ENTRY)!.data;
  const attachment = parsed.entries.get(ATTACHMENT)!.data;
  if (m.length > 4096 || !sidecar.length || sidecar.length > NUMBERING_RECOVERY_MAX_BYTES
    || !attachment.length || attachment.length > MAX_ATTACHMENT) invalid();
  const payload = canonicalize(parse(sidecar));
  const canonical = utf8(payload);
  const manifest: CheckpointManifest = { version: 2,
    numberingRecovery: { version: 2, ...descriptor(MANAGED_NUMBERING_ENTRY, canonical) },
    attachment: descriptor(ATTACHMENT, attachment),
  };
  if (!canonical.equals(sidecar) || !bundle(manifest, canonical, attachment).equals(bytes)) invalid();
  // Exact re-encoding also rejects duplicate/alternate manifest representations,
  // malformed TAR headers, ignored entry types, extra trailing bytes and aliases.
  return { payload, stateSha256: manifest.numberingRecovery.sha256, archiveSha256: digest(bytes) };
}
interface CustodyWitness {
  version: 2;
  lineage: string;
  generation: string;
  stateSha256: string;
  archiveSha256: string;
}
export interface ManagedNumberingCustodyAuthority {
  /** Supplied from independently fenced/approved storage, not incoming TAR. */
  expectedLineage: string;
  expectedGeneration: string;
  readCurrent(lineage: string, generation: string): Promise<CustodyWitness | null>;
}
type Admission = { ok: true; payload: ManagedNumberingPayload }
  | { ok: false; reason: "invalid-payload" | "trusted-witness-unavailable" | "freshness-mismatch" };
export async function admitManagedNumberingCheckpoint(input: Uint8Array, authority: ManagedNumberingCustodyAuthority | null): Promise<Admission> {
  let exact: ReturnType<typeof decodeCheckpoint>;
  try { exact = decodeCheckpoint(input); } catch { return { ok: false, reason: "invalid-payload" }; }
  if (!authority) return { ok: false, reason: "trusted-witness-unavailable" };
  try {
    const lineage = txt(authority.expectedLineage, lineageId), generation = decimal(authority.expectedGeneration);
    if (lineage !== exact.payload.managed.lineage || generation !== exact.payload.managed.generation) return { ok: false, reason: "freshness-mismatch" };
    const witness = await authority.readCurrent(lineage, generation);
    if (!witness) return { ok: false, reason: "trusted-witness-unavailable" };
    if (witness.version !== 2 || witness.lineage !== lineage || witness.generation !== generation
      || txt(witness.stateSha256, hash) !== exact.stateSha256 || txt(witness.archiveSha256, hash) !== exact.archiveSha256) {
      return { ok: false, reason: "freshness-mismatch" };
    }
  } catch { return { ok: false, reason: "trusted-witness-unavailable" }; }
  // Data-only. Never issue a managed credential or execute attachment contents.
  return { ok: true, payload: exact.payload };
}
