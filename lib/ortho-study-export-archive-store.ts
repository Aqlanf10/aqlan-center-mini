/** Private durable export receipts. All reads/publication re-enter canonical saved
 * study authority; stored provenance is evidence, never an authorization grant. */
import { randomUUID } from 'node:crypto';
import { insertAuditRow, type DbClient } from './db';
import { journeyFail, journeyTransaction, type JourneyOwnerInput } from './ortho-case-journey-authority';
import { readOrthoCaseStudyOn } from './ortho-case-study-store';
import { canonicalJourneyJSON, journeyContentHash } from './ortho-case-journey-hash';
import { journeyHash, journeyId } from './ortho-case-journey-records';
import { ORTHO_STUDY_HISTORY_TABLES, PURCHASE_RESET_FENCE } from './clinic-reset';
import { STUDY_TEXT_RENDERER } from './ortho-study-text-export';
import { FULL_STUDY_RENDERER, FULL_STUDY_CONTRACT_HASH } from './ortho-study-full-layout';
import { CASE_TEMPLATE_IDENTITY } from './ortho-case-template';
import { readStudyExportCommand, STUDY_EXPORT_ARCHIVE_LIMITS as LIMITS, STUDY_EXPORT_FAILURES,
  type StudyExportCommand, type StudyExportFailure, type StudyExportFormat, type StudyExportJob } from './ortho-study-export-archive-contract';

export const STUDY_ARCHIVE_RENDERERS: Readonly<Record<StudyExportFormat, string>> = Object.freeze({
  'text-pptx': STUDY_TEXT_RENDERER, 'illustrated-pptx': FULL_STUDY_RENDERER,
});
export const STUDY_ARCHIVE_CONTRACTS: Readonly<Record<StudyExportFormat, string>> = Object.freeze({
  'text-pptx': journeyContentHash({ renderer: STUDY_TEXT_RENDERER, template: CASE_TEMPLATE_IDENTITY }),
  'illustrated-pptx': FULL_STUDY_CONTRACT_HASH,
});
export interface StudyExportLease { jobId: number; generation: number; token: string; expiresAt: string }
export interface StudyExportArtifactReference { storageKey: string; sha256: string; sizeBytes: number }
/** Runner supplies only hashes/identities from its verified in-memory image projection. */
export interface StudyExportRendition {
  useId: string; documentId: number; sourceSha256: string; recipeSha256: string; geometrySha256: string;
  renditionSha256: string; processorVersion: string;
}
interface JobRow {
  id: number; patient_id: number; ortho_case_id: number; clinical_case_id: number; actor_user_id: number;
  revision_id: number; revision_sha256: string; command_id: string; command: StudyExportCommand; request_fingerprint: string;
  format: StudyExportFormat; render_binding: { language: 'ar'; privacy: 'clinical'; renderer: string; contractHash: string; template: unknown };
  state: StudyExportJob['state']; generation: number; lease_token: string | null; lease_expires_at: Date | null;
  failure_code: StudyExportFailure | null; created_at: Date; updated_at: Date;
}
interface ArtifactRow { job_id: number; storage_key: string; sha256: string; size_bytes: number; page_count: number; created_at: Date; manifest: unknown; manifest_sha256: string }
const bad = (code = 'invalid_study_export') => journeyFail(400, code);
const nonnegative = (v: number) => Number.isSafeInteger(v) && v >= 0;
async function fence(client: DbClient) {
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [PURCHASE_RESET_FENCE]);
  await client.query(`LOCK TABLE ${ORTHO_STUDY_HISTORY_TABLES.join(', ')} IN ROW EXCLUSIVE MODE`);
}
async function artifact(client: DbClient, id: number): Promise<ArtifactRow | null> {
  return (await client.query<ArtifactRow>('SELECT * FROM ortho_study_export_artifacts WHERE job_id=$1', [id])).rows[0] ?? null;
}
async function receipt(client: DbClient, row: JobRow): Promise<StudyExportJob> {
  const a = await artifact(client, row.id);
  if ((row.state === 'ready') !== (a !== null)) journeyFail(500, 'invalid_study_export_publication');
  return { id: row.id, revisionId: row.revision_id, revisionHash: row.revision_sha256, format: row.format,
    state: row.state, generation: row.generation, creatorId: row.actor_user_id, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), failureCode: row.failure_code,
    artifact: a ? { sha256: a.sha256, sizeBytes: a.size_bytes, pageCount: a.page_count, createdAt: a.created_at.toISOString() } : null };
}
async function audited(client: DbClient, input: JourneyOwnerInput, row: JobRow, event: string) {
  await insertAuditRow(client, { actor: input.session.username, actorRole: input.session.role,
    action: 'ortho.study_export', entity: 'ortho_study_export_jobs', entityId: row.id,
    details: { event, orthoCaseId: row.ortho_case_id, generation: row.generation, state: row.state } });
}
/** Discovery contains no response data and precedes canonical source locks. */
async function prepared(client: DbClient, input: JourneyOwnerInput & { jobId: number }, creator = false) {
  if (!journeyId(input.jobId)) bad();
  const discovery = (await client.query<JobRow>('SELECT * FROM ortho_study_export_jobs WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3',
    [input.jobId, input.patientId, input.orthoCaseId])).rows[0];
  // Authorize even a nonexistent job through the canonical current case read.
  const saved = await readOrthoCaseStudyOn(client, { ...input, revisionId: discovery?.revision_id, exportAccess: true });
  if (!discovery) journeyFail(404, 'study_export_not_found');
  const row = (await client.query<JobRow>('SELECT * FROM ortho_study_export_jobs WHERE id=$1 FOR UPDATE', [input.jobId])).rows[0];
  if (!row || row.patient_id !== saved.patientId || row.ortho_case_id !== saved.orthoCaseId || row.clinical_case_id !== saved.clinicalCaseId
    || saved.revision?.id !== row.revision_id || saved.revision.contentHash !== row.revision_sha256
    || journeyContentHash(row.command) !== row.request_fingerprint) journeyFail(409, 'study_export_scope_changed');
  if (creator && row.actor_user_id !== input.session.userId) journeyFail(403, 'study_export_creator_required');
  return { row, revision: saved.revision, scope: { patientId: saved.patientId, orthoCaseId: saved.orthoCaseId, clinicalCaseId: saved.clinicalCaseId } };
}
function requireLease(row: JobRow, lease: StudyExportLease) {
  if (row.state !== 'running' || row.id !== lease.jobId || row.generation !== lease.generation || row.lease_token !== lease.token)
    journeyFail(409, 'study_export_lease_changed');
}
export async function reserveStudyExport(input: JourneyOwnerInput & { command: unknown }) {
  let command: StudyExportCommand;
  try { command = readStudyExportCommand(input.command); } catch { return { ok: false as const, status: 400, code: 'invalid_study_export_command', message: 'طلب تصدير غير صالح.' }; }
  return journeyTransaction(true, async client => {
    await fence(client);
    const saved = await readOrthoCaseStudyOn(client, { ...input, revisionId: command.revisionId, exportAccess: true });
    if (saved.revision?.contentHash !== command.revisionHash) journeyFail(409, 'study_export_revision_changed');
    const binding = { language: 'ar', privacy: 'clinical', renderer: STUDY_ARCHIVE_RENDERERS[command.format], contractHash: STUDY_ARCHIVE_CONTRACTS[command.format], template: saved.revision.content.authored.template };
    await client.query(`INSERT INTO ortho_study_export_jobs(patient_id,ortho_case_id,clinical_case_id,actor_user_id,revision_id,revision_sha256,command_id,command,request_fingerprint,format,render_binding)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb) ON CONFLICT(ortho_case_id,actor_user_id,command_id) DO NOTHING`,
    [saved.patientId,saved.orthoCaseId,saved.clinicalCaseId,input.session.userId,command.revisionId,command.revisionHash,command.clientRequestId,canonicalJourneyJSON(command),journeyContentHash(command),command.format,canonicalJourneyJSON(binding)]);
    const row = (await client.query<JobRow>('SELECT * FROM ortho_study_export_jobs WHERE ortho_case_id=$1 AND actor_user_id=$2 AND command_id=$3 FOR UPDATE',
      [saved.orthoCaseId,input.session.userId,command.clientRequestId])).rows[0];
    if (!row || row.request_fingerprint !== journeyContentHash(command)) journeyFail(409, 'request_key_conflict');
    await audited(client, input, row, 'reserved_or_recovered');
    return { ok: true as const, job: await receipt(client, row) };
  });
}
export async function listStudyExports(input: JourneyOwnerInput & { revisionId: number; after?: number }) {
  return journeyTransaction(false, async client => {
    if (!journeyId(input.revisionId) || input.after !== undefined && !journeyId(input.after)) bad();
    await fence(client);
    const saved = await readOrthoCaseStudyOn(client, { ...input, exportAccess: true });
    const rows = (await client.query<JobRow>(`SELECT * FROM ortho_study_export_jobs WHERE patient_id=$1 AND ortho_case_id=$2 AND revision_id=$3
      AND ($4::integer IS NULL OR id<$4) ORDER BY id DESC LIMIT $5 FOR SHARE`, [saved.patientId,saved.orthoCaseId,input.revisionId,input.after??null,LIMITS.list])).rows;
    return { ok: true as const, jobs: await Promise.all(rows.map(row => receipt(client, row))), next: rows.length === LIMITS.list ? rows.at(-1)!.id : null };
  });
}
export async function claimStudyExport(input: JourneyOwnerInput & { jobId: number; expectedGeneration: number }) {
  return journeyTransaction(true, async client => {
    if (!nonnegative(input.expectedGeneration)) bad();
    await fence(client); const preparedJob = await prepared(client, input, true), { row } = preparedJob;
    if (row.state === 'ready' || row.state === 'cancelled') return { ok: true as const, job: await receipt(client,row), lease: null, revision: null, scope: preparedJob.scope };
    if (row.generation !== input.expectedGeneration) journeyFail(409, 'study_export_generation_changed');
    if (row.render_binding.renderer !== STUDY_ARCHIVE_RENDERERS[row.format] || row.render_binding.contractHash !== STUDY_ARCHIVE_CONTRACTS[row.format]) journeyFail(409, 'study_export_renderer_unavailable');
    const claimed = (await client.query<JobRow>(`UPDATE ortho_study_export_jobs SET state='running',generation=generation+1,lease_token=$2,
      lease_expires_at=clock_timestamp()+INTERVAL '60 seconds',failure_code=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND (state IN ('queued','failed') OR (state='running' AND lease_expires_at<=clock_timestamp())) RETURNING *`, [row.id,randomUUID()])).rows[0];
    if (!claimed) journeyFail(409, 'study_export_running');
    await audited(client,input,claimed,'claimed');
    const lease: StudyExportLease = { jobId: claimed.id, generation: claimed.generation, token: claimed.lease_token!, expiresAt: claimed.lease_expires_at!.toISOString() };
    return { ok: true as const, job: await receipt(client,claimed), lease, revision: preparedJob.revision, scope: preparedJob.scope };
  });
}
export async function publishStudyExport(input: JourneyOwnerInput & { lease: StudyExportLease; artifact: StudyExportArtifactReference & { pageCount: number; renditions: StudyExportRendition[] } }) {
  return journeyTransaction(true, async client => {
    await fence(client); const { row, revision } = await prepared(client, { ...input, jobId: input.lease.jobId }, true);
    requireLease(row,input.lease);
    const a = input.artifact;
    if (!journeyHash(a.sha256) || a.storageKey !== `${a.sha256.slice(0,2)}/${a.sha256.slice(2,4)}/${a.sha256}.pptx`
      || !journeyId(a.sizeBytes) || a.sizeBytes>LIMITS.bytes || !journeyId(a.pageCount) || a.pageCount>LIMITS.pages
      || !Array.isArray(a.renditions) || a.renditions.length>LIMITS.images) bad('invalid_study_export_artifact');
    const selectedUses = revision.content.authored.panels.filter(p=>p.included&&p.state==='available').flatMap(p=>p.images.map(i=>i.useId));
    if (row.format==='text-pptx' && a.renditions.length || row.format==='illustrated-pptx' && a.renditions.length!==selectedUses.length) bad('invalid_study_export_renditions');
    for (let index=0;index<a.renditions.length;index++) {
      const r=a.renditions[index], use=revision.content.authored.mediaUses.find(u=>u.useId===selectedUses[index]);
      if (!use || r.useId!==use.useId || r.documentId!==use.documentId || r.sourceSha256!==use.sourceSha256
        || ![r.sourceSha256,r.recipeSha256,r.geometrySha256,r.renditionSha256].every(journeyHash)
        || typeof r.processorVersion!=='string' || !/^[A-Za-z0-9._-]{1,100}$/.test(r.processorVersion)
        || Object.keys(r).sort().join(',')!=='documentId,geometrySha256,processorVersion,recipeSha256,renditionSha256,sourceSha256,useId') bad('invalid_study_export_renditions');
    }
    const manifest = { schemaVersion:1,jobId:row.id,revisionId:row.revision_id,revisionHash:row.revision_sha256,
      revisionKind:revision.kind,creatorId:row.actor_user_id,capturedAt:revision.content.capturedAt,
      renderBinding:row.render_binding,sourceSelections:revision.content.sources.map(s=>s.selection),
      sha256:a.sha256,sizeBytes:a.sizeBytes,pageCount:a.pageCount,renditions:a.renditions };
    const ready = (await client.query<JobRow>(`UPDATE ortho_study_export_jobs SET state='ready',lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND lease_expires_at>clock_timestamp() RETURNING *`, [row.id])).rows[0];
    if (!ready) journeyFail(409,'study_export_lease_expired');
    await client.query(`INSERT INTO ortho_study_export_artifacts(job_id,sha256,storage_key,size_bytes,page_count,manifest,manifest_sha256)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [row.id,a.sha256,a.storageKey,a.sizeBytes,a.pageCount,canonicalJourneyJSON(manifest),journeyContentHash(manifest)]);
    await audited(client,input,ready,'published');
    return { ok:true as const,job:await receipt(client,ready) };
  });
}
export async function failStudyExport(input: JourneyOwnerInput & { lease: StudyExportLease; code: StudyExportFailure }) {
  return journeyTransaction(true, async client => {
    if (!STUDY_EXPORT_FAILURES.includes(input.code)) bad();
    await fence(client); const { row }=await prepared(client,{...input,jobId:input.lease.jobId},true); requireLease(row,input.lease);
    const failed=(await client.query<JobRow>(`UPDATE ortho_study_export_jobs SET state='failed',failure_code=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[row.id,input.code])).rows[0];
    await audited(client,input,failed,'failed'); return {ok:true as const,job:await receipt(client,failed)};
  });
}
export async function cancelStudyExport(input: JourneyOwnerInput & { jobId:number; expectedGeneration:number }) {
  return journeyTransaction(true,async client=>{
    if(!nonnegative(input.expectedGeneration))bad();
    await fence(client);const {row}=await prepared(client,input,true);
    if(row.generation!==input.expectedGeneration)journeyFail(409,'study_export_generation_changed');
    if(row.state==='ready')journeyFail(409,'study_export_already_published');
    if(row.state==='cancelled')return {ok:true as const,job:await receipt(client,row)};
    const cancelled=(await client.query<JobRow>(`UPDATE ortho_study_export_jobs SET state='cancelled',failure_code=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,[row.id])).rows[0];
    await audited(client,input,cancelled,'cancelled');return {ok:true as const,job:await receipt(client,cancelled)};
  });
}
export async function readStudyExportArtifact(input: JourneyOwnerInput & {jobId:number}) {
  return journeyTransaction(false,async client=>{
    await fence(client);const {row}=await prepared(client,input),a=await artifact(client,row.id);
    if(row.state!=='ready'||!a)journeyFail(409,'study_export_not_ready');
    if(journeyContentHash(a.manifest)!==a.manifest_sha256)journeyFail(500,'invalid_study_export_manifest');
    return {ok:true as const,job:await receipt(client,row),reference:{storageKey:a.storage_key,sha256:a.sha256,sizeBytes:a.size_bytes} satisfies StudyExportArtifactReference};
  });
}
