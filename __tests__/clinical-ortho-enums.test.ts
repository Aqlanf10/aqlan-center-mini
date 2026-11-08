import { expect, it } from "vitest";
import { checkOrthoSessionDraft } from "../lib/ortho-baseline";
import { ELASTIC_LABEL, PHASE_LABEL } from "../lib/ortho";
for(const field of ["phase","elastics"] as const){
 it.each([""," ","unrecognized","constructor","toString","__proto__",123,false,[],{}])(`${field} refuses explicit invalid %j`,value=>expect(checkOrthoSessionDraft({caseId:1,[field]:value})).toMatchObject({ok:false}));
 it.each([undefined,null])(`${field} preserves absence/null default %j`,value=>expect(checkOrthoSessionDraft({caseId:1,[field]:value})).toMatchObject({ok:true,value:{[field]:field==="phase"?null:"none"}}));
}
it.each(Object.keys(PHASE_LABEL))("preserves known phase %s without weakening transactional phase policy",phase=>expect(checkOrthoSessionDraft({caseId:1,phase})).toMatchObject({ok:true,value:{phase}}));
it.each(Object.keys(ELASTIC_LABEL))("preserves exact elastics %s",elastics=>expect(checkOrthoSessionDraft({caseId:1,elastics})).toMatchObject({ok:true,value:{elastics}}));
it("preserves omitted entire session",()=>{expect(checkOrthoSessionDraft(undefined)).toEqual({ok:true,value:null});expect(checkOrthoSessionDraft(null)).toEqual({ok:true,value:null});});
