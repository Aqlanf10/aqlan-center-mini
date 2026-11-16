import {describe,it,expect} from "vitest";
import {assertExplicitLabSource,type LabPrescriptionInput} from "../lib/lab-prescription-input";
const draft:LabPrescriptionInput={partyId:null,shade:"",stumpShade:"",toothNumbers:"",dueDate:"2026-11-01",impressionType:"physical",priority:"normal"};
describe("materialized explicit lab source geometry",()=>{
 it("preserves all known teeth with neutral roles for incomplete draft",()=>expect(assertExplicitLabSource(draft,[28,26,27,26],"جسر")).toBe("26, 27, 28"));
 it("allows explicit roles on exactly the original bridge scope",()=>{const teeth="26(Abutment), 27(Pontic), 28(Abutment)";expect(assertExplicitLabSource({...draft,toothNumbers:teeth},[26,27,28],"جسر")).toBe(teeth);});
 it.each(["26(Abutment), 28(Abutment)","26(Abutment), 27(Pontic), 28(Abutment), 25(Pontic)"])("rejects silently changing materialized geometry %s",toothNumbers=>expect(()=>assertExplicitLabSource({...draft,toothNumbers},[26,27,28],"جسر")).toThrow());
 it("does not permit crown role on a bridge source",()=>expect(()=>assertExplicitLabSource({...draft,toothNumbers:"27(Crown)"},[27],"جسر")).toThrow());
});
