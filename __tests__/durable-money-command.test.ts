import {describe,it,expect} from "vitest";
import {durableMoneyCommand,readDurableMoneyAcknowledgment,restoreMoneyCommand,type DurableMoneyCommand} from "../lib/durable-money-command";
const payment=(patch:Record<string,unknown>={})=>({id:701,receiptNumber:"SYN-P",patientId:9,patientName:"Synthetic",invoiceId:12,planId:null,openingCurrency:null,shiftId:1,kind:"payment",amountMinor:500,currency:"YER",exchangeRate:1,baseAmountMinor:500,baseCurrency:"YER",method:"cash",note:null,createdBy:"synthetic-owner",createdAt:"2026-10-14T03:00:00Z",...patch});
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
    const payload={original:{id:701,receiptNumber:"SYN-P",patientId:9},replayed:true,idempotencyKey:source.attempt.key,reversal:payment({id:702,kind:"refund",amountMinor:300,baseAmountMinor:300}),replacement:payment({id:703,amountMinor:50,baseAmountMinor:50,note:"بدل السند SYN-P"})};
    expect(readDurableMoneyAcknowledgment(payload,source)).toMatchObject({paymentId:703,reversal:{id:702},replacement:{id:703}});
    for(const patch of [{original:{...payload.original,id:700}},{reversal:payment({id:702,kind:"refund",amountMinor:500})},{replacement:payment({id:703,amountMinor:50,invoiceId:13})}])expect(readDurableMoneyAcknowledgment({...payload,...patch},source)).toBeNull();
    expect(restoreMoneyCommand(durableMoneyCommand(source),9,source.actor).receipt).toEqual(source.receipt);
  });
});
