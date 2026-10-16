import { createHash } from 'node:crypto';
import type { IdentityCandidate, IdentityDecision, IdentityPreview, IdentityReason, IdentitySources } from './hr-identity-preview-shared';

const ids = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export class IdentityPreviewError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function parseIdentityPreviewRequest(value: unknown): { sourceDigest: string; decisions: IdentityDecision[] } {
  const fail = (): never => { throw new IdentityPreviewError(400, 'اختر معرفات صريحة وأكد أنها للشخص نفسه داخل المعاينة.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['sourceDigest', 'decisions'].includes(key))
    || typeof body.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.sourceDigest)
    || !Array.isArray(body.decisions) || body.decisions.length > 20) return fail();
  const decisions = body.decisions.map((raw): IdentityDecision => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some(key => !['userIds', 'partyIds', 'staffId', 'confirmedSamePerson'].includes(key))
      || row.confirmedSamePerson !== true || (row.staffId !== null && !validId(row.staffId))) return fail();
    for (const key of ['userIds', 'partyIds']) {
      const list = row[key];
      if (!Array.isArray(list) || list.length > 30 || list.some(id => !validId(id)) || new Set(list).size !== list.length) return fail();
    }
    const userIds = ids(row.userIds as number[]), partyIds = ids(row.partyIds as number[]);
    if (!userIds.length && !partyIds.length && row.staffId === null) return fail();
    return { userIds, partyIds, staffId: row.staffId as number | null, confirmedSamePerson: true };
  });
  return { sourceDigest: body.sourceDigest, decisions };
}

/** Deterministic suggestions, never executable commands. Names are display-only. */
export function buildIdentityPreview(input: IdentitySources, decisions: IdentityDecision[] = []): IdentityPreview {
  // Explicit projection also keeps accidental extra fields out of digests and responses.
  const sources: IdentitySources = {
    accounts: input.accounts.map(a => ({ id: a.id, label: a.label, role: a.role, active: a.active, partyId: a.partyId })).sort((a,b) => a.id-b.id),
    staff: input.staff.map(s => ({ id: s.id, label: s.label, userId: s.userId, workStatus: s.workStatus,
      hireDateRecorded: s.hireDateRecorded, salaryTermsComplete: s.salaryTermsComplete, contractKind: s.contractKind })).sort((a,b) => a.id-b.id),
    parties: input.parties.map(p => ({ id: p.id, label: ['doctor','employee'].includes(p.kind) ? p.label : null, kind: p.kind, active: p.active })).sort((a,b) => a.id-b.id),
    contracts: input.contracts.map(c => ({ id: c.id, staffId: c.staffId, partyId: c.partyId, status: c.status })).sort((a,b) => a.id-b.id),
    payrollLinks: input.payrollLinks.map(p => ({ staffId: p.staffId, partyId: p.partyId })).sort((a,b) => a.staffId-b.staffId || a.partyId-b.partyId),
  };
  const accounts = new Map(sources.accounts.map(a => [a.id, a]));
  const staff = new Map(sources.staff.map(s => [s.id, s]));
  const parties = new Map(sources.parties.map(p => [p.id, p]));
  const candidates: IdentityCandidate[] = [];
  const usedUsers = new Set<number>(), usedStaff = new Set<number>(), usedParties = new Set<number>();
  function expand(initialUsers: number[], initialParties: number[], initialStaff: number[]) {
    const staffIds = ids([...initialStaff, ...sources.staff.filter(s => s.userId !== null && initialUsers.includes(s.userId)).map(s => s.id)]);
    const userIds = ids([...initialUsers, ...staffIds.flatMap(id => staff.get(id)?.userId ? [staff.get(id)!.userId!] : [])]);
    const partyIds = ids([...initialParties, ...userIds.flatMap(id => accounts.get(id)?.partyId ? [accounts.get(id)!.partyId!] : []),
      ...sources.contracts.filter(c => staffIds.includes(c.staffId) && c.partyId !== null && ['active','approved'].includes(c.status)).map(c => c.partyId!),
      ...sources.payrollLinks.filter(p => staffIds.includes(p.staffId)).map(p => p.partyId)]);
    return { staffIds, userIds, partyIds };
  }
  const referenceKeys = (refs: ReturnType<typeof expand>) => [
    ...refs.userIds.map(id => `u:${id}`), ...refs.partyIds.map(id => `p:${id}`), ...refs.staffIds.map(id => `s:${id}`),
  ];
  // Count each expanded reference once per decision, before classifying any of
  // them. Otherwise a stored staff -> user -> party link can evade the raw-ID
  // counter. This detects overlap; it never unions people via a shared party/name.
  const expandedDecisions = decisions.map(d => expand(d.userIds, d.partyIds, d.staffId === null ? [] : [d.staffId]));
  const selected = new Map<string, number>();
  for (const refs of expandedDecisions) for (const key of referenceKeys(refs)) selected.set(key, (selected.get(key) ?? 0) + 1);
  function candidate(key: string, initialUsers: number[], initialParties: number[], initialStaff: number[], decision?: IdentityDecision,
    refs = expand(initialUsers, initialParties, initialStaff)) {
    const { staffIds, userIds, partyIds } = refs;
    const reasons: IdentityReason[] = [], unknowns: IdentityReason[] = [];
    if (userIds.some(id => !accounts.has(id)) || staffIds.some(id => !staff.has(id)) || partyIds.some(id => !parties.has(id))) reasons.push('missing_source');
    if (partyIds.some(id => parties.has(id) && !['doctor','employee'].includes(parties.get(id)!.kind))) reasons.push('excluded_party');
    if (partyIds.length > 1) reasons.push('different_parties');
    if (staffIds.length > 1 || (decision?.staffId && staffIds.some(id => id !== decision.staffId))) reasons.push('different_staff');
    if (partyIds.some(id => sources.accounts.some(a => a.partyId === id && !userIds.includes(a.id)))) reasons.push('shared_party');
    // Shared contracts/payroll also require review even when no account is linked.
    if (partyIds.some(id => sources.contracts.some(c => c.partyId === id && ['active','approved'].includes(c.status) && !staffIds.includes(c.staffId))
      || sources.payrollLinks.some(p => p.partyId === id && !staffIds.includes(p.staffId)))) reasons.push('different_staff');
    if (decision && referenceKeys(refs).some(id => (selected.get(id) ?? 0) > 1)) reasons.push('duplicate_selection');
    if (decision && decision.staffId === null && staffIds.length) reasons.push('select_existing_staff');
    if (!staffIds.length) unknowns.push('missing_staff', 'employment_unconfirmed');
    for (const id of staffIds) {
      const s = staff.get(id); if (!s) continue;
      if (!s.hireDateRecorded) unknowns.push('missing_hire_date');
      if (!sources.contracts.some(c => c.staffId === id && ['approved','active'].includes(c.status))) unknowns.push('missing_contract');
      if (['salary','salary_commission'].includes(s.contractKind) && !s.salaryTermsComplete) unknowns.push('incomplete_salary');
    }
    if (userIds.some(id => accounts.get(id)?.active === false)) unknowns.push('inactive_account');
    if (partyIds.some(id => parties.get(id)?.active === false)) unknowns.push('inactive_party');
    let action: IdentityCandidate['action'] = 'skip';
    if (reasons.length) action = 'conflict';
    else if (decision) {
      action = decision.staffId === null ? 'create'
        : userIds.some(id => staff.get(decision.staffId!)?.userId !== id) || initialParties.some(id => !sources.accounts.some(a => a.id === staff.get(decision.staffId!)?.userId && a.partyId === id)) ? 'link' : 'skip';
    }
    reasons.push(decision ? 'explicit_preview' : staffIds.length ? 'existing_staff' : 'employment_unconfirmed');
    candidates.push({ key, action, userIds, staffIds, partyIds, reasons: [...new Set(reasons)], unknowns: [...new Set(unknowns)], explicit: Boolean(decision) });
    userIds.forEach(id => usedUsers.add(id)); staffIds.forEach(id => usedStaff.add(id)); partyIds.forEach(id => usedParties.add(id));
  }
  decisions.forEach((d, i) => candidate(`review:${i+1}`, d.userIds, d.partyIds, d.staffId === null ? [] : [d.staffId], d, expandedDecisions[i]));
  for (const s of sources.staff) if (!usedStaff.has(s.id)) candidate(`staff:${s.id}`, [], [], [s.id]);
  for (const a of sources.accounts) if (!usedUsers.has(a.id)) candidate(`user:${a.id}`, [a.id], [], []);
  for (const p of sources.parties) if (!usedParties.has(p.id) && ['doctor','employee'].includes(p.kind)) candidate(`party:${p.id}`, [], [p.id], []);
  const sourceDigest = digest(sources);
  return { version: 1, readOnly: true, sourceDigest, previewDigest: digest({ sourceDigest, decisions, candidates }), sources, candidates,
    counts: { create: candidates.filter(c => c.action === 'create').length, link: candidates.filter(c => c.action === 'link').length,
      skip: candidates.filter(c => c.action === 'skip').length, conflict: candidates.filter(c => c.action === 'conflict').length } };
}
