import { permitsOrthoDocumentation, orthoDocumentationContext, type OrthoLifecycleStatus } from "./ortho-assessment-lifecycle";
import { canonicalJourneyJSON, journeyContentHash } from "./ortho-case-journey-hash";
export { journeyContentHash, canonicalJourneyJSON } from "./ortho-case-journey-hash";
import { insertAuditRow, type DbClient } from "./db";
import { journeyHash, journeyId, type Checked, type JourneyScope } from "./ortho-case-journey-records";
import type { RetentionEvent, RetentionEventArch } from "./ortho-retention-events";
import { assertJourneyCurrent, journeyFail, type JourneyAuthority, type JourneyOwner } from "./ortho-case-journey-authority";
export type JourneyTable = "ortho_decision_revisions" | "ortho_retention_entries";
const TABLES: readonly JourneyTable[] = ["ortho_decision_revisions", "ortho_retention_entries"];
export interface JourneyRevision<T> extends JourneyScope {
  id: number; recordedPatientId: number; schemaVersion: 1; version: number; predecessorId: number | null;
  createdBy: string; createdAt: string; reason: string; recordingContext: "current" | "retrospective";
  caseStatusAtCapture: OrthoLifecycleStatus; contentHash: string; content: T;
}
export interface JourneyRow extends Record<string, unknown> {
  id: unknown; patient_id: unknown; recorded_patient_id: unknown; ortho_case_id: unknown; clinical_case_id: unknown;
  schema_version: unknown; version: unknown; predecessor_id: unknown; actor_user_id: unknown;
  created_by: unknown; created_at: unknown; reason: unknown; recording_context: unknown; case_status_at_capture: unknown;
  command_id: unknown; request_fingerprint: unknown; content_sha256: unknown; content: unknown;
}
function tableName(table: JourneyTable): JourneyTable { if (!TABLES.includes(table)) journeyFail(500, "invalid_relation"); return table; }
function savedText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) journeyFail(500, "invalid_saved_text"); return value;
}
export function decodeJourneyRow<T>(row: JourneyRow, scope: JourneyScope, readContent: (value: unknown) => Checked<T>): JourneyRevision<T> {
  if (!journeyId(row.id) || !journeyId(row.recorded_patient_id) || row.patient_id !== scope.patientId || row.ortho_case_id !== scope.orthoCaseId || row.clinical_case_id !== scope.clinicalCaseId
    || row.schema_version !== 1 || !journeyId(row.version) || !(row.predecessor_id === null || journeyId(row.predecessor_id))
    || !journeyId(row.actor_user_id) || typeof row.command_id !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(row.command_id)
    || !journeyHash(row.request_fingerprint) || !journeyHash(row.content_sha256)) journeyFail(500, "invalid_saved_identity");
  if (row.recording_context !== "current" && row.recording_context !== "retrospective") journeyFail(500, "invalid_saved_context");
  if (!permitsOrthoDocumentation(row.case_status_at_capture)) journeyFail(500, "invalid_saved_status");
  if (row.recording_context !== orthoDocumentationContext(row.case_status_at_capture)) journeyFail(500, "invalid_saved_context");
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) journeyFail(500, "invalid_saved_date");
  const parsed = readContent(row.content); if (!parsed.ok) journeyFail(500, parsed.code);
  if (journeyContentHash(parsed.value) !== row.content_sha256 || journeyContentHash(row.content) !== row.content_sha256) journeyFail(500, "invalid_saved_hash");
  return { ...scope, id: row.id, recordedPatientId: row.recorded_patient_id, schemaVersion: 1, version: row.version, predecessorId: row.predecessor_id,
    createdBy: savedText(row.created_by, 200), createdAt, reason: savedText(row.reason, 500), recordingContext: row.recording_context,
    caseStatusAtCapture: row.case_status_at_capture, contentHash: row.content_sha256, content: parsed.value };
}
export const JOURNEY_HISTORY_LIMITS = Object.freeze({ rows: 5000, contentBytes: 8 * 1024 * 1024 });
export async function journeyHistory<T>(client: DbClient, table: JourneyTable, scope: JourneyScope, readContent: (value: unknown) => Checked<T>,
  limits: Readonly<{ rows: number; contentBytes: number }> = JOURNEY_HISTORY_LIMITS) {
  if (!Number.isSafeInteger(limits.rows) || limits.rows <= 0 || limits.rows > JOURNEY_HISTORY_LIMITS.rows
    || !Number.isSafeInteger(limits.contentBytes) || limits.contentBytes <= 0 || limits.contentBytes > JOURNEY_HISTORY_LIMITS.contentBytes) journeyFail(500, "invalid_history_limits");
  // Parent/case locks keep the append set stable. Refuse oversized whole history
  // before loading JSON; never silently truncate a lineage or publish partial truth.
  const { rows: sizes } = await client.query<{ row_count: string; content_bytes: string }>(
    `SELECT COUNT(*)::text AS row_count,COALESCE(SUM(octet_length(content::text)),0)::text AS content_bytes FROM ${tableName(table)} WHERE ortho_case_id=$1`, [scope.orthoCaseId]);
  const size = sizes[0];
  if (!size || !/^\d+$/.test(size.row_count) || !/^\d+$/.test(size.content_bytes)) journeyFail(500, "invalid_history_size");
  if (BigInt(size.row_count) > BigInt(limits.rows) || BigInt(size.content_bytes) > BigInt(limits.contentBytes)) journeyFail(409, "history_limit_exceeded");
  const { rows } = await client.query<JourneyRow>(`SELECT * FROM ${tableName(table)} WHERE ortho_case_id=$1 ORDER BY version DESC`, [scope.orthoCaseId]);
  const revisions = rows.map(row => decodeJourneyRow(row, scope, readContent));
  if (table === "ortho_retention_entries") {
    for (const [index, row] of rows.entries()) {
      if (!["active","retention","completed","discontinued"].includes(revisions[index].caseStatusAtCapture)) journeyFail(500, "invalid_retention_capture_status");
      const content = revisions[index].content as { arch?: unknown; supersedesEntryId?: unknown; payload?: RetentionEvent } | null;
      const device = content?.payload && "device" in content.payload ? content.payload.device : null;
      const replaces = content?.payload?.kind === "device_replacement" ? content.payload.replaces : null;
      if (!content || row.arch !== content.arch || row.entry_kind !== content.payload?.kind
        || row.supersedes_entry_id !== content.supersedesEntryId
        || row.device_entry_id !== (device?.deviceId ?? null)
        || row.replaces_device_id !== (replaces?.deviceId ?? null)
        || row.expected_device_revision_id !== (device?.expectedDeviceRevisionId ?? replaces?.expectedDeviceRevisionId ?? null)) journeyFail(500, "invalid_retention_columns");
    }
  }
  const seen = new Set<number>();
  for (let index = 0; index < revisions.length; index++) {
    const revision = revisions[index], previous = revisions[index + 1];
    if (seen.has(revision.id) || revision.version !== (previous?.version ?? 0) + 1 || revision.predecessorId !== (previous?.id ?? null)) journeyFail(500, "invalid_saved_lineage");
    seen.add(revision.id);
  }
  return { rows, revisions };
}
export function replayJourney<T>(rows: JourneyRow[], revisions: JourneyRevision<T>[], authority: JourneyAuthority, commandId: string, fingerprint: string): JourneyRevision<T> | null {
  const index = rows.findIndex(row => row.actor_user_id === authority.userId && row.command_id === commandId);
  if (index < 0) return null;
  if (rows[index].request_fingerprint !== fingerprint) journeyFail(409, "request_key_conflict");
  assertJourneyCurrent(authority); return revisions[index];
}
export async function insertJourneyRevision<T>(client: DbClient, input: {
  table: JourneyTable; owner: JourneyOwner; authority: JourneyAuthority; head: JourneyRevision<T> | null;
  expectedHeadId: number | null; commandId: string; fingerprint: string; reason: string; content: T;
  retention?: { arch: RetentionEventArch; kind: RetentionEvent["kind"]; supersedesEntryId: number | null; deviceEntryId: number | null; replacesDeviceId: number | null; expectedDeviceRevisionId: number | null };
  decode: (value: unknown) => Checked<T>;
}) {
  if (input.expectedHeadId !== (input.head?.id ?? null)) journeyFail(409, "head_changed");
  const { owner, authority, retention } = input;
  if ((input.table === "ortho_retention_entries") !== Boolean(retention)) journeyFail(500, "invalid_retention_columns");
  // Retention is treatment documentation, including historical closed treatment.
  // Broader study/decision admission must not admit a physical device write.
  if (input.table === "ortho_retention_entries" && !["active","retention","completed","discontinued"].includes(owner.status)) journeyFail(409, "retention_case_not_treatment");
  const serialized = canonicalJourneyJSON(input.content);
  const { rows: [capacity] } = await client.query<{ n: string; bytes: string }>(`SELECT COUNT(*)::text AS n,
    (COALESCE(SUM(octet_length(content::text)),0)+octet_length($2::jsonb::text))::text AS bytes
    FROM ${tableName(input.table)} WHERE ortho_case_id=$1`, [owner.orthoCaseId, serialized]);
  if (!capacity || !/^\d+$/.test(capacity.n) || !/^\d+$/.test(capacity.bytes)) journeyFail(500, "invalid_history_size");
  if (BigInt(capacity.n) >= BigInt(JOURNEY_HISTORY_LIMITS.rows) || BigInt(capacity.bytes) > BigInt(JOURNEY_HISTORY_LIMITS.contentBytes)) journeyFail(409, "history_limit_exceeded");
  const values: unknown[] = [owner.patientId, owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, (input.head?.version ?? 0) + 1, input.head?.id ?? null,
    authority.userId, authority.name, input.reason, owner.recordingContext, owner.status, input.commandId, input.fingerprint, journeyContentHash(input.content), serialized];
  let extraColumns = "", extraValues = "";
  if (retention) {
    extraColumns = ",arch,entry_kind,supersedes_entry_id,device_entry_id,replaces_device_id,expected_device_revision_id"; extraValues = ",$16,$17,$18,$19,$20,$21";
    values.push(retention.arch, retention.kind, retention.supersedesEntryId, retention.deviceEntryId, retention.replacesDeviceId, retention.expectedDeviceRevisionId);
  }
  assertJourneyCurrent(authority);
  const { rows } = await client.query<JourneyRow>(`INSERT INTO ${tableName(input.table)}
    (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,predecessor_id,actor_user_id,created_by,reason,recording_context,case_status_at_capture,command_id,request_fingerprint,content_sha256,content${extraColumns})
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb${extraValues}) RETURNING *`, values);
  const revision = decodeJourneyRow(rows[0], owner, input.decode);
  // Register these exact new action names in the central audit inventory at composition.
  await insertAuditRow(client, { action: "ortho.journey_record", entity: input.table, entityId: revision.id,
    entityLabel: `حالة التقويم #${owner.orthoCaseId}`, actor: authority.name, actorRole: authority.session.role,
    details: { patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, version: revision.version, contentHash: revision.contentHash } });
  assertJourneyCurrent(authority); return revision;
}
