import { expect, it } from "vitest";
import { checkOrthoSessionDraft } from "../lib/ortho-baseline";
const limits={upperWire:40,lowerWire:40,elasticNote:120,done:400,note:300};
for(const [field,limit] of Object.entries(limits)){
 it(`${field} preserves exact trimmed boundary and refuses truncation`,()=>{
  expect(checkOrthoSessionDraft({caseId:1,[field]:`  ${"x".repeat(limit)}  `})).toMatchObject({ok:true,value:{[field]:"x".repeat(limit)}});
  expect(checkOrthoSessionDraft({caseId:1,[field]:"x".repeat(limit+1)})).toMatchObject({ok:false});
 });
 it.each([false,123,{},[],undefined])(`${field} refuses present nontext %j`,value=>expect(checkOrthoSessionDraft({caseId:1,[field]:value})).toMatchObject({ok:false}));
 it.each([null,""," \t "])(`${field} preserves blank/null normalization %j`,value=>expect(checkOrthoSessionDraft({caseId:1,[field]:value})).toMatchObject({ok:true,value:{[field]:null}}));
}
it("keeps omitted text and whole-session absence compatible",()=>{
 expect(checkOrthoSessionDraft({caseId:1})).toMatchObject({ok:true,value:{upperWire:null,lowerWire:null,elasticNote:null,done:null,note:null}});
 expect(checkOrthoSessionDraft(null)).toEqual({ok:true,value:null});expect(checkOrthoSessionDraft(undefined)).toEqual({ok:true,value:null});
});
