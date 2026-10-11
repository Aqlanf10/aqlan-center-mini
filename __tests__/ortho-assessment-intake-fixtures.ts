import { type ActivateAssessmentCommand, type CancelAssessmentCommand, type IntakeEvent, type IntakeEventContent,
  type IntakeLifecycleCommand, type IntakeRead, type IntakeWriteResponse, type OpenAssessmentCommand } from "../lib/ortho-assessment-intake-client";
/** Synthetic fixtures only; this file does not execute a server or touch a DB. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
}
export const openCommand = (): OpenAssessmentCommand => ({ schemaVersion: 1, kind: "open_assessment", commandId: "synthetic_intake_open_1",
  patientId: 7, bridge: { mode: "new" }, intakeKind: "transferred", reason: "Synthetic transferred intake; treatment facts unknown" });
export const activateCommand = (): ActivateAssessmentCommand => ({ schemaVersion: 1, kind: "activate_assessment", commandId: "synthetic_intake_activate_1",
  patientId: 7, orthoCaseId: 8, clinicalCaseId: 9, expectedLifecycleVersion: 1, reason: "Synthetic explicit clinical setup",
  treatment: { appliance: "fixed_metal", arches: "upper", slot: null, bracketSystem: null, phase: "aligning",
    start: { state: "unknown", reason: "Transferred start not available" }, plannedMonths: null }, financialPlan: null });
export const cancelCommand = (): CancelAssessmentCommand => ({ schemaVersion: 1, kind: "cancel_assessment", commandId: "synthetic_intake_cancel_1",
  patientId: 7, orthoCaseId: 8, clinicalCaseId: 9, expectedLifecycleVersion: 1, reason: "Synthetic assessment cancellation" });
export async function eventFor(command: IntakeLifecycleCommand = openCommand(), policyOverride?: IntakeEventContent["policy"]): Promise<IntakeEvent> {
  const policy = command.kind === "open_assessment" ? { bridgeAtOpening: null, openingDateMeaning: "clinical_episode_opening_not_treatment_start" }
    : command.kind === "activate_assessment" ? { plan: null, consentPolicy: "existing_procedure_and_signature_guards_unchanged", consent: "not_recorded" }
      : { eventMeaning: "assessment_episode_cancelled_not_treatment_completed" };
  const content = { schemaVersion: 1, command: structuredClone(command), policy: policyOverride ?? policy } as IntakeEventContent;
  return { id: command.kind === "open_assessment" ? 40 : 41, patientId: 7, recordedPatientId: command.patientId, orthoCaseId: 8, clinicalCaseId: 9,
    version: command.kind === "open_assessment" ? 1 : 2, predecessorId: command.kind === "open_assessment" ? null : 40,
    kind: command.kind === "open_assessment" ? "assessment_opened" : command.kind === "activate_assessment" ? "assessment_activated" : "assessment_cancelled",
    recordedBy: "Synthetic clinician", recordedAt: "2026-10-11T00:00:00.000Z", reason: command.reason, contentHash: await hash(content), content };
}
export const emptyRead = (): IntakeRead => ({ ok: true, patientId: 7, writable: true, canLinkPlan: true, openCase: null,
  clinicalCases: [], plans: [], choicesTruncated: false, history: [] });
export const assessmentRead = (event: IntakeEvent): IntakeRead => ({ ...emptyRead(), openCase: { orthoCaseId: 8, clinicalCaseId: 9, status: "assessment", lifecycleVersion: 1 }, history: [event] });
export const saved = (event: IntakeEvent, replayed = false): IntakeWriteResponse => ({ ok: true, event, replayed,
  consentAtRecording: event.content.command.kind === "activate_assessment" && "consent" in event.content.policy ? event.content.policy.consent : "not_applicable" });
