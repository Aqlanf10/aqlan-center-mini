/** INACTIVE caller-owned transaction kernel. Caller must hold the shared reset
 * fence and patient/access serialization. No transaction or feature is opened here. */
import { journeyContentHash } from './ortho-case-journey-hash';
import { problemSourceIdentity, type ProblemSourceCommand, type ProblemSourceCandidate,
  type ProblemSourceRead, type ProblemSourceReceipt } from './ortho-problem-sources';
import { createProblemOperation, problemCandidate, problemCommand, problemFail, problemHash,
  problemId, problemMetadata, type ProblemOperation, type ProblemOwner,
  type ProblemQuery, type ProblemScope, type ProblemReadPorts, type ProblemWritePorts } from './ortho-problem-core-contract';

export interface ProblemSavedReview {
  id: number; patient_id: number; recorded_patient_id: number; ortho_case_id: number; clinical_case_id: number;
  problem_id: number; actor_user_id: number; created_by: string; created_at: Date | string;
  source_identity: string; source_version: string; source_snapshot: ProblemSourceCandidate;
  problem_label: string; reason: string; supersedes_review_id: number | null;
  command_id: string; request_fingerprint: string; snapshot_bytes: number | string;
}
function invalid(code = 'invalid_problem_history'): never { return problemFail(500, code, 'integrity'); }
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && v.length <= max && (empty || !!v.trim());
export function problemDate(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') return invalid('invalid_problem_timestamp');
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return invalid('invalid_problem_timestamp');
  return d.toISOString();
}
export function matchProblemOwner(a: ProblemOwner, b: ProblemOwner): void {
  if (a.patientId !== b.patientId || a.orthoCaseId !== b.orthoCaseId || a.clinicalCaseId !== b.clinicalCaseId || a.recordingContext !== b.recordingContext)
    problemFail(409, 'case_changed');
}
/** Source-specific status set intentionally preserves the reference branch's
 * diagnostic episodes. It does not modify the destination's shared lifecycle. */
export async function readProblemOwner(op: ProblemOperation, lock: 'none' | 'read' | 'write' = 'none'): Promise<ProblemOwner> {
  await op.current();
  const suffix = lock === 'none' ? '' : lock === 'write' ? 'FOR UPDATE' : 'FOR SHARE';
  const cases = (await op.query<{id:number;patient_id:number;status:ProblemOwner['status'];plan_id:number|null}>(
    `SELECT id,patient_id,status,plan_id FROM ortho_cases WHERE id=$1 ${suffix}`, [op.scope.orthoCaseId], false, undefined, {maxRows:1})).rows;
  const row = cases[0];
  if (!row || row.patient_id !== op.scope.patientId) problemFail(404, 'ortho_case_not_found');
  if (!problemId(row.id) || row.id !== op.scope.orthoCaseId || row.plan_id !== null && !problemId(row.plan_id)) invalid('invalid_problem_owner');
  if (typeof row.status !== 'string' || !['assessment','active','retention','completed','discontinued'].includes(row.status)) problemFail(409, 'invalid_case_state');
  const bridges = (await op.query<{id:number;patient_id:number;ortho_case_id:number;specialty:string}>(
    `SELECT id,patient_id,ortho_case_id,specialty FROM clinical_cases WHERE ortho_case_id=$1 LIMIT 2 ${suffix}`, [row.id], false, undefined, {maxRows:2})).rows;
  if (bridges.length !== 1) problemFail(409, bridges.length ? 'ambiguous_bridge' : 'bridge_missing');
  const bridge = bridges[0];
  if (!problemId(bridge.id) || bridge.patient_id !== row.patient_id || bridge.ortho_case_id !== row.id || bridge.specialty !== 'orthodontics') problemFail(409, 'scope_mismatch');
  return Object.freeze({patientId:row.patient_id,orthoCaseId:row.id,clinicalCaseId:bridge.id,status:row.status,planId:row.plan_id,
    recordingContext:row.status === 'completed' || row.status === 'discontinued' ? 'retrospective' : 'current'});
}
function decodeReview(row: ProblemSavedReview, owner: ProblemOwner): ProblemSavedReview {
  for (const key of ['id','patient_id','recorded_patient_id','ortho_case_id','clinical_case_id','problem_id','actor_user_id'] as const) if (!problemId(row[key])) invalid();
  if (row.patient_id !== owner.patientId || row.recorded_patient_id !== owner.patientId || row.ortho_case_id !== owner.orthoCaseId || row.clinical_case_id !== owner.clinicalCaseId
    || !text(row.created_by, 2000) || !text(row.problem_label,2000) || !text(row.reason,1000)
    || typeof row.command_id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(row.command_id) || !problemHash(row.request_fingerprint)
    || row.supersedes_review_id !== null && !problemId(row.supersedes_review_id)) invalid();
  problemDate(row.created_at);
  const source = problemCandidate(row.source_snapshot, owner);
  if (source.identity !== row.source_identity || source.ref.version !== row.source_version || !source.available) invalid();
  if (problemMetadata(row.snapshot_bytes) > 262144) invalid('problem_source_budget');
  return Object.freeze({...row, source_snapshot:source});
}
async function savedReviews(op: ProblemOperation, owner: ProblemOwner): Promise<ProblemSavedReview[]> {
  const [meta] = (await op.query<{n:string;bytes:string;images:boolean}>(`SELECT count(*)::text n,coalesce(sum(octet_length(source_snapshot::text)),0)::text bytes,
    coalesce(bool_or(source_snapshot->>'requiresImages'='true'),false) images FROM ortho_problem_source_reviews WHERE ortho_case_id=$1`, [owner.orthoCaseId], false, rows => {
      if (rows.length !== 1 || typeof rows[0].images !== 'boolean') invalid();
      if (problemMetadata(rows[0].n) > 500 || problemMetadata(rows[0].bytes) > 2097152) problemFail(409,'problem_history_budget');
    }, {maxRows:1})).rows;
  if (meta.images) await op.images();
  const rows = (await op.query<ProblemSavedReview>('SELECT *,octet_length(source_snapshot::text) snapshot_bytes FROM ortho_problem_source_reviews WHERE ortho_case_id=$1 ORDER BY id DESC LIMIT 501', [owner.orthoCaseId], meta.images, raw => {
    if (raw.length !== problemMetadata(meta.n)) problemFail(409,'problem_history_changed');
    let bytes = 0;
    for (const row of raw) { const n = problemMetadata(row.snapshot_bytes); if (n > 262144) invalid('problem_source_budget'); bytes += n; }
    if (bytes !== problemMetadata(meta.bytes)) invalid('problem_history_metadata_changed');
  }, {maxRows:500,read:'clinical'})).rows.map(row => decodeReview(row, owner));
  if (rows.some(row => row.source_snapshot.requiresImages) !== meta.images) invalid('problem_history_metadata_changed');
  const ids = new Set<number>(), commands = new Set<string>(), versions = new Set<string>(), successors = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], key = `${row.actor_user_id}:${row.command_id}`, version = `${row.source_identity}:${row.source_version}`;
    if (ids.has(row.id) || commands.has(key) || versions.has(version) || i > 0 && rows[i-1].id <= row.id) invalid();
    ids.add(row.id); commands.add(key); versions.add(version);
    if (row.supersedes_review_id !== null) {
      const previous = rows.find(p => p.id === row.supersedes_review_id);
      if (!previous || previous.id >= row.id || previous.source_identity !== row.source_identity || successors.has(previous.id)) invalid('invalid_problem_lineage');
      successors.add(previous.id);
    }
  }
  return rows;
}
export async function findProblemReview(op: ProblemOperation, commandId: string): Promise<ProblemSavedReview | null> {
  return (await op.query<ProblemSavedReview>('SELECT *,octet_length(source_snapshot::text) snapshot_bytes FROM ortho_problem_source_reviews WHERE patient_id=$1 AND actor_user_id=$2 AND command_id=$3 LIMIT 2',
    [op.scope.patientId,op.actor.userId,commandId], false, undefined,{maxRows:1,read:'clinical'})).rows[0] ?? null;
}
async function problems(op: ProblemOperation, owner: ProblemOwner): Promise<ProblemSourceRead['problems']> {
  const rows = (await op.query<ProblemSourceRead['problems'][number]>("SELECT id,label,site,status FROM patient_problems WHERE patient_id=$1 AND case_id=$2 AND specialty='orthodontics' ORDER BY id DESC LIMIT 501 FOR SHARE", [owner.patientId,owner.clinicalCaseId], false, raw => {
    if (raw.length > 500) problemFail(409,'problem_list_budget');
  },{maxRows:501,read:'clinical'})).rows;
  const ids = new Set<number>();
  for (const p of rows) {
    if (!problemId(p.id) || ids.has(p.id) || !text(p.label,2000) || p.site !== null && !text(p.site,2000,true) || !text(p.status,100)) invalid('invalid_problem_list');
    ids.add(p.id);
  }
  return rows;
}
export type ProblemReviewPurpose = 'append' | 'reserve-validation' | 'recovery-validation';
/** Internal operation-scoped execution, never a transferable prepared grant. */
export async function runProblemReview(op: ProblemOperation, raw: unknown, purpose: ProblemReviewPurpose): Promise<ProblemSourceReceipt | null> {
  if (purpose === 'append' ? !['execute','direct-append'].includes(op.operation) : purpose === 'reserve-validation' ? op.operation !== 'reserve' : op.operation !== 'recover')
    problemFail(500,'problem_core_context_changed','authority');
  const command: ProblemSourceCommand = problemCommand(raw), fingerprint = journeyContentHash(command);
  await op.current();
  const before = await readProblemOwner(op), saved = await savedReviews(op,before);
  const rawDuplicate = await findProblemReview(op,command.commandId);
  const receipt = (row: ProblemSavedReview,replayed:boolean): ProblemSourceReceipt => ({ok:true,patientId:before.patientId,orthoCaseId:before.orthoCaseId,clinicalCaseId:before.clinicalCaseId,
    actorId:op.actor.userId,commandId:command.commandId,requestFingerprint:fingerprint,reviewId:row.id,problemId:row.problem_id,sourceIdentity:row.source_identity,sourceVersion:row.source_version,replayed});
  if (rawDuplicate) {
    if (rawDuplicate.patient_id !== before.patientId || rawDuplicate.actor_user_id !== op.actor.userId || rawDuplicate.command_id !== command.commandId || rawDuplicate.ortho_case_id !== before.orthoCaseId
      || rawDuplicate.clinical_case_id !== before.clinicalCaseId || rawDuplicate.request_fingerprint !== fingerprint) problemFail(409,'request_key_conflict');
    const duplicate = decodeReview(rawDuplicate,before);
    if (!saved.some(row => row.id === duplicate.id && journeyContentHash({...row,created_at:problemDate(row.created_at)}) === journeyContentHash({...duplicate,created_at:problemDate(duplicate.created_at)}))) invalid();
    if (duplicate.source_identity !== problemSourceIdentity(command.source) || journeyContentHash(duplicate.source_snapshot.ref) !== journeyContentHash(command.source)
      || duplicate.reason !== command.reason || duplicate.supersedes_review_id !== command.expectedReviewId
      || command.action === 'link' && duplicate.problem_id !== command.problemId || command.action === 'create' && duplicate.problem_label !== command.label!.trim()) invalid();
    if (duplicate.source_snapshot.requiresImages) await op.images();
    const evidence = purpose === 'recovery-validation' ? await op.capture(before) : null;
    if (evidence && !evidence.candidates.some(c => c.available && c.identity === duplicate.source_identity && journeyContentHash(c.ref) === journeyContentHash(command.source))) problemFail(409,'problem_source_changed');
    if (!(await problems(op,before)).some(p => p.id === duplicate.problem_id)) problemFail(409,'problem_unavailable');
    matchProblemOwner(before, await readProblemOwner(op,purpose === 'recovery-validation' ? 'read' : 'write'));
    if (evidence) await op.assertEvidence(evidence);
    await op.current(duplicate.source_snapshot.requiresImages || saved.some(r => r.source_snapshot.requiresImages));
    return receipt(duplicate,true);
  }
  const identity = problemSourceIdentity(command.source), previous = saved.find(r => r.source_identity === identity);
  if ((previous?.id ?? null) !== command.expectedReviewId) problemFail(409,'problem_review_changed');
  if (saved.some(r => r.source_identity === identity && r.source_version === command.source.version)) problemFail(409,'problem_source_already_reviewed');
  if (previous && command.action === 'create') problemFail(409,'problem_source_has_problem');
  const evidence = await op.capture(before);
  const candidate = evidence.candidates.find(c => c.identity === identity && journeyContentHash(c.ref) === journeyContentHash(command.source));
  if (!candidate?.available) problemFail(409,'problem_source_changed');
  const needsImages = candidate.requiresImages || saved.some(r => r.source_snapshot.requiresImages);
  const current = await problems(op,before), owner = await readProblemOwner(op,purpose === 'recovery-validation' ? 'read' : 'write');
  matchProblemOwner(before,owner);
  await op.query<{count:number;bytes:string;candidate_bytes:number}>(`SELECT count(*)::int count, (coalesce(sum(octet_length(source_snapshot::text)),0)+octet_length($2::jsonb::text))::text bytes,
    octet_length($2::jsonb::text) candidate_bytes FROM ortho_problem_source_reviews WHERE ortho_case_id=$1`, [owner.orthoCaseId,JSON.stringify(candidate)], needsImages, rows => {
      if (rows.length !== 1) invalid('problem_history_budget');
      const b = rows[0], n = problemMetadata(b.count), bytes = problemMetadata(b.bytes), sourceBytes = problemMetadata(b.candidate_bytes);
      if (n !== saved.length || bytes !== sourceBytes + saved.reduce((sum,row) => sum + problemMetadata(row.snapshot_bytes),0)) invalid('problem_history_metadata_changed');
      if (n >= 500 || bytes > 2097152 || sourceBytes > 262144) problemFail(409,'problem_history_budget');
    },{maxRows:1});
  if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > 262144) problemFail(409,'problem_source_budget');
  let problemId: number | null = null, label: string;
  if (command.action === 'link') {
    const found = current.find(p => p.id === command.problemId);
    if (!found || found.status !== 'active') problemFail(409,'problem_not_active_in_case');
    problemId = found.id; label = found.label;
  } else {
    if (current.length >= 500) problemFail(409,'problem_list_budget');
    label = command.label!.trim();
    if (current.some(p => p.status === 'active' && p.label.normalize('NFKC').trim().toLowerCase() === label.normalize('NFKC').toLowerCase() && p.site === candidate.site)) problemFail(409,'matching_problem_exists');
  }
  await op.assertEvidence(evidence); await op.current(needsImages);
  if (purpose !== 'append') return null;
  if (command.action === 'create') {
    // The query re-proves clinical creation after its final general authority wait.
    const [created] = (await op.query<{id:number;patient_id:number;case_id:number;specialty:string;label:string;site:string|null;noted_by:string;status:string}>(
      `INSERT INTO patient_problems(patient_id,label,site,specialty,case_id,noted_by) VALUES($1,$2,$3,'orthodontics',$4,$5) RETURNING id,patient_id,case_id,specialty,label,site,noted_by,status`,
      [owner.patientId,label,candidate.site,owner.clinicalCaseId,op.actor.name],needsImages,undefined,{maxRows:1,mutation:'problem-create'})).rows;
    if (!created || !problemIdValid(created.id) || created.patient_id !== owner.patientId || created.case_id !== owner.clinicalCaseId || created.specialty !== 'orthodontics'
      || created.label !== label || created.site !== candidate.site || created.noted_by !== op.actor.name || created.status !== 'active') invalid('invalid_problem_returning');
    problemId = created.id;
  }
  await op.assertEvidence(evidence); await op.current(needsImages);
  const [rawRow] = (await op.query<ProblemSavedReview>(`INSERT INTO ortho_problem_source_reviews(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,problem_id,
    actor_user_id,created_by,source_identity,source_version,source_snapshot,problem_label,reason,supersedes_review_id,command_id,request_fingerprint)
    VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14) RETURNING *,octet_length(source_snapshot::text) snapshot_bytes`,
    [owner.patientId,owner.orthoCaseId,owner.clinicalCaseId,problemId,op.actor.userId,op.actor.name,identity,candidate.ref.version,JSON.stringify(candidate),label,command.reason,previous?.id??null,command.commandId,fingerprint],needsImages,undefined,{maxRows:1})).rows;
  if (!rawRow) invalid('invalid_problem_returning');
  const row = decodeReview(rawRow,owner);
  if (row.actor_user_id !== op.actor.userId || row.created_by !== op.actor.name || row.problem_id !== problemId || row.command_id !== command.commandId || row.request_fingerprint !== fingerprint
    || row.source_identity !== identity || row.source_version !== candidate.ref.version || journeyContentHash(row.source_snapshot) !== journeyContentHash(candidate)
    || row.problem_label !== label || row.reason !== command.reason || row.supersedes_review_id !== (previous?.id??null) || saved.some(r => r.id >= row.id)) invalid('invalid_problem_returning');
  await op.audit({actor:op.actor,action:'ortho.problem_source.review',entity:'ortho_problem_source_reviews',entityId:row.id,
    details:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,problemId:row.problem_id,sourceIdentity:identity,sourceVersion:candidate.ref.version,action:command.action,requestFingerprint:fingerprint}},needsImages);
  await op.assertEvidence(evidence); await op.current(needsImages);
  return receipt(row,false);
}
const problemIdValid = problemId;
export async function appendProblemSourceWith(client: ProblemQuery, scope: ProblemScope, raw: unknown, ports: ProblemWritePorts): Promise<ProblemSourceReceipt> {
  const command = problemCommand(raw), op = createProblemOperation(client,scope,ports,'direct-append');
  try {
    await op.begin('review');
    const {rows} = await op.query<{id:number}>('SELECT id FROM ortho_problem_source_submissions WHERE (ortho_case_id=$1 AND acknowledged_at IS NULL) OR (patient_id=$2 AND actor_user_id=$3 AND command_id=$4) LIMIT 1',
      [op.scope.orthoCaseId,op.scope.patientId,op.actor.userId,command.commandId],false,undefined,{maxRows:1});
    if (rows.length) problemFail(409,'problem_submission_requires_journal');
    const result = await runProblemReview(op,command,'append');
    if (!result) invalid('missing_problem_receipt');
    return result;
  } finally { op.close(); }
}
export async function getProblemSourcesWith(client: ProblemQuery, scope: ProblemScope, ports: ProblemReadPorts): Promise<ProblemSourceRead> {
  const op = createProblemOperation(client,scope,ports,'list');
  try {
    await op.begin();
    const before = await readProblemOwner(op), saved = await savedReviews(op,before), evidence = await op.capture(before);
    const current = await problems(op,before), owner = await readProblemOwner(op,'read'); matchProblemOwner(before,owner);
    const writable = await op.eligibility('direct-append');
    const reviews: ProblemSourceRead['reviews'] = saved.map(row => {
      const source = evidence.candidates.find(c => c.identity === row.source_identity);
      return {id:row.id,problemId:row.problem_id,sourceIdentity:row.source_identity,sourceVersion:row.source_version,source:row.source_snapshot,problemLabel:row.problem_label,
        createdBy:row.created_by,createdAt:problemDate(row.created_at),reason:row.reason,supersedesReviewId:row.supersedes_review_id,
        currentSourceState:!source?.available?'unavailable':source.ref.version===row.source_version?'current':'newer_version'};
    });
    await op.assertEvidence(evidence); await op.current(saved.some(r => r.source_snapshot.requiresImages));
    return {ok:true,patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId,writable,candidates:evidence.candidates,problems:current,reviews};
  } finally { op.close(); }
}
