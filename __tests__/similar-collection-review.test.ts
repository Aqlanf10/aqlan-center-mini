import {describe,expect,it} from "vitest";
import {parseSimilarCollectionReview,reviewMatchesReceipts,type SimilarCollectionReceipt} from "../lib/similar-collection";

const row=(id:number):SimilarCollectionReceipt=>({
  id,receiptNumber:`R-${id}`,amountMinor:205000,currency:"YER",
  createdAt:"2026-10-14T11:44:00.000Z",method:"cash",invoiceId:169,planId:null,
  openingCurrency:null,createdBy:"synthetic-cashier",
});
describe("similar receipt warning is advisory, not amount-based deduplication",()=>{
  it("requires an explicit, bounded and exact snapshot",()=>{
    expect(parseSimilarCollectionReview({observedReceiptIds:[9],confirmed:true})).toEqual({observedReceiptIds:[9],confirmed:true});
    for(const invalid of [
      {observedReceiptIds:[9,9],confirmed:true},{observedReceiptIds:[0],confirmed:true},
      {observedReceiptIds:[9],confirmed:"true"},{observedReceiptIds:[],confirmed:true,extra:"bypass"},
      {observedReceiptIds:"9",confirmed:true},null,
    ])expect(parseSimilarCollectionReview(invalid)).toBeNull();
  });
  it("warns on same-patient native amount/currency matches until operator confirms",()=>{
    expect(reviewMatchesReceipts({observedReceiptIds:[],confirmed:false},[])).toBe(true);
    expect(reviewMatchesReceipts({observedReceiptIds:[],confirmed:false},[row(294)])).toBe(false);
    expect(reviewMatchesReceipts({observedReceiptIds:[294],confirmed:false},[row(294)])).toBe(false);
    expect(reviewMatchesReceipts({observedReceiptIds:[294],confirmed:true},[row(294)])).toBe(true);
  });
  it("does not accept a stale acknowledgment after another distinct receipt is recorded",()=>{
    const reviewed={observedReceiptIds:[294],confirmed:true};
    expect(reviewMatchesReceipts(reviewed,[row(295),row(294)])).toBe(false);
    expect(reviewMatchesReceipts(reviewed,[row(295)])).toBe(false);
    // Two legitimate separate payments remain allowed with renewed review.
    expect(reviewMatchesReceipts({observedReceiptIds:[295,294],confirmed:true},[row(295),row(294)])).toBe(true);
  });
  it("never turns a reused key into a permission to merge two receipts",()=>{
    expect(reviewMatchesReceipts({observedReceiptIds:[294],confirmed:true},[row(294)])).toBe(true);
    expect(reviewMatchesReceipts({observedReceiptIds:[294],confirmed:true},[row(294),row(293)])).toBe(false);
  });
});
