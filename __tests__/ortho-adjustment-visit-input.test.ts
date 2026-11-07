import { describe, it, expect } from "vitest";
import { isAdjustmentVisitInput } from "../lib/ortho-adjustment-visit-input";
describe("new explicit visit identity admission",()=>{
 it.each([undefined,null,1,2147483647,"1"," 004 ","2147483647"])("accepts supported identity %j",value=>expect(isAdjustmentVisitInput(value)).toBe(true));
 it.each([""," ",0,-1,1.5,"1.5","invalid","+1","1e0","1.0","1.00000000000000001","2147483647.0000001",true,false,[],[1],{},2147483648,"2147483648",Number.MAX_SAFE_INTEGER+1,NaN,Infinity])("refuses invalid identity %j",value=>expect(isAdjustmentVisitInput(value)).toBe(false));
});
