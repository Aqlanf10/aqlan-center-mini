import { plain, keys, positiveId } from "./ortho-assessment-model";
import { checkAnyAssessmentCommand, type AssessmentCommandV2 } from "./ortho-assessment-command-v2";
import { blankMeasurementEditorV2, editMeasurementPayloadV2, measurementPayloadV2, type MeasurementEditorDraftV2 } from "./ortho-assessment-measurement-editor-v2";
import type { AnyAssessmentRevision } from "./ortho-assessment-persisted-v2";
import { CLINICAL_FIELDS_V2, addClinicalFieldV2 } from "./ortho-assessment-findings-v2";
export interface AssessmentEditorV2 {
  commandId: string; expectedRevisionId: number | null; previousVersion: number; reason: string;
  measurements: MeasurementEditorDraftV2;
}
export function newAssessmentEditorV2(commandId: string, revision: AnyAssessmentRevision | null): AssessmentEditorV2 | null {
  // Schema1 promotion is a separate explicit copy/reconciliation action. Never
  // erase its narrative or invent per-value dates by converting it silently.
  if (revision?.schemaVersion === 1) return null;
  let measurements = revision ? editMeasurementPayloadV2(revision.content.draft) : blankMeasurementEditorV2();
  if (!revision && measurements) for (const [field] of CLINICAL_FIELDS_V2) measurements = addClinicalFieldV2(measurements, field) ?? measurements;
  return measurements ? { commandId, expectedRevisionId: revision?.id ?? null, previousVersion: revision?.version ?? 0, reason: "", measurements } : null;
}
export function readAssessmentEditorV2(text: string): AssessmentEditorV2 | null {
  if (!text || text.length > 2_000_000) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!plain(raw) || !keys(raw, ["commandId", "expectedRevisionId", "previousVersion", "reason", "measurements"])
      || typeof raw.commandId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(raw.commandId)
      || !(raw.expectedRevisionId === null || positiveId(raw.expectedRevisionId)) || !Number.isSafeInteger(raw.previousVersion)
      || typeof raw.previousVersion !== "number" || raw.previousVersion < 0 || ((raw.expectedRevisionId === null) !== (raw.previousVersion === 0))
      || typeof raw.reason !== "string" || raw.reason.length > 500 || !plain(raw.measurements)
      || !keys(raw.measurements, ["payload", "values", "decimal"]) || ![".", "٫", ","].includes(String(raw.measurements.decimal))
      || typeof raw.measurements.decimal !== "string" || !plain(raw.measurements.values)) return null;
    const canonical = editMeasurementPayloadV2(raw.measurements.payload);
    if (!canonical || Object.keys(raw.measurements.values).length !== Object.keys(canonical.values).length) return null;
    for (const [id, baseline] of Object.entries(canonical.values)) {
      const value = raw.measurements.values[id];
      if (!plain(value) || !keys(value, Object.keys(baseline))) return null;
      for (const key of ["numberText", "text", "reason", "date", "dateReason", "methodDescription", "performerAttribution"])
        if (typeof value[key] !== "string" || value[key].length > 4000) return null;
      if (!["not_recorded", "measured", "recorded", "not_measured", "unknown", "not_applicable", "unavailable", "tooth_absent", "not_erupted"].includes(String(value.state))
        || !["", "known", "unknown"].includes(String(value.dateState)) || !["", "direct_examination", "manual_record_measurement", "external_report", "legacy_revision"].includes(String(value.method))
        || !["unknown", "documented"].includes(String(value.performer)) || !Array.isArray(value.sources) || value.sources.length > 12
        || JSON.stringify(value.copiedFrom) !== JSON.stringify(baseline.copiedFrom)) return null;
      for (const s of value.sources) if (!plain(s) || !keys(s, ["kind", "id", "version"]) || !positiveId(s.id)
        || typeof s.kind !== "string" || !["document", "ceph_study", "clinical_visit", "patient_history", "assessment_revision"].includes(s.kind)
        || typeof s.version !== "string" || !s.version.trim() || s.version.length > 200) return null;
      for (const key of ["state", "dateState", "method", "performer"]) if (typeof value[key] !== "string") return null;
    }
    return raw as unknown as AssessmentEditorV2;
  } catch { return null; }
}
export function assessmentEditorCommandV2(draft: AssessmentEditorV2): AssessmentCommandV2 | null {
  const payload = measurementPayloadV2(draft.measurements);
  if (!payload.ok) return null;
  const checked = checkAnyAssessmentCommand({ schemaVersion: 2, commandId: draft.commandId,
    expectedRevisionId: draft.expectedRevisionId, reason: draft.reason, content: payload.payload });
  return checked.ok && checked.value.schemaVersion === 2 ? checked.value : null;
}
