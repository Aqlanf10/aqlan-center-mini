import { expect, it } from "vitest";
import { checkOrthoSessionDraft } from "../lib/ortho-baseline";
it.each([1,2147483647,"1"," 004 ","2147483647"])("accepts exact required case identity %j",caseId=>{
 expect(checkOrthoSessionDraft({caseId,nextWeeks:4})).toMatchObject({ok:true,value:{caseId:Number(caseId)}});
});
it.each([undefined,null,""," ",true,false,[],[1],{},0,-1,1.5,NaN,Infinity,2147483648,Number.MAX_SAFE_INTEGER+1,"1.00000000000000001","2147483647.0000001","1.0","1e0","+1"])("refuses malformed required case identity %j",caseId=>{
 expect(checkOrthoSessionDraft({caseId,nextWeeks:4})).toMatchObject({ok:false});
});
it.each([undefined,null])("keeps absent entire session %j compatible",value=>expect(checkOrthoSessionDraft(value)).toEqual({ok:true,value:null}));
