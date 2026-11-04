import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseCanonicalProblemCreate } from "../lib/canonical-problem-create-command";
const input={label:"  SYN clinical problem  ",site:" 26 ",specialty:"endodontics",caseId:7};
describe("canonical clinical problem creation",()=>{
  it("uses original conservative clinical normalization without truncating",()=>expect(parseCanonicalProblemCreate("3",input)).toEqual({patientId:3,label:"SYN clinical problem",site:"26",specialty:"endodontics",caseId:7}));
  it("admits genuinely optional unlinked fields",()=>expect(parseCanonicalProblemCreate("3",{label:"SYN",site:null,specialty:null,caseId:null})).toEqual({patientId:3,label:"SYN",site:null,specialty:null,caseId:null}));
  it.each(["0","01","-1","2147483648","1e2"])("refuses invalid patient %s",id=>expect(()=>parseCanonicalProblemCreate(id,input)).toThrow());
  it.each([null,[],{}, {...input,label:" "},{...input,label:"a".repeat(201)},{...input,site:"a".repeat(61)},{...input,site:1},{...input,specialty:""},{...input,specialty:"unknown"},{...input,caseId:"7"},{...input,caseId:0},{...input,caseId:2147483648},{...input,actor:"owner"},{...input,status:"resolved"},{...input,patientId:4},{...input,responsiblePartyId:8},{...input,amount:100}])("refuses invalid/extra values without dropping requested linkage",body=>expect(()=>parseCanonicalProblemCreate("3",body)).toThrow());
});
