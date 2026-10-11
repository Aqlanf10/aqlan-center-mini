import { createHash } from "node:crypto";
import type { SessionPayload } from "./auth";
import { ensureSchema, findUserByUsername, getPool, insertAuditRow, type DbClient } from "./db";
import { canAccessPatient } from "./patient-access";
import { requireSession } from "./session";
import {
  bindStrategyRows, checkStrategyCommand, decodeStrategyRevision, projectStrategyRevision,
  type StrategyCanonicalContext, type StrategyCommand, type StrategyPlanItemReference,
  type StrategyProblemReference, type StrategyProjection, type StrategyRecordingContext, type StrategyRevision, type StrategyScope,
} from "./ortho-treatment-strategy";

/** This store only appends clinical documentation. Existing case, problem, plan,
 * treatment, financial and lifecycle writers retain exclusive ownership. */
const MAX_STORED_DOCUMENT_BYTES = 1024 * 1024;
type RecordingContext = StrategyRecordingContext;
export interface OrthoStrategyFailure { ok: false; status: number; code: string; message: string }
export interface OrthoStrategyHistoryEntry {
  revisionId: number; version: number; supersedesRevisionId: number | null;
  recordedPatientId: number;
  recordingContext: RecordingContext; createdAt: string; createdBy: string; reason: string;
}
interface ReadCommon {
  ok: true; patientId: number; orthoCaseId: number;
  /** Current case state at this read, distinct from each saved revision's context. */
  recordingContext: RecordingContext;
  planVisible: boolean; clinicalWritable: boolean; planLinksWritable: boolean;
  /** Current authority for selected content AND the current head; no hidden-link deletion. */
  canRevise: boolean;
  history: OrthoStrategyHistoryEntry[];
  revision: StrategyProjection | null;
  choices: { problems: StrategyProblemReference[]; planItems: StrategyPlanItemReference[] };
}
export type OrthoStrategyReadResult = OrthoStrategyFailure | (ReadCommon & (
  { state: "ready"; clinicalCaseId: number } | { state: "bridge_missing"; clinicalCaseId: null }
));
export type OrthoStrategyWriteResult = OrthoStrategyFailure
  | { ok: true; revision: StrategyProjection; replayed: boolean };
interface OwnerInput { session: SessionPayload; patientId: number; orthoCaseId: number }
interface Actor { session: SessionPayload; id: number; name: string }
interface Authority {
  actor: Actor; planVisible: boolean; clinicalWritable: boolean; planLinksWritable: boolean;
}
interface LockedOwner {
  patientId: number; orthoCaseId: number; clinicalCaseId: number | null; recordingContext: RecordingContext;
}
interface StoredRow {
  id: unknown; patient_id: unknown; recorded_patient_id: unknown; ortho_case_id: unknown; clinical_case_id: unknown;
  schema_version: unknown; version: unknown; supersedes_revision_id: unknown;
  created_at: unknown; created_by: unknown; reason: unknown; recording_context: unknown; rows: unknown;
  actor_user_id: unknown; command_id: unknown; request_fingerprint: unknown;
}
const COLUMNS = `id, patient_id, recorded_patient_id, ortho_case_id, clinical_case_id, schema_version, version,
  supersedes_revision_id, created_at, created_by, reason, recording_context, rows,
  actor_user_id, command_id, request_fingerprint`;
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const sortedIds = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

class StoreFault extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new StoreFault(status, code, message); }
function checked<T>(value: { ok: true; value: T } | { ok: false; code: string; message: string }, status = 409): T {
  if (!value.ok) fail(status, value.code, value.message);
  return value.value;
}
function validOwner(input: OwnerInput): void {
  if (!isId(input.patientId) || !isId(input.orthoCaseId)) fail(400, "invalid_scope", "معرّف المريض أو حالة التقويم غير صالح.");
}
function scopeOf(owner: LockedOwner): StrategyScope {
  if (owner.clinicalCaseId === null) fail(409, "bridge_missing", "اربط حالة التقويم سريريًا بالإجراء الصريح أولًا.");
  return { patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId };
}

/** Same canonical session validator as routes: credential/role revocation and
 * account activity are checked under the transaction's users FOR SHARE lock. */
async function authorize(client: DbClient, input: OwnerInput, write: boolean): Promise<Authority> {
  const session = await requireSession(client);
  if (!session || !isId(session.userId) || session.expiresAt < Date.now()
    || session.userId !== input.session.userId || session.username !== input.session.username
    || session.role !== input.session.role) fail(401, "session_expired", "انتهت الجلسة أو تغيرت صلاحياتها. سجّل الدخول من جديد.");
  const user = await findUserByUsername(session.username, client);
  if (!user || !user.isActive || user.id !== session.userId || user.role !== session.role
    || user.username.toLowerCase() !== session.username.toLowerCase()) {
    fail(401, "session_expired", "تعذّر التحقق من الحساب الحالي.");
  }
  const clinicalWritable = session.role === "doctor" || session.role === "admin";
  if (write && !clinicalWritable) fail(403, "clinical_edit_denied", "تعديل الخطة السريرية متاح للطبيب والمدير فقط.");
  // Match the canonical cases route's CLINIC allowlist at this internal entry
  // point too; access through another caller must not expand role visibility.
  if (!clinicalWritable && session.role !== "reception") fail(403, "clinical_read_denied", "عرض الخطة السريرية غير متاح لهذا الدور.");
  // Establish patient lock order before canonical access takes witness locks.
  // doctorOwnsPatient(client) may hold a treatment-plan FOR SHARE witness: all
  // authority calls must finish BEFORE Ortho/bridge/problem/item acquisition.
  const { rows: patients } = await client.query<{ id: number }>(
    `SELECT id FROM patients WHERE id = $1 ${write ? "FOR NO KEY UPDATE" : "FOR SHARE"}`, [input.patientId]);
  if (!patients[0]) fail(404, "patient_not_found", "لم يُعثر على ملف المريض.");
  if (!(await canAccessPatient(session, input.patientId, undefined, client))) {
    fail(403, "patient_access_denied", "غير مصرّح لك بملف هذا المريض.");
  }
  const planVisible = await canAccessPatient(session, input.patientId, "canViewPlans", client);
  const planLinksWritable = clinicalWritable && planVisible
    && await canAccessPatient(session, input.patientId, "canEditPlans", client);
  return { actor: { session, id: user.id, name: user.displayName }, clinicalWritable, planVisible, planLinksWritable };
}
function assertUnexpired(authority: Authority): void {
  // Account/permission and positive patient-access witnesses remain locked for
  // this transaction. Only wall-clock expiry can retire that authority now.
  if (authority.actor.session.expiresAt < Date.now()) fail(401, "session_expired", "انتهت الجلسة. سجّل الدخول من جديد.");
}

async function lockOwner(client: DbClient, input: OwnerInput, write: boolean): Promise<LockedOwner> {
  // Never add a funding-plan lock after these locks. Existing item deletion
  // starts at its plan; taking the reverse order here would introduce deadlock.
  const { rows: cases } = await client.query<{ id: number; patient_id: number; status: string }>(
    `SELECT id, patient_id, status FROM ortho_cases WHERE id = $1 AND patient_id = $2 ${write ? "FOR UPDATE" : "FOR SHARE"}`,
    [input.orthoCaseId, input.patientId]);
  const ortho = cases[0];
  if (!ortho || ortho.patient_id !== input.patientId) fail(404, "ortho_case_not_found", "حالة التقويم غير متاحة لهذا المريض.");
  if (!["active", "retention", "completed", "discontinued"].includes(ortho.status)) {
    fail(409, "invalid_case_state", "تعذّر التحقق من حالة التقويم الحالية.");
  }
  const { rows: bridges } = await client.query<{ id: number; patient_id: number; ortho_case_id: number }>(
    `SELECT id, patient_id, ortho_case_id FROM clinical_cases WHERE ortho_case_id = $1 ${write ? "FOR UPDATE" : "FOR SHARE"}`,
    [input.orthoCaseId]);
  if (bridges.length > 1 || (bridges[0] && (bridges[0].patient_id !== ortho.patient_id || bridges[0].ortho_case_id !== ortho.id))) {
    fail(409, "scope_mismatch", "الرابط السريري لا يطابق المريض وحالة التقويم المحددين.");
  }
  if (!bridges[0]) {
    const { rows: saved } = await client.query<{ id: number }>(
      `SELECT id FROM ortho_strategy_revisions WHERE ortho_case_id = $1 LIMIT 1`, [input.orthoCaseId]);
    if (saved[0]) fail(409, "revision_scope_mismatch", "توجد نسخ محفوظة لكن رابط الحالة السريري لم يعد متاحًا. يلزم التحقق من السجل.");
  }
  // Authorization is tied to both canonical live owners. Historical recorded
  // patient identity below is provenance only and never grants patient access.
  return { patientId: ortho.patient_id, orthoCaseId: ortho.id, clinicalCaseId: bridges[0]?.id ?? null,
    recordingContext: ortho.status === "completed" || ortho.status === "discontinued" ? "retrospective" : "current" };
}

/** Fixed property order and normalized text/IDs; row and link ordering remain
 * meaningful. commandId is a lookup key, not part of the command fingerprint. */
function fingerprint(command: StrategyCommand): string {
  return createHash("sha256").update(JSON.stringify({ schemaVersion: command.schemaVersion,
    expectedRevisionId: command.expectedRevisionId, reason: command.reason,
    rows: command.rows.map(row => ({ problemId: row.problemId, objective: row.objective,
      strategy: row.strategy, planItemIds: row.planItemIds, rationale: row.rationale })) })).digest("hex");
}
function decode(row: StoredRow, scope: StrategyScope): StrategyRevision {
  if (!isId(row.actor_user_id) || typeof row.command_id !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(row.command_id)
    || typeof row.request_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.request_fingerprint)) {
    fail(500, "invalid_stored_revision", "تعذّر التحقق من هوية النسخة المحفوظة.");
  }
  let createdAt = row.created_at;
  if (createdAt instanceof Date) {
    if (!Number.isFinite(createdAt.getTime())) fail(500, "invalid_stored_revision", "تاريخ النسخة المحفوظة غير صالح.");
    createdAt = createdAt.toISOString();
  }
  const raw = { id: row.id, patientId: row.patient_id, recordedPatientId: row.recorded_patient_id,
    orthoCaseId: row.ortho_case_id, clinicalCaseId: row.clinical_case_id,
    schemaVersion: row.schema_version, version: row.version, supersedesRevisionId: row.supersedes_revision_id,
    createdAt, createdBy: row.created_by, reason: row.reason, recordingContext: row.recording_context, rows: row.rows };
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_STORED_DOCUMENT_BYTES) {
    fail(500, "invalid_stored_revision", "حجم النسخة المحفوظة يتجاوز الحد المسموح.");
  }
  return checked(decodeStrategyRevision(raw, scope), 500);
}
function historyEntry(revision: StrategyRevision): OrthoStrategyHistoryEntry {
  return { revisionId: revision.id, version: revision.version, supersedesRevisionId: revision.supersedesRevisionId,
    recordedPatientId: revision.recordedPatientId,
    recordingContext: revision.recordingContext, createdAt: revision.createdAt, createdBy: revision.createdBy, reason: revision.reason };
}
async function validatedHistory(client: DbClient, scope: StrategyScope): Promise<{ stored: StoredRow[]; revisions: StrategyRevision[] }> {
  // Validate the whole anchored lineage before any projection, replay or new
  // append. A plausible head must not conceal a skipped or cyclic predecessor.
  const { rows: stored } = await client.query<StoredRow>(`SELECT ${COLUMNS} FROM ortho_strategy_revisions
    WHERE ortho_case_id = $1 ORDER BY version DESC`, [scope.orthoCaseId]);
  const revisions = stored.map(row => decode(row, scope));
  const seen = new Set<number>();
  for (let index = 0; index < revisions.length; index += 1) {
    const current = revisions[index];
    const predecessor = revisions[index + 1] ?? null;
    if (seen.has(current.id) || current.supersedesRevisionId !== (predecessor?.id ?? null)
      || current.version !== (predecessor?.version ?? 0) + 1) {
      fail(500, "invalid_stored_revision", "تعذّر التحقق من تسلسل النسخ المحفوظة.");
    }
    seen.add(current.id);
  }
  return { stored, revisions };
}
function requirePlanLinks(authority: Authority, revisions: (StrategyRevision | null)[], command: StrategyCommand): void {
  const linked = command.rows.some(row => row.planItemIds.length > 0)
    || revisions.some(revision => revision?.rows.some(row => row.planItems.length > 0));
  if (linked && (!authority.planVisible || !authority.planLinksWritable)) {
    fail(403, "plan_links_unavailable", "يلزم تصريح عرض الخطط وتعديلها عند إضافة الروابط أو الاحتفاظ بها أو حذفها.");
  }
}

async function lockReferences(client: DbClient, scope: StrategyScope, command: StrategyCommand): Promise<void> {
  const problemIds = sortedIds(command.rows.map(row => row.problemId));
  const itemIds = sortedIds(command.rows.flatMap(row => row.planItemIds));
  // Lock only same-patient records; a foreign ID will fail the fresh membership
  // read below rather than acquiring another patient's locks or exposing data.
  await client.query(`SELECT p.id FROM patient_problems p
    WHERE p.patient_id = $1 AND p.id = ANY($2::int[]) ORDER BY p.id FOR UPDATE OF p`, [scope.patientId, problemIds]);
  if (itemIds.length) await client.query(`SELECT i.id FROM plan_items i
    JOIN treatment_plans t ON t.id = i.plan_id
    WHERE t.patient_id = $1 AND i.id = ANY($2::int[]) ORDER BY i.id FOR UPDATE OF i`, [scope.patientId, itemIds]);
}

/** Returns only minimal clinical fields. A historical ID now owned by somebody
 * else gets an identity-only unavailable marker, never that owner's data. */
async function canonicalContext(
  client: DbClient, scope: StrategyScope, authority: Authority, revisions: StrategyRevision[], command?: StrategyCommand,
): Promise<StrategyCanonicalContext> {
  const problemIds = sortedIds([...revisions.flatMap(revision => revision.rows.map(row => row.problem.id)),
    ...(command?.rows.map(row => row.problemId) ?? [])]);
  const itemIds = sortedIds([...revisions.flatMap(revision => revision.rows.flatMap(row => row.planItems.map(item => item.id))),
    ...(command?.rows.flatMap(row => row.planItemIds) ?? [])]);
  const { rows: problems } = await client.query<{
    id: number; patient_id: number; case_id: number | null; label: string; site: string | null; status: string | null;
  }>(`SELECT p.id, p.patient_id, p.case_id, p.label, p.site, p.status FROM patient_problems p
    WHERE p.patient_id = $1 AND (p.case_id = $2 OR p.id = ANY($3::int[])) ORDER BY p.id`,
  [scope.patientId, scope.clinicalCaseId, problemIds]);
  const problemRefs: StrategyProblemReference[] = problems.map(row => ({ id: row.id, patientId: row.patient_id,
    caseId: row.case_id, label: row.label, site: row.site, status: row.status }));
  if (problemIds.length) {
    const { rows: unavailable } = await client.query<{ id: number }>(
      `SELECT id FROM patient_problems WHERE id = ANY($1::int[]) AND patient_id <> $2`, [problemIds, scope.patientId]);
    for (const row of unavailable) problemRefs.push({ id: row.id, patientId: 0, caseId: null, label: "", site: null, status: null });
  }
  const itemRefs: StrategyPlanItemReference[] = [];
  if (authority.planVisible) {
    const { rows: items } = await client.query<{
      id: number; patient_id: number; case_id: number | null; service_name: string; tooth_code: number | null;
      case_site: string | null; status: string | null;
    }>(`SELECT i.id, t.patient_id, i.case_id, i.service_name, i.tooth_code,
      CASE WHEN c.patient_id = $1 THEN c.site ELSE NULL END AS case_site, i.status
      FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
      LEFT JOIN clinical_cases c ON c.id = i.case_id
      WHERE t.patient_id = $1 AND (i.case_id = $2 OR i.id = ANY($3::int[])) ORDER BY i.id`,
    [scope.patientId, scope.clinicalCaseId, itemIds]);
    itemRefs.push(...items.map(row => ({ id: row.id, patientId: row.patient_id, caseId: row.case_id,
      serviceName: row.service_name, toothCode: row.tooth_code, caseSite: row.case_site, status: row.status })));
    if (itemIds.length) {
      const { rows: unavailable } = await client.query<{ id: number }>(`SELECT i.id FROM plan_items i
        JOIN treatment_plans t ON t.id = i.plan_id WHERE i.id = ANY($1::int[]) AND t.patient_id <> $2`, [itemIds, scope.patientId]);
      for (const row of unavailable) itemRefs.push({ id: row.id, patientId: 0, caseId: null,
        serviceName: "", toothCode: null, caseSite: null, status: null });
    }
  }
  return { patientId: scope.patientId, orthoCase: { id: scope.orthoCaseId, patientId: scope.patientId },
    clinicalCase: { id: scope.clinicalCaseId, patientId: scope.patientId, orthoCaseId: scope.orthoCaseId },
    problems: problemRefs, problemLookupState: "ready", planItems: itemRefs,
    planVisibility: authority.planVisible ? "allowed" : "restricted",
    clinicalWriteAllowed: authority.clinicalWritable, planLinksWritable: authority.planLinksWritable };
}

async function transaction<T extends { ok: true }>(write: boolean, body: (client: DbClient) => Promise<T>): Promise<T | OrthoStrategyFailure> {
  await ensureSchema();
  const client = await getPool().connect();
  let committing = false;
  try {
    await client.query("BEGIN");
    const result = await body(client);
    committing = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof StoreFault) return { ok: false, status: error.status, code: error.code, message: error.message };
    if (write && committing) return { ok: false, status: 503, code: "write_unconfirmed",
      message: "لم تتأكد نتيجة الحفظ. أعد التحقق بنفس معرّف الطلب قبل إنشاء مراجعة أخرى." };
    throw error;
  } finally { client.release(); }
}

export async function getOrthoTreatmentStrategy(
  input: OwnerInput & { revisionId?: number },
): Promise<OrthoStrategyReadResult> {
  return transaction<Exclude<OrthoStrategyReadResult, OrthoStrategyFailure>>(false, async client => {
    validOwner(input);
    if (input.revisionId !== undefined && !isId(input.revisionId)) fail(400, "invalid_revision", "معرّف النسخة غير صالح.");
    const authority = await authorize(client, input, false);
    const owner = await lockOwner(client, input, false);
    if (owner.clinicalCaseId === null) {
      assertUnexpired(authority);
      return { ok: true, state: "bridge_missing", ...owner, clinicalCaseId: null,
        planVisible: authority.planVisible, clinicalWritable: authority.clinicalWritable, planLinksWritable: authority.planLinksWritable,
        canRevise: false, history: [], revision: null, choices: { problems: [], planItems: [] } };
    }
    const scope = scopeOf(owner);
    // Select the exact authorized OrthoCase, then decode every stored ownership
    // field. Filtering corrupt patient/bridge columns out here would disguise
    // corrupt history as a successfully empty record.
    const { revisions } = await validatedHistory(client, scope);
    const selected = input.revisionId === undefined ? revisions[0] ?? null
      : revisions.find(revision => revision.id === input.revisionId) ?? null;
    if (input.revisionId !== undefined && selected === null) fail(404, "revision_not_found", "النسخة المحددة غير متاحة لهذه الحالة.");
    const context = await canonicalContext(client, scope, authority, selected ? [selected] : []);
    assertUnexpired(authority);
    const revision = selected ? checked(projectStrategyRevision(selected, context), 500) : null;
    return { ok: true, state: "ready", ...owner, clinicalCaseId: scope.clinicalCaseId,
      planVisible: authority.planVisible, clinicalWritable: authority.clinicalWritable, planLinksWritable: authority.planLinksWritable,
      canRevise: authority.clinicalWritable && ([selected, revisions[0] ?? null].every(revision =>
        !revision?.rows.some(row => row.planItems.length > 0)) || authority.planLinksWritable),
      history: revisions.map(historyEntry), revision,
      choices: { problems: context.problems.filter(problem => problem.patientId === scope.patientId && problem.caseId === scope.clinicalCaseId),
        planItems: authority.planVisible ? context.planItems.filter(item => item.patientId === scope.patientId && item.caseId === scope.clinicalCaseId) : [] } };
  });
}

export async function appendOrthoTreatmentStrategy(
  input: OwnerInput & { command: unknown },
): Promise<OrthoStrategyWriteResult> {
  return transaction<Exclude<OrthoStrategyWriteResult, OrthoStrategyFailure>>(true, async client => {
    validOwner(input);
    const command = checked(checkStrategyCommand(input.command), 400);
    const authority = await authorize(client, input, true);
    const owner = await lockOwner(client, input, true);
    const scope = scopeOf(owner);
    const hash = fingerprint(command);
    const { stored, revisions } = await validatedHistory(client, scope);
    const replayIndex = stored.findIndex(row => row.actor_user_id === authority.actor.id && row.command_id === command.commandId);
    if (replayIndex >= 0) {
      const original = revisions[replayIndex];
      const predecessor = revisions[replayIndex + 1] ?? null;
      // A replay of link removal still needs the original predecessor's plan
      // authority. A later head or changed labels must never replace the result.
      requirePlanLinks(authority, [original, predecessor], command);
      if (stored[replayIndex].request_fingerprint !== hash) fail(409, "command_conflict", "استُخدم معرّف الحفظ لطلب مختلف.");
      const context = await canonicalContext(client, scope, authority, [original]);
      assertUnexpired(authority);
      return { ok: true, revision: checked(projectStrategyRevision(original, context), 500), replayed: true };
    }
    const previous = revisions[0] ?? null;
    requirePlanLinks(authority, [previous], command);
    if (command.expectedRevisionId !== (previous?.id ?? null)) fail(409, "stale_revision", "تغيرت نسخة الخطة. أعد قراءتها قبل المراجعة.");
    await lockReferences(client, scope, command);
    // This is a fresh statement after all reference locks, so a waited-on move
    // or delete cannot pass using the pre-lock snapshot.
    const context = await canonicalContext(client, scope, authority, [], command);
    assertUnexpired(authority);
    requirePlanLinks(authority, [previous], command);
    context.clinicalWriteAllowed = authority.clinicalWritable;
    context.planVisibility = authority.planVisible ? "allowed" : "restricted";
    context.planLinksWritable = authority.planLinksWritable;
    const bound = checked(bindStrategyRows(command, context, previous));
    const { rows: identities } = await client.query<{ id: number; created_at: Date }>(
      `SELECT nextval(pg_get_serial_sequence('ortho_strategy_revisions', 'id'))::int AS id, clock_timestamp() AS created_at`);
    const identity = identities[0];
    if (!identity || !(identity.created_at instanceof Date) || !Number.isFinite(identity.created_at.getTime())) {
      fail(500, "invalid_revision_identity", "تعذّر إنشاء هوية النسخة المحفوظة.");
    }
    const revision = checked(decodeStrategyRevision({ ...scope, recordedPatientId: scope.patientId, id: identity.id, schemaVersion: 1,
      version: (previous?.version ?? 0) + 1, supersedesRevisionId: previous?.id ?? null,
      createdAt: identity.created_at.toISOString(), createdBy: authority.actor.name, recordingContext: owner.recordingContext,
      reason: command.reason, rows: bound }, scope), 500);
    if (Buffer.byteLength(JSON.stringify(revision), "utf8") > MAX_STORED_DOCUMENT_BYTES) {
      fail(413, "revision_too_large", "حجم النسخة وروابطها يتجاوز الحد المسموح.");
    }
    await client.query(`INSERT INTO ortho_strategy_revisions
      (id, patient_id, recorded_patient_id, ortho_case_id, clinical_case_id, version, supersedes_revision_id, schema_version,
       actor_user_id, created_by, created_at, command_id, request_fingerprint, reason, recording_context, rows)
      VALUES ($1, $2, $3, $4, $5, $6, $7::int, $8, $9, $10, $11::timestamptz, $12, $13, $14, $15, $16::jsonb)`,
    [revision.id, scope.patientId, revision.recordedPatientId, scope.orthoCaseId, scope.clinicalCaseId, revision.version, revision.supersedesRevisionId,
      revision.schemaVersion, authority.actor.id, revision.createdBy, revision.createdAt, command.commandId, hash,
      revision.reason, revision.recordingContext, JSON.stringify(revision.rows)]);
    await insertAuditRow(client, { action: "ortho.strategy_revision", entity: "patient", entityId: scope.patientId,
      actor: authority.actor.name, actorRole: authority.actor.session.role,
      details: { revisionId: revision.id, recordedPatientId: revision.recordedPatientId,
        orthoCaseId: scope.orthoCaseId, clinicalCaseId: scope.clinicalCaseId,
        version: revision.version, supersedesRevisionId: revision.supersedesRevisionId, actorUserId: authority.actor.id,
        recordingContext: revision.recordingContext, reason: revision.reason, rowCount: revision.rows.length,
        linkCount: revision.rows.reduce((count, row) => count + row.planItems.length, 0) } });
    assertUnexpired(authority);
    return { ok: true, revision: checked(projectStrategyRevision(revision, context), 500), replayed: false };
  });
}
