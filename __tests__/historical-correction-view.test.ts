import {parseHistoricalCorrection} from "../lib/legacy-treatment-document";
import {describe,it,expect} from "vitest";
import {durableHistoricalCorrection,readHistoricalCorrectionReceipt,readHistoricalDocuments,restoreHistoricalCorrection,type HistoricalCorrectionCommand,type HistoricalDocumentView} from "../lib/historical-correction-view";

function fixture(){
  const original:HistoricalDocumentView={id:1,version:1,revisionId:2,patientId:9,currency:"SAR",createdBy:"original-owner",idempotencyKey:"history-original",reason:"Original agreement",totalMinor:300000,discountMinor:0,discountReason:null,
    agreedMinor:300000,previouslyPaidMinor:120000,remainingMinor:180000,historicalAsOf:"2026-10-01",note:null,
    lines:[{agreementId:5,planItemId:6,planId:88,caseId:77,serviceId:7,doctorId:null,description:"Synthetic RCT",toothCode:16,site:{mode:"per_tooth_episode",toothCode:16,surfaces:null,scope:null,episodeTeeth:null},unitPriceMinor:300000,discountMinor:0,netMinor:300000}],
    repayment:{arrangementId:3,revisionId:4,version:1,terms:{mode:"full",installments:[]}},openingPrincipalMinor:180000,openingCollectedMinor:20000,openingRemainingMinor:160000,accountDueMinor:160000,scheduleVersion:1,sourceHash:"a".repeat(64),correctionAvailable:true,correctionMessage:null,history:[{version:1,reason:"Original agreement",created_by:"original-owner"}]};
  const body={idempotencyKey:"history-correction",expectedVersion:1,expectedSourceHash:original.sourceHash,prices:["3000"],discount:"0",discountReason:null,previouslyPaidAmount:"2900",historicalAsOf:"2026-10-01",note:"Correction note",reason:"Reviewed historical correction",repaymentTerms:{mode:"full",installments:[]},repaymentRemainingMinor:0,repaymentVersion:1};
  const command:HistoricalCorrectionCommand={key:body.idempotencyKey,actor:"correction-owner",patientId:9,documentId:1,body:JSON.stringify(body),original,outcome:"pending",message:""};
  const document={...original,revisionId:10,version:2,createdBy:command.actor,idempotencyKey:command.key,previouslyPaidMinor:290000,remainingMinor:10000,note:body.note,reason:body.reason,repayment:{arrangementId:3,revisionId:11,version:2,terms:body.repaymentTerms}};
  return {original,body,command,payload:{replayed:false,document}};
}
describe("historical correction immutable command and full acknowledgement",()=>{
  it("accepts first and JSONB replay acknowledgements with unchanged clinical identity and actual credit",()=>{
    const {command,payload}=fixture();expect(readHistoricalCorrectionReceipt(payload,command)).toEqual(payload.document);
    expect(readHistoricalCorrectionReceipt(JSON.parse(JSON.stringify({...payload,replayed:true})),command)).toEqual(payload.document);
  });
  it("rejects a successful-looking wrong patient, actor, prior/new version, price, site or schedule",()=>{
    const {command,payload}=fixture();
    const changes=[{patientId:10},{createdBy:"other"},{revisionId:2},{version:1},{idempotencyKey:"other-key"},{previouslyPaidMinor:280000,remainingMinor:20000},{repayment:null},
      {lines:[{...payload.document.lines[0],caseId:78}]},{lines:[{...payload.document.lines[0],site:{...payload.document.lines[0].site,toothCode:17}}]},
      {repayment:{...payload.document.repayment,version:3}}];
    for(const change of changes)expect(readHistoricalCorrectionReceipt({...payload,document:{...payload.document,...change}},command),JSON.stringify(change)).toBeNull();
  });
  it("restores the original actor/patient intent and refuses altered payload or owner",()=>{
    const {command}=fixture(),saved=durableHistoricalCorrection(command);
    expect(restoreHistoricalCorrection(saved,9,command.actor)).toMatchObject({body:command.body,outcome:"uncertain",original:command.original});
    expect(()=>restoreHistoricalCorrection(saved,10,command.actor)).toThrow();expect(()=>restoreHistoricalCorrection(saved,9,"other")).toThrow();
    expect(()=>restoreHistoricalCorrection({...saved,payload:JSON.stringify({...command,body:command.body.replace('"2900"','"2800"')})},9,command.actor)).toThrow();
  });
  it("refuses a durable schedule that quietly omits another document's opening remaining",()=>{
    const {command}=fixture();const changed={...command,original:{...command.original,openingPrincipalMinor:200000,openingRemainingMinor:180000}};
    expect(()=>restoreHistoricalCorrection(durableHistoricalCorrection(changed),9,command.actor)).toThrow();
  });
  it("reads account credit without clamping debt and rejects inconsistent aggregate opening or history",()=>{
    const {original}=fixture();expect(readHistoricalDocuments({documents:[{...original,accountDueMinor:-10000}]},9)).not.toBeNull();
    for(const change of [{openingRemainingMinor:180000},{history:[]},{currency:"EUR"},{correctionAvailable:undefined}])expect(readHistoricalDocuments({documents:[{...original,...change}]},9)).toBeNull();
  });
});


describe("explicit historical correction safety refusals",()=>{
  it("does not assert an unverified pre-system credit or rewrite a historical clinical identity",()=>{
    const {original,body}=fixture();
    const credit=parseHistoricalCorrection({...body,previouslyPaidAmount:"4000"},original,"2026-10-14");
    expect(credit.ok).toBe(false);if(!credit.ok)expect(credit.message).toContain("مراجعة مستقلة");
    for(const fields of [{doctorId:8},{serviceId:8},{toothCode:17},{lines:[]}]){
      const clinical=parseHistoricalCorrection({...body,...fields},original,"2026-10-14");
      expect(clinical.ok).toBe(false);if(!clinical.ok)expect(clinical.message).toContain("تصحيح سريري مستقل");
    }
  });
});
