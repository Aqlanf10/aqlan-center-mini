import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { readRetentionTransitionRecord, type RetentionTransitionCommand } from "./ortho-retention-transition";
export async function verifyRetentionTransitionSaved(raw: unknown, expected: {
  patientId: number; orthoCaseId: number; clinicalCaseId: number; actorId: number; command: RetentionTransitionCommand;
}, status: number) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_transition_receipt");
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "ok,replayed,transition" || r.ok !== true
    || typeof r.replayed !== "boolean" || status !== (r.replayed ? 200 : 201)) throw new Error("invalid_transition_receipt");
  const transition = readRetentionTransitionRecord(r.transition, expected);
  const bytes = new TextEncoder().encode(canonicalJourneyJSON(expected.command));
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
  if (transition.clinicalCaseId !== expected.clinicalCaseId || transition.actorId !== expected.actorId || transition.requestFingerprint !== hash
    || canonicalJourneyJSON(transition.command) !== canonicalJourneyJSON(expected.command)) throw new Error("transition_receipt_mismatch");
  return transition;
}
