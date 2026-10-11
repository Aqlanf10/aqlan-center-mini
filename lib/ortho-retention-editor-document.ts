import { journeyId } from "./ortho-case-journey-records";
import { RETENTION_EVENT_KINDS, RETENTION_REVIEW_FINDINGS, type RetentionEditorDraft } from "./ortho-retention-editor";
/** Partial form decoder only. A draft may be incomplete; the canonical event
 * parser independently admits any submitted command. No fields are defaulted. */
export function readRetentionEditorDocument(text: string): RetentionEditorDraft | null {
  try {
    if (typeof text !== "string" || text.length > 256 * 1024 || new TextEncoder().encode(text).length > 256 * 1024) return null;
    const raw: unknown = JSON.parse(text);
    const object = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
    const str = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
    const member = (value: unknown, choices: readonly string[]) => typeof value === "string" && choices.includes(value);
    const arch = (value: unknown) => member(value, ["upper", "lower", "legacy_unknown"]);
    if (!object(raw, ["expectedHeadId", "previousVersion", "kind", "arch", "reason", "supersedesEntryId", "originalArch", "archCorrectionReason",
      "occurrence", "note", "documentIds", "device", "deviceType", "description", "extent", "findings", "status", "dueOn", "intervalDays", "followupScope"])) return null;
    if (!(raw.expectedHeadId === null || journeyId(raw.expectedHeadId)) || !Number.isSafeInteger(raw.previousVersion) || typeof raw.previousVersion !== "number"
      || raw.previousVersion < 0 || raw.previousVersion > 5000 || (raw.expectedHeadId === null) !== (raw.previousVersion === 0)
      || !(raw.kind === "" || RETENTION_EVENT_KINDS.some(value => value === raw.kind)) || !(raw.arch === "" || arch(raw.arch))
      || !str(raw.reason, 500) || !(raw.supersedesEntryId === null || journeyId(raw.supersedesEntryId))
      || !(raw.originalArch === null || arch(raw.originalArch)) || (raw.originalArch === null) !== (raw.supersedesEntryId === null)
      || !str(raw.archCorrectionReason, 500) || !str(raw.note, 4000) || !str(raw.description, 4000) || !str(raw.extent, 500)
      || !member(raw.deviceType, ["", "fixed", "removable", "other"]) || !member(raw.status, ["", "in_use", "not_in_use", "lost", "removed", "unknown"])
      || !str(raw.dueOn, 10) || !str(raw.intervalDays, 4) || !str(raw.followupScope, 1000)) return null;
    if (!object(raw.occurrence, ["occurredOn", "dateProvenance", "sourceNote"]) || !(raw.occurrence.occurredOn === null || str(raw.occurrence.occurredOn, 10))
      || !member(raw.occurrence.dateProvenance, ["unknown", "contemporaneous_record", "retrospective_record", "historical_source"]) || !str(raw.occurrence.sourceNote, 1000)) return null;
    if (!Array.isArray(raw.documentIds) || raw.documentIds.length > 30 || !raw.documentIds.every(journeyId) || new Set(raw.documentIds).size !== raw.documentIds.length) return null;
    if (raw.device !== null && (!object(raw.device, ["deviceId", "expectedDeviceRevisionId"]) || !journeyId(raw.device.deviceId) || !journeyId(raw.device.expectedDeviceRevisionId))) return null;
    if (!object(raw.findings, [...RETENTION_REVIEW_FINDINGS])) return null;
    for (const key of RETENTION_REVIEW_FINDINGS) {
      const value = raw.findings[key]; if (!object(value, ["state", "note"]) || !member(value.state, ["recorded", "unknown", "not_assessed"]) || !str(value.note, 1000)) return null;
    }
    return raw as unknown as RetentionEditorDraft;
  } catch { return null; }
}
