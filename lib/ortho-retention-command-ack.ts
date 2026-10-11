/** Additive acknowledgment of this authenticated actor's exact stored command.
 * It is returned only by the existing write/replay route, never a user inventory. */
import { journeyHash, journeyId } from "./ortho-case-journey-records";
export interface RetentionCommandAcknowledgment {
  schemaVersion: 1; actorId: number; commandId: string; requestFingerprint: string; revisionId: number;
}
export function readRetentionCommandAcknowledgment(raw: unknown): RetentionCommandAcknowledgment {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_retention_acknowledgment");
  const r = raw as Record<string, unknown>, fields = ["schemaVersion", "actorId", "commandId", "requestFingerprint", "revisionId"];
  if (Object.keys(r).length !== fields.length || fields.some(key => !Object.hasOwn(r, key)) || r.schemaVersion !== 1
    || !journeyId(r.actorId) || !journeyId(r.revisionId) || !journeyHash(r.requestFingerprint)
    || typeof r.commandId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(r.commandId)) throw new Error("invalid_retention_acknowledgment");
  return { schemaVersion: 1, actorId: r.actorId, commandId: r.commandId, requestFingerprint: r.requestFingerprint, revisionId: r.revisionId };
}
/** Server adapter uses returned canonical row values, not caller-supplied actor data. */
export function acknowledgeStoredRetentionCommand(row: { id: unknown; actor_user_id: unknown; command_id: unknown; request_fingerprint: unknown },
  expected: { revisionId: number; actorId: number; commandId: string; requestFingerprint: string }): RetentionCommandAcknowledgment {
  const value = readRetentionCommandAcknowledgment({ schemaVersion: 1, actorId: row.actor_user_id, commandId: row.command_id,
    requestFingerprint: row.request_fingerprint, revisionId: row.id });
  if (value.revisionId !== expected.revisionId || value.actorId !== expected.actorId || value.commandId !== expected.commandId
    || value.requestFingerprint !== expected.requestFingerprint) throw new Error("stored_retention_acknowledgment_mismatch");
  return value;
}
