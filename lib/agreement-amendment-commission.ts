/**
 * Commission decisions are not price calculations. Reuse the existing clinical
 * commission rate/effective-date precedence, including case overrides.
 * A posting writer must independently prove doctor attribution and costs.
 */
import { resolvePolicyForShare, type CommissionPolicy, type CaseOverrideHit } from "./commission";
import type { DoctorShareItem } from "./commission";
export type AmendmentCommissionDecision =
  | { state: "no_authorized_doctor" }
  | { state: "pending_cost_evidence"; required: ("lab" | "materials")[] }
  | { state: "policy_resolved"; percent: number; basis: "collected_cash" | "invoiced"; ruleSource: string };
export function decideAmendmentCommission(input:{
  policy: CommissionPolicy | undefined;
  atIso: string;
  share: Pick<DoctorShareItem,"category"|"serviceId"|"serviceName">;
  override?: CaseOverrideHit;
  /** Proof of attributed incremental cost, not total original-work cost. */
  labIncrementMinor?: number;
  materialIncrementMinor?: number;
}): AmendmentCommissionDecision {
  if (!input.policy) return {state:"no_authorized_doctor"};
  const policy=resolvePolicyForShare(input.policy,input.atIso,input.share,input.override);
  const required: ("lab"|"materials")[]=[];
  if (policy.deductLab && input.labIncrementMinor===undefined) required.push("lab");
  if (policy.deductMaterials && input.materialIncrementMinor===undefined) required.push("materials");
  if ([input.labIncrementMinor,input.materialIncrementMinor].some(x=>x!==undefined&&(!Number.isSafeInteger(x)||x<0)))
    throw new RangeError("Invalid incremental cost evidence");
  return required.length ? {state:"pending_cost_evidence",required} : {
    state:"policy_resolved",percent:policy.percent,basis:policy.basis,ruleSource:policy.ruleSource,
  };
}
