import { journeyHash, journeyId, type JourneyScope } from "./ortho-case-journey-records";
import type { StudySourceKind, StudySourceSelection } from "./ortho-case-study";
export interface StudyInventoryChoice {
  id: number; version: number | null; kind: StudySourceKind; state: "available" | "unavailable";
  unavailableReason: string | null; selection: StudySourceSelection | null;
}
export interface StudyInventoryRead extends JourneyScope {
  ok: true; kind: StudySourceKind; state: "available" | "restricted"; choices: StudyInventoryChoice[]; nextAfterId: number | null;
}
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_study_inventory");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error("invalid_study_inventory");
  return value;
}
export function readStudyInventoryResponse(raw: unknown, scope: JourneyScope, kind: StudySourceKind): StudyInventoryRead {
  const value = object(raw, ["ok", "patientId", "orthoCaseId", "clinicalCaseId", "kind", "state", "choices", "nextAfterId"]);
  if (value.ok !== true || value.patientId !== scope.patientId || value.orthoCaseId !== scope.orthoCaseId || value.clinicalCaseId !== scope.clinicalCaseId
    || value.kind !== kind || value.state !== "available" && value.state !== "restricted" || !Array.isArray(value.choices) || value.choices.length > 25
    || value.nextAfterId !== null && !journeyId(value.nextAfterId)) throw new Error("invalid_study_inventory_scope");
  const versioned = ["assessment", "diagnosis", "strategy", "decision", "retention_event"].includes(kind);
  let previous = 0;
  const choices = value.choices.map(rawChoice => {
    const row = object(rawChoice, ["id", "version", "kind", "state", "unavailableReason", "selection"]);
    if (!journeyId(row.id) || row.id <= previous || row.kind !== kind || (versioned ? !journeyId(row.version) : row.version !== null)
      || row.state !== "available" && row.state !== "unavailable") throw new Error("invalid_study_inventory_choice");
    previous = row.id; let selection: StudySourceSelection | null = null;
    if (row.state === "available") {
      const selected = object(row.selection, ["key", "kind", "id", "version", "contentHash"]);
      if (row.unavailableReason !== null || selected.key !== `${kind}_${row.id}` || selected.id !== row.id || selected.kind !== kind
        || selected.version !== row.version || !journeyHash(selected.contentHash)) throw new Error("invalid_study_inventory_selection");
      selection = { key: selected.key as string, kind, id: row.id, version: row.version as number | null, contentHash: selected.contentHash };
    } else if (row.selection !== null || typeof row.unavailableReason !== "string"
      || !["source_missing_or_outside_case", "source_schema_unavailable", "document_removed", "ceph_review_projection_unavailable"].includes(row.unavailableReason)) throw new Error("invalid_study_inventory_missing");
    return { id: row.id, version: row.version as number | null, kind, state: row.state,
      unavailableReason: row.unavailableReason as string | null, selection } as StudyInventoryChoice;
  });
  if (value.state === "restricted" && (choices.length || value.nextAfterId !== null)
    || value.nextAfterId !== null && (choices.length !== 25 || value.nextAfterId !== choices.at(-1)?.id)) throw new Error("invalid_study_inventory_cursor");
  return { ok: true, ...scope, kind, state: value.state, choices, nextAfterId: value.nextAfterId as number | null };
}
