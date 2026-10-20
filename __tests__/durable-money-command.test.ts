import {calculationRateMatchesStoredSnapshot} from "../lib/payment-acknowledgment";
import {describe,it,expect} from "vitest";
import type {AcknowledgmentEvidence,CorrectionAcknowledgmentEvidence,PaymentCalculationEvidence,PaymentReplacementLineageEvidence} from "../lib/payment-acknowledgment";
import {durableMoneyCommand,readDurableMoneyAcknowledgment,restoreMoneyCommand,type DurableMoneyCommand} from "../lib/durable-money-command";
const payment=(patch:Record<string,unknown>={})=>({id:701,receiptNumber:"SYN-P",patientId:9,patientName:"Synthetic",invoiceId:12,planId:null,openingCurrency:null,shiftId:1,kind:"payment",reversalOfId:null,amountMinor:500,currency:"YER",exchangeRate:1,baseAmountMinor:500,baseCurrency:"YER",method:"cash",note:null,createdBy:"synthetic-owner",createdAt:"2026-10-14T03:00:00Z",...patch});
function command():DurableMoneyCommand{return {actor:"synthetic-owner",patientId:9,owner:"collection:9",receipt:null,attempt:{key:"durable-payment-key",phase:"sending",request:{url:"/api/payments",operation:"payment",body:JSON.stringify({patientId:9,invoiceId:"12",amount:"500",currency:"YER",method:"cash",kind:"payment"})}}};}
describe("durable collection and receipt acknowledgement",()=>{
  it("requires the complete actor, patient, target, native amount and original key",()=>{
    const source=command(),payload=payment({idempotencyKey:source.attempt.key});expect(readDurableMoneyAcknowledgment(payload,source)).toEqual({paymentId:701});
    for(const patch of [{idempotencyKey:"other"},{patientId:10},{invoiceId:13},{currency:"SAR"},{createdBy:"other"},{amountMinor:501},{method:"transfer"},{planId:3},{openingCurrency:"YER"},{baseCurrency:"SAR",baseAmountMinor:50000},{baseAmountMinor:499}])expect(readDurableMoneyAcknowledgment({...payload,...patch},source)).toBeNull();
    expect(readDurableMoneyAcknowledgment({id:701},source)).toBeNull();
  });
  it("restores exact owner intent and rejects changed financial payload or actor",()=>{
    const source=command(),encoded=durableMoneyCommand(source);expect(restoreMoneyCommand(encoded,9,source.actor).attempt).toMatchObject({key:source.attempt.key,request:source.attempt.request,phase:"uncertain"});
    expect(()=>restoreMoneyCommand(encoded,10,source.actor)).toThrow();expect(()=>restoreMoneyCommand(encoded,9,"other")).toThrow();
    expect(()=>restoreMoneyCommand({...encoded,payload:JSON.stringify({...source,owner:"collection:10"})},9,source.actor)).toThrow();
  });
  it("accepts a generated installment invoice only with the immutable original plan target",()=>{
    const source=command();source.attempt={...source.attempt,request:{...source.attempt.request,body:JSON.stringify({patientId:9,planId:8,amount:"500",currency:"YER",kind:"payment"})}};
    expect(readDurableMoneyAcknowledgment(payment({invoiceId:20,planId:8,idempotencyKey:source.attempt.key}),source)).not.toBeNull();
    expect(readDurableMoneyAcknowledgment(payment({invoiceId:20,planId:9,idempotencyKey:source.attempt.key}),source)).toBeNull();
  });
  it("binds a correction to its original and exact reversal/replacement while allowing the server's explanatory note",()=>{
    const source=command();source.owner="correction:701";source.receipt={id:701,receiptNumber:"SYN-P",amountMinor:500,currency:"YER",method:"cash",invoiceId:12,remainingMinor:300};
    source.attempt={...source.attempt,request:{url:"/api/payments/701/correct",operation:"correct",body:JSON.stringify({mode:"correct",reason:"Reviewed correction",target:"original",amount:"50",currency:"YER",method:"cash"})}};
    const payload={original:{id:701,receiptNumber:"SYN-P",patientId:9},replayed:true,idempotencyKey:source.attempt.key,reversal:payment({id:702,kind:"refund",reversalOfId:701,amountMinor:300,baseAmountMinor:300}),replacement:payment({id:703,amountMinor:50,baseAmountMinor:50,note:"بدل السند SYN-P"})};
    expect(readDurableMoneyAcknowledgment(payload,source)).toMatchObject({paymentId:703,reversal:{id:702},replacement:{id:703}});
    for(const patch of [{original:{...payload.original,id:700}},{reversal:payment({id:702,kind:"refund",reversalOfId:701,amountMinor:500})},{replacement:payment({id:703,amountMinor:50,invoiceId:13})}])expect(readDurableMoneyAcknowledgment({...payload,...patch},source)).toBeNull();
    expect(restoreMoneyCommand(durableMoneyCommand(source),9,source.actor).receipt).toEqual(source.receipt);
  });
});

const rawRate=140.1234567,storedRate=140.123457;
function rawCollection(){
  const source=command();source.attempt={...source.attempt,request:{...source.attempt.request,body:JSON.stringify({patientId:9,invoiceId:"12",amount:"0.81",currency:"SAR",method:"cash",kind:"payment"})}};
  const calculation:PaymentCalculationEvidence={kind:"generic-v1-request-rate",paymentId:701,amountMinor:81,currency:"SAR",baseCurrency:"YER",exchangeRate:storedRate,baseAmountMinor:113,calculationRate:rawRate};
  const acknowledgmentEvidence:AcknowledgmentEvidence={version:1,operation:"payment",requestKey:source.attempt.key,calculation};
  return {source,payload:{...payment({amountMinor:81,currency:"SAR",exchangeRate:storedRate,baseAmountMinor:113,idempotencyKey:source.attempt.key}),acknowledgmentEvidence},acknowledgmentEvidence};
}
function conservedCorrection(operation:"correct"|"void"="correct"){
  const source=command();source.owner="correction:701";source.receipt={id:701,receiptNumber:"SYN-P",amountMinor:81,currency:"SAR",method:"cash",invoiceId:12,remainingMinor:80};
  source.attempt={...source.attempt,request:{url:"/api/payments/701/correct",operation,body:JSON.stringify({mode:operation,reason:"Reviewed correction",target:"original",amount:"0.80",currency:"SAR",method:"cash"})}};
  const correction:CorrectionAcknowledgmentEvidence={
    pair:{auditId:900,originalId:701,reversalId:702,replacementId:operation==="correct"?703:null,actor:source.actor,reason:"Reviewed correction",keyedPaymentId:operation==="correct"?703:702},
    origin:{id:701,receiptNumber:"SYN-P",amountMinor:81,baseAmountMinor:113,currency:"SAR",baseCurrency:"YER",exchangeRate:storedRate,method:"cash",invoiceId:12,planId:null,openingCurrency:null},
    closingRefund:{reversalId:702,otherRefunds:[{id:700,amountMinor:1,baseAmountMinor:0}]},
  };
  const acknowledgmentEvidence:AcknowledgmentEvidence={version:1,operation,requestKey:source.attempt.key,correction};
  const payload={original:{id:701,receiptNumber:"SYN-P",patientId:9},replayed:true,idempotencyKey:source.attempt.key,
    reversal:payment({id:702,receiptNumber:"SYN-R",kind:"refund",reversalOfId:701,amountMinor:80,currency:"SAR",exchangeRate:storedRate,baseAmountMinor:113}),
    replacement:operation==="correct"?payment({id:703,receiptNumber:"SYN-C",amountMinor:80,currency:"SAR",exchangeRate:storedRate,baseAmountMinor:112,note:"بدل السند SYN-P"}):null,
    acknowledgmentEvidence};
  return {source,payload,correction,acknowledgmentEvidence};
}

describe("response-only payment acknowledgment evidence",()=>{
  it("accepts the exact historical calculation when the PostgreSQL-stored rate rounds differently",()=>{
    const {source,payload}=rawCollection();
    expect(readDurableMoneyAcknowledgment(payload,source)).toEqual({paymentId:701});
    const {acknowledgmentEvidence:_,...withoutProof}=payload;void _;
    expect(readDurableMoneyAcknowledgment(withoutProof,source)).toBeNull();
    expect(readDurableMoneyAcknowledgment({...withoutProof,baseAmountMinor:114},source)).toEqual({paymentId:701});
  });
  it("binds every raw calculation field to the returned receipt and exact arithmetic",()=>{
    const {source,payload,acknowledgmentEvidence}=rawCollection();
    for(const patch of [{kind:"other"},{paymentId:702},{amountMinor:80},{currency:"USD"},{baseCurrency:"SAR"},{exchangeRate:rawRate},{baseAmountMinor:114},{calculationRate:storedRate},{calculationRate:140},{calculationRate:0},{calculationRate:NaN},{extra:"unrecognised"}]){
      expect(readDurableMoneyAcknowledgment({...payload,acknowledgmentEvidence:{...acknowledgmentEvidence,calculation:{...acknowledgmentEvidence.calculation,...patch}}},source),JSON.stringify(patch)).toBeNull();
    }
  });
  it("does not weaken existing command, receipt, actor, patient, shift, time, note or target checks",()=>{
    const {source,payload}=rawCollection();
    for(const patch of [{reversalOfId:700},{reversalOfId:undefined},{id:702},{receiptNumber:" "},{idempotencyKey:"other-key"},{patientId:10},{createdBy:"other"},{kind:"refund"},{amountMinor:80},{currency:"USD"},{method:"transfer"},{invoiceId:13},{planId:4},{openingCurrency:"SAR"},{shiftId:0},{createdAt:"invalid"},{note:"changed"}])expect(readDurableMoneyAcknowledgment({...payload,...patch},source),JSON.stringify(patch)).toBeNull();
  });
  it("never falls back when any supplied evidence is unconfirmed, unknown or malformed",()=>{
    const source=command(),payload=payment({idempotencyKey:source.attempt.key});
    const good={version:1,operation:"payment",requestKey:source.attempt.key,calculation:{kind:"generic-v1-request-rate",paymentId:701,amountMinor:500,currency:"YER",baseCurrency:"YER",exchangeRate:1,baseAmountMinor:500,calculationRate:1}};
    expect(readDurableMoneyAcknowledgment({...payload,acknowledgmentEvidence:good},source)).toEqual({paymentId:701});
    for(const acknowledgmentEvidence of [null,undefined,[],{},true,{version:1,status:"unconfirmed"},{...good,version:2},{...good,operation:"installment"},{...good,requestKey:"other"},{...good,extra:true},{...good,calculation:undefined},{...good,calculation:{...good.calculation,paymentId:702}}])expect(readDurableMoneyAcknowledgment({...payload,acknowledgmentEvidence},source)).toBeNull();
  });
  it("continues to acknowledge proven zero-base foreign receipts without inventing a base unit",()=>{
    const source=command();source.attempt={...source.attempt,request:{...source.attempt.request,body:JSON.stringify({patientId:9,invoiceId:12,amount:"0.01",currency:"SAR",kind:"payment"})}};
    const row=payment({amountMinor:1,currency:"SAR",exchangeRate:40,baseAmountMinor:0,idempotencyKey:source.attempt.key});
    expect(readDurableMoneyAcknowledgment(row,source)).toEqual({paymentId:701});
    expect(readDurableMoneyAcknowledgment({...row,baseAmountMinor:1},source)).toBeNull();
  });
});

describe("audited correction closing-refund evidence",()=>{
  it.each(["correct","void"] as const)("acknowledges %s conserved native/base residuals, including prior zero-base refunds",operation=>{
    const {source,payload}=conservedCorrection(operation);
    expect(readDurableMoneyAcknowledgment(payload,source)).toMatchObject({paymentId:operation==="correct"?703:null,reversal:{id:702}});
    const {acknowledgmentEvidence:_,...withoutProof}=payload;void _;
    expect(readDurableMoneyAcknowledgment(withoutProof,source)).toBeNull();
    // This pre-evidence journal has no saved base amount or exchange rate.
    const restored=restoreMoneyCommand(durableMoneyCommand(source),9,source.actor);
    expect(restored.receipt).toEqual(source.receipt);
    expect(readDurableMoneyAcknowledgment(payload,restored)).not.toBeNull();
  });
  it("does not require the immutable original or closing reversal to equal a standalone conversion",()=>{
    const {source,payload,correction}=conservedCorrection("void");
    source.receipt!.remainingMinor=81;
    expect(readDurableMoneyAcknowledgment({...payload,reversal:{...payload.reversal,amountMinor:81},acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction:{...correction,closingRefund:{reversalId:702,otherRefunds:[]}}}},source)).not.toBeNull();
  });
  it("requires the saved expected native remainder, not merely a valid later residual",()=>{
    const {source,payload}=conservedCorrection();source.receipt!.remainingMinor=81;
    expect(readDurableMoneyAcknowledgment(payload,source)).toBeNull();
  });
  it("binds the original snapshot and audited pair to saved intent and the exact returned IDs",()=>{
    const {source,payload,correction}=conservedCorrection();
    for(const patch of [{auditId:0},{originalId:700},{reversalId:704},{replacementId:704},{replacementId:null},{actor:"other"},{reason:"Different reason"},{keyedPaymentId:702}])expect(readDurableMoneyAcknowledgment({...payload,acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction:{...correction,pair:{...correction.pair,...patch}}}},source),JSON.stringify(patch)).toBeNull();
    for(const patch of [{id:700},{receiptNumber:"other"},{amountMinor:82},{baseAmountMinor:114},{currency:"USD"},{baseCurrency:"SAR"},{exchangeRate:rawRate},{method:"transfer"},{invoiceId:13},{planId:4},{openingCurrency:"SAR"}])expect(readDurableMoneyAcknowledgment({...payload,acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction:{...correction,origin:{...correction.origin,...patch}}}},source),JSON.stringify(patch)).toBeNull();
  });
  it("rejects omitted, duplicate, self-related and excessive other refunds with exact safe-integer subtraction",()=>{
    const {source,payload,correction}=conservedCorrection();
    for(const otherRefunds of [[],[{id:700,amountMinor:1,baseAmountMinor:1}],[{id:700,amountMinor:2,baseAmountMinor:0}],[{id:700,amountMinor:1,baseAmountMinor:0},{id:700,amountMinor:1,baseAmountMinor:0}],...[701,702,703].map(id=>[{id,amountMinor:1,baseAmountMinor:0}]),[{id:700,amountMinor:1,baseAmountMinor:-1}],[{id:700,amountMinor:0,baseAmountMinor:0}],[{id:700,amountMinor:Number.MAX_SAFE_INTEGER+1,baseAmountMinor:0}],[{id:700,amountMinor:Number.MAX_SAFE_INTEGER,baseAmountMinor:0},{id:699,amountMinor:Number.MAX_SAFE_INTEGER,baseAmountMinor:0}]])expect(readDurableMoneyAcknowledgment({...payload,acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction:{...correction,closingRefund:{reversalId:702,otherRefunds}}}},source),JSON.stringify(otherRefunds)).toBeNull();
  });
  it("requires the reversal's own origin link and original method, and three distinct receipt IDs",()=>{
    const {source,payload}=conservedCorrection();
    for(const patch of [{reversalOfId:null},{reversalOfId:700},{reversalOfId:undefined},{method:"transfer"},{id:701},{amountMinor:79},{baseAmountMinor:112},{exchangeRate:rawRate},{createdBy:"other"},{patientId:10}])expect(readDurableMoneyAcknowledgment({...payload,reversal:{...payload.reversal,...patch}},source),JSON.stringify(patch)).toBeNull();
    for(const patch of [{id:701},{id:702},{reversalOfId:701},{reversalOfId:undefined},{baseAmountMinor:113}])expect(readDurableMoneyAcknowledgment({...payload,replacement:{...payload.replacement,...patch}},source),JSON.stringify(patch)).toBeNull();
  });
  it("validates optional replacement calculation independently rather than inheriting the closing budget",()=>{
    const {source,payload,correction}=conservedCorrection();
    source.attempt={...source.attempt,request:{...source.attempt.request,body:JSON.stringify({mode:"correct",reason:"Reviewed correction",target:"original",amount:"0.81",currency:"SAR",method:"cash"})}};
    const replacement={...payload.replacement,amountMinor:81,baseAmountMinor:113};
    const replacementCalculation:PaymentCalculationEvidence={kind:"generic-v1-request-rate",paymentId:703,amountMinor:81,currency:"SAR",baseCurrency:"YER",exchangeRate:storedRate,baseAmountMinor:113,calculationRate:rawRate};
    expect(readDurableMoneyAcknowledgment({...payload,replacement,acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction:{...correction,replacementCalculation}}},source)).not.toBeNull();
    expect(readDurableMoneyAcknowledgment({...payload,replacement},source)).toBeNull();
    expect(readDurableMoneyAcknowledgment({...payload,replacement,acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction:{...correction,replacementCalculation:{...replacementCalculation,calculationRate:140}}}},source)).toBeNull();
    expect(readDurableMoneyAcknowledgment({...payload,replacement,acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction:{...correction,replacementCalculation:{...replacementCalculation,calculationRate:storedRate}}}},source)).toBeNull();
  });
  it("does not fall back for malformed correction evidence even when standalone arithmetic is valid",()=>{
    const {source,payload,correction}=conservedCorrection();
    const standalone={...payload,reversal:{...payload.reversal,baseAmountMinor:112}};
    const {acknowledgmentEvidence:_,...withoutProof}=standalone;void _;
    expect(readDurableMoneyAcknowledgment(withoutProof,source)).not.toBeNull();
    for(const proof of [null,{...correction,extra:true},{...correction,pair:{...correction.pair,extra:true}},{...correction,origin:{...correction.origin,extra:true}},{...correction,closingRefund:{...correction.closingRefund,extra:true}},{...correction,replacementCalculation:undefined},{...correction,replacementLineage:undefined}])expect(readDurableMoneyAcknowledgment({...standalone,acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction:proof}},source)).toBeNull();
  });
});

function reclassifiedCorrection(){
  const fixture=conservedCorrection();
  const replacementLineage:PaymentReplacementLineageEvidence={kind:"reclassified-original-target",patientId:9,originalPaymentId:701,sourceInvoiceId:12,targetInvoiceId:14,documentId:30,correctionId:40,sourceInvoiceIds:[12,15],documentOriginalInvoiceId:15,documentCorrectedInvoiceId:13,path:[{correctionId:41,originalInvoiceId:13,correctedInvoiceId:14}]};
  return {...fixture,replacementLineage,payload:{...fixture.payload,replacement:{...fixture.payload.replacement,invoiceId:14},acknowledgmentEvidence:{...fixture.acknowledgmentEvidence,correction:{...fixture.correction,replacementLineage}}}};
}
describe("exact original-target reclassification lineage",()=>{
  it("allows only a documented original source membership and contiguous successor path",()=>{
    const {source,payload}=reclassifiedCorrection();expect(readDurableMoneyAcknowledgment(payload,source)).not.toBeNull();
    const direct=structuredClone(payload);direct.replacement.invoiceId=13;direct.acknowledgmentEvidence.correction.replacementLineage.targetInvoiceId=13;direct.acknowledgmentEvidence.correction.replacementLineage.path=[];
    expect(readDurableMoneyAcknowledgment(direct,source)).not.toBeNull();
  });
  it("rejects an arbitrary same-patient invoice and refuses proof on an explicit target",()=>{
    const {source,payload,correction}=reclassifiedCorrection();
    expect(readDurableMoneyAcknowledgment({...payload,acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction}},source)).toBeNull();
    source.attempt={...source.attempt,request:{...source.attempt.request,body:JSON.stringify({mode:"correct",reason:"Reviewed correction",target:"explicit",invoiceId:14,amount:"0.80",currency:"SAR",method:"cash"})}};
    expect(readDurableMoneyAcknowledgment(payload,source)).toBeNull();
    expect(readDurableMoneyAcknowledgment({...payload,acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction}},source)).not.toBeNull();
  });
  it("rejects incorrect identity, source membership, document IDs, disconnected, repeated or cyclic paths",()=>{
    const {source,payload,replacementLineage}=reclassifiedCorrection();
    const patches=[{kind:"other"},{patientId:10},{originalPaymentId:700},{sourceInvoiceId:15},{targetInvoiceId:16},{documentId:0},{correctionId:41},{sourceInvoiceIds:[15]},{sourceInvoiceIds:[12,15,12]},{sourceInvoiceIds:[12,15,13]},{documentOriginalInvoiceId:16},{documentCorrectedInvoiceId:12},{path:[]},{path:[{correctionId:41,originalInvoiceId:16,correctedInvoiceId:14}]},{path:[{correctionId:41,originalInvoiceId:13,correctedInvoiceId:13}]},{path:[{correctionId:41,originalInvoiceId:13,correctedInvoiceId:14},{correctionId:42,originalInvoiceId:14,correctedInvoiceId:13}]},{path:[{correctionId:41,originalInvoiceId:13,correctedInvoiceId:14,extra:true}]},{extra:true}];
    for(const patch of patches)expect(readDurableMoneyAcknowledgment({...payload,acknowledgmentEvidence:{...payload.acknowledgmentEvidence,correction:{...payload.acknowledgmentEvidence.correction,replacementLineage:{...replacementLineage,...patch}}}},source),JSON.stringify(patch)).toBeNull();
    for(const patch of [{planId:4},{openingCurrency:"SAR"}])expect(readDurableMoneyAcknowledgment({...payload,replacement:{...payload.replacement,...patch}},source)).toBeNull();
  });
});


describe("exact positive NUMERIC(18,6) acknowledgment snapshot",()=>{
  it.each([
    [140.1234567,140.123457,true],[140,140.123457,false],[140.1234564,140.123456,true],
    [140.1234565,140.123457,true],[140.123457,140.123457,true],[1.9999995,2,true],
    [140.1234567,140.1234567,false],
    [1e-7,0.000001,false],[5e-7,0.000001,true],[1.5e-6,0.000002,true],
    [4.999999e-7,0.000001,false],[1e-6,0.000001,true],[1e-20,0.000001,false],
    [999999999999.9999,999999999999.9999,true],[1e12,1e12,false],[1e21,1e21,false],
    [0,1,false],[-1,1,false],[Infinity,1,false],[NaN,1,false],
  ])("validates rate %s against stored %s",(raw,stored,expected)=>{
    expect(calculationRateMatchesStoredSnapshot(raw as number,stored as number)).toBe(expected);
  });
});
