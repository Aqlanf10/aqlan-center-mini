import type { FinancialCommand } from "./financial-command-journal";
import { parseFollowupCoverageCommand, type FollowupCoverageCommand, type FollowupCoverageRevision } from "./ortho-followup-coverage";

export interface FollowupCoverageAttempt { actor: string; patientId: number; orthoCaseId: number; command: FollowupCoverageCommand }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const sameCommand = (value: unknown, expected: FollowupCoverageCommand) => {
  const parsed = parseFollowupCoverageCommand(value);
  return parsed !== null && JSON.stringify(parsed) === JSON.stringify(expected);
};
export function followupCoverageJournal(attempt: FollowupCoverageAttempt): FinancialCommand {
  const original = JSON.stringify(attempt);
  return { kind: "ortho-followup-coverage", key: attempt.command.commandId, original, payload: original };
}
export function restoreFollowupCoverage(command: FinancialCommand, actor: string, patientId: number): FollowupCoverageAttempt | null {
  if (command.kind !== "ortho-followup-coverage" || command.original !== command.payload) return null;
  try {
    const value: unknown = JSON.parse(command.original);
    if (!record(value) || value.actor !== actor || value.patientId !== patientId || Object.keys(value).length !== 4) return null;
    const parsed = parseFollowupCoverageCommand(value.command);
    if (!parsed || parsed.commandId !== command.key || parsed.source.patientId !== patientId || parsed.source.orthoCaseId !== value.orthoCaseId) return null;
    const attempt = { actor, patientId, orthoCaseId: parsed.source.orthoCaseId, command: parsed };
    return followupCoverageJournal(attempt).original === command.original ? attempt : null;
  } catch { return null; }
}
/** A key alone is not proof: every immutable source/decision field must match. */
export function readFollowupCoverageReceipt(value: unknown, attempt: FollowupCoverageAttempt): FollowupCoverageRevision | null {
  if (!record(value) || !record(value.source)) return null;
  const c = attempt.command, source = value.source;
  if (typeof value.id !== "string" || !/^[1-9]\d{0,18}$/.test(value.id)
    || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || value.supersedesRevisionId !== c.expectedRevisionId
    || (c.expectedRevisionId === null ? value.version !== 1 : value.version === 1)
    || value.commandId !== c.commandId || value.sourceFingerprint !== c.expectedSourceFingerprint
    || value.decision !== c.decision || value.reason !== c.reason || value.createdBy !== attempt.actor
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || Object.entries(c.source).some(([key, id]) => source[key] !== id)) return null;
  return value as unknown as FollowupCoverageRevision;
}
/** Only a status read's exact durable tombstone may retire a rejected command. */
export function isFollowupCoverageRejection(value: unknown, attempt: FollowupCoverageAttempt): boolean {
  if (!record(value) || value.state !== "rejected" || !record(value.rejection)) return false;
  const r = value.rejection;
  return r.terminal === true && r.commandId === attempt.command.commandId && r.actor === attempt.actor
    && r.patientId === attempt.patientId && r.orthoCaseId === attempt.orthoCaseId
    && ["source_changed", "stale_coverage", "case_closed"].includes(String(r.code))
    && typeof r.message === "string" && r.message.trim().length > 0
    && typeof r.rejectedAt === "string" && Number.isFinite(Date.parse(r.rejectedAt))
    && sameCommand(r.command, attempt.command);
}
