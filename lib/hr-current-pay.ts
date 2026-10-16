import { commissionPolicyResolver, loadCommissionPolicyTimelines, type DbClient } from './db';
import { CONTRACT_SELECT, contractFromRow, hasCommission, resolvePayTerms, type ContractInput, type PayTerms, type PayBlocker } from './hr-pay-terms';
import type { HrStaffView } from './hr-shared';

/** A read projection of documented terms, never an accrual or a payment. */
export interface HrCurrentPay {
  asOf: string;
  source: 'contract' | 'staff_profile' | null;
  terms: PayTerms | null;
  effectiveOn: string | null;
  contract: Pick<ContractInput, 'id' | 'contractNumber' | 'versionNumber' | 'commissionRatePercent' | 'doctorPartyId'> | null;
  profilePayLocked: boolean;
  blockers: PayBlocker[];
  commissionPolicyPercent: number | null;
}

export function currentStaffPay(staff: HrStaffView, contracts: readonly ContractInput[], day: string): HrCurrentPay {
  if (staff.workStatus === 'unconfirmed' || staff.contractKind === 'unspecified') return {
    asOf:day,source:null,terms:null,effectiveOn:null,contract:null,profilePayLocked:true,blockers:['no_pay_terms'],commissionPolicyPercent:null,
  };
  const resolution = resolvePayTerms({ kind: staff.contractKind, salaryMinor: staff.payTerms?.amountMinor ?? null,
    currency: staff.payTerms?.currency as PayTerms['currency'] ?? null, salaryPeriod: staff.payTerms?.period ?? null,
    effectiveOn: staff.payTerms?.effectiveOn ?? null, hireDate: staff.hireDate, endDate: staff.endDate }, contracts, { start: day, end: day });
  const unresolved = resolution.blockers.some(code => ['contract_priority_unresolved', 'contract_coverage_unresolved', 'contract_lifecycle_unresolved', 'profile_terms_effective_after_period_start'].includes(code));
  const contract = resolution.contract;
  return { asOf: day, source: unresolved ? null : resolution.source, terms: unresolved ? null : resolution.terms,
    effectiveOn: contract?.startDate ?? staff.payTerms?.effectiveOn ?? null,
    contract: contract && !unresolved ? { id: contract.id, contractNumber: contract.contractNumber, versionNumber: contract.versionNumber,
      commissionRatePercent: contract.commissionRatePercent, doctorPartyId: contract.doctorPartyId } : null,
    profilePayLocked: contracts.some(c => ['approved', 'active'].includes(c.status) && c.startDate <= day && (!c.endDate || c.endDate >= day)),
    blockers: resolution.blockers, commissionPolicyPercent: null };
}

/** Batched, on the caller's repeatable-read snapshot and its clinic day. */
export async function readCurrentStaffPay(client: DbClient, staff: readonly HrStaffView[], day: string): Promise<Map<number, HrCurrentPay>> {
  if (!staff.length) return new Map();
  const { rows } = await client.query(`${CONTRACT_SELECT.replace('SELECT id,', 'SELECT staff_id, id,')} WHERE staff_id = ANY($1::int[])`, [staff.map(s => s.id)]);
  const grouped = new Map<number, ContractInput[]>();
  for (const row of rows) grouped.set(Number(row.staff_id), [...(grouped.get(Number(row.staff_id)) ?? []), contractFromRow(row)]);
  const result = new Map(staff.map(s => [s.id, currentStaffPay(s, grouped.get(s.id) ?? [], day)]));
  const commissionStaff = staff.filter(s => hasCommission(result.get(s.id)?.terms?.kind) && result.get(s.id)?.contract?.commissionRatePercent != null);
  if (commissionStaff.length) {
    const history = await loadCommissionPolicyTimelines(client), resolve = commissionPolicyResolver(history);
    const { rows: [{ at }] } = await client.query('SELECT NOW() AS at');
    const { rows: links } = await client.query('SELECT s.id, u.party_id FROM hr_staff s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=ANY($1::int[])', [commissionStaff.map(s => s.id)]);
    for (const s of commissionStaff) {
      const pay = result.get(s.id)!;
      const doctorId = pay.contract?.doctorPartyId ?? links.find(row => Number(row.id) === s.id)?.party_id;
      const policy = doctorId ? resolve(Number(doctorId), new Date(at).toISOString()) : undefined;
      pay.commissionPolicyPercent = policy ? policy.config?.defaultPercent ?? policy.percent : null;
      if (pay.commissionPolicyPercent !== pay.contract!.commissionRatePercent) pay.blockers.push('commission_policy_conflict');
    }
  }
  return result;
}
