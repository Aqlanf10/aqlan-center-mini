import {describe,expect,it} from "vitest";
import {hrContractEditable,hrContractHasApproval,hrContractNextStatuses,type HrContractStatus} from "../lib/hr-contracts-attendance-shared";
describe("administrative contract lifecycle",()=>{
  it("preserves explicit direct draft approval and optional review, with no activation shortcut",()=>{
    expect(hrContractNextStatuses({status:"draft"})).toEqual(["approved","under_review","terminated"]);
    expect(hrContractNextStatuses({status:"under_review"})).toEqual(["approved","draft","terminated"]);
    expect(hrContractNextStatuses({status:"approved"})).toEqual(["active","expired","terminated"]);
  });
  it.each(["approved","active","expired","terminated"] as HrContractStatus[])("never makes %s editable or returns it to draft",status=>{
    expect(hrContractEditable({status})).toBe(false);expect(hrContractNextStatuses({status})).not.toContain("draft");expect(hrContractNextStatuses({status})).not.toContain("under_review");
  });
  it("preserves approval history even for a legacy incorrectly reset draft",()=>{
    const witness={status:"draft" as const,approvedBy:"Synthetic admin",approvedAt:"2026-01-01T00:00:00Z"};
    expect(hrContractHasApproval(witness)).toBe(true);expect(hrContractEditable(witness)).toBe(false);expect(hrContractNextStatuses(witness)).toEqual([]);
  });
});

import {HR_CANONICAL_CONTRACT_KINDS,hrContractCompensationKind,hrContractPayMissing} from "@/lib/hr-contracts-attendance-shared";
it("only offers schema-backed templates and does not treat missing wages as explicit zero",()=>{
 expect(HR_CANONICAL_CONTRACT_KINDS).toEqual(["doctor_percentage","doctor_salary","doctor_hybrid","support_staff"]);
 expect(HR_CANONICAL_CONTRACT_KINDS.map(hrContractCompensationKind)).toEqual(["commission","salary","salary_commission","salary"]);
 const missing={compensationKind:"salary",baseSalaryMinor:null,salaryCurrency:null,salaryPeriod:null,commissionRatePercent:null,doctorPartyId:null};
 expect(hrContractPayMissing(missing)).toEqual(["مبلغ الراتب","عملة الراتب","دورية الراتب"]);
 expect(hrContractPayMissing({...missing,baseSalaryMinor:0,salaryCurrency:"YER",salaryPeriod:"monthly"})).toEqual([]);
 expect(hrContractPayMissing({...missing,compensationKind:"commission"})).toEqual(["نسبة الطبيب","جهة الطبيب"]);
 expect(hrContractPayMissing({...missing,compensationKind:"commission",commissionRatePercent:0,doctorPartyId:1})).toEqual([]);
});
