/** Newly authored successor contracts. No clinical recommendation/default or
 * approval is inferred from a documentary choice. */
import { readOccurrenceEvidence, type OccurrenceEvidence } from "./ortho-case-occurrence";
export type Checked<T> = { ok: true; value: T } | { ok: false; code: string };
export interface JourneyScope { patientId: number; orthoCaseId: number; clinicalCaseId: number }
export const journeyId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const journeyHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export interface JourneyRevisionReference { id: number; version: number; contentHash: string }
export interface ConsentObservation {
  planId: number; capturedAt: string; consentAt: string | null; consentBy: string | null;
  state: "current" | "not_recorded" | "historical_unverified"; planScopeHash: string; observationHash: string;
}
export interface DecisionContent {
  occurrence: OccurrenceEvidence; status: "proposed" | "selected";
  alternatives: { id: string; label: string; description: string }[];
  selectedAlternativeId: string | null; rationale: string; missingEvidence: string[];
  assessment: JourneyRevisionReference | null; diagnosis: { id: number; version: number } | null;
  strategy: JourneyRevisionReference | null; planId: number | null;
  expectedPlanScopeHash: string | null; expectedConsentHash: string | null;
}
export interface DecisionCommand { schemaVersion: 1; clientRequestId: string; expectedHeadId: number | null; reason: string; content: DecisionContent }
const fail = (code: string): never => { throw new Error(code); };
function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_documentary_object");
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) return fail("invalid_documentary_fields"); return r;
}
function text(raw: unknown, max: number, empty = false): string {
  if (typeof raw !== "string" || raw.length > max || !empty && !raw.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(raw)) return fail("invalid_documentary_text"); return raw;
}
function id(raw: unknown): number { if (!journeyId(raw)) return fail("invalid_documentary_id"); return raw; }
function reference(raw: unknown): JourneyRevisionReference | null {
  if (raw === null) return null;
  const r = record(raw, ["id", "version", "contentHash"]); if (!journeyHash(r.contentHash)) return fail("invalid_documentary_hash");
  return { id: id(r.id), version: id(r.version), contentHash: r.contentHash };
}
export function checkDecisionCommand(raw: unknown): Checked<DecisionCommand> {
  try {
    const r = record(raw, ["schemaVersion", "clientRequestId", "expectedHeadId", "reason", "content"]);
    if (r.schemaVersion !== 1 || typeof r.clientRequestId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(r.clientRequestId)
      || !(r.expectedHeadId === null || journeyId(r.expectedHeadId))) return fail("invalid_decision_command");
    const c = record(r.content, ["occurrence", "status", "alternatives", "selectedAlternativeId", "rationale", "missingEvidence",
      "assessment", "diagnosis", "strategy", "planId", "expectedPlanScopeHash", "expectedConsentHash"]);
    if (c.status !== "proposed" && c.status !== "selected" || !Array.isArray(c.alternatives) || c.alternatives.length < 1 || c.alternatives.length > 20) return fail("invalid_decision_alternatives");
    const alternatives = c.alternatives.map(rawAlternative => {
      const a = record(rawAlternative, ["id", "label", "description"]);
      if (typeof a.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(a.id)) return fail("invalid_alternative_id");
      return { id: a.id, label: text(a.label, 300), description: text(a.description, 4000, true) };
    });
    if (new Set(alternatives.map(a => a.id)).size !== alternatives.length
      || c.status === "proposed" && c.selectedAlternativeId !== null
      || c.status === "selected" && (typeof c.selectedAlternativeId !== "string" || !alternatives.some(a => a.id === c.selectedAlternativeId))) return fail("invalid_selected_alternative");
    if (!Array.isArray(c.missingEvidence) || c.missingEvidence.length > 30) return fail("invalid_missing_evidence");
    const missingEvidence = c.missingEvidence.map(v => text(v, 500));
    if (new Set(missingEvidence).size !== missingEvidence.length) return fail("duplicate_missing_evidence");
    const diagnosisRaw = c.diagnosis === null ? null : record(c.diagnosis, ["id", "version"]);
    const planId = c.planId === null ? null : id(c.planId);
    if (planId === null ? c.expectedPlanScopeHash !== null || c.expectedConsentHash !== null
      : !journeyHash(c.expectedPlanScopeHash) || !journeyHash(c.expectedConsentHash)) return fail("invalid_plan_observation_reference");
    const value: DecisionCommand = { schemaVersion: 1, clientRequestId: r.clientRequestId, expectedHeadId: r.expectedHeadId,
      reason: text(r.reason, 500), content: { occurrence: readOccurrenceEvidence(c.occurrence), status: c.status, alternatives,
        selectedAlternativeId: c.selectedAlternativeId as string | null, rationale: text(c.rationale, 4000), missingEvidence,
        assessment: reference(c.assessment), diagnosis: diagnosisRaw ? { id: id(diagnosisRaw.id), version: id(diagnosisRaw.version) } : null,
        strategy: reference(c.strategy), planId, expectedPlanScopeHash: c.expectedPlanScopeHash as string | null, expectedConsentHash: c.expectedConsentHash as string | null } };
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128 * 1024) return fail("decision_payload_limit");
    return { ok: true, value };
  } catch (error) { return { ok: false, code: error instanceof Error ? error.message : "invalid_decision_command" }; }
}
