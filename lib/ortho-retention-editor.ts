/** Controlled documentary draft; it does not write, book recalls or change treatment. */
import { checkRetentionEventCommand, type RetentionDeviceRef, type RetentionEvent, type RetentionEventArch, type RetentionEventCommand } from "./ortho-retention-events";
import type { OccurrenceEvidence } from "./ortho-case-occurrence";
import type { RetentionRead } from "./ortho-retention-client";
import type { RetentionDeviceProjection } from "./ortho-retention-event-history";
export const RETENTION_EVENT_KINDS = ["debond", "device_delivery", "device_replacement", "device_review", "device_repair", "device_status_change", "followup_intent"] as const;
export const RETENTION_REVIEW_FINDINGS = ["fit", "breakage", "loss", "hygiene", "adherence", "relapse"] as const;
type Findings = Extract<RetentionEvent, { kind: "device_review" }>["observations"];
export interface RetentionEditorDraft {
  expectedHeadId: number | null; previousVersion: number;
  kind: RetentionEvent["kind"] | ""; arch: RetentionEventArch | ""; reason: string;
  supersedesEntryId: number | null; originalArch: RetentionEventArch | null; archCorrectionReason: string;
  occurrence: OccurrenceEvidence; note: string; documentIds: number[];
  device: RetentionDeviceRef | null; deviceType: "fixed" | "removable" | "other" | "";
  description: string; extent: string; findings: Findings; status: "in_use" | "not_in_use" | "lost" | "removed" | "unknown" | "";
  dueOn: string; intervalDays: string; followupScope: string;
}
const unassessed = (): Findings => Object.fromEntries(RETENTION_REVIEW_FINDINGS.map(key => [key, { state: "not_assessed", note: "" }])) as Findings;
/** Explicit digit normalization only; fractions, separators and exponents refuse. */
export function retentionIntervalDays(raw: string): number | null {
  if (raw === "") return null;
  const normalized = raw.replace(/[٠-٩]/g, char => String(char.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, char => String(char.charCodeAt(0) - 0x6f0));
  if (!/^[1-9][0-9]{0,3}$/.test(normalized) || Number(normalized) > 3650) throw new Error("invalid_retention_interval");
  return Number(normalized);
}
export function initialRetentionEditor(read: RetentionRead): RetentionEditorDraft {
  return { expectedHeadId: read.history[0]?.id ?? null, previousVersion: read.history[0]?.version ?? 0,
    kind: "", arch: "", reason: "", supersedesEntryId: null, originalArch: null, archCorrectionReason: "",
    occurrence: { occurredOn: null, dateProvenance: "unknown", sourceNote: "" }, note: "", documentIds: [], device: null, deviceType: "",
    description: "", extent: "", findings: unassessed(), status: "", dueOn: "", intervalDays: "", followupScope: "" };
}
export function chooseRetentionKind(draft: RetentionEditorDraft, kind: RetentionEditorDraft["kind"]): RetentionEditorDraft {
  if (draft.supersedesEntryId !== null || draft.kind === kind) return draft;
  return { ...draft, kind, device: null, deviceType: "", description: "", extent: "", findings: unassessed(), status: "", dueOn: "", intervalDays: "", followupScope: "" };
}
export function chooseRetentionDevice(draft: RetentionEditorDraft, device: RetentionDeviceProjection | null): RetentionEditorDraft {
  // User selects the physical root, not an arch. The exact observed head is frozen
  // in the draft and is never refreshed silently after a server reread.
  if (draft.supersedesEntryId !== null && (draft.device?.deviceId ?? null) !== (device?.deviceId ?? null)) throw new Error("correction_retargets_device");
  return { ...draft, device: device ? { deviceId: device.deviceId, expectedDeviceRevisionId: device.lastEventId } : null,
    arch: device ? device.arch : draft.arch };
}
export function correctRetentionEvent(read: RetentionRead, eventId: number): RetentionEditorDraft {
  const row = read.currentEvents.find(value => value.id === eventId); if (!row) throw new Error("retention_correction_unavailable");
  const value = row.content, initial = initialRetentionEditor(read);
  const draft: RetentionEditorDraft = { ...initial, kind: value.kind, arch: row.arch, supersedesEntryId: row.id, originalArch: row.arch,
    occurrence: { ...value.occurrence }, note: value.note, documentIds: [...value.documentIds] };
  const target = "device" in value ? value.device : value.kind === "device_replacement" ? value.replaces : null;
  if (target) {
    const current = read.devices.find(device => device.deviceId === target.deviceId); if (!current) throw new Error("retention_correction_device_unavailable");
    draft.device = { deviceId: target.deviceId, expectedDeviceRevisionId: current.lastEventId };
  }
  if (value.kind === "device_delivery" || value.kind === "device_replacement") { draft.deviceType = value.deviceType; draft.description = value.description; draft.extent = value.extent; }
  if (value.kind === "debond") draft.extent = value.extent;
  if (value.kind === "device_repair") draft.description = value.description;
  if (value.kind === "device_review") draft.findings = Object.fromEntries(RETENTION_REVIEW_FINDINGS.map(key => [key, { ...value.observations[key] }])) as Findings;
  if (value.kind === "device_status_change") draft.status = value.status;
  if (value.kind === "followup_intent") { draft.dueOn = value.dueOn ?? ""; draft.intervalDays = value.intervalDays === null ? "" : String(value.intervalDays); draft.followupScope = value.scope; }
  return draft;
}
export function retentionEditorCommand(draft: RetentionEditorDraft, clientRequestId: string) {
  const base = { occurrence: { ...draft.occurrence }, note: draft.note, documentIds: [...draft.documentIds] };
  let content: unknown;
  switch (draft.kind) {
    case "debond": content = { ...base, kind: draft.kind, extent: draft.extent }; break;
    case "device_delivery": content = { ...base, kind: draft.kind, deviceType: draft.deviceType, description: draft.description, extent: draft.extent, labOrderId: null }; break;
    case "device_replacement": content = { ...base, kind: draft.kind, deviceType: draft.deviceType, description: draft.description, extent: draft.extent, labOrderId: null, replaces: draft.device }; break;
    case "device_review": content = { ...base, kind: draft.kind, device: draft.device, observations: draft.findings }; break;
    case "device_repair": content = { ...base, kind: draft.kind, device: draft.device, description: draft.description }; break;
    case "device_status_change": content = { ...base, kind: draft.kind, device: draft.device, status: draft.status }; break;
    case "followup_intent": {
      let intervalDays: number | null;
      try { intervalDays = retentionIntervalDays(draft.intervalDays); } catch { return { ok: false as const, code: "invalid_retention_interval" }; }
      content = { ...base, kind: draft.kind, device: draft.device, dueOn: draft.dueOn || null,
        intervalDays, scope: draft.followupScope }; break;
    }
    default: return { ok: false as const, code: "retention_event_kind_required" };
  }
  if (!Number.isSafeInteger(draft.previousVersion) || draft.previousVersion < 0
    || (draft.expectedHeadId === null) !== (draft.previousVersion === 0)) return { ok: false as const, code: "invalid_retention_draft_head" };
  if (draft.supersedesEntryId !== null && (!draft.originalArch || (draft.arch !== draft.originalArch) !== !!draft.archCorrectionReason.trim())) return { ok: false as const, code: "arch_correction_reason_mismatch" };
  return checkRetentionEventCommand({ schemaVersion: 1, clientRequestId, expectedHeadId: draft.expectedHeadId, reason: draft.reason,
    arch: draft.arch, supersedesEntryId: draft.supersedesEntryId, archCorrectionReason: draft.supersedesEntryId !== null && draft.arch !== draft.originalArch ? draft.archCorrectionReason : null, content });
}
export function retentionDraftTargetIsCurrent(draft: RetentionEditorDraft, read: RetentionRead): boolean {
  if (draft.expectedHeadId !== (read.history[0]?.id ?? null) || draft.previousVersion !== (read.history[0]?.version ?? 0)) return false;
  if (draft.supersedesEntryId !== null && !read.currentEvents.some(row => row.id === draft.supersedesEntryId && row.content.kind === draft.kind)) return false;
  if (draft.device) return read.devices.some(device => device.deviceId === draft.device!.deviceId && device.lastEventId === draft.device!.expectedDeviceRevisionId);
  return true;
}
export type RetentionValidatedCommand = RetentionEventCommand;
