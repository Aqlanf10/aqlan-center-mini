/** Deliberate scope only: never authorizes extra services, a new invoice, cash,
 * retrospective waivers or changes to a prior signed adjustment. */
export type RoutineFollowupDecision = "included" | "excluded";
export interface FollowupSourceIdentity {
  patientId: number; orthoCaseId: number; clinicalCaseId: number;
  planId: number; planItemId: number; invoiceId: number;
}
export interface FollowupSourceChoice extends FollowupSourceIdentity {
  fingerprint: string; invoiceNumber: string; serviceName: string;
}
export interface FollowupCoverageCommand {
  schemaVersion: 1; commandId: string; expectedRevisionId: string | null;
  source: FollowupSourceIdentity; expectedSourceFingerprint: string;
  scope: "routine_adjustments"; decision: RoutineFollowupDecision; reason: string;
}
export interface FollowupCoverageRevision {
  id: string; version: number; supersedesRevisionId: string | null;
  source: FollowupSourceIdentity; sourceFingerprint: string; decision: RoutineFollowupDecision;
  reason: string; createdAt: string; createdBy: string; commandId: string;
}
export interface FollowupCoverageRead {
  patientId: number; orthoCaseId: number; enabled: boolean; canEdit: boolean;
  current: FollowupCoverageRevision | null; applicable: boolean; sources: FollowupSourceChoice[];
}
const positive = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
export function parseFollowupCoverageCommand(raw: unknown): FollowupCoverageCommand | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>, source = c.source as Record<string, unknown> | null;
  const keys = ["schemaVersion","commandId","expectedRevisionId","source","expectedSourceFingerprint","scope","decision","reason"];
  const ids = ["patientId","orthoCaseId","clinicalCaseId","planId","planItemId","invoiceId"];
  if (Object.keys(c).some(k => !keys.includes(k)) || c.schemaVersion !== 1
    || typeof c.commandId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(c.commandId)
    || !(c.expectedRevisionId === null || typeof c.expectedRevisionId === "string" && /^[1-9]\d{0,18}$/.test(c.expectedRevisionId))
    || !source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).length !== ids.length || ids.some(k => !positive(source[k]))
    || typeof c.expectedSourceFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(c.expectedSourceFingerprint)
    || c.scope !== "routine_adjustments" || c.decision !== "included" && c.decision !== "excluded"
    || typeof c.reason !== "string" || c.reason.trim().length < 3 || c.reason.trim().length > 600) return null;
  return { schemaVersion:1,commandId:c.commandId.toLowerCase(),expectedRevisionId:c.expectedRevisionId,
    source:Object.fromEntries(ids.map(k=>[k,source[k]])) as unknown as FollowupSourceIdentity,
    expectedSourceFingerprint:c.expectedSourceFingerprint,scope:c.scope,decision:c.decision,reason:c.reason.trim() };
}
