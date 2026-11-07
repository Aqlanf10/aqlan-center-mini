/** Transaction-local persistence only. The canonical store must already hold
 * patient -> current authority -> selected sources -> Ortho/bridge locks.
 * No HTTP route may call this module without that store admission. Export
 * capabilities and media conversion are deliberately absent from study saves. */
import { insertAuditRow, type DbClient } from "./db";
import { assertJourneyCurrent, journeyFail, type JourneyAuthority, type JourneyOwner } from "./ortho-case-journey-authority";
import { canonicalJourneyJSON, journeyContentHash } from "./ortho-case-journey-hash";
import { JOURNEY_HISTORY_LIMITS } from "./ortho-case-journey-history";
import type { Checked, JourneyScope } from "./ortho-case-journey-records";
import { STUDY_LIMITS, type StudyDraftContent, type StudySaveCommand } from "./ortho-case-study";
import { decodeStudyHistory, studyHeadMatches, type StudyHistoryRow, type StudyRevision } from "./ortho-case-study-history";

export interface StudyContentPolicy<T> {
  decode(value: unknown, scope: JourneyScope): Checked<T>;
  authored(content: T): StudyDraftContent;
  /** Current section/source authority, including transitive imaging restrictions.
   * A saved sourceAccess flag by itself must not grant current permission. */
  requireCurrentRead(content: T): Promise<void>;
}
export async function readLockedStudyHistory<T>(client: DbClient, owner: JourneyOwner, policy: StudyContentPolicy<T>) {
  const { rows: [size] } = await client.query<{ rows: string; bytes: string }>(
    `SELECT COUNT(*)::text AS rows,COALESCE(SUM(octet_length(content::text)),0)::text AS bytes
     FROM ortho_case_study_revisions WHERE ortho_case_id=$1`, [owner.orthoCaseId]);
  if (!size || !/^\d+$/.test(size.rows) || !/^\d+$/.test(size.bytes)) journeyFail(500, "invalid_study_history_size");
  if (BigInt(size.rows) > BigInt(JOURNEY_HISTORY_LIMITS.rows) || BigInt(size.bytes) > BigInt(JOURNEY_HISTORY_LIMITS.contentBytes)) journeyFail(409, "study_history_limit");
  const { rows } = await client.query<StudyHistoryRow>(
    `SELECT * FROM ortho_case_study_revisions WHERE ortho_case_id=$1 ORDER BY version`, [owner.orthoCaseId]);
  const decoded = decodeStudyHistory(rows, owner, policy.decode);
  if (!decoded.ok) journeyFail(500, decoded.code);
  return { rows, revisions: decoded.value };
}

/** All existing history is validated before replay or append. source capture is
 * lazy so an acknowledged retry returns its exact earlier revision rather than
 * recapturing newly changed clinical facts. Current permission is still checked. */
export async function appendLockedStudyRevision<T>(client: DbClient, input: {
  owner: JourneyOwner; authority: JourneyAuthority; command: StudySaveCommand;
  policy: StudyContentPolicy<T>; capture: () => Promise<T>;
}): Promise<{ ok: true; replayed: boolean; revision: StudyRevision<T> }> {
  const { owner, authority, command, policy } = input;
  if (!authority.canWrite) journeyFail(403, "clinical_access_denied");
  assertJourneyCurrent(authority);
  const { rows, revisions } = await readLockedStudyHistory(client, owner, policy);
  const head = revisions.at(-1) ?? null;
  if (head) await policy.requireCurrentRead(head.content);
  const fingerprint = journeyContentHash(command);
  const replayIndex = rows.findIndex(row => row.actor_user_id === authority.userId && row.command_id === command.clientRequestId);
  if (replayIndex >= 0) {
    if (rows[replayIndex].request_fingerprint !== fingerprint) journeyFail(409, "request_key_conflict");
    const revision = revisions[replayIndex]; await policy.requireCurrentRead(revision.content);
    assertJourneyCurrent(authority); return { ok: true, replayed: true, revision };
  }
  if (!studyHeadMatches(head, command.expectedHead)) journeyFail(409, "study_head_changed");
  const base = command.baseDocumentedRevision;
  if (base) {
    const original = revisions.find(r => r.id === base.id && r.kind === "documented" && r.contentHash === base.contentHash);
    if (!original) journeyFail(409, "study_documented_base_changed");
    await policy.requireCurrentRead(original.content);
  }
  // Documenting is an explicit immutable copy. Capture is not invoked for this
  // transition and cannot refresh sources or discard submitted edits silently.
  let content: T;
  if (command.kind === "documented") {
    if (!head || head.kind !== "draft" || command.documentedFrom?.id !== head.id
      || command.documentedFrom.contentHash !== head.contentHash) journeyFail(409, "study_documented_source_changed");
    if ((base?.id ?? null) !== head.baseDocumentedId) journeyFail(409, "study_documented_base_changed");
    if (journeyContentHash(command.content) !== journeyContentHash(policy.authored(head.content))) journeyFail(409, "study_documented_content_changed");
    content = head.content;
  } else content = await input.capture();
  const decoded = policy.decode(content, owner);
  if (!decoded.ok || journeyContentHash(decoded.value) !== journeyContentHash(content)) journeyFail(500, "invalid_study_capture");
  content = decoded.value; await policy.requireCurrentRead(content);
  const serialized = canonicalJourneyJSON(content);
  if (Buffer.byteLength(serialized, "utf8") > STUDY_LIMITS.bytes) journeyFail(409, "study_capture_limit");
  const contentHash = journeyContentHash(content);
  // Admission must include the prospective row. Otherwise a successful append
  // could make the next complete-history read exceed its own safety bound.
  const { rows: [capacity] } = await client.query<{ n: string; bytes: string }>(`SELECT COUNT(*)::text AS n,
    (COALESCE(SUM(octet_length(content::text)),0)+octet_length($2::jsonb::text))::text AS bytes
    FROM ortho_case_study_revisions WHERE ortho_case_id=$1`, [owner.orthoCaseId, serialized]);
  if (!capacity || !/^\d+$/.test(capacity.n) || !/^\d+$/.test(capacity.bytes)) journeyFail(500, "invalid_study_history_size");
  if (BigInt(capacity.n) >= BigInt(JOURNEY_HISTORY_LIMITS.rows) || BigInt(capacity.bytes) > BigInt(JOURNEY_HISTORY_LIMITS.contentBytes)) journeyFail(409, "study_history_limit");
  assertJourneyCurrent(authority);
  const { rows: inserted } = await client.query<StudyHistoryRow>(`INSERT INTO ortho_case_study_revisions
    (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,kind,schema_version,version,predecessor_id,
     documented_from_id,base_documented_id,actor_user_id,reason,command_id,request_fingerprint,content_sha256,content)
    VALUES($1,$1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING *`,
  [owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, command.kind, (head?.version ?? 0) + 1, head?.id ?? null,
    command.documentedFrom?.id ?? null, base?.id ?? null, authority.userId, command.reason, command.clientRequestId,
    fingerprint, contentHash, serialized]);
  if (inserted.length !== 1) journeyFail(500, "invalid_study_insert");
  const full = decodeStudyHistory([...rows, inserted[0]], owner, policy.decode);
  if (!full.ok) journeyFail(500, full.code);
  const revision = full.value.at(-1)!;
  await insertAuditRow(client, { action: "ortho.journey_record", entity: "ortho_case_study_revisions", entityId: revision.id,
    entityLabel: `حالة التقويم #${owner.orthoCaseId}`, actor: authority.name, actorRole: authority.session.role,
    details: { patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, version: revision.version,
      kind: revision.kind, contentHash: revision.contentHash } });
  assertJourneyCurrent(authority); return { ok: true, replayed: false, revision };
}
