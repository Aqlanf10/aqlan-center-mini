/** No patient text. The expected patient ID is a witness, never authorization.
 * Source timestamps are PostgreSQL epoch text, never JS Dates. */
export const FOLLOWUP_OUTCOMES = ["pending", "no_answer", "awaiting_reply", "rebooking_review", "declined", "resolved"] as const;
export const FOLLOWUP_NEXT_STEPS = ["call", "review", "none"] as const;
export type FollowupOutcome = typeof FOLLOWUP_OUTCOMES[number];
export type FollowupNextStep = typeof FOLLOWUP_NEXT_STEPS[number];
export interface FollowupCommand {
  appointmentId: number;
  expectedPatientId: number;
  expectedActorUserId: number; // Witness only; authenticated transaction actor remains authority.
  sourceCreatedAt: string;
  generation: string;
  requestId: string;
  expectedRevision: number; // 0 = explicit creation; otherwise compare-and-swap.
  assigneeUserId: number;
  dueAt: string;
  status: "open" | "closed";
  outcome: FollowupOutcome;
  nextStep: FollowupNextStep;
}
const keys = ["appointmentId", "expectedPatientId", "expectedActorUserId", "sourceCreatedAt", "generation", "requestId", "expectedRevision", "assigneeUserId", "dueAt", "status", "outcome", "nextStep"];
function id(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}
export function parseFollowupCommand(value: unknown): FollowupCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(key => !keys.includes(key))) return null;
  if (!id(v.appointmentId) || !id(v.expectedPatientId) || !id(v.expectedActorUserId) || !id(v.assigneeUserId)
    || typeof v.expectedRevision !== "number" || !Number.isInteger(v.expectedRevision) || v.expectedRevision < 0 || v.expectedRevision >= 2147483647
    || typeof v.sourceCreatedAt !== "string" || !/^\d{1,12}\.\d{6}$/.test(v.sourceCreatedAt)
    || typeof v.generation !== "string" || !/^[a-f0-9]{32}$/.test(v.generation)
    || typeof v.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(v.requestId)
    || typeof v.dueAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.dueAt)
    || !Number.isFinite(Date.parse(v.dueAt)) || new Date(v.dueAt).toISOString() !== v.dueAt
    || typeof v.status !== "string" || !["open", "closed"].includes(v.status)
    || !FOLLOWUP_OUTCOMES.includes(v.outcome as FollowupOutcome)
    || !FOLLOWUP_NEXT_STEPS.includes(v.nextStep as FollowupNextStep)) return null;
  const closed = v.status === "closed";
  if (closed !== ["declined", "resolved"].includes(String(v.outcome)) || closed !== (v.nextStep === "none")) return null;
  if (v.outcome === "rebooking_review" && v.nextStep !== "review") return null;
  if (v.expectedRevision === 0 && (v.status !== "open" || v.outcome !== "pending")) return null;
  // Explicit construction fixes fingerprint order and strips prototypes.
  return { appointmentId: v.appointmentId, expectedPatientId: v.expectedPatientId, expectedActorUserId: v.expectedActorUserId, sourceCreatedAt: v.sourceCreatedAt, generation: v.generation,
    requestId: v.requestId, expectedRevision: v.expectedRevision, assigneeUserId: v.assigneeUserId,
    dueAt: v.dueAt, status: v.status as FollowupCommand["status"],
    outcome: v.outcome as FollowupOutcome, nextStep: v.nextStep as FollowupNextStep };
}
export function followupFingerprintInput(command: FollowupCommand): string {
  // Actor is already the receipt namespace. Excluding the new witness preserves
  // historical fingerprints for identical legacy intents; it never grants access.
  const { requestId: _requestId, expectedActorUserId: _actorWitness, ...intent } = command;
  return JSON.stringify({ version: 1, ...intent });
}
