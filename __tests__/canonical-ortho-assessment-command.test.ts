import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseCanonicalOrthoAssessmentCommand as parse } from "../lib/canonical-ortho-assessment-command";
import { AssessmentStoreFault } from "../lib/ortho-assessment-authority";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";
it("keeps the existing schema2 clinical command and request identity without inferred input", () => {
  const command=assessmentCommandV2();expect(parse("17",command)).toEqual({id:17,command});
});
it.each(["0","01","-1","1.2","1e2","2147483648","1x"])("rejects ambiguous case identity %s",id=>{
  expect(()=>parse(id,assessmentCommandV2())).toThrow(AssessmentStoreFault);
});
it.each([
  {schemaVersion:1}, {actor:"owner"}, {force:true}, {patientId:7}, {commandId:[]}, {commandId:"short"},
  {expectedRevisionId:"1"}, {expectedRevisionId:0}, {reason:["SYN"]}, {reason:{}}, {reason:""},
  {content:[]}, {content:{}}, {schemaVersion:[2]},
])("rejects coerced, incomplete or authority-bearing data %#",overrides=>{
  expect(()=>parse("17",{...assessmentCommandV2(),...overrides})).toThrow(AssessmentStoreFault);
});
it.each([null,[],"{}",17])("rejects non-object request %#",body=>{
  expect(()=>parse("17",body)).toThrow(AssessmentStoreFault);
});
