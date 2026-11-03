import { editMeasurementPayloadV2, type MeasurementEditorDraftV2 } from "./ortho-assessment-measurement-editor-v2";
import { validFdi, type AssessmentObservationV2, type AssessmentSourceV2 } from "./ortho-assessment-v2";
import type { AssessmentDraftV2 } from "./ortho-assessment-measurement-set-v2";

const prefix = "panoramic_v1_";
export function panoramicFindingId(documentId: number, tooth: number | null) {
  if (!Number.isSafeInteger(documentId) || documentId < 1 || documentId > 2147483647 || tooth !== null && !validFdi(tooth)) throw Error("invalid_panoramic_target");
  return `${prefix}${documentId}_${tooth === null ? "case" : `tooth_${tooth}`}`;
}
export function readPanoramicFindingId(id: string): { documentId: number; tooth: number | null } | null {
  const match = /^panoramic_v1_([1-9]\d*)_(case|tooth_(\d{2}))$/.exec(id);
  if (!match) return null;
  const documentId = Number(match[1]), tooth = match[2] === "case" ? null : Number(match[3]);
  try { return panoramicFindingId(documentId, tooth) === id ? { documentId, tooth } : null; } catch { return null; }
}
/** A new empty note does not assert a radiographic finding or copy a date. */
export function addPanoramicFinding(draft: MeasurementEditorDraftV2, source: AssessmentSourceV2, tooth: number | null): MeasurementEditorDraftV2 | null {
  if (source.kind !== "document" || !/^sha256:[a-f0-9]{64}$/.test(source.version)) return null;
  let id: string; try { id = panoramicFindingId(source.id, tooth); } catch { return null; }
  if (draft.values[id] || draft.payload.observations.observations.length >= 256) return null;
  const row: AssessmentObservationV2 = { id, definition: "clinical_finding", definitionVersion: 1, unit: "qualitative",
    label: tooth === null ? "قراءة عامة للبانوراما" : `قراءة البانوراما للسن FDI ${tooth}`,
    target: tooth === null ? { kind: "case" } : { kind: "tooth", tooth }, value: { state: "not_recorded" }, occurredOn: null, provenance: null };
  const next = editMeasurementPayloadV2({ ...draft.payload, observations: { ...draft.payload.observations, observations: [...draft.payload.observations.observations, row] } });
  return next ? { ...next, decimal: draft.decimal, values: { ...draft.values, [id]: { ...next.values[id], sources: [{ ...source }] } } } : null;
}
/** Reserved editor identities bind the tooth and exact source bytes. This is a
 * new-write rule, not a new historical decoder or an interpretation engine. */
export function panoramicFindingReferences(draft: AssessmentDraftV2): { ok: true; references: AssessmentSourceV2[] } | { ok: false; code: string } {
  const references = new Map<number, AssessmentSourceV2>();
  for (const row of draft.observations.observations) {
    if (!row.id.startsWith(prefix)) continue;
    const identity = readPanoramicFindingId(row.id);
    if (!identity || row.definition !== "clinical_finding" || row.definitionVersion !== 1 || row.unit !== "qualitative"
      || (identity.tooth === null ? row.target.kind !== "case" : row.target.kind !== "tooth" || row.target.tooth !== identity.tooth))
      return { ok: false, code: "invalid_panoramic_target" };
    if (row.value.state === "not_recorded") continue;
    const source = row.provenance?.sources.find(s => s.kind === "document" && s.id === identity.documentId);
    if (!source || !/^sha256:[a-f0-9]{64}$/.test(source.version)) return { ok: false, code: "missing_panoramic_source" };
    if (references.has(source.id) && references.get(source.id)!.version !== source.version) return { ok: false, code: "panoramic_source_conflict" };
    references.set(source.id, source);
  }
  return { ok: true, references: [...references.values()] };
}
