/** Strict stored-content decoder shared by retention reads and study capture.
 * No mutation or physical-device inference is performed here. */
import { checkRetentionEventCommand, type RetentionEvent, type RetentionEventArch } from "./ortho-retention-events";
import type { Checked } from "./ortho-case-journey-records";
export interface RetentionSavedContent { arch: RetentionEventArch; supersedesEntryId: number | null; archCorrectionReason: string | null; payload: RetentionEvent }
export function decodeRetentionSavedContent(raw: unknown): Checked<RetentionSavedContent> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "invalid_retention_content" };
  const r = raw as Record<string, unknown>, fields = ["arch", "supersedesEntryId", "archCorrectionReason", "payload"];
  if (Object.keys(r).length !== fields.length || fields.some(k => !Object.hasOwn(r, k))) return { ok: false, code: "invalid_retention_content" };
  const checked = checkRetentionEventCommand({ schemaVersion: 1, clientRequestId: "stored_read_only", expectedHeadId: null, reason: "stored",
    arch: r.arch, supersedesEntryId: r.supersedesEntryId, archCorrectionReason: r.archCorrectionReason, content: r.payload });
  if (!checked.ok) return checked;
  const c = checked.value;
  return { ok: true, value: { arch: c.arch, supersedesEntryId: c.supersedesEntryId, archCorrectionReason: c.archCorrectionReason, payload: c.content } };
}
