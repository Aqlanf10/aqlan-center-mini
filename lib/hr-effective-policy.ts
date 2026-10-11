import { assertRange, immutableJson, partitionTemporal, selectTemporal, temporalFail, type TemporalTimeline } from './hr-temporal';

export type EmploymentStatus = 'active' | 'suspended' | 'ended';
export interface EmploymentFact { readonly status: EmploymentStatus }
export type HrEffectivePolicyKey = 'employment_pay_effect' | 'proration' | 'leave_entitlement';
export interface HrEffectivePolicy {
  readonly key: HrEffectivePolicyKey;
  readonly approval: { readonly state: 'unapproved' } | { readonly state: 'approved'; readonly decisionRef: string };
  /** Opaque configured terms. This layer neither invents nor executes a financial formula. */
  readonly parameters: Readonly<Record<string, unknown>>;
}
export type HrPolicyTimelines = Partial<Record<HrEffectivePolicyKey, TemporalTimeline<HrEffectivePolicy>>>;
export interface HrCalculationBlocker { readonly code: string; readonly from: string; readonly to: string; readonly policyKey?: HrEffectivePolicyKey }

export function selectApprovedHrPolicy(timeline: TemporalTimeline<HrEffectivePolicy> | undefined, key: HrEffectivePolicyKey, day: string) {
  const selected = selectTemporal(timeline ?? { revision: 0, facts: [] }, day);
  if (selected.kind === 'unknown') return { kind: 'blocked' as const, code: 'policy_history_unknown', key };
  const value = selected.fact.value;
  if (!value || value.key !== key || !value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) temporalFail('invalid_policy', 'The policy key and terms must match this stream.');
  if (value.approval?.state !== 'approved' || typeof value.approval.decisionRef !== 'string' || !value.approval.decisionRef.trim()) return { kind: 'blocked' as const, code: 'policy_not_approved', key };
  return immutableJson({ kind: 'approved' as const, key, revision: selected.revision, factId: selected.fact.id, decisionRef: value.approval.decisionRef, parameters: value.parameters });
}

/** Per-calculation preconditions, never an authorization token or a money/leave calculator. */
export function assessHrCalculation(input: {
  operation: 'salary_accrual' | 'leave_entitlement' | 'attendance_measurement';
  from: string; to: string;
  employment: TemporalTimeline<EmploymentFact>;
  policies: HrPolicyTimelines;
  requiresProration?: boolean;
}) {
  assertRange(input.from, input.to);
  if (!['salary_accrual', 'leave_entitlement', 'attendance_measurement'].includes(input.operation)) temporalFail('invalid_operation', 'Unknown calculation operation.');
  // Actual attendance remains measurable while unrelated financial policy is unresolved.
  if (input.operation === 'attendance_measurement') return immutableJson({ ready: true, operation: input.operation, blockers: [] as HrCalculationBlocker[], segments: [] });
  const employment = partitionTemporal(input.employment, input.from, input.to);
  const boundaries = new Set([input.from, input.to]);
  for (const part of employment) { boundaries.add(part.from); boundaries.add(part.to); }
  const neededKeys: HrEffectivePolicyKey[] = input.operation === 'leave_entitlement' ? ['leave_entitlement'] : ['employment_pay_effect', 'proration'];
  for (const key of neededKeys) if (input.policies[key]) for (const part of partitionTemporal(input.policies[key]!, input.from, input.to)) { boundaries.add(part.from); boundaries.add(part.to); }
  const days = [...boundaries].sort(), blockers: HrCalculationBlocker[] = [];
  const knownStatuses = new Set(employment.flatMap(part => part.selection.kind === 'known' ? [part.selection.fact.value.status] : []));
  const prorating = input.requiresProration === true || knownStatuses.size > 1;
  const segments = days.slice(0, -1).map((from, i) => {
    const to = days[i + 1], selected = selectTemporal(input.employment, from), policies = [];
    if (selected.kind === 'unknown') blockers.push({ code: 'employment_history_unknown', from, to });
    else if (!['active', 'suspended', 'ended'].includes(selected.fact.value?.status)) temporalFail('invalid_employment', 'Employment state is not a login or clinician role.');
    const keys: HrEffectivePolicyKey[] = input.operation === 'leave_entitlement' ? ['leave_entitlement'] : [];
    if (input.operation === 'salary_accrual') {
      if (selected.kind === 'known' && selected.fact.value.status !== 'active') keys.push('employment_pay_effect');
      if (prorating) keys.push('proration');
    }
    for (const key of keys) {
      const policy = selectApprovedHrPolicy(input.policies[key], key, from);
      if (policy.kind === 'blocked') blockers.push({ code: policy.code, from, to, policyKey: key });
      else policies.push(policy);
    }
    return { from, to, employment: selected, policies };
  });
  return immutableJson({ ready: blockers.length === 0, operation: input.operation, blockers, segments });
}
