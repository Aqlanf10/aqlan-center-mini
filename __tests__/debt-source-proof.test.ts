import {describe,it,expect} from "vitest";
import {debtRequestHash,debtRevisionSourceMatches} from "../lib/debt-source-proof";
const payment={id:1,kind:"payment",reversal_of_id:null,amount_minor:"20000",base_amount_minor:"82000"};
const snapshot={invoiceId:201,patientId:101,currency:"SAR",totalMinor:60000,discountMinor:0,cancelled:false,
  lineage:[{id:201,patientId:101,currency:"SAR",totalMinor:60000,discountMinor:0,status:"open"}],corrections:[],payments:[payment]};
describe("debt principal identity and monotonic settlement evidence",()=>{
  it("allows ordinary receipts and derived paid status without weakening full preview hashes",()=>{
    const current={...snapshot,lineage:[{...snapshot.lineage[0],status:"paid"}],payments:[payment,{...payment,id:2},{...payment,id:3}]};
    expect(debtRevisionSourceMatches(current,snapshot)).toBe(true);
    expect(debtRequestHash(current)).not.toBe(debtRequestHash(snapshot));
    expect(debtRequestHash({a:1,b:2})).toBe(debtRequestHash({b:2,a:1}));
  });
  it.each([
    {payments:[]},
    {payments:[{...payment,amount_minor:"19000"}]},
    {payments:[payment,{...payment,id:2,kind:"refund",reversal_of_id:1}]},
    {payments:[payment,{...payment,id:2,kind:"refund",reversal_of_id:1},{...payment,id:3}]},
    {payments:[payment,payment]},
    {payments:[payment,{...payment,id:2,amount_minor:"0"}]},
    {totalMinor:70000}, {discountMinor:1}, {currency:"YER"}, {patientId:102}, {cancelled:true},
    {corrections:[{id:1,original_invoice_id:200,corrected_invoice_id:201}]},
    {lineage:[{...snapshot.lineage[0],status:"cancelled"}]},
  ])("rejects proof drift %j",change=>{
    expect(debtRevisionSourceMatches({...snapshot,...change},snapshot)).toBe(false);
  });
  it("retains the exact opening-balance and unknown-shape comparison policy",()=>{
    const opening={patientId:101,currency:"YER",opening:{amount_minor:"100",as_of_date:"2026-10-17"}};
    expect(debtRevisionSourceMatches(opening,opening)).toBe(true);
    expect(debtRevisionSourceMatches({...opening,opening:{...opening.opening,amount_minor:"101"}},opening)).toBe(false);
    expect(debtRevisionSourceMatches(snapshot,null)).toBe(false);
  });
});
