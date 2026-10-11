import { permitsOrthoDocumentation, orthoDocumentationContext, type OrthoLifecycleStatus } from "./ortho-assessment-lifecycle";
/** Strict immutable study capture envelope. Current authority is rechecked by
 * the store; embedded patient identity is historical provenance only. */
import { decodeAnyAssessmentRevision } from "./ortho-assessment-persisted-v2";
import { decodeStrategyRevision } from "./ortho-treatment-strategy";
import { decodeDecisionSavedContent } from "./ortho-case-decision-content";
import { decodeRetentionSavedContent } from "./ortho-retention-history-store";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { journeyId, journeyHash, type Checked, type JourneyScope } from "./ortho-case-journey-records";
import { readStudyDraftContent, STUDY_LIMITS, type StudyDraftContent, type StudySourceSelection } from "./ortho-case-study";
import type { StudySourceCapture } from "./ortho-case-study-sources";

export interface StudySavedContent {
  schemaVersion: 1; capturedAt: string; recordedPatientId: number; orthoCaseId: number; clinicalCaseId: number;
  caseStatusAtCapture: OrthoLifecycleStatus;
  authored: StudyDraftContent; sources: StudySourceCapture[];
}
function fail(code = "invalid_study_capture"): never { throw new Error(code); }
function obj(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k))) return fail();
  return value;
}
function text(raw: unknown, max: number, nullable = false): string | null {
  if (raw === null && nullable) return null;
  if (typeof raw !== "string" || raw.length > max) return fail(); return raw;
}
function id(raw: unknown): number { if (!journeyId(raw)) return fail(); return raw; }
function nullableId(raw: unknown): number | null { return raw === null ? null : id(raw); }
function stamp(raw: unknown, nullable = false): string | null {
  if (raw === null && nullable) return null;
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) return fail(); return raw;
}
function same(raw: unknown, checked: unknown) { if (journeyContentHash(raw) !== journeyContentHash(checked)) fail(); }
function envelope(raw: unknown, scope: JourneyScope, selection: StudySourceSelection) {
  const r = obj(raw, ["patientId", "orthoCaseId", "clinicalCaseId", "id", "recordedPatientId", "schemaVersion", "version", "predecessorId",
    "createdBy", "createdAt", "reason", "recordingContext", "caseStatusAtCapture", "contentHash", "content"]);
  if (r.patientId !== scope.patientId || r.orthoCaseId !== scope.orthoCaseId || r.clinicalCaseId !== scope.clinicalCaseId
    || r.id !== selection.id || r.version !== selection.version || r.schemaVersion !== 1 || r.contentHash !== selection.contentHash
    || !journeyHash(r.contentHash) || journeyContentHash(r.content) !== r.contentHash
    || r.recordingContext !== "current" && r.recordingContext !== "retrospective"
    || !permitsOrthoDocumentation(r.caseStatusAtCapture)) fail();
  if (r.recordingContext !== orthoDocumentationContext(r.caseStatusAtCapture)) fail();
  id(r.recordedPatientId); nullableId(r.predecessorId); text(r.createdBy, 200); stamp(r.createdAt); text(r.reason, 500);
  return r;
}
function payload(raw: unknown, scope: JourneyScope, s: StudySourceSelection): { value: unknown; images: boolean; plans: boolean } {
  let value: unknown = raw, images = false, plans = false;
  if (s.kind === "assessment") {
    const result = decodeAnyAssessmentRevision(raw, scope); if (!result.ok) fail(result.code);
    if (result.value.id !== s.id || result.value.version !== s.version || result.value.contentHash !== s.contentHash) fail();
    value = result.value; // Transitive current image authority is checked by the store, not inferred here.
  } else if (s.kind === "strategy") {
    const result = decodeStrategyRevision(raw, scope); if (!result.ok) fail(result.code);
    if (result.value.id !== s.id || result.value.version !== s.version || journeyContentHash(result.value.rows) !== s.contentHash) fail();
    value = result.value; plans = result.value.rows.some(row => row.planItems.length > 0);
  } else if (s.kind === "diagnosis") {
    const r = obj(raw, ["id", "version", "createdAt", "createdBy", "content"]);
    if (r.id !== s.id || r.version !== s.version || !r.content || typeof r.content !== "object" || Array.isArray(r.content)) fail();
    stamp(r.createdAt); text(r.createdBy, 200);
    const entries = Object.entries(r.content as Record<string, unknown>);
    for (const [key, item] of entries) {
      if (!["skeletal", "dental", "crowding", "overjet", "bite", "note"].includes(key)) fail();
      text(item, key === "note" ? 1000 : 200, true);
    }
    if (!entries.some(([, v]) => typeof v === "string" && v.trim()) || journeyContentHash(r.content) !== s.contentHash) fail();
  } else if (s.kind === "decision" || s.kind === "retention_event") {
    const r = envelope(raw, scope, s);
    if (s.kind === "decision") {
      const result = decodeDecisionSavedContent(r.content); if (!result.ok) fail(result.code);
      same(r.content, result.value); images = result.value.sourceAccess.imaging; plans = result.value.sourceAccess.plans;
    } else {
      const result = decodeRetentionSavedContent(r.content); if (!result.ok) fail(result.code);
      same(r.content, result.value); images = result.value.payload.documentIds.length > 0;
    }
  } else if (s.kind === "document") {
    const r = obj(raw, ["id", "title", "mimeType", "sizeBytes", "contentHash", "width", "height"]);
    if (r.id !== s.id || r.contentHash !== s.contentHash) fail();
    text(r.title, 500, true); text(r.mimeType, 100); id(r.sizeBytes); nullableId(r.width); nullableId(r.height); images = true;
  } else if (s.kind === "ceph_study") {
    const r = obj(raw, ["id", "status", "phase", "acquisitionDate", "device", "referenceSetKey", "studyKind", "note",
      "createdAt", "createdBy", "completedAt", "completedBy", "correctsStudyId", "image", "measurements", "diagnosis",
      "interpretation", "historicalCompletionMeaning"]);
    if (r.id !== s.id || journeyContentHash(r) !== s.contentHash || typeof r.status !== "string"
      || !["draft", "completed", "discarded"].includes(r.status)
      || r.historicalCompletionMeaning !== "stored_completion_not_new_clinical_validation") fail();
    text(r.phase, 100); text(r.acquisitionDate, 20, true); text(r.device, 500, true); text(r.referenceSetKey, 200);
    text(r.studyKind, 100); text(r.note, 4000, true); stamp(r.createdAt); text(r.createdBy, 200);
    stamp(r.completedAt, true); text(r.completedBy, 200, true); nullableId(r.correctsStudyId);
    const image = obj(r.image, ["documentId", "contentHash", "state"]);
    id(image.documentId); if (!journeyHash(image.contentHash) || image.state !== "available" && image.state !== "removed") fail();
    const interpretation = obj(r.interpretation, ["state", "reason"]);
    if (interpretation.state !== "unavailable" || interpretation.reason !== "review_and_reference_witness_not_versioned") fail();
    if (!Array.isArray(r.measurements) || r.measurements.length > 256) fail();
    const codes = new Set<string>();
    for (const rawMeasurement of r.measurements) {
      const m = obj(rawMeasurement, ["code", "value", "unit", "provenance"]), code = text(m.code, 100);
      if (!code || codes.has(code) || typeof m.value !== "number" || !Number.isFinite(m.value)
        || m.unit !== null || m.provenance !== "stored_measurement_unit_not_versioned") fail();
      codes.add(code);
    }
    if (r.diagnosis !== null) {
      const dx = obj(r.diagnosis, ["skeletal", "dental", "softTissue", "note", "finalDx", "createdBy", "createdAt", "updatedAt"]);
      for (const key of ["skeletal", "dental", "softTissue", "note"]) text(dx[key], 4000, true);
      text(dx.finalDx, 4000); text(dx.createdBy, 200); stamp(dx.createdAt); stamp(dx.updatedAt);
    }
    images = true;
  } else if (s.kind === "adjustment") {
    const r = obj(raw, ["id", "visitId", "doneOn", "phase", "upperWire", "lowerWire", "done", "note", "signedAt"]);
    if (r.id !== s.id || journeyContentHash(r) !== s.contentHash) fail();
    nullableId(r.visitId); text(r.doneOn, 20); stamp(r.signedAt, true);
    for (const key of ["phase", "upperWire", "lowerWire", "done", "note"]) text(r[key], 4000, true);
  } else if (s.kind === "plan_consent") {
    const r = obj(raw, ["planId", "title", "status", "patientId", "items", "consent", "itemScope", "excludedItemCount", "consentScope"]);
    if (r.planId !== s.id || r.patientId !== scope.patientId || !Array.isArray(r.items) || r.items.length > 1000) fail();
    if (r.itemScope !== "selected_clinical_case_only" || r.consentScope !== "existing_whole_plan_observation"
      || typeof r.excludedItemCount !== "number" || !Number.isSafeInteger(r.excludedItemCount) || r.excludedItemCount < 0 || r.excludedItemCount > 1000) fail();
    text(r.title, 4000); text(r.status, 100);
    const itemIds = new Set<number>();
    for (const rawItem of r.items) {
      const item = obj(rawItem, ["id", "caseId", "serviceName", "toothCode", "surfaces", "quantity", "status"]);
      const itemId = id(item.id); if (itemIds.has(itemId)) fail(); itemIds.add(itemId);
      if (item.caseId !== scope.clinicalCaseId) fail();
      nullableId(item.toothCode); text(item.serviceName, 4000); text(item.surfaces, 100, true); id(item.quantity); text(item.status, 100);
    }
    const c = obj(r.consent, ["planId", "consentAt", "consentBy", "state", "planScopeHash", "observationHash"]);
    if (c.planId !== s.id || c.observationHash !== s.contentHash || !journeyHash(c.planScopeHash)
      || typeof c.state !== "string" || !["current", "not_recorded", "historical_unverified"].includes(c.state)
      || (c.state === "not_recorded") !== (c.consentAt === null)) fail();
    stamp(c.consentAt, true); text(c.consentBy, 200, true);
    const observed = { planId: c.planId, consentAt: c.consentAt, consentBy: c.consentBy, state: c.state, planScopeHash: c.planScopeHash };
    if (journeyContentHash(observed) !== c.observationHash) fail(); plans = true;
  } else fail("unsupported_study_capture_payload");
  same(raw, value); return { value, images, plans };
}
export function decodeStudySavedContent(raw: unknown, current: JourneyScope): Checked<StudySavedContent> {
  try {
    const c = obj(raw, ["schemaVersion", "capturedAt", "recordedPatientId", "orthoCaseId", "clinicalCaseId", "caseStatusAtCapture", "authored", "sources"]);
    if (c.schemaVersion !== 1 || c.orthoCaseId !== current.orthoCaseId || c.clinicalCaseId !== current.clinicalCaseId
      || !permitsOrthoDocumentation(c.caseStatusAtCapture)) fail();
    const scope = { patientId: id(c.recordedPatientId), orthoCaseId: current.orthoCaseId, clinicalCaseId: current.clinicalCaseId };
    const authored = readStudyDraftContent(c.authored);
    if (!Array.isArray(c.sources) || c.sources.length !== authored.sources.length) fail();
    const sources: StudySourceCapture[] = c.sources.map((rawSource, index) => {
      const r = obj(rawSource, ["selection", "state", "unavailableReason", "access", "payload"]), selection = authored.sources[index];
      same(r.selection, selection);
      const access = obj(r.access, ["images", "plans"]);
      if (typeof access.images !== "boolean" || typeof access.plans !== "boolean") fail();
      if (r.state === "unavailable") {
        if (r.payload !== null || typeof r.unavailableReason !== "string"
          || !["source_missing_or_outside_case", "source_schema_unavailable", "document_removed", "ceph_review_projection_unavailable"].includes(r.unavailableReason)
          || r.unavailableReason === "source_schema_unavailable" && selection.kind !== "assessment"
          || r.unavailableReason === "document_removed" && selection.kind !== "document"
          || r.unavailableReason === "ceph_review_projection_unavailable" && selection.kind !== "ceph_study") fail();
        return { selection, state: "unavailable", unavailableReason: r.unavailableReason as StudySourceCapture["unavailableReason"], access: { images: access.images, plans: access.plans }, payload: null };
      }
      if (r.state !== "available" || r.unavailableReason !== null) fail();
      const decoded = payload(r.payload, scope, selection);
      if (decoded.images && !access.images || decoded.plans && !access.plans) fail();
      return { selection, state: "available", unavailableReason: null, access: { images: access.images, plans: access.plans }, payload: decoded.value };
    });
    const value: StudySavedContent = { schemaVersion: 1, capturedAt: stamp(c.capturedAt)!, recordedPatientId: scope.patientId,
      orthoCaseId: scope.orthoCaseId, clinicalCaseId: scope.clinicalCaseId,
      caseStatusAtCapture: c.caseStatusAtCapture as StudySavedContent["caseStatusAtCapture"], authored, sources };
    same(raw, value);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > STUDY_LIMITS.bytes) fail("study_capture_limit");
    return { ok: true, value };
  } catch (error) { return { ok: false, code: error instanceof Error ? error.message : "invalid_study_capture" }; }
}
