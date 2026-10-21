import {expect,it} from "vitest";
import {decideAmendmentCommission} from "../lib/agreement-amendment-commission";
const share={category:"prosthodontics",serviceId:7,serviceName:"Zirconia"};
it("uses the existing policy and does not demand costs policy does not deduct",()=>{
 const policy={percent:20,config:{basis:"collected_cash",deductLab:false,deductMaterials:false}};
 // The real policy resolver may apply config defaults; explicit rules win.
 const result=decideAmendmentCommission({policy:policy as never,atIso:"2026-10-21T00:00:00Z",share});
 expect(result.state).toBe("policy_resolved");
});
it("holds an unproven lab deduction rather than inventing zero",()=>{
 expect(decideAmendmentCommission({policy:{percent:20,config:null},atIso:"2026-10-21T00:00:00Z",share})).toEqual({state:"pending_cost_evidence",required:["lab"]});
});
it("has no entitlement without a proven doctor policy",()=>{
 expect(decideAmendmentCommission({policy:undefined,atIso:"2026-10-21T00:00:00Z",share})).toEqual({state:"no_authorized_doctor"});
});
