/** Unwired data-only numbering sidecar. The archive is never executable authority. */
import { createHash } from "node:crypto";
import { PATIENT_NUMBER_MAX } from "./patient-numbering-policy";

export const NUMBERING_RECOVERY_ENTRY = "numbering-recovery-v1.json";
export const NUMBERING_RECOVERY_MAX_BYTES = 16 * 1024 * 1024;
export const NUMBERING_RECOVERY_MAX_ROWS = 100_000;
const prefixes = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const pgMax = 9223372036854775807n;

export interface NumberingRecoverySequence {
  lastValue: string;
  isCalled: boolean;
}
export interface NumberingRecoveryCounter extends NumberingRecoverySequence {
  prefix: string;
  historicalThrough: string;
  historyComplete: true;
}
interface AuditSnapshot {
  prefix: string;
  allocatedThrough: string;
  pendingNext: string | null;
  historicalThrough: string;
  historyComplete: true;
  revision: string;
}
interface RecoveryAudit {
  id: string;
  actor: string;
  reason: string;
  beforeState: AuditSnapshot;
  afterState: AuditSnapshot;
}
interface RecoveryReceipt {
  actor: string;
  request: string;
  intent: string;
  result: { prefix: string; next: string; preview: string; revision: string };
}
interface RetiredAlias { number: string; patientId: string }
export interface NumberingRecoveryPayload {
  version: 1;
  lineage: string;
  activePrefix: string;
  configRevision: string;
  counters: NumberingRecoveryCounter[];
  auditSequence: NumberingRecoverySequence;
  retiredAliases: RetiredAlias[];
  audit: RecoveryAudit[];
  receipts: RecoveryReceipt[];
}
export interface NumberingRecoveryManifest {
  version: 1;
  entry: typeof NUMBERING_RECOVERY_ENTRY;
  bytes: number;
  sha256: string;
}
/** Read by a reviewed, server-only independent authority. Never construct this
 * from the restore bundle or its manifest. The codec cannot prove provenance. */
export interface NumberingFreshnessWitness {
  version: 1;
  lineage: string;
  stateSha256: string;
}
export interface NumberingFreshnessAuthority {
  /** Configured by the trusted server, not selected by an archive or request. */
  expectedLineage: string;
  readCurrent: (lineage: string) => Promise<NumberingFreshnessWitness | null>;
}

class InvalidNumberingRecovery extends Error {}
function invalid(): never { throw new InvalidNumberingRecovery("Invalid or incomplete numbering recovery payload"); }
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== keys.length || keys.some((k) => !Object.hasOwn(input, k))) invalid();
  return input as Record<string, unknown>;
}
function text(input: unknown, re: RegExp): string {
  if (typeof input !== "string" || !re.test(input)) invalid();
  return input;
}
function decimal(input: unknown, max = pgMax, allowZero = false): string {
  const n = text(input, allowZero ? /^(?:0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/);
  if (BigInt(n) > max) invalid();
  return n;
}
function seq(r: Record<string, unknown>, max = pgMax): NumberingRecoverySequence {
  if (typeof r.isCalled !== "boolean") invalid();
  return { lastValue: decimal(r.lastValue, max), isCalled: r.isCalled };
}
function array(input: unknown, limit: number): unknown[] {
  if (!Array.isArray(input) || input.length > limit) invalid();
  return input;
}
const letter = (input: unknown) => text(input, /^[A-Z]$/);
const lineageId = (input: unknown) => text(input, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hashText = (input: unknown) => text(input, /^[0-9a-f]{64}$/);
const digest = (input: Uint8Array) => createHash("sha256").update(input).digest("hex");
function reason(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 500 || value.trim() !== value || value.includes("\0")) invalid();
  return value;
}
function revisionToken(value: unknown) {
  const raw = text(value, /^[A-Za-z0-9._:-]{1,128}$/);
  const match = /^(\d+):([A-Z]):([A-Z]):(\d+):([01]):(\d+):([01])$/.exec(raw);
  if (!match) invalid();
  return {
    raw, config: decimal(match[1]), active: match[2], prefix: match[3],
    last: decimal(match[4], PATIENT_NUMBER_MAX), called: match[5] === "1",
    historical: decimal(match[6], PATIENT_NUMBER_MAX, true), complete: match[7] === "1",
  };
}
function snapshot(input: unknown): AuditSnapshot {
  const r = object(input, ["prefix", "allocatedThrough", "pendingNext", "historicalThrough", "historyComplete", "revision"]);
  const prefix = letter(r.prefix), token = revisionToken(r.revision);
  const allocatedThrough = decimal(r.allocatedThrough, PATIENT_NUMBER_MAX, true);
  const pendingNext = r.pendingNext === null ? null : decimal(r.pendingNext, PATIENT_NUMBER_MAX);
  const historicalThrough = decimal(r.historicalThrough, PATIENT_NUMBER_MAX, true);
  if (r.historyComplete !== true || !token.complete || token.prefix !== prefix || token.historical !== historicalThrough
    || (token.called ? allocatedThrough !== token.last || pendingNext !== null
      : allocatedThrough !== "0" || pendingNext !== token.last)) invalid();
  return { prefix, allocatedThrough, pendingNext, historicalThrough, historyComplete: true, revision: token.raw };
}
export function canonicalizeLegacyNumberingRecovery(input: unknown): NumberingRecoveryPayload {
  const r = object(input, ["version", "lineage", "activePrefix", "configRevision", "counters", "auditSequence", "retiredAliases", "audit", "receipts"]);
  if (r.version !== 1) invalid();
  const lineage = lineageId(r.lineage), activePrefix = letter(r.activePrefix), configRevision = decimal(r.configRevision);
  const counters: NumberingRecoveryCounter[] = array(r.counters, 26).map((value) => {
    const row = object(value, ["prefix", "lastValue", "isCalled", "historicalThrough", "historyComplete"]);
    const s = seq(row, PATIENT_NUMBER_MAX), historicalThrough = decimal(row.historicalThrough, PATIENT_NUMBER_MAX, true);
    if (row.historyComplete !== true || BigInt(historicalThrough) > BigInt(s.lastValue)
      || (!s.isCalled && historicalThrough === s.lastValue)) invalid();
    return { prefix: letter(row.prefix), ...s, historicalThrough, historyComplete: true };
  });
  counters.sort((a, b) => a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0);
  if (counters.map((counter) => counter.prefix).join("") !== prefixes) invalid();
  const auditSequence = seq(object(r.auditSequence, ["lastValue", "isCalled"]));
  const normalizedOwner = new Map<string, string>(), exactAliases = new Set<string>();
  const retiredAliases = array(r.retiredAliases, NUMBERING_RECOVERY_MAX_ROWS).map((value): RetiredAlias => {
    const row = object(value, ["number", "patientId"]);
    const number = text(row.number, /^[A-Z]-[0-9]{1,18}$/), patientId = decimal(row.patientId);
    const n = BigInt(number.slice(2)), prefix = number[0];
    const normalized = prefix + "-" + n;
    const existing = normalizedOwner.get(normalized);
    if (n < 1n || n > BigInt(counters[prefix.charCodeAt(0) - 65].historicalThrough)
      || exactAliases.has(number) || (existing !== undefined && existing !== patientId)) invalid();
    exactAliases.add(number);
    normalizedOwner.set(normalized, patientId);
    return { number, patientId };
  }).sort((a, b) => a.number < b.number ? -1 : a.number > b.number ? 1 : 0);

  const keys = new Set<string>(), auditIds = new Set<string>();
  const audit = array(r.audit, NUMBERING_RECOVERY_MAX_ROWS).map((value): RecoveryAudit => {
    const row = object(value, ["id", "actor", "reason", "beforeState", "afterState"]);
    const id = decimal(row.id), actor = decimal(row.actor), note = reason(row.reason);
    const beforeState = snapshot(row.beforeState), afterState = snapshot(row.afterState);
    const b = revisionToken(beforeState.revision), a = revisionToken(afterState.revision);
    const command = JSON.stringify([actor, note, b.raw, a.raw]);
    if (auditIds.has(id) || keys.has(command) || BigInt(auditSequence.lastValue) < BigInt(id)
      || (!auditSequence.isCalled && auditSequence.lastValue === id)
      || !afterState.pendingNext || a.active !== a.prefix || a.prefix !== b.prefix
      || b.historical !== a.historical || BigInt(a.last) <= BigInt(b.historical)
      || BigInt(a.last) <= BigInt(beforeState.allocatedThrough)
      || (beforeState.pendingNext !== null && BigInt(a.last) < BigInt(beforeState.pendingNext))
      || BigInt(a.config) !== BigInt(b.config) + 1n || BigInt(a.config) > BigInt(configRevision)) invalid();
    keys.add(command);
    auditIds.add(id);
    return { id, actor, reason: note, beforeState, afterState };
  }).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);

  const receiptIds = new Set<string>();
  const receipts = array(r.receipts, NUMBERING_RECOVERY_MAX_ROWS).map((value): RecoveryReceipt => {
    const row = object(value, ["actor", "request", "intent", "result"]);
    const actor = decimal(row.actor), request = text(row.request, /^[A-Za-z0-9_-]{16,128}$/);
    const requestKey = actor + ":" + request;
    if (receiptIds.has(requestKey) || typeof row.intent !== "string" || row.intent.length > 4096) invalid();
    receiptIds.add(requestKey);
    let i: unknown[];
    try { i = array(JSON.parse(row.intent), 4); } catch { invalid(); }
    if (i.length !== 4 || JSON.stringify(i) !== row.intent) invalid();
    const result = object(row.result, ["prefix", "next", "preview", "revision"]);
    const prefix = letter(result.prefix), next = decimal(result.next, PATIENT_NUMBER_MAX);
    const preview = prefix + "-" + next.padStart(5, "0");
    const after = revisionToken(result.revision), before = revisionToken(i[2]), note = reason(i[3]);
    if (i[0] !== prefix || i[1] !== next || result.preview !== preview || after.prefix !== prefix
      || after.last !== next || !keys.delete(JSON.stringify([actor, note, before.raw, after.raw]))) invalid();
    return { actor, request, intent: row.intent, result: { prefix, next, preview, revision: after.raw } };
  }).sort((a, b) => a.actor !== b.actor ? (BigInt(a.actor) < BigInt(b.actor) ? -1 : 1) : a.request < b.request ? -1 : 1);
  // Version 1 starts at P, revision 1. Each command advances exactly
  // once; sequence IDs may have gaps but policy evidence may not.
  if (keys.size !== 0 || BigInt(configRevision) !== BigInt(audit.length) + 1n) invalid();
  let currentActive = "P";
  const lastPerPrefix = new Map<string, ReturnType<typeof revisionToken>>();
  for (const [index, event] of audit.entries()) {
    const before = revisionToken(event.beforeState.revision);
    const after = revisionToken(event.afterState.revision);
    const live = counters[after.prefix.charCodeAt(0) - 65];
    const previous = lastPerPrefix.get(after.prefix);
    if (before.active !== currentActive || BigInt(before.config) !== BigInt(index) + 1n
      || BigInt(live.historicalThrough) < BigInt(after.historical)
      || BigInt(live.lastValue) < BigInt(after.last)
      || (previous && (BigInt(before.last) < BigInt(previous.last)
        || BigInt(before.historical) < BigInt(previous.historical)))) invalid();
    currentActive = after.active;
    lastPerPrefix.set(after.prefix, after);
  }
  if (activePrefix !== currentActive) invalid();
  return { version: 1, lineage, activePrefix, configRevision, counters, auditSequence, retiredAliases, audit, receipts };
}
export function encodeNumberingRecovery(input: unknown): { manifest: NumberingRecoveryManifest; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalizeLegacyNumberingRecovery(input)));
  if (bytes.byteLength > NUMBERING_RECOVERY_MAX_BYTES) invalid();
  return { manifest: { version: 1, entry: NUMBERING_RECOVERY_ENTRY, bytes: bytes.byteLength, sha256: digest(bytes) }, bytes };
}
function decodeRecovery(bytes: Uint8Array, descriptor: unknown): { state: NumberingRecoveryPayload; sha256: string } {
  const d = object(descriptor, ["version", "entry", "bytes", "sha256"]);
  if (!(bytes instanceof Uint8Array) || d.version !== 1 || d.entry !== NUMBERING_RECOVERY_ENTRY
    || d.bytes !== bytes.byteLength || bytes.byteLength > NUMBERING_RECOVERY_MAX_BYTES
    || bytes.byteLength === 0 || hashText(d.sha256) !== digest(bytes)) invalid();
  let json: unknown;
  try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { invalid(); }
  const state = canonicalizeLegacyNumberingRecovery(json);
  const canonical = JSON.stringify(state);
  // Reject duplicate keys, UTF-8 aliases/BOM, extra whitespace/order and alternate encodings.
  if (!Buffer.from(canonical, "utf8").equals(Buffer.from(bytes))) invalid();
  return { state, sha256: d.sha256 as string };
}
export type NumberingRecoveryAdmission =
  | { ok: true; payload: NumberingRecoveryPayload }
  | { ok: false; reason: "invalid-payload" | "trusted-witness-unavailable" | "freshness-mismatch" };
/** Accept only exact current authority-owned state, not a signed-looking archive
 * or a partially greater counter. Restore target fencing remains separate. */
export async function admitNumberingRecovery(
  bytes: Uint8Array, descriptor: unknown, trustedAuthority: NumberingFreshnessAuthority | null,
): Promise<NumberingRecoveryAdmission> {
  let decoded: ReturnType<typeof decodeRecovery>;
  try { decoded = decodeRecovery(bytes, descriptor); } catch { return { ok: false, reason: "invalid-payload" }; }
  if (!trustedAuthority) return { ok: false, reason: "trusted-witness-unavailable" };
  try {
    const expectedLineage = lineageId(trustedAuthority.expectedLineage);
    if (decoded.state.lineage !== expectedLineage) return { ok: false, reason: "freshness-mismatch" };
    const witness = await trustedAuthority.readCurrent(expectedLineage);
    if (!witness) return { ok: false, reason: "trusted-witness-unavailable" };
    if (witness.version !== 1 || lineageId(witness.lineage) !== decoded.state.lineage
      || hashText(witness.stateSha256) !== decoded.sha256) return { ok: false, reason: "freshness-mismatch" };
  } catch { return { ok: false, reason: "trusted-witness-unavailable" }; }
  return { ok: true, payload: decoded.state };
}
