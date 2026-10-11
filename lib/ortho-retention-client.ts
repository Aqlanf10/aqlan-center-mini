/** Strict browser boundary for the existing documentary retention API.
 * The server validates full physical lineage; this reader does not reconstruct
 * missing superseded content from currentEvents or turn dates into treatment. */
import { journeyHash, journeyId, type JourneyScope } from "./ortho-case-journey-records";
import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { readOccurrenceEvidence } from "./ortho-case-occurrence";
import { checkRetentionEventCommand, readRetentionEvent, type RetentionEventCommand, type RetentionEventArch } from "./ortho-retention-events";
import { decodeRetentionSavedContent, type RetentionSavedContent } from "./ortho-retention-history-store";
import type { RetentionDeviceProjection, RetentionEventRecord } from "./ortho-retention-event-history";
import { readRetentionCommandAcknowledgment } from "./ortho-retention-command-ack";
export type RetentionCaseStatus = "assessment" | "assessment_cancelled" | "active" | "retention" | "completed" | "discontinued";
export interface RetentionRevision extends JourneyScope {
  id: number; recordedPatientId: number; schemaVersion: 1; version: number; predecessorId: number | null;
  createdBy: string; createdAt: string; reason: string; recordingContext: "current" | "retrospective";
  caseStatusAtCapture: "active" | "retention" | "completed" | "discontinued"; contentHash: string; content: RetentionSavedContent;
}
export interface RetentionHistoryItem { id: number; version: number; predecessorId: number | null; createdAt: string; contentHash: string }
export interface RetentionRead extends JourneyScope {
  ok: true; status: RetentionCaseStatus; recordingContext: "current" | "retrospective"; planId: number | null;
  revision: RetentionRevision | null; devices: RetentionDeviceProjection[]; currentEvents: RetentionEventRecord[];
  canAppend: boolean; history: RetentionHistoryItem[];
}
export interface RetentionSaveExpectation { scope: JourneyScope; actorId: number; previousVersion: number; command: RetentionEventCommand }
export const RETENTION_RESPONSE_BYTE_LIMIT = 24 * 1024 * 1024;
const fail = (code = "invalid_retention_response"): never => { throw new Error(code); };
/** Apply to already JSON-parsed inputs before allocating detached projections.
 * Network callers must also use the streaming byte limit below before parsing. */
function admitJSON(raw: unknown) {
  // Conservative decoded-graph accounting is separate from compressed/wire bytes.
  let budget = 64 * 1024 * 1024, nodes = 0;
  const active = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 600_000 || depth > 24) return fail("retention_response_limit");
    if (typeof value === "string") { budget -= value.length * 3 + 2; }
    else if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) budget -= 32;
    else if (typeof value === "object" && value !== null) {
      if (active.has(value) || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return fail();
      active.add(value);
      const keys = Object.keys(value); if (keys.length > 5000) return fail("retention_response_limit");
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) return fail();
        budget -= key.length * 3 + 4; if (budget < 0) return fail("retention_response_limit");
        visit(descriptor.value, depth + 1);
      }
      active.delete(value);
    } else return fail();
    if (budget < 0) return fail("retention_response_limit");
  };
  visit(raw, 0);
}
export async function readRetentionResponseJSON(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(RETENTION_RESPONSE_BYTE_LIMIT))) return fail("retention_response_limit");
  if (!response.body) return fail("retention_response_missing_body");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > RETENTION_RESPONSE_BYTE_LIMIT) return fail("retention_response_limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode(); return JSON.parse(text);
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
function object(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(); const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== fields.length || fields.some(k => !Object.hasOwn(r, k))) return fail(); return r;
}
function id(value: unknown): number { if (!journeyId(value)) return fail(); return value; }
function nullableId(value: unknown): number | null { return value === null ? null : id(value); }
function hash(value: unknown): string { if (!journeyHash(value)) return fail(); return value; }
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) return fail(); return value;
}
function timestamp(value: unknown): string { const s = text(value, 80); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)
  || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) return fail(); return s; }
function date(value: unknown): string | null {
  return readOccurrenceEvidence({ occurredOn: value, dateProvenance: value === null ? "unknown" : "historical_source", sourceNote: "" }).occurredOn;
}
function arch(value: unknown): RetentionEventArch { if (value !== "upper" && value !== "lower" && value !== "legacy_unknown") return fail(); return value; }
function checkedScope(raw: Record<string, unknown>, expected: JourneyScope): JourneyScope {
  const value = { patientId: id(raw.patientId), orthoCaseId: id(raw.orthoCaseId), clinicalCaseId: id(raw.clinicalCaseId) };
  if (value.patientId !== expected.patientId || value.orthoCaseId !== expected.orthoCaseId || value.clinicalCaseId !== expected.clinicalCaseId) return fail("retention_scope_changed"); return value;
}
function recordedContext(status: RetentionCaseStatus): "current" | "retrospective" { return ["assessment_cancelled", "completed", "discontinued"].includes(status) ? "retrospective" : "current"; }
export const retentionTreatmentStatus = (status: unknown): status is RetentionRevision["caseStatusAtCapture"] => typeof status === "string" && ["active", "retention", "completed", "discontinued"].includes(status);
export function readRetentionRevision(raw: unknown, expected: JourneyScope): RetentionRevision {
  const r = object(raw, ["patientId", "orthoCaseId", "clinicalCaseId", "id", "recordedPatientId", "schemaVersion", "version", "predecessorId", "createdBy", "createdAt", "reason", "recordingContext", "caseStatusAtCapture", "contentHash", "content"]);
  if (r.schemaVersion !== 1 || !retentionTreatmentStatus(r.caseStatusAtCapture) || r.recordingContext !== recordedContext(r.caseStatusAtCapture)) return fail();
  const parsed = decodeRetentionSavedContent(r.content); if (!parsed.ok) return fail(parsed.code);
  return { ...checkedScope(r, expected), id: id(r.id), recordedPatientId: id(r.recordedPatientId), schemaVersion: 1, version: id(r.version),
    predecessorId: nullableId(r.predecessorId), createdBy: text(r.createdBy, 200), createdAt: timestamp(r.createdAt), reason: text(r.reason, 500),
    recordingContext: r.recordingContext as RetentionRevision["recordingContext"], caseStatusAtCapture: r.caseStatusAtCapture, contentHash: hash(r.contentHash), content: parsed.value };
}
function historyItem(raw: unknown): RetentionHistoryItem {
  const r = object(raw, ["id", "version", "predecessorId", "createdAt", "contentHash"]);
  return { id: id(r.id), version: id(r.version), predecessorId: nullableId(r.predecessorId), createdAt: timestamp(r.createdAt), contentHash: hash(r.contentHash) };
}
function event(raw: unknown): RetentionEventRecord {
  const r = object(raw, ["id", "version", "arch", "supersedesEntryId", "archCorrectionReason", "content"]);
  const parsed = checkRetentionEventCommand({ schemaVersion: 1, clientRequestId: "client_read_only_001", expectedHeadId: null, reason: "read",
    arch: r.arch, supersedesEntryId: r.supersedesEntryId, archCorrectionReason: r.archCorrectionReason, content: r.content });
  if (!parsed.ok) return fail(parsed.code); const value = parsed.value;
  return { id: id(r.id), version: id(r.version), arch: value.arch, supersedesEntryId: value.supersedesEntryId, archCorrectionReason: value.archCorrectionReason, content: value.content };
}
function device(raw: unknown): RetentionDeviceProjection {
  const r = object(raw, ["deviceId", "deliveryRevisionId", "lastEventId", "arch", "delivery", "replacedDeviceId", "currentState", "stateEventId", "intervalStart", "intervalEnd", "ambiguityReasons"]);
  const delivery = readRetentionEvent(r.delivery);
  if (delivery.kind !== "device_delivery" && delivery.kind !== "device_replacement" || typeof r.currentState !== "string"
    || !["in_use", "not_in_use", "lost", "removed", "replaced", "unknown", "ambiguous"].includes(r.currentState)
    || !Array.isArray(r.ambiguityReasons) || r.ambiguityReasons.length > 20) return fail();
  return { deviceId: id(r.deviceId), deliveryRevisionId: id(r.deliveryRevisionId), lastEventId: id(r.lastEventId), arch: arch(r.arch), delivery,
    replacedDeviceId: nullableId(r.replacedDeviceId), currentState: r.currentState as RetentionDeviceProjection["currentState"],
    stateEventId: nullableId(r.stateEventId), intervalStart: date(r.intervalStart), intervalEnd: date(r.intervalEnd), ambiguityReasons: r.ambiguityReasons.map(value => text(value, 200)) };
}
export function readRetentionRead(raw: unknown, expected: JourneyScope, selectedId: number | null = null): RetentionRead {
  admitJSON(raw);
  const r = object(raw, ["ok", "patientId", "orthoCaseId", "clinicalCaseId", "status", "recordingContext", "planId", "revision", "devices", "currentEvents", "canAppend", "history"]);
  if (r.ok !== true || typeof r.status !== "string" || !["assessment", "assessment_cancelled", "active", "retention", "completed", "discontinued"].includes(r.status)
    || r.recordingContext !== recordedContext(r.status as RetentionCaseStatus) || typeof r.canAppend !== "boolean"
    || !Array.isArray(r.history) || r.history.length > 5000 || !Array.isArray(r.currentEvents) || r.currentEvents.length > 5000 || !Array.isArray(r.devices) || r.devices.length > 5000) return fail();
  const scope = checkedScope(r, expected), history = r.history.map(historyItem), byId = new Map<number, RetentionHistoryItem>();
  for (let n = 0; n < history.length; n++) {
    const item = history[n], previous = history[n + 1];
    if (byId.has(item.id) || item.version !== (previous?.version ?? 0) + 1 || item.predecessorId !== (previous?.id ?? null)) return fail("retention_history_mismatch"); byId.set(item.id, item);
  }
  const revision = r.revision === null ? null : readRetentionRevision(r.revision, scope), selected = selectedId ?? history[0]?.id ?? null;
  if (selectedId !== null && !journeyId(selectedId) || (revision?.id ?? null) !== selected) return fail("retention_selected_revision_mismatch");
  if (revision) { const item = byId.get(revision.id); if (!item || item.version !== revision.version || item.contentHash !== revision.contentHash
    || item.predecessorId !== revision.predecessorId || item.createdAt !== revision.createdAt) return fail("retention_history_mismatch"); }
  const currentEvents = r.currentEvents.map(event), eventById = new Map<number, RetentionEventRecord>();
  for (const row of currentEvents) {
    const item = byId.get(row.id), predecessor = row.supersedesEntryId === null ? null : byId.get(row.supersedesEntryId);
    if (!item || item.version !== row.version || eventById.has(row.id) || row.supersedesEntryId !== null && (!predecessor || predecessor.version >= row.version)) return fail("retention_event_identity_mismatch");
    eventById.set(row.id, row);
  }
  const superseded = new Set<number>(), latestTouch = new Map<number, RetentionEventRecord>();
  for (const row of currentEvents) {
    if (row.supersedesEntryId !== null) {
      if (eventById.has(row.supersedesEntryId) || superseded.has(row.supersedesEntryId)) return fail("retention_event_identity_mismatch");
      superseded.add(row.supersedesEntryId);
    }
    const target = "device" in row.content ? row.content.device : row.content.kind === "device_replacement" ? row.content.replaces : null;
    if (target && (!latestTouch.has(target.deviceId) || latestTouch.get(target.deviceId)!.version < row.version)) latestTouch.set(target.deviceId, row);
  }
  const devices = r.devices.map(device), roots = new Set<number>();
  for (const row of devices) {
    const delivery = eventById.get(row.deliveryRevisionId);
    if (roots.has(row.deviceId) || !byId.has(row.deviceId) || !byId.has(row.lastEventId) || row.stateEventId !== null && !byId.has(row.stateEventId)
      || !delivery || delivery.arch !== row.arch || canonicalJourneyJSON(delivery.content) !== canonicalJourneyJSON(row.delivery)
      || row.replacedDeviceId !== (row.delivery.kind === "device_replacement" ? row.delivery.replaces.deviceId : null)) return fail("retention_device_identity_mismatch");
    const root = byId.get(row.deviceId)!;
    // An uncorrected delivery is its own physical root. A corrected delivery's
    // root is older and cannot also be a different surviving current event.
    if (delivery.supersedesEntryId === null ? row.deviceId !== delivery.id
      : root.version >= delivery.version || eventById.has(row.deviceId)) return fail("retention_device_identity_mismatch");
    const touch = latestTouch.get(row.deviceId), latest = touch && touch.version > delivery.version ? touch : delivery;
    if (row.lastEventId !== latest.id) return fail("retention_device_identity_mismatch");
    roots.add(row.deviceId);
  }
  if (history.length && !eventById.has(history[0].id)) return fail("retention_event_identity_mismatch");
  const deliveryIds = new Set(devices.map(row => row.deliveryRevisionId));
  if (deliveryIds.size !== devices.length || currentEvents.some(row => (row.content.kind === "device_delivery" || row.content.kind === "device_replacement") && !deliveryIds.has(row.id))) return fail("retention_device_identity_mismatch");
  for (const row of currentEvents) {
    const target = "device" in row.content ? row.content.device : row.content.kind === "device_replacement" ? row.content.replaces : null;
    if (target && (!roots.has(target.deviceId) || !byId.has(target.expectedDeviceRevisionId)
      || byId.get(target.deviceId)!.version >= row.version || byId.get(target.expectedDeviceRevisionId)!.version >= row.version)) return fail("retention_device_identity_mismatch");
  }
  if (devices.some(row => row.replacedDeviceId !== null && !roots.has(row.replacedDeviceId))) return fail("retention_device_identity_mismatch");
  return { ok: true, ...scope, status: r.status as RetentionCaseStatus, recordingContext: r.recordingContext as RetentionRead["recordingContext"],
    planId: nullableId(r.planId), revision, devices, currentEvents, canAppend: r.canAppend, history };
}
async function browserHash(value: unknown): Promise<string> {
  const text = canonicalJourneyJSON(value); if (text.length > 1024 * 1024) return fail("retention_hash_limit");
  const bytes = new TextEncoder().encode(text); if (bytes.length > 1024 * 1024 || !globalThis.crypto?.subtle) return fail("retention_hash_unavailable");
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
}
export async function verifyRetentionRead(raw: unknown, expected: JourneyScope, selectedId: number | null = null): Promise<RetentionRead> {
  const read = readRetentionRead(raw, expected, selectedId);
  if (read.revision && read.revision.contentHash !== await browserHash(read.revision.content)) return fail("retention_revision_hash_mismatch");
  // Current events are matched to authoritative history hashes without pretending
  // the browser has every superseded body needed to rerun physical projection.
  const hashes = new Map(read.history.map(row => [row.id, row.contentHash]));
  for (const row of read.currentEvents) {
    const content = { arch: row.arch, supersedesEntryId: row.supersedesEntryId, archCorrectionReason: row.archCorrectionReason, payload: row.content };
    if (hashes.get(row.id) !== await browserHash(content)) return fail("retention_event_hash_mismatch");
  }
  return read;
}
export function snapshotRetentionExpectation(expected: RetentionSaveExpectation): RetentionSaveExpectation {
  const command = checkRetentionEventCommand(expected.command);
  if (!command.ok || !journeyId(expected.actorId) || !Number.isSafeInteger(expected.previousVersion) || expected.previousVersion < 0 || expected.previousVersion >= 5000
    || (command.value.expectedHeadId === null) !== (expected.previousVersion === 0)) return fail("invalid_retention_expectation");
  return { actorId: expected.actorId, previousVersion: expected.previousVersion,
    scope: checkedScope({ ...expected.scope }, expected.scope), command: command.value };
}
export async function verifyRetentionSaved(raw: unknown, expected: RetentionSaveExpectation, status: number) {
  admitJSON(raw);
  const snapshot = snapshotRetentionExpectation(expected), r = object(raw, ["ok", "replayed", "revision", "acknowledgment"]);
  if (r.ok !== true || typeof r.replayed !== "boolean" || status !== (r.replayed ? 200 : 201)) return fail("invalid_retention_saved_status");
  const replayed = r.replayed;
  const revision = readRetentionRevision(r.revision, snapshot.scope), acknowledgment = readRetentionCommandAcknowledgment(r.acknowledgment);
  const content = { arch: snapshot.command.arch, supersedesEntryId: snapshot.command.supersedesEntryId, archCorrectionReason: snapshot.command.archCorrectionReason, payload: snapshot.command.content };
  if (acknowledgment.actorId !== snapshot.actorId || acknowledgment.commandId !== snapshot.command.clientRequestId || acknowledgment.revisionId !== revision.id
    || revision.version !== snapshot.previousVersion + 1 || revision.predecessorId !== snapshot.command.expectedHeadId || revision.reason !== snapshot.command.reason
    || canonicalJourneyJSON(revision.content) !== canonicalJourneyJSON(content)) return fail("retention_saved_command_mismatch");
  if (acknowledgment.requestFingerprint !== await browserHash(snapshot.command) || revision.contentHash !== await browserHash(content)) return fail("retention_saved_hash_mismatch");
  return { ok: true as const, replayed, revision, acknowledgment };
}
