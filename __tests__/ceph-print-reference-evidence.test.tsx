import { completionProvenance } from "./fixtures/ceph-completion-evidence";
import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cephSourceIdentity } from "../lib/ceph-completion-provenance";
const m = vi.hoisted(() => ({ study: vi.fn(), catalog: vi.fn() }));
vi.mock("../lib/db", () => ({ getCephStudy:m.study,getCephReferenceSet:m.catalog,getSettingsSafe:async()=>({}),getPatient:async()=>({fullName:"Synthetic"}) }));
vi.mock("../lib/session",()=>({requireSession:async()=>({username:"Synthetic"})}));
vi.mock("../lib/patient-access",()=>({canAccessPatient:async()=>true}));
vi.mock("next/navigation",()=>({notFound:()=>{throw new Error("not found")}}));
vi.mock("../components/PrintDocument",()=>({PrintMetadata:({children}:{children:ReactNode})=>children,PrintTableFrame:({children}:{children:ReactNode})=>children}));
vi.mock("../components/PrintHeader",()=>({PrintHeader:()=>null,PrintFooter:()=>null}));
vi.mock("../components/PrintButton",()=>({PrintButton:()=>null}));
import Page from "../app/print/ceph/[id]/page";
const source={key:"selected-print",name:"Bound print source",version:"v1",population:null,ageMin:null,ageMax:null,sex:null,active:true,values:[{code:"SNA",mean:110,sd:3}]};
const makeStudy=()=>({analysis:{id:71,patientId:11,documentId:51,status:"draft",refSet:"selected-print",mmPerPixel:1,phase:"pretreatment"},
  landmarks:[{code:"S",x:0,y:0},{code:"N",x:10,y:0},{code:"A",x:10,y:10},{code:"B",x:10,y:20}],measurements:[],diagnosis:null,
  completionSources:{state:"available",referenceSet:source,identity:cephSourceIdentity({documentId:51,sha256:"a".repeat(64),width:null,height:null},source)}});
const output=async()=>renderToStaticMarkup(await Page({params:Promise.resolve({id:"71"})}));
beforeEach(()=>{vi.clearAllMocks();m.study.mockResolvedValue(makeStudy());m.catalog.mockResolvedValue({name:"Torn later read",values:{SNA:{mean:1,sd:99}}});});
describe("draft print uses only source-bound informational reference evidence",()=>{
  it("uses the same bundled reference rather than a second mutable catalog read",async()=>{
    const html=await output(); expect(m.catalog).not.toHaveBeenCalled(); expect(html).toContain("Bound print source");
    expect(html).toContain("selected-print@v1"); expect(html).toContain("110±3"); expect(html).not.toContain("Torn later read");
    expect(html).toContain("ملاءمة هذه المراجع لهذا المريض غير متحققة");
    expect(html).not.toContain("***"); expect(html).not.toContain("Maxillary Prognathism");
    expect(html).not.toContain("الشدة / Dev"); expect(html).not.toContain("المؤشر / Gauge");
    expect(html).not.toContain("80±2");
  });
  it("keeps finite large catalog values and never borrows measurement units for them",async()=>{
    const study=makeStudy(); study.completionSources.referenceSet={...source,values:[{code:"SNA",mean:1e308,sd:1e308}]};
    m.study.mockResolvedValue(study); const html=await output();
    expect(html).toContain("1e+308±1e+308"); expect(html).not.toContain("Infinity"); expect(html).not.toContain("1e+308±1e+308°");
    expect(html).toContain("ليست لقطة اعتماد");
  });
  it.each([undefined,{state:"unavailable",reason:"missing"}])("does not manufacture draft norms when sources are unavailable (%j)",async sources=>{
    m.study.mockResolvedValue({...makeStudy(),completionSources:sources}); const html=await output();
    expect(html).not.toContain("Torn later read"); expect(html).not.toContain("82±2"); expect(html).toContain("غير متاح");
  });
});


describe("saved completion evidence in print", () => {
  it.each([1, 2] as const)("prints saved calibration and seal without current source substitution (v%s)", async version => {
    m.study.mockResolvedValue({ ...makeStudy(), analysis: { ...makeStudy().analysis, status: "completed", mmPerPixel: 999 },
      provenance: completionProvenance(version) });
    const html = await output();
    expect(html.includes('data-testid="ceph-saved-completion-evidence"')).toBe(true);
    expect(html).toContain("0.125 mm/px"); expect(html).toContain("SAVED_SEAL_ACTOR");
  });
  it.each([undefined, { state: "unversioned", reason: "historical_completion_without_witness" }, { state: "integrity_unavailable", reason: "invalid_completion_witness" }])("omits unavailable completed evidence %j", async provenance => {
    m.study.mockResolvedValue({ ...makeStudy(), analysis: { ...makeStudy().analysis, status: "completed" }, provenance });
    expect(await output()).not.toContain('data-testid="ceph-saved-completion-evidence"');
  });
  it("does not use a supplied witness as draft completion evidence", async () => {
    m.study.mockResolvedValue({ ...makeStudy(), provenance: completionProvenance() });
    expect(await output()).not.toContain('data-testid="ceph-saved-completion-evidence"');
  });

});
