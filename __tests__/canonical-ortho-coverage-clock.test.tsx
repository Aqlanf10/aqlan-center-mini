import { renderToStaticMarkup } from "react-dom/server";
import { expect,it,vi } from "vitest";
const hooks=vi.hoisted(()=>({cursor:0,values:[] as unknown[]}));
vi.mock("react",async original=>({...await original<typeof import("react")>(),useId:()=>"synthetic-coverage-clock",useEffect:()=>undefined,useState:()=>[hooks.values[hooks.cursor++],()=>undefined]}));
// The independent command editor has its own transport/journal tests. This witness
// renders the saved-date component through React rather than calling its hooks.
vi.mock("../components/OrthoFollowupCoveragePanel",()=>({OrthoFollowupCoveragePanel:()=>null}));
import { CanonicalOrthoCoverage } from "../components/patient/CanonicalOrthoCoverage";
import { formatClinicDate } from "../lib/clinic-clock";
function label(createdAt:string,clinicTimeZone:string){
 const feed={projection:"ortho-followup-coverage",patientId:1,orthoCaseId:2,clinicTimeZone,enabled:true,applicable:true,current:{id:"1",version:1,decision:"included",reason:"SYN saved decision",createdBy:"SYN",createdAt},invoiceSources:{state:"restricted"}};
 hooks.cursor=0;hooks.values=[true,0,feed,null];
 return renderToStaticMarkup(<CanonicalOrthoCoverage patientId={1} caseId={2} />).match(/<time[^>]*>(.*?)<\/time>/)?.[1];
}
it("Aden midnight: the stored Oct31 22:30Z instant is a Nov1 01:30 clinic decision",()=>{expect(label("2026-10-31T22:30:00.000Z","Asia/Aden")).toBe("الأحد 01/11/2026");});
it.each([
 ["2026-10-31T20:59:59.000Z","Asia/Aden","السبت 31/10/2026"],
 ["2026-10-31T21:00:00.000Z","Asia/Aden","الأحد 01/11/2026"],
 ["2026-11-01T02:30:00.000Z","America/New_York","السبت 31/10/2026"],
])("renders the supplied clinic zone for %s in %s",(instant,zone,expected)=>{expect(label(instant,zone)).toBe(expected);});
it("the existing formatter keeps a calendar business date literal",()=>{expect(formatClinicDate("2026-11-01","America/Los_Angeles")).toBe("الأحد 01/11/2026");});
