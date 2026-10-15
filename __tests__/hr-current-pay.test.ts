import { expect, it } from 'vitest';
import { currentStaffPay } from '../lib/hr-current-pay';
import type { HrStaffView } from '../lib/hr-shared';
import type { ContractInput } from '../lib/hr-pay-terms';
import { hrHref, hrId } from '../lib/hr-navigation';
const staff = { id: 1, contractKind: 'salary', payTerms: { amountMinor: 100000, currency: 'YER', period: 'monthly', effectiveOn: '2026-01-01' }, hireDate: null, endDate: null } as HrStaffView;
const contract: ContractInput = { id: 7, contractNumber: 'SYN-7', versionNumber: 1, status: 'approved', startDate: '2099-02-01', endDate: null, kind: 'salary', salaryMinor: 150000, currency: 'YER', salaryPeriod: 'monthly', commissionRatePercent: null, doctorPartyId: null };
it('future approval changes the displayed source at the clinic-day boundary without mutating its input', () => {
  const before = JSON.stringify({ staff, contract });
  expect(currentStaffPay(staff, [contract], '2099-01-31')).toMatchObject({ source: 'staff_profile', terms: { salaryMinor: 100000 }, profilePayLocked: false });
  expect(currentStaffPay(staff, [contract], '2099-02-01')).toMatchObject({ source: 'contract', terms: { salaryMinor: 150000 }, profilePayLocked: true, blockers: [] });
  expect(JSON.stringify({ staff, contract })).toBe(before);
});
it.each([['YER', 150000], ['SAR', 150050], ['USD', 150099]] as const)('preserves exact native %s minor units', (currency, salaryMinor) => {
  expect(currentStaffPay(staff, [{ ...contract, currency, salaryMinor }], '2099-02-01').terms).toMatchObject({ currency, salaryMinor });
});
it('does not call an arbitrary independent overlap the governing source', () => {
  const pay = currentStaffPay(staff, [contract, { ...contract, id: 8, versionNumber: 5 }], '2099-02-01');
  expect(pay.source).toBeNull(); expect(pay.terms).toBeNull(); expect(pay.blockers).toContain('contract_priority_unresolved'); expect(pay.profilePayLocked).toBe(true);
});
it('retains a dated addendum as the governing source', () => {
  expect(currentStaffPay(staff, [contract, { ...contract, id: 8, parentContractId: 7, versionNumber: 2, salaryMinor: 175000 }], '2099-02-01')).toMatchObject({ source: 'contract', contract: { id: 8 }, terms: { salaryMinor: 175000 } });
});
it('changes the displayed compensation kind with its governing contract, without rewriting the profile', () => {
  const old = { ...staff, contractKind: 'commission' as const, payTerms: null };
  expect(currentStaffPay(old, [contract], '2099-01-31').terms?.kind).toBe('commission');
  expect(currentStaffPay(old, [contract], '2099-02-01').terms?.kind).toBe('salary');
  expect(old.contractKind).toBe('commission'); expect(old.payTerms).toBeNull();
});
it('shows unresolved coverage and terminal history instead of silently showing an old wage', () => {
  for (const c of [{ ...contract, endDate: '2099-02-01' }, { ...contract, status: 'terminated', approvedBy: 'synthetic' }]) {
    const pay = currentStaffPay(staff, [c], '2099-02-02'); expect(pay.source).toBeNull(); expect(pay.terms).toBeNull(); expect(pay.blockers.length).toBeGreaterThan(0);
  }
});
it('keeps employee/profile tab across HR links and rejects malformed/external values', () => {
  expect(hrHref('tab=staff&staffId=7&profileTab=leaves', { tab: 'contracts' })).toBe('/hr?tab=contracts&staffId=7&profileTab=leaves');
  expect(hrHref('tab=staff&staffId=7&contractId=8', { staffId: null, contractId: null })).toBe('/hr?tab=staff');
  expect(hrHref('redirect=https://example.com&staffId=-1&tab=javascript:alert(1)', {})).toBe('/hr');
  for (const id of ['-1', '0', '1e3', '01', '9007199254740992']) expect(hrId(id)).toBe('');
});
