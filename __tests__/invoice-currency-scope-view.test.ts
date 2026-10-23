import { expect, it } from "vitest";
import { readInvoiceRevisionView } from "../lib/invoice-revision-view";
const fixture = () => ({
  invoice:{id:12,invoiceNumber:"SYNTHETIC",patientId:17,patientName:"Synthetic",status:"open",totalMinor:2500,discountMinor:0,baseCurrency:"YER",note:null,createdAt:"2026-01-01T00:00:00Z",
    items:[{id:1,serviceId:null,doctorId:null,description:"Synthetic",quantity:1,unitPriceMinor:2500,totalMinor:2500}]},
  sourceHash:"a".repeat(64),settledMinor:0,remainingMinor:2500,accountDueMinor:2500,repaymentVersion:0,repaymentTerms:{mode:"full",installments:[]},work:[],
  currencyCorrection:{available:false,targetCurrency:"SAR",settledMinor:0,accountDueMinor:0,message:"تصحيح هذا المصدر غير مدعوم حاليًا."},
});
it("accepts existing responses and exact reason codes without enabling currency changes",()=>{
  expect(readInvoiceRevisionView(fixture(),17,12)).not.toBeNull();
  for(const code of ["PLAN_LINKED_LINEAGE","INDEPENDENT_ITEM_SOURCE","ALREADY_RECLASSIFIED"]){
    const value=fixture();Object.assign(value.currencyCorrection,{reasonCodes:[code]});
    expect(readInvoiceRevisionView(value,17,12)?.currencyCorrection).toMatchObject({available:false,reasonCodes:[code]});
  }
});
it("a pre-0069 response offers only its single target, with the top-level amounts",()=>{
  const value=fixture();Object.assign(value.currencyCorrection,{available:true,settledMinor:300,accountDueMinor:2200});
  expect(readInvoiceRevisionView(value,17,12)?.currencyCorrection).toMatchObject({available:true,targets:["SAR"],
    options:[{currency:"SAR",settledMinor:300,accountDueMinor:2200}]});
  expect(readInvoiceRevisionView(fixture(),17,12)?.currencyCorrection).toMatchObject({available:false,targets:[],options:[]});
  const half=fixture();Object.assign(half.currencyCorrection,{targets:["SAR"]});
  expect(readInvoiceRevisionView(half,17,12)).toBeNull();
});
it.each(["UNKNOWN",null,17,{},["UNKNOWN"],[17],["__proto__"]])("rejects malformed scope diagnostics %j",reasonCodes=>{
  const value=fixture();Object.assign(value.currencyCorrection,{reasonCodes});
  expect(readInvoiceRevisionView(value,17,12)).toBeNull();
});
