/** Immutable study metadata/lineage validation. Content validation and hashing are
 * injected only by the server's strict typed capture decoder, never by HTTP input. */
import { journeyHash, journeyId, type Checked, type JourneyScope } from "./ortho-case-journey-records";
import { journeyContentHash } from "./ortho-case-journey-hash";
import type { StudyRevisionRef } from "./ortho-case-study";
export interface StudyRevision<T> extends JourneyScope {
  id: number; recordedPatientId: number; schemaVersion: 1; version: number;
  predecessorId: number | null; kind: "draft" | "documented";
  documentedFromId: number | null; baseDocumentedId: number | null;
  actorId: number; createdAt: string; reason: string; contentHash: string; content: T;
}
export interface StudyHistoryRow extends Record<string, unknown> {
  id: unknown; patient_id: unknown; recorded_patient_id: unknown; ortho_case_id: unknown; clinical_case_id: unknown;
  schema_version: unknown; version: unknown; predecessor_id: unknown; kind: unknown;
  documented_from_id: unknown; base_documented_id: unknown; actor_user_id: unknown; created_at: unknown;
  reason: unknown; command_id: unknown; request_fingerprint: unknown; content_sha256: unknown; content: unknown;
}
const bad = (code: string): Checked<never> => ({ ok: false, code });
const nullableId = (value: unknown): value is number | null => value === null || journeyId(value);
export function decodeStudyHistory<T>(rowsAscending: readonly StudyHistoryRow[], scope: JourneyScope,
  content: (value: unknown, currentScope: JourneyScope) => Checked<T>): Checked<StudyRevision<T>[]> {
  if (rowsAscending.length > 5000) return bad("study_history_limit");
  const revisions: StudyRevision<T>[] = [], byId = new Map<number, StudyRevision<T>>();
  const commands = new Set<string>();
  for (const row of rowsAscending) {
    if (!journeyId(row.id) || byId.has(row.id) || row.patient_id !== scope.patientId || row.ortho_case_id !== scope.orthoCaseId
      || row.clinical_case_id !== scope.clinicalCaseId || !journeyId(row.recorded_patient_id) || row.schema_version !== 1
      || !journeyId(row.version) || !nullableId(row.predecessor_id) || !nullableId(row.documented_from_id) || !nullableId(row.base_documented_id)
      || row.kind !== "draft" && row.kind !== "documented" || !journeyId(row.actor_user_id)
      || !journeyHash(row.content_sha256) || !journeyHash(row.request_fingerprint)
      || typeof row.command_id !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(row.command_id)
      || typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 500) return bad("invalid_study_history_identity");
    const commandKey = `${row.actor_user_id}:${row.command_id}`;
    if (commands.has(commandKey)) return bad("duplicate_study_command"); commands.add(commandKey);
    const previous = revisions[revisions.length - 1];
    if (row.version !== (previous?.version ?? 0) + 1 || row.predecessor_id !== (previous?.id ?? null)) return bad("invalid_study_lineage");
    const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) return bad("invalid_study_recorded_date");
    // Nested capture patient IDs are immutable provenance, not live authority.
    // A canonical patient merge may precede documentation of an old draft;
    // the strict decoder checks stable case/bridge anchors against currentScope.
    const decoded = content(row.content, scope); if (!decoded.ok) return decoded;
    if (journeyContentHash(decoded.value) !== row.content_sha256 || journeyContentHash(row.content) !== row.content_sha256) return bad("invalid_study_content_hash");
    if (row.base_documented_id !== null && byId.get(row.base_documented_id)?.kind !== "documented") return bad("invalid_study_documented_base");
    if (row.kind === "documented") {
      if (!previous || previous.kind !== "draft" || row.documented_from_id !== previous.id || row.content_sha256 !== previous.contentHash
        || row.base_documented_id !== previous.baseDocumentedId
        || journeyContentHash(previous.content) !== row.content_sha256) return bad("documented_study_changed_draft");
    } else if (row.documented_from_id !== null) return bad("draft_has_documentation_source");
    const revision: StudyRevision<T> = { ...scope, id: row.id, recordedPatientId: row.recorded_patient_id, schemaVersion: 1,
      version: row.version, predecessorId: row.predecessor_id, kind: row.kind, documentedFromId: row.documented_from_id,
      baseDocumentedId: row.base_documented_id, actorId: row.actor_user_id, createdAt, reason: row.reason,
      contentHash: row.content_sha256, content: decoded.value };
    byId.set(revision.id, revision); revisions.push(revision);
  }
  return { ok: true, value: revisions };
}
export function studyHeadMatches<T>(head: StudyRevision<T> | null, expected: StudyRevisionRef | null): boolean {
  return head === null ? expected === null : expected !== null && head.id === expected.id && head.contentHash === expected.contentHash;
}
