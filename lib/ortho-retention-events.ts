/** New strict documentary contract. No scheduling, treatment or financial action
 * follows from recording an event. Lab-order binding is deliberately unavailable. */
import { readOccurrenceEvidence, type OccurrenceEvidence } from "./ortho-case-occurrence";
import { journeyId, type Checked } from "./ortho-case-journey-records";
export type RetentionEventArch = "upper" | "lower" | "legacy_unknown";
export interface RetentionDeviceRef { deviceId: number; expectedDeviceRevisionId: number }
interface Base { occurrence: OccurrenceEvidence; note: string; documentIds: number[] }
interface Delivery { deviceType: "fixed" | "removable" | "other"; description: string; extent: string; labOrderId: null }
export type RetentionEvent =
  | (Base & { kind: "debond"; extent: string })
  | (Base & Delivery & { kind: "device_delivery" })
  | (Base & Delivery & { kind: "device_replacement"; replaces: RetentionDeviceRef })
  | (Base & { kind: "device_review"; device: RetentionDeviceRef; observations: Record<"fit" | "breakage" | "loss" | "hygiene" | "adherence" | "relapse", { state: "recorded" | "unknown" | "not_assessed"; note: string }> })
  | (Base & { kind: "device_repair"; device: RetentionDeviceRef; description: string })
  | (Base & { kind: "device_status_change"; device: RetentionDeviceRef; status: "in_use" | "not_in_use" | "lost" | "removed" | "unknown" })
  | (Base & { kind: "followup_intent"; device: RetentionDeviceRef | null; dueOn: string | null; intervalDays: number | null; scope: string });
export interface RetentionEventCommand {
  schemaVersion: 1; clientRequestId: string; expectedHeadId: number | null; reason: string;
  arch: RetentionEventArch; supersedesEntryId: number | null; archCorrectionReason: string | null; content: RetentionEvent;
}
const fail = (code = "invalid_retention_event"): never => { throw new Error(code); };
function obj(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) return fail(); return r;
}
function text(v: unknown, max = 4000, empty = false): string {
  if (typeof v !== "string" || v.length > max || !empty && !v.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v)) return fail(); return v;
}
function id(v: unknown): number { if (!journeyId(v)) return fail(); return v; }
function ref(v: unknown): RetentionDeviceRef {
  const r = obj(v, ["deviceId", "expectedDeviceRevisionId"]); return { deviceId: id(r.deviceId), expectedDeviceRevisionId: id(r.expectedDeviceRevisionId) };
}
export function readRetentionEvent(raw: unknown): RetentionEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const kind = (raw as Record<string, unknown>).kind;
  if (typeof kind !== "string") return fail();
  const extra: Record<string, string[]> = {
    debond: ["extent"], device_delivery: ["deviceType", "description", "extent", "labOrderId"],
    device_replacement: ["deviceType", "description", "extent", "labOrderId", "replaces"],
    device_review: ["device", "observations"], device_repair: ["device", "description"],
    device_status_change: ["device", "status"], followup_intent: ["device", "dueOn", "intervalDays", "scope"],
  };
  if (!Object.hasOwn(extra, kind)) return fail();
  const r = obj(raw, ["kind", "occurrence", "note", "documentIds", ...extra[kind]]);
  if (!Array.isArray(r.documentIds) || r.documentIds.length > 30) return fail();
  const documentIds = r.documentIds.map(id); if (new Set(documentIds).size !== documentIds.length) return fail();
  const base: Base = { occurrence: readOccurrenceEvidence(r.occurrence), note: text(r.note, 4000, true), documentIds };
  if (kind === "debond") return { ...base, kind, extent: text(r.extent, 500) };
  if (kind === "device_delivery" || kind === "device_replacement") {
    if (r.deviceType !== "fixed" && r.deviceType !== "removable" && r.deviceType !== "other" || r.labOrderId !== null) return fail("unsupported_retention_lab_binding");
    const delivery: Delivery = { deviceType: r.deviceType, description: text(r.description, 1000), extent: text(r.extent, 500), labOrderId: null };
    return kind === "device_delivery" ? { ...base, ...delivery, kind } : { ...base, ...delivery, kind, replaces: ref(r.replaces) };
  }
  if (kind === "device_repair") return { ...base, kind, device: ref(r.device), description: text(r.description) };
  if (kind === "device_status_change") {
    if (r.status !== "in_use" && r.status !== "not_in_use" && r.status !== "lost" && r.status !== "removed" && r.status !== "unknown") return fail();
    return { ...base, kind, device: ref(r.device), status: r.status };
  }
  if (kind === "followup_intent") {
    const dueOn = r.dueOn === null ? null : readOccurrenceEvidence({ occurredOn: r.dueOn, dateProvenance: "contemporaneous_record", sourceNote: "" }).occurredOn;
    if (r.intervalDays !== null && (typeof r.intervalDays !== "number" || !Number.isSafeInteger(r.intervalDays) || r.intervalDays < 1 || r.intervalDays > 3650)) return fail();
    if (dueOn === null && r.intervalDays === null) return fail("followup_intent_missing_timing");
    return { ...base, kind, device: r.device === null ? null : ref(r.device), dueOn, intervalDays: r.intervalDays as number | null, scope: text(r.scope, 1000) };
  }
  const fields = ["fit", "breakage", "loss", "hygiene", "adherence", "relapse"] as const;
  const observed = obj(r.observations, [...fields]);
  const observations = {} as Extract<RetentionEvent, { kind: "device_review" }>["observations"];
  for (const field of fields) {
    const o = obj(observed[field], ["state", "note"]);
    if (o.state !== "recorded" && o.state !== "unknown" && o.state !== "not_assessed") return fail();
    const note = text(o.note, 1000, o.state !== "recorded");
    observations[field] = { state: o.state, note };
  }
  return { ...base, kind: "device_review", device: ref(r.device), observations };
}
export function checkRetentionEventCommand(raw: unknown): Checked<RetentionEventCommand> {
  try {
    const r = obj(raw, ["schemaVersion", "clientRequestId", "expectedHeadId", "reason", "arch", "supersedesEntryId", "archCorrectionReason", "content"]);
    if (r.schemaVersion !== 1 || typeof r.clientRequestId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(r.clientRequestId)
      || r.arch !== "upper" && r.arch !== "lower" && r.arch !== "legacy_unknown") return fail();
    const supersedesEntryId = r.supersedesEntryId === null ? null : id(r.supersedesEntryId);
    const archCorrectionReason = r.archCorrectionReason === null ? null : text(r.archCorrectionReason, 500);
    if (archCorrectionReason !== null && supersedesEntryId === null) return fail();
    return { ok: true, value: { schemaVersion: 1, clientRequestId: r.clientRequestId, expectedHeadId: r.expectedHeadId === null ? null : id(r.expectedHeadId),
      reason: text(r.reason, 500), arch: r.arch, supersedesEntryId, archCorrectionReason, content: readRetentionEvent(r.content) } };
  } catch (e) { return { ok: false, code: e instanceof Error ? e.message : "invalid_retention_event" }; }
}
