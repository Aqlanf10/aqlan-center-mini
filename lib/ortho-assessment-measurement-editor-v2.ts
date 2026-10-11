import { checkAssessmentDraftV2, deriveDraftAnalysisV2, parseClinicalNumberV2, type AssessmentDraftV2, type DraftAnalysisSelectionV2 } from "./ortho-assessment-measurement-set-v2";
import { checkObservationV2, validFdi, type AssessmentObservationV2, type ObservationProvenance, type ObservationValue } from "./ortho-assessment-v2";

export const UPPER_MEASUREMENT_TEETH = [18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28] as const;
export const LOWER_MEASUREMENT_TEETH = [48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38] as const;
export interface MeasurementValueDraftV2 {
  state: ObservationValue["state"]; numberText: string; text: string; reason: string;
  dateState: "" | "known" | "unknown"; date: string; dateReason: string;
  method: "" | ObservationProvenance["method"]["kind"]; methodDescription: string;
  performer: "unknown" | "documented"; performerAttribution: string;
  sources: ObservationProvenance["sources"]; copiedFrom: ObservationProvenance["copiedFrom"];
}
export interface MeasurementEditorDraftV2 {
  payload: AssessmentDraftV2; values: Record<string, MeasurementValueDraftV2>; decimal: "." | "٫" | ",";
}
function editableValue(row: AssessmentObservationV2): MeasurementValueDraftV2 {
  return { state: row.value.state, numberText: row.value.state === "measured" ? String(row.value.value) : "",
    text: row.value.state === "recorded" ? row.value.text : "", reason: "reason" in row.value ? row.value.reason : "",
    dateState: row.occurredOn?.state ?? "", date: row.occurredOn?.state === "known" ? row.occurredOn.date : "",
    dateReason: row.occurredOn?.state === "unknown" ? row.occurredOn.reason : "", method: row.provenance?.method.kind ?? "",
    methodDescription: row.provenance?.method.description ?? "", performer: row.provenance?.performer.state ?? "unknown",
    performerAttribution: row.provenance?.performer.state === "documented" ? row.provenance.performer.attribution : "",
    sources: structuredClone(row.provenance?.sources ?? []), copiedFrom: structuredClone(row.provenance?.copiedFrom ?? null) };
}
export function editMeasurementPayloadV2(raw: unknown): MeasurementEditorDraftV2 | null {
  const parsed = checkAssessmentDraftV2(raw);
  return parsed.ok ? { payload: parsed.value, decimal: ".", values: Object.fromEntries(parsed.value.observations.observations.map(row => [row.id, editableValue(row)])) } : null;
}
function untouched(id: string, definition: AssessmentObservationV2["definition"], label: string, target: AssessmentObservationV2["target"]): AssessmentObservationV2 {
  return { id, definition, definitionVersion: 1, label, unit: definition === "dentition" ? "qualitative" : "mm", target,
    value: { state: "not_recorded" }, occurredOn: null, provenance: null };
}
export function blankMeasurementEditorV2(): MeasurementEditorDraftV2 {
  const observations = [...UPPER_MEASUREMENT_TEETH, ...LOWER_MEASUREMENT_TEETH].map(tooth => untouched(`width_${tooth}`, "mesiodistal_width", `FDI ${tooth}`, { kind: "tooth", tooth }));
  observations.push(untouched("available_upper", "arch_available_space", "المساحة المتاحة العلوية", { kind: "arch", arch: "upper" }),
    untouched("available_lower", "arch_available_space", "المساحة المتاحة السفلية", { kind: "arch", arch: "lower" }),
    untouched("dentition", "dentition", "نوع الأسنان", { kind: "case" }));
  const parsed = editMeasurementPayloadV2({ schemaVersion: 2, observations: { schemaVersion: 2, dentitionObservationId: "dentition", observations },
    measurementSets: [{ id: "current", toothWidthObservationIds: observations.filter(o => o.definition === "mesiodistal_width").map(o => o.id), upperAvailableObservationId: "available_upper", lowerAvailableObservationId: "available_lower" }], analyses: [] });
  if (!parsed) throw new Error("Invalid empty measurement contract");
  return parsed;
}
/** Private readiness projection: invalid raw values become explicitly unrecorded ONLY
 * here. Saving always rejects its errors and can never persist this substitution. */
function project(draft: MeasurementEditorDraftV2) {
  const errors: { observationId: string; code: string }[] = [];
  const observations = draft.payload.observations.observations.map(row => {
    const empty = { ...row, value: { state: "not_recorded" as const }, occurredOn: null, provenance: null };
    const raw = draft.values[row.id];
    if (!raw) { errors.push({ observationId: row.id, code: "missing_editor_value" }); return empty; }
    let value: unknown;
    if (raw.state === "measured") {
      const number = parseClinicalNumberV2(raw.numberText, draft.decimal);
      if (number.state !== "valid") { errors.push({ observationId: row.id, code: `number_${number.state}` }); return empty; }
      value = { state: "measured", value: number.value };
    } else if (raw.state === "recorded") value = { state: "recorded", text: raw.text };
    else if (raw.state === "not_recorded") value = { state: "not_recorded" };
    else value = { state: raw.state, reason: raw.reason };
    const checked = checkObservationV2({ ...row, value,
      occurredOn: raw.state === "not_recorded" ? null : raw.dateState === "known" ? { state: "known", date: raw.date }
        : raw.dateState === "unknown" ? { state: "unknown", reason: raw.dateReason } : null,
      provenance: raw.state === "not_recorded" ? null : { performer: raw.performer === "unknown" ? { state: "unknown" } : { state: "documented", attribution: raw.performerAttribution },
        method: { version: 1, kind: raw.method, description: raw.methodDescription }, sources: raw.sources, copiedFrom: raw.copiedFrom } });
    if (!checked.ok) { errors.push({ observationId: row.id, code: checked.code }); return empty; }
    return checked.value;
  });
  const checked = checkAssessmentDraftV2({ ...draft.payload, observations: { ...draft.payload.observations, observations } });
  return checked.ok ? { ok: true as const, payload: checked.value, errors } : { ok: false as const, errors: [...errors, { observationId: "", code: checked.code }] };
}
export function measurementPayloadV2(draft: MeasurementEditorDraftV2) {
  const result = project(draft);
  return !result.ok || result.errors.length ? { ok: false as const, errors: result.errors } : { ok: true as const, payload: result.payload };
}
export function measurementReadinessV2(draft: MeasurementEditorDraftV2) {
  const result = project(draft);
  if (!result.ok) return { state: "editing" as const, errors: result.errors, analyses: [] };
  return { state: result.errors.length ? "editing" as const : "validated_draft" as const, errors: result.errors,
    analyses: result.payload.analyses.map(selection => ({ selection, readiness: deriveDraftAnalysisV2(result.payload,
      result.payload.measurementSets.find(set => set.id === selection.measurementSetId), selection) })) };
}
export function changeMeasurementDecimalV2(draft: MeasurementEditorDraftV2, decimal: MeasurementEditorDraftV2["decimal"]): MeasurementEditorDraftV2 {
  return { ...draft, decimal, values: Object.fromEntries(Object.entries(draft.values).map(([id, raw]) => [id, {
    ...raw, numberText: parseClinicalNumberV2(raw.numberText, draft.decimal).state === "valid" ? raw.numberText.replace(draft.decimal, decimal) : raw.numberText,
  }])) };
}
export function toggleMeasurementAnalysisV2(draft: MeasurementEditorDraftV2, selection: DraftAnalysisSelectionV2): MeasurementEditorDraftV2 {
  return { ...draft, payload: { ...draft.payload, analyses: draft.payload.analyses.some(a => a.id === selection.id)
    ? draft.payload.analyses.filter(a => a.id !== selection.id) : [...draft.payload.analyses, selection] } };
}
export function applyMeasurementSessionV2(draft: MeasurementEditorDraftV2, sourceId: string, targets: readonly string[], replaceExisting = false) {
  const projected = project(draft), source = draft.values[sourceId];
  if (!projected.ok || !source || source.state === "not_recorded" || source.copiedFrom || projected.errors.some(e => e.observationId === sourceId))
    return { ok: false as const, code: "invalid_session_source" };
  if (!targets.length || new Set(targets).size !== targets.length) return { ok: false as const, code: "invalid_targets" };
  for (const id of targets) {
    const target = draft.values[id];
    if (!target || target.state === "not_recorded" || target.copiedFrom) return { ok: false as const, code: "historical_or_untouched_target" };
    if (!replaceExisting && (target.dateState !== "" || target.method !== "" || target.sources.length || target.performer === "documented"))
      return { ok: false as const, code: "confirmation_required" };
  }
  const values = { ...draft.values };
  for (const id of targets) values[id] = { ...values[id], dateState: source.dateState, date: source.date, dateReason: source.dateReason,
    method: source.method, methodDescription: source.methodDescription, performer: source.performer, performerAttribution: source.performerAttribution,
    sources: structuredClone(source.sources), copiedFrom: null };
  return { ok: true as const, draft: { ...draft, values } };
}
export type MissingEditorInputV2 = { kind: "tooth"; tooth: number } | { kind: "available"; arch: "upper" | "lower" } | { kind: "dentition" };
export function matchesMeasurementInputV2(row: AssessmentObservationV2, target: MissingEditorInputV2): boolean {
  return target.kind === "tooth" ? row.definition === "mesiodistal_width" && row.target.kind === "tooth" && row.target.tooth === target.tooth
    : target.kind === "available" ? row.definition === "arch_available_space" && row.target.kind === "arch" && row.target.arch === target.arch
      : row.definition === "dentition" && row.target.kind === "case";
}
export function linkMeasurementInputV2(draft: MeasurementEditorDraftV2, setId: string, target: MissingEditorInputV2, existingId?: string): MeasurementEditorDraftV2 | null {
  const set = draft.payload.measurementSets.find(s => s.id === setId);
  if (!set || target.kind === "tooth" && !validFdi(target.tooth)) return null;
  let row = existingId === undefined ? undefined : draft.payload.observations.observations.find(o => o.id === existingId);
  if (existingId !== undefined && (!row || !matchesMeasurementInputV2(row, target))) return null;
  let observations = draft.payload.observations.observations, values = draft.values;
  if (!row) {
    let suffix = 1; while (observations.some(o => o.id === `measurement_${suffix}`)) suffix++;
    row = target.kind === "tooth" ? untouched(`measurement_${suffix}`, "mesiodistal_width", `FDI ${target.tooth}`, { kind: "tooth", tooth: target.tooth })
      : target.kind === "available" ? untouched(`measurement_${suffix}`, "arch_available_space", `المساحة ${target.arch}`, { kind: "arch", arch: target.arch })
        : untouched(`measurement_${suffix}`, "dentition", "نوع الأسنان", { kind: "case" });
    observations = [...observations, row]; values = { ...values, [row.id]: editableValue(row) };
  }
  const linked = row;
  const next = { ...draft, values, payload: { ...draft.payload, observations: { ...draft.payload.observations, observations,
    dentitionObservationId: target.kind === "dentition" ? linked.id : draft.payload.observations.dentitionObservationId },
    measurementSets: draft.payload.measurementSets.map(s => s.id !== setId ? s : target.kind === "tooth" ? { ...s,
      toothWidthObservationIds: [...s.toothWidthObservationIds.filter(id => !observations.some(o => o.id === id && matchesMeasurementInputV2(o, target))), linked.id] }
      : target.kind === "available" ? { ...s, [target.arch === "upper" ? "upperAvailableObservationId" : "lowerAvailableObservationId"]: linked.id } : s) } };
  return checkAssessmentDraftV2(next.payload).ok ? next : null;
}
export function addMeasurementSetV2(draft: MeasurementEditorDraftV2): MeasurementEditorDraftV2 | null {
  if (draft.payload.measurementSets.length >= 12) return null;
  let number = 1; while (draft.payload.measurementSets.some(s => s.id === `set_${number}`)) number++;
  return { ...draft, payload: { ...draft.payload, measurementSets: [...draft.payload.measurementSets,
    { id: `set_${number}`, toothWidthObservationIds: [], upperAvailableObservationId: null, lowerAvailableObservationId: null }] } };
}
