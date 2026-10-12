import {describe,expect,it} from "vitest";
import {allocateHistoricalDiscount} from "../lib/legacy-treatment-document";

describe("historical document discount attribution",()=>{
  it("attributes 20000 across two55000 teeth and one210000 grouped line without allocating old payments",()=>{
    expect(allocateHistoricalDiscount([55000,55000,210000],20000)).toEqual([
      {discountMinor:3438,netMinor:51562},{discountMinor:3437,netMinor:51563},{discountMinor:13125,netMinor:196875},
    ]);
  });
  it("uses stable document order for tied sub-cent remainders",()=>{
    expect(allocateHistoricalDiscount([1,1,1],2)).toEqual([
      {discountMinor:1,netMinor:0},{discountMinor:1,netMinor:0},{discountMinor:0,netMinor:1},
    ]);
  });
  it("conserves exact totals even when multiplication exceeds safe floating-point integer precision",()=>{
    const prices=[4_000_000_000_001,4_000_000_000_000,1_000_000_000_003];
    const discount=3_000_000_000_001;const shares=allocateHistoricalDiscount(prices,discount);
    expect(shares.reduce((sum,x)=>sum+x.discountMinor,0)).toBe(discount);
    expect(shares.reduce((sum,x)=>sum+x.netMinor,0)).toBe(prices.reduce((sum,x)=>sum+x,0)-discount);
    for(const [i,share] of shares.entries()) {
      const total=prices.reduce((sum,x)=>sum+BigInt(x),0n),numerator=BigInt(prices[i])*BigInt(discount);
      expect(BigInt(share.discountMinor)>=numerator/total).toBe(true);
      expect(BigInt(share.discountMinor)<=numerator/total+1n).toBe(true);
    }
  });
  it("rejects unsafe or impossible amounts",()=>{
    for(const [prices,discount] of [[[],0],[[100],100],[[1.1],0],[[Number.MAX_SAFE_INTEGER,1],1],[[100],-1]] as [number[],number][])
      expect(()=>allocateHistoricalDiscount(prices,discount)).toThrow();
  });
});
