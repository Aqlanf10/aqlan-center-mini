/** INACTIVE kernel boundary. Callers own transaction lifetime, reset fences and
 * commit/rollback. No capability mapping or production source factory lives here.
 * Trusted adapters must freshly prove exact transaction/action/scope/actor on
 * every assertion. A source witness or reservation is never a mutation grant. */
import { DIAGNOSIS_FIELDS } from './diagnosis';
import { checkVersionedAssessmentDraftV2 } from './ortho-assessment-measurement-set-v2';
import { deriveDraftAnalysisV2 as deriveAnalysis210 } from './ortho-assessment-engine-2_1_0';
import { deriveDraftAnalysisV2 as deriveAnalysis220 } from './ortho-assessment-engine-2_2_0';
import { deriveDraftAnalysisV2 as deriveAnalysis221 } from './ortho-assessment-engine-2_2_1';
import { assessmentJsonHash } from './ortho-assessment-persisted-v2';
import { checkAssessmentObservationV2, checkAssessmentSourceV2, type AssessmentObservationV2, type ObservationTarget } from './ortho-assessment-v2';
import { readFacialRevision } from './ortho-facial-records';
import { journeyContentHash, canonicalJourneyJSON } from './ortho-case-journey-hash';
import { readProblemSourceCommand, readProblemSourceRef, problemSourceIdentity,
  type ProblemSourceCandidate, type ProblemSourceCommand } from './ortho-problem-sources';

export interface ProblemQuery {
  query<Row extends object = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
export type ProblemScope = Readonly<{ patientId: number; orthoCaseId: number }>;
export type ProblemActor = Readonly<{ userId: number; name: string; role: string }>;
export interface ProblemOwner extends ProblemScope {
  readonly clinicalCaseId: number; readonly planId: number | null;
  readonly status: 'assessment' | 'active' | 'retention' | 'completed' | 'discontinued';
  readonly recordingContext: 'current' | 'retrospective';
}
export type ProblemOperationName = 'list' | 'reserve' | 'execute' | 'direct-append' | 'recover' | 'acknowledge' | 'cancel';
export type ProblemFaultCategory = 'domain' | 'integrity' | 'authority';
export class ProblemFault extends Error {
  constructor(readonly status: number, readonly code: string, readonly category: ProblemFaultCategory = 'domain') { super(code); }
}
export function problemFail(status: number, code: string, category: ProblemFaultCategory = 'domain'): never { throw new ProblemFault(status, code, category); }
export const problemId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
export const problemHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function problemMetadata(v: unknown): number {
  const n = typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || Object.is(n, -0)) problemFail(500, 'invalid_problem_metadata', 'integrity');
  return n;
}
export function problemScope(input: ProblemScope): ProblemScope {
  if (!input || !problemId(input.patientId) || !problemId(input.orthoCaseId)) problemFail(400, 'invalid_scope');
  return Object.freeze({ patientId: input.patientId, orthoCaseId: input.orthoCaseId });
}
/** Bound the raw graph BEFORE copying. Accessors, sparse arrays, cycles and
 * exotic prototypes are rejected. Date values are owned copies for PG rows;
 * JSON source/command validators reject them where JSON-only is required. */
function boundedProblemValue<T>(raw: T, maxBytes: number, maxNodes: number, maxDepth: number, makeCopy: boolean): T {
  let bytes = 0, nodes = 0;
  const path = new Set<object>();
  const charge = (n: number) => { bytes += n; if (bytes > maxBytes) problemFail(500, 'problem_payload_budget', 'integrity'); };
  const visit = (v: unknown, depth: number, copy: boolean): unknown => {
    if (++nodes > maxNodes || depth > maxDepth) problemFail(500, 'problem_payload_budget', 'integrity');
    if (v === null || typeof v === 'boolean') { charge(5); return v; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) problemFail(500, 'invalid_problem_payload', 'integrity'); charge(24); return v; }
    if (typeof v === 'string') { if (v.length > maxBytes) problemFail(500, 'problem_payload_budget', 'integrity'); charge(new TextEncoder().encode(v).length + 2); return v; }
    if (!v || typeof v !== 'object') problemFail(500, 'invalid_problem_payload', 'integrity');
    if (v instanceof Date) { if (!Number.isFinite(v.getTime())) problemFail(500, 'invalid_problem_payload', 'integrity'); charge(32); return copy ? Object.freeze(new Date(v.getTime())) : v; }
    if (path.has(v)) problemFail(500, 'invalid_problem_payload', 'integrity');
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) problemFail(500, 'invalid_problem_payload', 'integrity');
    const keys = Reflect.ownKeys(v);
    if (keys.length > maxNodes - nodes + 1 || keys.some(k => typeof k !== 'string')) problemFail(500, 'problem_payload_budget', 'integrity');
    if (array && (v.length > maxNodes || keys.length !== v.length + 1)) problemFail(500, 'invalid_problem_payload', 'integrity');
    path.add(v); charge(2);
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in d) || !d.enumerable) problemFail(500, 'invalid_problem_payload', 'integrity');
      charge(new TextEncoder().encode(String(key)).length + 4);
      const item = visit(d.value, depth + 1, copy);
      if (copy) Object.defineProperty(result, key, { value: item, enumerable: true });
    }
    path.delete(v);
    return copy ? Object.freeze(result) : v;
  };
  visit(raw, 0, false); if (!makeCopy) return raw; nodes = 0; bytes = 0;
  return visit(raw, 0, true) as T;
}
export function detachProblemValue<T>(raw: T, maxBytes = 3145728, maxNodes = 100000, maxDepth = 64): T {
  return boundedProblemValue(raw, maxBytes, maxNodes, maxDepth, true);
}
export function guardProblemValue(raw: unknown, maxBytes = 3145728, maxNodes = 100000, maxDepth = 64): void {
  boundedProblemValue(raw, maxBytes, maxNodes, maxDepth, false);
}
function jsonOnly(v: unknown): void {
  if (v instanceof Date) problemFail(500, 'invalid_problem_payload', 'integrity');
  if (v && typeof v === 'object') for (const value of Object.values(v)) jsonOnly(value);
}
export function problemCommand(raw: unknown): ProblemSourceCommand {
  const owned = detachProblemValue(raw, 32768, 100, 8); jsonOnly(owned);
  const command = readProblemSourceCommand(owned);
  if (!command || typeof command.source.kind !== 'string') problemFail(400, 'invalid_problem_review');
  return command;
}
export function decodeProblemCandidate(raw: unknown, owner?: ProblemOwner): ProblemSourceCandidate {
  const c = detachProblemValue(raw, 262144, 20000, 64) as ProblemSourceCandidate; jsonOnly(c);
  const ref = c && readProblemSourceRef(c.ref);
  if (!ref || typeof ref.kind !== 'string' || c.identity !== problemSourceIdentity(ref)
    || typeof c.available !== 'boolean' || typeof c.requiresImages !== 'boolean'
    || !['category', 'title', 'summary', 'sourceActor', 'sourceDate'].every(k => typeof c[k as keyof ProblemSourceCandidate] === 'string')
    || c.proposedLabel !== null && (typeof c.proposedLabel !== 'string' || c.proposedLabel.length > 2000)
    || c.site !== null && typeof c.site !== 'string'
    || !Object.hasOwn(c, 'target') || !Object.hasOwn(c, 'snapshot')) problemFail(500, 'invalid_problem_candidate', 'integrity');
  if ((ref.kind === 'facial_review' || ref.kind === 'ceph_diagnosis') && !c.requiresImages) problemFail(500, 'invalid_problem_candidate', 'integrity');
  validateCandidateSnapshot(c, owner);
  return c;
}
function sourceSite(target: ObservationTarget): string | null {
  return target.kind === 'tooth' ? `FDI ${target.tooth}` : target.kind === 'arch' ? target.arch === 'upper' ? 'الفك العلوي' : 'الفك السفلي' : target.kind === 'side' ? target.side : null;
}
/** Validate the saved source union without treating it as current evidence. */
function validateCandidateSnapshot(c: ProblemSourceCandidate, owner?: ProblemOwner): void {
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
  function fail(): never { return problemFail(500, 'invalid_problem_candidate', 'integrity'); }
  const s = c.snapshot;
  if (!obj(s) || !obj(c.target) || !text(c.title, 4000) || !text(c.category, 4000) || !text(c.summary, 20000)
    || c.site !== null && !text(c.site, 1000) || c.sourceActor.length > 4000 || c.sourceDate.length > 100) fail();
  switch (c.ref.kind) {
    case 'clinical_diagnosis':
      if (!DIAGNOSIS_FIELDS().some(f => f.key === c.ref.member) || s.field !== c.ref.member || !text(s.text, 2000)
        || !problemId(s.revisionVersion) || c.summary !== s.text || c.proposedLabel !== s.text || c.requiresImages
        || c.target.kind !== 'case' || c.site !== null) fail();
      break;
    case 'ceph_diagnosis':
      if (!['skeletal', 'dental', 'soft_tissue', 'final_dx', 'note'].includes(c.ref.member) || s.studyId !== c.ref.id
        || s.field !== c.ref.member || !text(s.text, 4000) || c.summary !== s.text || c.proposedLabel !== (s.text.length <= 2000 ? s.text : null)
        || !problemHash(s.completionWitnessSha256) || !obj(s.source) || s.source.kind !== 'ceph_study'
        || s.source.id !== c.ref.id || s.source.version !== c.ref.version || c.target.kind !== 'case' || c.site !== null || !c.requiresImages) fail();
      break;
    case 'facial_review': {
      if (!obj(s.revision) || !problemId(s.revision.patientId) || !problemId(s.revision.orthoCaseId)
        || s.limitation !== 'Manual 2D photographic description, not calibrated anatomy or automatic diagnosis') fail();
      try {
        const r = readFacialRevision(s.revision, owner ?? {patientId:s.revision.patientId, orthoCaseId:s.revision.orthoCaseId});
        if (owner && (r.patientId !== owner.patientId || r.recordedPatientId !== owner.patientId || r.orthoCaseId !== owner.orthoCaseId || r.clinicalCaseId !== owner.clinicalCaseId)) fail();
        if (r.id !== c.ref.id || c.ref.member !== `document_${r.documentId}_review` || c.ref.version !== `sha256:${journeyContentHash(r)}`
          || journeyContentHash(r.command) !== r.requestFingerprint || journeyContentHash({content:r.command.content,results:r.results}) !== r.contentHash
          || r.createdBy !== c.sourceActor || r.createdAt !== c.sourceDate || r.recordedPatientId !== r.patientId
          || r.command.content.review.state !== 'reviewed' || !r.command.content.review.note.trim() || c.summary !== r.command.content.review.note
          || r.results.measures.some(m => m.state === 'invalid_geometry') || c.proposedLabel !== null || c.site !== null || c.target.kind !== 'case' || !c.requiresImages) fail();
      } catch { fail(); }
      break;
    }
    case 'assessment_observation': {
      const parsed = checkAssessmentObservationV2(s.observation);
      if (!parsed.ok || !problemId(s.revisionVersion) || !Array.isArray(s.sourceStates) || s.sourceStates.length > 512) fail();
      const o = parsed.value;
      if (o.id !== c.ref.member || o.definition === 'dentition' || !['recorded', 'measured', 'tooth_absent', 'not_erupted'].includes(o.value.state)
        || canonicalJourneyJSON(c.target) !== canonicalJourneyJSON(o.target)) fail();
      const expectedSummary = o.value.state === 'measured' ? `${o.value.value} ${o.unit}` : o.value.state === 'recorded' ? o.value.text : o.value.state === 'tooth_absent' ? 'السن مسجل كغائب' : 'السن مسجل كغير بازغ';
      if (c.summary !== expectedSummary || c.proposedLabel !== (o.value.state === 'recorded' ? o.value.text : null) || c.site !== sourceSite(o.target)) fail();
      const states = new Map<string, {version:string}>();
      for (const state of s.sourceStates) {
        if (!obj(state) || !checkAssessmentSourceV2(state.source).ok || typeof state.state !== 'string' || !['available', 'unavailable', 'changed'].includes(state.state)) fail();
        const source = state.source as {kind:string;id:number;version:string};
        const key = `${source.kind}:${source.id}`; if (states.has(key)) fail(); states.set(key, source);
        if ((source.kind === 'document' || source.kind === 'ceph_study') && !c.requiresImages) fail();
      }
      for (const source of o.provenance?.sources ?? []) {
        if (states.get(`${source.kind}:${source.id}`)?.version !== source.version) fail();
        if ((source.kind === 'document' || source.kind === 'ceph_study') && !c.requiresImages) fail();
      }
      if (c.available !== s.sourceStates.every(v => obj(v) && v.state === 'available')) fail();
      break;
    }
    case 'assessment_analysis': {
      if (!obj(s.selection) || s.selection.id !== c.ref.member || s.selection.state !== 'draft' || typeof s.selection.method !== 'string'
        || !['arch_space', 'bolton_anterior', 'bolton_overall', 'tanaka_johnston_1974'].includes(s.selection.method)
        || !obj(s.result) || s.result.analysisId !== c.ref.member || !problemHash(s.result.resultHash)
        || !obj(s.result.result) || s.result.result.state !== 'ready' || !obj(s.result.result.witness)
        || !obj(s.result.result.witness.result) || s.result.result.witness.result.state !== 'calculated'
        || s.result.result.witness.clinicalApproval !== 'unapproved' || !obj(s.result.result.witness.formula)
        || !text(s.result.result.witness.formula.engineVersion,100) || !text(s.result.result.witness.formula.formulaVersion,100)
        || !Array.isArray(s.result.result.dependencyObservationIds) || !Array.isArray(s.observations) || s.observations.length > 512 || c.proposedLabel !== null) fail();
      const ids = new Set<string>(), observations: AssessmentObservationV2[] = [];
      for (const raw of s.observations) {
        const parsed = checkAssessmentObservationV2(raw); if (!parsed.ok || ids.has(parsed.value.id)) fail(); ids.add(parsed.value.id); observations.push(parsed.value);
        if (parsed.value.provenance?.sources.some(v => v.kind === 'document' || v.kind === 'ceph_study') && !c.requiresImages) fail();
      }
      const deps = s.result.result.dependencyObservationIds;
      if (deps.some(id => typeof id !== 'string' || !ids.has(id)) || new Set(deps).size !== deps.length || ids.size !== deps.length) fail();
      // The stored projection deliberately excludes the full draft. Reconstruct
      // only its already-present dependencies, refusing ambiguous roles rather
      // than inventing observations or acquiring a new source permission.
      const dentition = observations.filter(o => o.definition === 'dentition');
      const upper = observations.filter(o => o.definition === 'arch_available_space' && o.target.kind === 'arch' && o.target.arch === 'upper');
      const lower = observations.filter(o => o.definition === 'arch_available_space' && o.target.kind === 'arch' && o.target.arch === 'lower');
      if (dentition.length !== 1 || upper.length > 1 || lower.length > 1) fail();
      const parsedDraft = checkVersionedAssessmentDraftV2({schemaVersion:2,
        observations:{schemaVersion:2,dentitionObservationId:dentition[0].id,observations},
        measurementSets:[{id:s.selection.measurementSetId,toothWidthObservationIds:observations.filter(o => o.definition === 'mesiodistal_width').map(o => o.id),
          upperAvailableObservationId:upper[0]?.id ?? null,lowerAvailableObservationId:lower[0]?.id ?? null}],analyses:[s.selection]});
      if (!parsedDraft.ok) fail();
      const draft = parsedDraft.value, selection = draft.analyses[0], set = draft.measurementSets[0];
      const engine = s.result.result.witness.formula.engineVersion;
      let computed: ReturnType<typeof deriveAnalysis221>;
      if (engine === 'ortho-model-2.1.0') {
        if (selection.method === 'tanaka_johnston_1974') fail();
        computed = deriveAnalysis210({...draft,analyses:[selection]},set,selection);
      } else if (engine === 'ortho-model-2.2.0') computed = deriveAnalysis220(draft,set,selection);
      else if (engine === 'ortho-model-2.2.1') computed = deriveAnalysis221(draft,set,selection);
      else fail();
      if (!computed.ok || computed.value.state !== 'ready' || computed.value.witness.result.state !== 'calculated'
        || canonicalJourneyJSON(computed.value) !== canonicalJourneyJSON(s.result.result)
        || assessmentJsonHash(computed.value) !== s.result.resultHash) fail();
      const arithmetic = computed.value.witness.result, numeric = (value:number) => Number(value.toFixed(3));
      const summary = arithmetic.method === 'arch_space'
        ? `المتاح: ${numeric(arithmetic.availableMm)} mm · المطلوب: ${numeric(arithmetic.requiredMm)} mm · المتاح ناقص المطلوب: ${numeric(arithmetic.availableMinusRequiredMm)} mm`
        : arithmetic.method === 'tanaka_johnston_1974_approximation_v1'
          ? `تقدير Tanaka–Johnston: القواطع السفلية المقاسة ${numeric(arithmetic.measuredLowerIncisorSumMm)} mm · قواطع الفك المقاسة ${numeric(arithmetic.measuredTargetIncisorSumMm)} mm · تقدير الناب والضاحكين لكل جهة ${numeric(arithmetic.predictedCaninePremolarPerQuadrantMm)} mm · المتاح المقاس ${numeric(arithmetic.measuredAvailableMm)} mm · المطلوب المقدّر ${numeric(arithmetic.estimatedRequiredMm)} mm · المتاح ناقص المقدّر ${numeric(arithmetic.availableMinusEstimatedRequiredMm)} mm · ملاءمة المرجع للمريض غير معتمدة`
          : `مجموع العلوي: ${numeric(arithmetic.upperMm)} mm · مجموع السفلي: ${numeric(arithmetic.lowerMm)} mm · نسبة السفلي إلى العلوي: ${numeric(arithmetic.ratioPercent)}%`;
      const target: ObservationTarget = 'arch' in selection ? {kind:'arch',arch:selection.arch} : {kind:'case'};
      if (c.summary !== summary || canonicalJourneyJSON(c.target) !== canonicalJourneyJSON(target) || c.site !== sourceSite(target)) fail();
      break;
    }
  }
}
export const problemCandidate = decodeProblemCandidate;
type Current = (client: ProblemQuery, scope: ProblemScope, actor: ProblemActor, operation: ProblemOperationName) => Promise<ProblemActor>;
interface ProblemImageAuthority {
  assertImages: Current;
  /** Current clinical-fact visibility, independent of review/edit and create. */
  assertClinicalRead: Current;
}
export interface ProblemWriteAuthority extends ProblemImageAuthority {
  beginWrite(client: ProblemQuery, scope: ProblemScope, operation: ProblemOperationName): Promise<ProblemActor>;
  assertWrite: Current;
  assertProblemCreate: Current;
}
export interface ProblemReadAuthority extends ProblemImageAuthority {
  beginRead(client: ProblemQuery, scope: ProblemScope, operation: ProblemOperationName): Promise<ProblemActor>;
  assertRead: Current;
  /** A deliberate action denial may return false; stale identity must throw. */
  readWriteEligibility(client: ProblemQuery, scope: ProblemScope, actor: ProblemActor, target: 'cancel' | 'direct-append'): Promise<boolean>;
}
export type ProblemAuditEvent = Readonly<{ actor: ProblemActor; entityId: number } & ({
  action: 'ortho.problem_source.review'; entity: 'ortho_problem_source_reviews';
  details: { patientId: number; orthoCaseId: number; problemId: number; sourceIdentity: string; sourceVersion: string; action: 'create' | 'link'; requestFingerprint: string };
} | {
  action: 'ortho.problem_submission'; entity: 'ortho_problem_source_submissions';
  details: { event: 'reserved' | 'committed' | 'cancelled_before_arrival' | 'cancelled' | 'acknowledged'; orthoCaseId: number; requestFingerprint: string; state: 'pending' | 'committed' | 'cancelled' };
})>;
export interface ProblemAuditPort { append(client: ProblemQuery, event: ProblemAuditEvent): Promise<void> }
/** Source-specific decoded proof is supplied only by trusted acquisition code.
 * This boundary checks its shape and candidate correspondence; the live port
 * must verify the actual persisted source closure and bytes in this transaction. */
export type ProblemSourceProof =
 | { kind: 'assessment_observation' | 'assessment_analysis'; revisionId: number; schemaVersion: 2; closureHash: string; sourceVersion: string; complete: true }
 | { kind: 'clinical_diagnosis'; diagnosisId: number; patientId: number; orthoCaseId: number; contentHash: string; sourceVersion: string; locked: true }
 | { kind: 'ceph_diagnosis'; studyId: number; schemaVersion: 2; completionHash: string; externalSourceHash: string; sourceVersion: string; assigned: true; nonDiscarded: true }
 | { kind: 'facial_review'; revisionId: number; documentId: number; sourceVersion: string; basisHash: string; head: 'latest'; review: 'reviewed'; nonemptyNote: true; geometryValid: true; documentCurrent: true };
export interface ProblemSourceContext {
  readonly scope: ProblemScope; readonly actor: ProblemActor; readonly operation: ProblemOperationName;
  query: ProblemQuery['query']; clinicalQuery: ProblemQuery['query'];
  current(): Promise<void>; images(): Promise<void>; clinicalRead(): Promise<void>;
}
export interface ProblemSourceEvidencePort {
  capture(client: ProblemQuery, context: ProblemSourceContext, owner: ProblemOwner): Promise<{
    entries: { candidate: ProblemSourceCandidate; proof: ProblemSourceProof }[]; witness: object;
  }>;
  assertCurrent(client: ProblemQuery, context: ProblemSourceContext, owner: ProblemOwner, witness: object): Promise<void>;
}
/** Register ALL underlying service methods used behind stable forwarding
 * closures, including image services. Empty is suitable only for self-contained
 * adapters. This is configuration integrity, never a cached authority proof. */
export interface ProblemBinding { readonly target: object; readonly methods: readonly string[] }
interface ProblemPorts { readonly sources: ProblemSourceEvidencePort; readonly bindings: readonly ProblemBinding[] }
export interface ProblemWritePorts extends ProblemPorts { readonly mode: 'write'; readonly authority: ProblemWriteAuthority; readonly audit: ProblemAuditPort }
export interface ProblemReadPorts extends ProblemPorts { readonly mode: 'legacy-read'; readonly authority: ProblemReadAuthority }
export type ProblemCorePorts = ProblemWritePorts | ProblemReadPorts;
export interface ProblemEvidence { readonly candidates: ProblemSourceCandidate[] }
export interface ProblemQueryLimits { maxRows?: number; maxBytes?: number; mutation?: 'problem-create'; read?: 'clinical' }
export interface ProblemOperation {
  readonly scope: ProblemScope; readonly actor: ProblemActor; readonly operation: ProblemOperationName;
  begin(fences?: 'review' | 'journal'): Promise<void>; current(images?: boolean): Promise<void>; images(): Promise<void>; clinicalRead(): Promise<void>; create(): Promise<void>;
  eligibility(target: 'cancel' | 'direct-append'): Promise<boolean>;
  query<Row extends object = Record<string, unknown>>(sql: string, values?: unknown[], images?: boolean,
    beforeSnapshot?: (rows: readonly Row[]) => void, limits?: ProblemQueryLimits): Promise<{ rows: Row[] }>;
  capture(owner: ProblemOwner): Promise<ProblemEvidence>; assertEvidence(evidence: ProblemEvidence): Promise<void>;
  audit(event: ProblemAuditEvent, images?: boolean): Promise<void>; close(): void;
}
function actorCopy(raw: ProblemActor): ProblemActor {
  if (!raw || !problemId(raw.userId) || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 2000 || typeof raw.role !== 'string' || !raw.role.trim() || raw.role.length > 100) problemFail(500, 'problem_core_port_invalid', 'integrity');
  return Object.freeze({ userId: raw.userId, name: raw.name, role: raw.role });
}
function sameActor(raw: ProblemActor, expected: ProblemActor) {
  const a = actorCopy(raw);
  if (a.userId !== expected.userId || a.name !== expected.name || a.role !== expected.role) problemFail(401, 'problem_authority_changed', 'authority');
}
export function pinProblemConfiguration(client: ProblemQuery, ports: ProblemCorePorts): () => void {
  if (!ports || !['write', 'legacy-read'].includes(ports.mode) || !ports.sources || !ports.authority || !Array.isArray(ports.bindings) || ports.bindings.length > 100) problemFail(500, 'problem_core_port_invalid', 'integrity');
  const mode = ports.mode, authority = ports.authority, sources = ports.sources, bindings = ports.bindings;
  const methods: { target: object; name: string; value: unknown }[] = [];
  const add = (target: object, names: readonly string[]) => {
    for (const name of names) {
      const value = (target as Record<string, unknown>)[name];
      if (typeof value !== 'function') problemFail(500, 'problem_core_port_invalid', 'integrity');
      methods.push({ target, name, value });
    }
  };
  add(client, ['query']); add(sources, ['capture', 'assertCurrent']); add(authority, ['assertImages', 'assertClinicalRead']);
  if (ports.mode === 'write') { add(authority, ['beginWrite', 'assertWrite', 'assertProblemCreate']); add(ports.audit, ['append']); }
  else add(authority, ['beginRead', 'assertRead', 'readWriteEligibility']);
  const audit = ports.mode === 'write' ? ports.audit : null;
  const originalBindings = bindings.map(b => {
    if (!b || !b.target || !Array.isArray(b.methods) || b.methods.length > 100 || b.methods.some((n: unknown) => typeof n !== 'string')) problemFail(500, 'problem_core_port_invalid', 'integrity');
    const names = [...b.methods]; add(b.target, names); return { entry: b, target: b.target, methods: b.methods, names };
  });
  return () => {
    if (ports.mode !== mode || ports.authority !== authority || ports.sources !== sources || ports.bindings !== bindings
      || bindings.length !== originalBindings.length || ports.mode === 'write' && ports.audit !== audit
      || originalBindings.some((b, i) => bindings[i] !== b.entry || b.entry.target !== b.target || b.entry.methods !== b.methods || b.methods.length !== b.names.length || b.names.some((n, j) => b.methods[j] !== n))
      || methods.some(m => (m.target as Record<string, unknown>)[m.name] !== m.value)) problemFail(500, 'problem_core_context_changed', 'integrity');
  };
}
function validateProof(candidate: ProblemSourceCandidate, proof: ProblemSourceProof) {
  if (!proof || proof.kind !== candidate.ref.kind || proof.sourceVersion !== candidate.ref.version) problemFail(500, 'invalid_problem_source_proof', 'integrity');
  let valid = false;
  switch (proof.kind) {
    case 'assessment_observation': case 'assessment_analysis': valid = proof.revisionId === candidate.ref.id && proof.schemaVersion === 2 && problemHash(proof.closureHash) && proof.complete === true; break;
    case 'clinical_diagnosis': valid = proof.diagnosisId === candidate.ref.id && problemId(proof.patientId) && problemId(proof.orthoCaseId) && problemHash(proof.contentHash) && proof.locked === true; break;
    case 'ceph_diagnosis': valid = proof.studyId === candidate.ref.id && proof.schemaVersion === 2 && problemHash(proof.completionHash) && problemHash(proof.externalSourceHash) && proof.assigned === true && proof.nonDiscarded === true
      && (candidate.snapshot as {completionWitnessSha256:string}).completionWitnessSha256 === proof.completionHash
      && journeyContentHash((candidate.snapshot as {source:unknown}).source) === proof.externalSourceHash; break;
    case 'facial_review': valid = proof.revisionId === candidate.ref.id && problemId(proof.documentId) && candidate.ref.member === `document_${proof.documentId}_review` && problemHash(proof.basisHash) && proof.head === 'latest' && proof.review === 'reviewed' && proof.nonemptyNote === true && proof.geometryValid === true && proof.documentCurrent === true
      && journeyContentHash((candidate.snapshot as {revision:{command:{content:{image:unknown}}}}).revision.command.content.image) === proof.basisHash; break;
  }
  if (!valid) problemFail(500, 'invalid_problem_source_proof', 'integrity');
}
/** A live authority failure is never a recoverable source-domain refusal. */
async function authorityResult<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) { if (error instanceof ProblemFault) throw new ProblemFault(error.status, error.code, 'authority'); throw error; }
}
async function integrityResult<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) { if (error instanceof ProblemFault) throw new ProblemFault(error.status, error.code, 'integrity'); throw error; }
}
export function createProblemOperation(client: ProblemQuery, input: ProblemScope, ports: ProblemCorePorts, operation: ProblemOperationName): ProblemOperation {
  const scope = problemScope(input), configuration = pinProblemConfiguration(client, ports);
  if (!['list', 'reserve', 'execute', 'direct-append', 'recover', 'acknowledge', 'cancel'].includes(operation)
    || (ports.mode === 'legacy-read') !== (operation === 'list' || operation === 'recover')) problemFail(500, 'problem_core_port_invalid', 'integrity');
  const authority = ports.authority, sources = ports.sources, query = client.query;
  const begin = ports.mode === 'write' ? ports.authority.beginWrite : ports.authority.beginRead;
  const current = ports.mode === 'write' ? ports.authority.assertWrite : ports.authority.assertRead;
  const images = authority.assertImages, clinical = authority.assertClinicalRead, capture = sources.capture, assertSource = sources.assertCurrent;
  const create = ports.mode === 'write' ? ports.authority.assertProblemCreate : null;
  const eligibility = ports.mode === 'legacy-read' ? ports.authority.readWriteEligibility : null;
  const audit = ports.mode === 'write' ? ports.audit : null, append = audit?.append;
  let actor: ProblemActor | null = null, begun = false, closed = false, imageObligation = false, clinicalObligation = false;
  const witnesses = new WeakMap<ProblemEvidence, { owner: ProblemOwner; witness: object; context: ProblemSourceContext; images: boolean }>();
  const check = () => { configuration(); if (closed) problemFail(500, 'problem_core_context_changed', 'integrity'); };
  const actual = () => { check(); if (!actor) problemFail(500, 'problem_core_context_changed', 'integrity'); return actor; };
  const assertClinical = async () => {
    if (!clinicalObligation) return;
    const expected = actual(); sameActor(await authorityResult(() => clinical.call(authority, client, scope, expected, operation)), expected); check();
  };
  const op: ProblemOperation = {
    scope, operation, get actor() { return actual(); },
    async begin(fences) {
      check(); if (fences !== undefined && fences !== 'review' && fences !== 'journal') problemFail(500, 'problem_core_context_changed', 'integrity');
      if (begun) problemFail(500, 'problem_core_context_changed', 'integrity'); begun = true;
      // Caller already holds the reset fence. Fixed table fences precede patient admission.
      if (fences) {
        await query.call(client, 'LOCK TABLE ortho_problem_source_reviews IN ROW EXCLUSIVE MODE'); check();
        if (fences === 'journal') { await query.call(client, 'LOCK TABLE ortho_problem_source_submissions IN ROW EXCLUSIVE MODE'); check(); }
      }
      actor = actorCopy(await authorityResult(() => begin.call(authority, client, scope, operation))); check(); await op.current();
    },
    async current(withImages = false) {
      imageObligation ||= withImages;
      const expected = actual(); sameActor(await authorityResult(() => current.call(authority, client, scope, expected, operation)), expected); check();
      if (imageObligation) { sameActor(await authorityResult(() => images.call(authority, client, scope, expected, operation)), expected); check();
        sameActor(await authorityResult(() => current.call(authority, client, scope, expected, operation)), expected); check(); }
      // Re-prove clinical visibility after every awaited general/image check.
      await assertClinical();
    },
    async images() { await op.current(true); },
    async clinicalRead() { clinicalObligation = true; await op.current(); },
    async create() {
      await op.current(); if (!create || operation !== 'execute' && operation !== 'direct-append') problemFail(500, 'problem_core_context_changed', 'integrity');
      sameActor(await authorityResult(() => create.call(authority, client, scope, actual(), operation)), actual()); await op.current();
    },
    async eligibility(target) {
      await op.current(); if (!eligibility || target !== 'cancel' && target !== 'direct-append') problemFail(500, 'problem_core_context_changed', 'integrity');
      const result = await authorityResult(() => eligibility.call(authority, client, scope, actual(), target)); await op.current();
      if (typeof result !== 'boolean') problemFail(500, 'problem_core_port_invalid', 'integrity'); return result;
    },
    async query<Row extends object = Record<string, unknown>>(sql: string, values?: unknown[], withImages = false, beforeSnapshot?: (rows: readonly Row[]) => void, rawLimits: ProblemQueryLimits = {}) {
      const limits = detachProblemValue(rawLimits, 1024, 20, 2);
      if (Object.keys(limits).some(key => !['maxRows','maxBytes','mutation','read'].includes(key))
        || limits.read !== undefined && limits.read !== 'clinical') problemFail(500, 'problem_core_context_changed', 'integrity');
      clinicalObligation ||= limits.read === 'clinical';
      if (problemMetadata(limits.maxRows ?? 512) > 512 || problemMetadata(limits.maxBytes ?? 3145728) > 3145728) problemFail(500, 'problem_query_budget', 'integrity');
      const args = values === undefined ? undefined : detachProblemValue(values);
      await op.current(withImages);
      const assertCreate = async () => {
        if (!create || operation !== 'execute' && operation !== 'direct-append') problemFail(500, 'problem_core_context_changed', 'integrity');
        const expected = actual(); sameActor(await authorityResult(() => create.call(authority, client, scope, expected, operation)), expected); check();
        await assertClinical();
      };
      if (limits.mutation !== undefined && limits.mutation !== 'problem-create') problemFail(500, 'problem_core_context_changed', 'integrity');
      if (limits.mutation === 'problem-create') await assertCreate();
      const result = await query.call(client, sql, args) as { rows: Row[] };
      check();
      const descriptor = result && Object.getOwnPropertyDescriptor(result, 'rows');
      if (!descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value) || descriptor.value.length > (limits.maxRows ?? 512)) problemFail(500, 'problem_query_budget', 'integrity');
      const rawRows = descriptor.value as Row[];
      guardProblemValue(rawRows, limits.maxBytes ?? 3145728);
      // Own bounded rows before an authority await can mutate caller buffers.
      // No content callback/decoder consumes them until the post-SQL gate passes.
      const rows = detachProblemValue(rawRows, limits.maxBytes ?? 3145728);
      await op.current(withImages);
      beforeSnapshot?.(rows);
      if (limits.mutation === 'problem-create') await assertCreate();
      await op.current(withImages);
      if (limits.mutation === 'problem-create') await assertCreate();
      return { rows };
    },
    async capture(ownerInput) {
      const owner = detachProblemValue(ownerInput, 8192, 100, 8);
      if (owner.patientId !== scope.patientId || owner.orthoCaseId !== scope.orthoCaseId || !problemId(owner.clinicalCaseId)) problemFail(500, 'problem_core_context_changed', 'integrity');
      await op.current();
      const context: ProblemSourceContext = Object.freeze({ scope, actor: actual(), operation,
        query: op.query.bind(op),
        clinicalQuery: <Row extends object = Record<string, unknown>>(sql: string, values?: unknown[]) => op.query<Row>(sql, values, false, undefined, {read:'clinical'}),
        current: () => op.current(), images: () => op.images(), clinicalRead: () => op.clinicalRead() });
      const result = await capture.call(sources, client, context, owner); check();
      const entriesDescriptor = result && Object.getOwnPropertyDescriptor(result, 'entries'), witnessDescriptor = result && Object.getOwnPropertyDescriptor(result, 'witness');
      if (!entriesDescriptor || !('value' in entriesDescriptor) || !Array.isArray(entriesDescriptor.value) || entriesDescriptor.value.length > 512
        || !witnessDescriptor || !('value' in witnessDescriptor) || !witnessDescriptor.value || typeof witnessDescriptor.value !== 'object') problemFail(500, 'invalid_problem_source_proof', 'integrity');
      const entries = detachProblemValue(entriesDescriptor.value as {candidate:ProblemSourceCandidate;proof:ProblemSourceProof}[], 2097152);
      await op.current();
      const candidates = entries.map(entry => {
        const candidate = decodeProblemCandidate(entry.candidate, owner); validateProof(candidate, entry.proof);
        if (entry.proof.kind === 'clinical_diagnosis' && (entry.proof.patientId !== scope.patientId || entry.proof.orthoCaseId !== scope.orthoCaseId)) problemFail(500, 'invalid_problem_source_proof', 'integrity');
        return candidate;
      });
      if (new Set(candidates.map(c => c.identity)).size !== candidates.length) problemFail(500, 'invalid_problem_source_proof', 'integrity');
      const evidence: ProblemEvidence = Object.freeze({ candidates: Object.freeze(candidates) as unknown as ProblemSourceCandidate[] });
      witnesses.set(evidence, { owner, witness: witnessDescriptor.value as object, context, images: candidates.some(c => c.requiresImages) });
      await op.assertEvidence(evidence); return evidence;
    },
    async assertEvidence(evidence) {
      const witness = witnesses.get(evidence); if (!witness) problemFail(500, 'problem_core_context_changed', 'integrity');
      await op.current(witness.images);
      await integrityResult(() => assertSource.call(sources, client, witness.context, witness.owner, witness.witness));
      await op.current(witness.images);
    },
    async audit(event, withImages = false) {
      const owned = detachProblemValue(event, 32768, 200, 8); sameActor(owned.actor, actual());
      if (!append || !audit || !problemId(owned.entityId) || owned.details.orthoCaseId !== scope.orthoCaseId || !problemHash(owned.details.requestFingerprint)
        || owned.action === 'ortho.problem_source.review' && (owned.entity !== 'ortho_problem_source_reviews' || owned.details.patientId !== scope.patientId || !problemId(owned.details.problemId) || !['create', 'link'].includes(owned.details.action))
        || owned.action === 'ortho.problem_submission' && (owned.entity !== 'ortho_problem_source_submissions' || !['reserved', 'committed', 'cancelled_before_arrival', 'cancelled', 'acknowledged'].includes(owned.details.event) || !['pending', 'committed', 'cancelled'].includes(owned.details.state))
        || owned.action !== 'ortho.problem_source.review' && owned.action !== 'ortho.problem_submission') problemFail(500, 'invalid_problem_audit', 'integrity');
      await op.current(withImages); await integrityResult(() => append.call(audit, client, owned)); await op.current(withImages);
    },
    close() { closed = true; },
  };
  Object.freeze(op); return op;
}
