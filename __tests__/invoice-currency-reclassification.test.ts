import {describe,it,expect} from "vitest";
import {planCurrencyReclassification,ReclassificationProofError,type ReclassificationPayment} from "../lib/invoice-currency-reclassification";
const payment=(id:number,amountMinor:number,baseAmountMinor:number):ReclassificationPayment=>({id,patientId:101,invoiceId:201,kind:"payment",reversalOfId:null,currency:"SAR",amountMinor,baseCurrency:"YER",baseAmountMinor,exchangeRate:410});
const rows=[payment(1,70000,287000),payment(2,10000,41000),payment(3,10000,41000)];
const input={patientId:101,lineageInvoiceIds:[201],fromCurrency:"YER" as const,toCurrency:"SAR" as const,principalMinor:250000,payments:rows};
describe("currency reclassification design arithmetic (not a deployed writer)",()=>{
  it("proves each receipt, settles 900 SAR, leaves 1600 SAR and never changes cash",()=>{
    const before=structuredClone(rows),unallocated={...payment(4,100,100),invoiceId:null,currency:"YER",exchangeRate:1};
    const result=planCurrencyReclassification(input);
    expect(result).toMatchObject({sourceMinor:369000,settledMinor:90000,remainingMinor:160000,creditMinor:0});
    expect(result.evidence.map(row=>row.targetMinor)).toEqual([70000,10000,10000]);
    expect(result.settlementDeltas).toEqual([{currency:"YER",minor:-369000},{currency:"SAR",minor:90000}]);
    expect(rows).toEqual(before);expect(unallocated).toMatchObject({amountMinor:100,currency:"YER",invoiceId:null});
    expect(()=>planCurrencyReclassification({...input,payments:[...rows,unallocated as ReclassificationPayment]})).toThrow(ReclassificationProofError);
    expect(planCurrencyReclassification(input)).toEqual(result);
  });
  it("uses per-receipt snapshots even when recorded exchange rates differ",()=>{
    expect(planCurrencyReclassification({...input,payments:[rows[0],{...rows[1],exchangeRate:400,baseAmountMinor:40000}]})).toMatchObject({sourceMinor:327000,settledMinor:80000});
  });
  it.each([1,10000,70000])("projects a recorded %i minor refund once",amountMinor=>{
    const refund={...payment(5,amountMinor,Math.round(amountMinor*410/100)),kind:"refund" as const,reversalOfId:1};
    const projected=planCurrencyReclassification({...input,payments:[...rows,refund]});
    expect(projected.settledMinor).toBe(90000-amountMinor);
    expect(projected.evidence[0].refundIds).toEqual([5]);
    expect(()=>planCurrencyReclassification({...input,payments:[...rows,refund,refund]})).toThrow(ReclassificationProofError);
  });
  it.each([
    {patientId:102},{invoiceId:202},{currency:"YER"},{baseAmountMinor:286999},{amountMinor:0.5},
    {amountMinor:Number.MAX_SAFE_INTEGER+1},{exchangeRate:0},{kind:"refund",reversalOfId:null},
    {kind:"refund",reversalOfId:999},
  ])("rejects unsupported or corrupt proof %j",change=>{
    expect(()=>planCurrencyReclassification({...input,payments:[{...rows[0],...change} as ReclassificationPayment]})).toThrow(ReclassificationProofError);
  });
  it("rejects over-refund and cross-invoice reversal",()=>{
    const refund={...payment(5,70001,287004),kind:"refund" as const,reversalOfId:1};
    expect(()=>planCurrencyReclassification({...input,payments:[...rows,refund]})).toThrow(ReclassificationProofError);
    expect(()=>planCurrencyReclassification({...input,lineageInvoiceIds:[201,202],payments:[...rows,{...refund,invoiceId:202}]})).toThrow(ReclassificationProofError);
  });
});
