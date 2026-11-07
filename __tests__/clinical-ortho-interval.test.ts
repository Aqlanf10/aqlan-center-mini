import { expect, it } from "vitest";
import { checkOrthoSessionDraft } from "../lib/ortho-baseline";
it.each([undefined,null,1,4,52,"1"," 004 ","52"])("preserves clinical interval/default %j",nextWeeks=>{
 expect(checkOrthoSessionDraft({caseId:1,nextWeeks})).toMatchObject({ok:true,value:{nextWeeks:nextWeeks==null?4:Number(nextWeeks)}});
});
it.each([""," ",true,false,[],[4],{},0,-1,53,1.5,NaN,Infinity,"1.5","1.00000000000000001","52.000000000000001","1.0","1e0","+1"])("refuses supplied coercive clinical interval %j",nextWeeks=>{
 expect(checkOrthoSessionDraft({caseId:1,nextWeeks})).toMatchObject({ok:false});
});
it.each([undefined,null])("preserves absent entire session %j",value=>expect(checkOrthoSessionDraft(value)).toEqual({ok:true,value:null}));
