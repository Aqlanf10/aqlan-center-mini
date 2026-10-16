import { createHash } from 'node:crypto';
import { buildIdentityPreview, IdentityPreviewError, parseIdentityPreviewRequest } from './hr-identity-preview';
import type { IdentitySources } from './hr-identity-preview-shared';

export const HR_PERSON_IDENTITY_BASE = 'fe3b66740882b83aeeeee969de6bace7ed50a492';
export const identityDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface PersonIdentityDecision {
  key: string; staffId: number | null; expectedRevision: number | null; fullName: string | null;
  userIds: number[]; partyId: number | null; confirmedSamePerson: true;
  reason: string; sourceRef: string; closeAccountLinkIds: string[]; closePartyLinkId: string | null;
}
export interface PersonIdentityStep {
  key: string; staffId: number | null; revision: number; action: 'create' | 'confirm' | 'link' | 'skip' | 'conflict';
  userIds: number[]; partyId: number | null; conflicts: string[];
}
export interface PersonIdentityPlan {
  version: 1; baseCommit: typeof HR_PERSON_IDENTITY_BASE; schemaFingerprint: string; sourceFingerprint: string;
  decisions: PersonIdentityDecision[]; steps: PersonIdentityStep[]; planDigest: string;
}
const fail = (): never => { throw new IdentityPreviewError(400, 'قرار الهوية يحتاج معرفات صريحة ومراجعة وسببًا ومرجع إثبات صالحًا.'); };
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const linkId = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v);
const text = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;

/** Strict projection: account permissions, wages and role changes are not commands here. */
export function parsePersonIdentityDecisions(value: unknown): PersonIdentityDecision[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return fail();
  const keys = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some(k => !['key','staffId','expectedRevision','fullName','userIds','partyId','confirmedSamePerson','reason','sourceRef','closeAccountLinkIds','closePartyLinkId'].includes(k))
      || typeof r.key !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(r.key) || keys.has(r.key)
      || (r.staffId !== null && !id(r.staffId)) || (r.partyId !== null && !id(r.partyId)) || r.confirmedSamePerson !== true
      || !text(r.reason,3,1000) || !text(r.sourceRef,3,200)
      || (r.staffId === null ? r.expectedRevision !== null || !text(r.fullName,2,120)
        : !Number.isSafeInteger(r.expectedRevision) || Number(r.expectedRevision) < 0 || r.fullName !== null)) return fail();
    const closeIds = r.closeAccountLinkIds ?? [], closeParty = r.closePartyLinkId ?? null;
    if (!Array.isArray(closeIds) || closeIds.length > 30 || closeIds.some(v => !linkId(v)) || new Set(closeIds).size !== closeIds.length
      || (closeParty !== null && !linkId(closeParty)) || (r.staffId === null && (closeIds.length > 0 || closeParty !== null))) return fail();
    const parsed = parseIdentityPreviewRequest({ sourceDigest: '0'.repeat(64), decisions: [{ userIds:r.userIds,
      partyIds:r.partyId === null ? [] : [r.partyId],staffId:r.staffId,confirmedSamePerson:true }] }).decisions[0];
    keys.add(r.key);
    return { key:r.key,staffId:parsed.staffId,expectedRevision:r.expectedRevision as number|null,
      fullName:r.fullName === null ? null : String(r.fullName).trim(),userIds:parsed.userIds,partyId:r.partyId as number|null,
      confirmedSamePerson:true as const,reason:r.reason.trim(),sourceRef:r.sourceRef.trim(),
      closeAccountLinkIds:[...closeIds].sort(),closePartyLinkId:closeParty };
  }).sort((a,b) => a.key.localeCompare(b.key));
}

/** A plan is derived, never a trusted client classification. No ID/sequence is allocated. */
export function buildPersonIdentityPlan(sources: IdentitySources, input: unknown): PersonIdentityPlan {
  if (!sources.schemaFingerprint) throw new IdentityPreviewError(503, 'نموذج الهوية غير مسجل؛ التطبيق غير متاح.');
  const decisions = parsePersonIdentityDecisions(input);
  const closedAccounts = new Set(decisions.flatMap(d => d.closeAccountLinkIds));
  const closedParties = new Set(decisions.flatMap(d => d.closePartyLinkId ? [d.closePartyLinkId] : []));
  const prospective = { ...sources,
    accountLinks:sources.accountLinks?.map(l => closedAccounts.has(l.id) ? {...l,closed:true} : l),
    partyLinks:sources.partyLinks?.map(l => closedParties.has(l.id) ? {...l,closed:true} : l),
  };
  const preview = buildIdentityPreview(prospective, decisions.map(d => ({ staffId:d.staffId,userIds:d.userIds,
    partyIds:d.partyId === null ? [] : [d.partyId],confirmedSamePerson:true })));
  const steps: PersonIdentityStep[] = decisions.map((d,i) => {
    const candidate = preview.candidates[i], staff = sources.staff.find(s => s.id === d.staffId);
    const revision = staff?.identityRevision ?? 0;
    const conflicts: string[] = candidate.action === 'conflict' ? candidate.reasons.filter(r => r !== 'explicit_preview') : [];
    if (d.staffId !== null && d.expectedRevision !== revision) conflicts.push('stale_revision');
    if (candidate.partyIds.length && d.partyId === null) conflicts.push('financial_selection_required');
    if (candidate.userIds.some(userId => sources.staff.some(s => s.userId === userId && s.id !== d.staffId))) conflicts.push('legacy_account_reserved');
    if (d.closeAccountLinkIds.some(id => !(sources.accountLinks ?? []).some(l => l.id === id && l.staffId === d.staffId && !l.closed))
      || (d.closePartyLinkId !== null && !(sources.partyLinks ?? []).some(l => l.id === d.closePartyLinkId && l.staffId === d.staffId && !l.closed))) conflicts.push('invalid_link_closure');
    if (revision === 0 && (d.closeAccountLinkIds.length || d.closePartyLinkId)) conflicts.push('identity_not_converted');
    if (d.closeAccountLinkIds.some(id => (sources.accountLinks ?? []).some(l => l.id === id && candidate.userIds.includes(l.userId)))
      || (d.closePartyLinkId !== null && sources.partyLinks?.some(l => l.id === d.closePartyLinkId && l.partyId === d.partyId))) conflicts.push('close_and_reopen_same_link');
    const changed = d.closeAccountLinkIds.length > 0 || d.closePartyLinkId !== null
      || candidate.userIds.some(userId => !(sources.accountLinks ?? []).some(l => !l.closed && l.staffId === d.staffId && l.userId === userId))
      || (d.partyId !== null && !(sources.partyLinks ?? []).some(l => !l.closed && l.staffId === d.staffId && l.partyId === d.partyId));
    return { key:d.key,staffId:d.staffId,revision,userIds:candidate.userIds,partyId:d.partyId,
      action:conflicts.length ? 'conflict' : d.staffId === null ? 'create' : revision === 0 ? 'confirm' : changed ? 'link' : 'skip',
      conflicts:[...new Set(conflicts)] };
  });
  const content: Omit<PersonIdentityPlan,'planDigest'> = { version:1,baseCommit:HR_PERSON_IDENTITY_BASE,schemaFingerprint:sources.schemaFingerprint,
    sourceFingerprint:buildIdentityPreview(sources).sourceDigest,decisions,steps };
  return { ...content,planDigest:identityDigest(content) };
}

export function parsePersonIdentityPlan(value: unknown): PersonIdentityPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const p = value as PersonIdentityPlan;
  if (Object.keys(p).some(k => !['version','baseCommit','schemaFingerprint','sourceFingerprint','decisions','steps','planDigest'].includes(k))
    || p.version !== 1 || p.baseCommit !== HR_PERSON_IDENTITY_BASE
    || [p.schemaFingerprint,p.sourceFingerprint,p.planDigest].some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))
    || !Array.isArray(p.steps) || p.steps.length !== p.decisions?.length) return fail();
  const decisions = parsePersonIdentityDecisions(p.decisions);
  for (const step of p.steps) {
    if (!step || typeof step !== 'object' || Object.keys(step).some(k => !['key','staffId','revision','action','userIds','partyId','conflicts'].includes(k))
      || typeof step.key !== 'string' || !/^[a-zA-Z0-9_-]{1,60}$/.test(step.key)
      || (step.staffId !== null && !id(step.staffId)) || (step.partyId !== null && !id(step.partyId))
      || !Number.isSafeInteger(step.revision) || step.revision < 0 || !['create','confirm','link','skip','conflict'].includes(step.action)
      || !Array.isArray(step.userIds) || step.userIds.length > 1000 || step.userIds.some(v => !id(v))
      || !Array.isArray(step.conflicts) || step.conflicts.length > 30 || step.conflicts.some(v => typeof v !== 'string' || !/^[a-z_]{1,80}$/.test(v))) return fail();
  }
  // Steps are recomputed under source locks at apply. Digest binds the exact reviewed envelope.
  const content = { version:p.version,baseCommit:p.baseCommit,schemaFingerprint:p.schemaFingerprint,
    sourceFingerprint:p.sourceFingerprint,decisions,steps:p.steps };
  if (identityDigest(content) !== p.planDigest) return fail();
  return { ...content,planDigest:p.planDigest };
}
