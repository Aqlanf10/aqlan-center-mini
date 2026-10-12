import {describe,expect,it} from "vitest";
import {parseHistoricalDocument} from "../lib/legacy-treatment-document";
import {readHistoricalPreview,readHistoricalReceipt,type HistoricalReceiptExpectation} from "../lib/historical-document-receipt";

function fixture(){
  const source={patientId:9,currency:"SAR",items:[{serviceId:7,quantity:1,price:"3000",catalogPriceMinor:300000,toothCode:16}],discount:"0",discountReason:null,previouslyPaidAmount:"1200",historicalAsOf:"2026-10-01",note:null,idempotencyKey:"history-receipt-test",repaymentRemainingMinor:180000,repaymentVersion:0,repaymentSourceHash:null,repaymentTerms:{mode:"full",installments:[]}};
  const parsed=parseHistoricalDocument(source,new Map([[7,{id:7,name:"Synthetic RCT",category:"rct",priceMinor:1000,priceSarMinor:300000,priceUsdMinor:null,priceConfigured:true,priceProvisional:false,isActive:true,sortOrder:0}]]),new Set(),{today:"2026-10-12",role:"admin",maxDiscountPercent:10});
  if(!parsed.ok)throw new Error(parsed.message);const input=parsed.value,owner={};
  const preview=readHistoricalPreview({patientId:9,currency:"SAR",lines:[{serviceId:7,site:input.lines[0].site,specialty:"endodontics",planId:88,case:{mode:"existing",id:77,title:"Original assessment"}}],remainingMinor:180000,openingPrincipalMinor:180000,accountDueMinor:180000,sourceHash:null,scheduleVersion:0,requiresAllocationReview:false},input)!;
  const expected:HistoricalReceiptExpectation={kind:"historical",owner,patientId:9,currency:"SAR",createdBy:"synthetic-owner",input,preview};
  const payload={replayed:false,document:{id:1,version:1,revisionId:2,patientId:9,currency:"SAR",createdBy:"synthetic-owner",idempotencyKey:source.idempotencyKey,totalMinor:300000,discountMinor:0,discountReason:null,agreedMinor:300000,previouslyPaidMinor:120000,remainingMinor:180000,historicalAsOf:source.historicalAsOf,note:null,reason:"Synthetic creation",
    lines:[{agreementId:5,planItemId:6,planId:88,caseId:77,serviceId:7,doctorId:null,description:"Synthetic RCT",toothCode:16,site:input.lines[0].site,unitPriceMinor:300000,discountMinor:0,netMinor:300000}],repayment:{arrangementId:3,revisionId:4,version:1,terms:source.repaymentTerms}}};
  return{input,owner,expected,payload,preview};
}
describe("historical acknowledgement retirement",()=>{
  it("accepts full immutable original and replay receipts in native minor units",()=>{
    const {owner,expected,payload}=fixture();expect(readHistoricalReceipt(payload,expected,owner)).toEqual(payload.document);
    expect(readHistoricalReceipt({...payload,replayed:true},expected,owner)).toEqual(payload.document);
  });
  it("rejects wrong owner and malformed financial/clinical/schedule acknowledgements",()=>{
    const {owner,expected,payload}=fixture();expect(readHistoricalReceipt(payload,expected,{})).toBeNull();
    const changes=[{patientId:10},{currency:"YER"},{createdBy:"someone-else"},{idempotencyKey:"new-retry"},{previouslyPaidMinor:0},{remainingMinor:300000},{discountMinor:1},{version:2},{repayment:null},
      {lines:[{...payload.document.lines[0],planId:89}]},{lines:[{...payload.document.lines[0],caseId:78}]},{lines:[{...payload.document.lines[0],site:{...payload.document.lines[0].site,toothCode:17}}]},
      {lines:[{...payload.document.lines[0],discountMinor:1,netMinor:299999}]},{lines:[]},{repayment:{...payload.document.repayment,version:2}}];
    for(const change of changes)expect(readHistoricalReceipt({...payload,document:{...payload.document,...change}},expected,owner),JSON.stringify(change)).toBeNull();
  });
  it("rejects preview for another patient/currency or incomplete scope",()=>{
    const {input,preview}=fixture();expect(preview).not.toBeNull();
    for(const change of [{patientId:10},{currency:"YER"},{lines:[]},{sourceHash:"guess"},{requiresAllocationReview:true},{remainingMinor:-1}])expect(readHistoricalPreview({...preview,...change},input)).toBeNull();
  });
});
