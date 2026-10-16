import { describe, expect, it } from 'vitest';
import { buildIdentityPreview, parseIdentityPreviewRequest } from '../lib/hr-identity-preview';
import type { IdentitySources } from '../lib/hr-identity-preview-shared';

function sources(): IdentitySources {
  return {
    accounts: [
      { id: 1, label: 'اسم اصطناعي مطابق', role: 'admin', active: true, partyId: null },
      { id: 2, label: 'اسم اصطناعي مطابق', role: 'doctor', active: true, partyId: 10 },
      { id: 3, label: 'استقبال اصطناعي', role: 'reception', active: false, partyId: null },
    ],
    parties: [{ id: 10, label: 'طبيب اصطناعي', kind: 'doctor', active: true },
      { id: 11, label: 'طبيب بلا حساب', kind: 'doctor', active: true },
      { id: 12, label: 'مورد غير موظف', kind: 'supplier', active: true }],
    staff: [{ id: 20, label: 'ملف ناقص', userId: 3, workStatus: 'active', hireDateRecorded: false, contractKind: 'salary', salaryTermsComplete: false }],
    contracts: [], payrollLinks: [],
  };
}
describe('identity evidence has no name-based person union or employment inference', () => {
  it('keeps equal names separate, reception linked, doctor-only party independent and suppliers excluded', () => {
    const result = buildIdentityPreview(sources());
    expect(result.candidates.map(c => c.key)).toEqual(['staff:20','user:1','user:2','party:11']);
    expect(result.counts).toEqual({ create: 0, link: 0, skip: 4, conflict: 0 });
    expect(result.candidates.find(c => c.key === 'staff:20')?.unknowns).toEqual(['missing_hire_date','missing_contract','incomplete_salary','inactive_account']);
    expect(result.candidates.find(c => c.key === 'party:11')?.unknowns).toContain('employment_unconfirmed');
    expect(JSON.stringify(result)).not.toContain('مورد غير موظف');
  });
  it('accepts two explicitly identified accounts for one proposed incomplete person, without changing any input', () => {
    const input = sources(), before = structuredClone(input);
    const result = buildIdentityPreview(input, [{ userIds: [1,2], partyIds: [10], staffId: null, confirmedSamePerson: true }]);
    expect(result.candidates[0]).toMatchObject({ action: 'create', userIds: [1,2], partyIds: [10], staffIds: [], explicit: true });
    expect(result.candidates[0].unknowns).toContain('employment_unconfirmed');
    expect(input).toEqual(before);
    expect(result.sources.staff).toHaveLength(1);
    expect(result.sources.contracts).toEqual([]);
  });
  it('proposes linking to an explicitly selected existing HR file', () => {
    const result = buildIdentityPreview(sources(), [{ userIds: [1,3], partyIds: [], staffId: 20, confirmedSamePerson: true }]);
    expect(result.candidates[0]).toMatchObject({ action: 'link', userIds: [1,3], staffIds: [20] });
  });
  it('shared party is not shared person until all accounts are explicitly included', () => {
    const input = sources(); input.accounts[0].partyId = 10;
    expect(buildIdentityPreview(input).candidates.find(c => c.key === 'user:1')?.reasons).toContain('shared_party');
    expect(buildIdentityPreview(input, [{ userIds: [1,2], partyIds: [10], staffId: null, confirmedSamePerson: true }]).candidates[0].action).toBe('create');
  });
  it('conflicts on a different HR file, even if the names and party agree', () => {
    const input = sources(); input.staff.push({ ...input.staff[0], id: 21, userId: 1 });
    const result = buildIdentityPreview(input, [{ userIds: [1,3], partyIds: [], staffId: 20, confirmedSamePerson: true }]);
    expect(result.candidates[0].action).toBe('conflict');
    expect(result.candidates[0].reasons).toContain('different_staff');
  });
  it('does not bypass existing HR by proposing a new file', () => {
    expect(buildIdentityPreview(sources(), [{ userIds: [3], partyIds: [], staffId: null, confirmedSamePerson: true }]).candidates[0].reasons).toContain('select_existing_staff');
  });
  it('exposes contract and historical payroll identity disagreements without touching money', () => {
    const input = sources(); input.staff[0].userId = 2;
    input.contracts = [{ id: 30, staffId: 20, partyId: 10, status: 'approved' }];
    input.payrollLinks = [{ staffId: 20, partyId: 11 }];
    expect(buildIdentityPreview(input).candidates[0]).toMatchObject({ action: 'conflict', partyIds: [10,11] });
  });
  it('flags missing references and rejects a referenced supplier as a worker', () => {
    const input = sources(); input.accounts[0].partyId = 999; input.accounts[1].partyId = 12;
    const result = buildIdentityPreview(input);
    expect(result.candidates.find(c => c.key === 'user:1')?.reasons).toContain('missing_source');
    expect(result.candidates.find(c => c.key === 'user:2')?.reasons).toContain('excluded_party');
  });
  it('strictly projects fields, including from accidental oversized source rows', () => {
    const input = sources();
    Object.assign(input.accounts[0], { password_hash: 'secret-marker', commission_config: 'draft-marker', permissions: 'grant-marker' });
    Object.assign(input.staff[0], { salary_amount_minor: 987654321, phone: 'private-phone' });
    const json = JSON.stringify(buildIdentityPreview(input));
    for (const forbidden of ['secret-marker','draft-marker','grant-marker','987654321','private-phone','password_hash','commission_config','permissions']) expect(json).not.toContain(forbidden);
  });
  it('is deterministic across row order and detects a changed source', () => {
    const input = sources(), before = buildIdentityPreview(input);
    input.accounts.reverse(); input.parties.reverse();
    expect(buildIdentityPreview(input)).toEqual(before);
    input.accounts[0].active = !input.accounts[0].active;
    expect(buildIdentityPreview(input).sourceDigest).not.toBe(before.sourceDigest);
  });
  it('duplicate explicit decisions remain conflicts instead of silently winning by order', () => {
    const choice = { userIds: [1], partyIds: [], staffId: null, confirmedSamePerson: true as const };
    const result = buildIdentityPreview(sources(), [choice, choice]);
    expect(result.candidates.slice(0,2).every(c => c.action === 'conflict' && c.reasons.includes('duplicate_selection'))).toBe(true);
  });
  it('validates only explicit, bounded identifier choices; rejects authority, credentials, names and unconfirmed unions', () => {
    const valid = { sourceDigest: 'a'.repeat(64), decisions: [{ userIds: [2,1], partyIds: [10], staffId: null, confirmedSamePerson: true }] };
    expect(parseIdentityPreviewRequest(valid).decisions[0].userIds).toEqual([1,2]);
    for (const bad of [null, { ...valid, actor: 1 }, { ...valid, sourceDigest: 'old' },
      { ...valid, decisions: [{ ...valid.decisions[0], confirmedSamePerson: false }] },
      { ...valid, decisions: [{ ...valid.decisions[0], userIds: [1,1] }] },
      { ...valid, decisions: [{ ...valid.decisions[0], partyIds: [-1] }] },
      { ...valid, decisions: [{ ...valid.decisions[0], staffId: '20' }] },
      { ...valid, decisions: [{ ...valid.decisions[0], commission_config: {} }] }]) expect(() => parseIdentityPreviewRequest(bad)).toThrow();
  });
});
