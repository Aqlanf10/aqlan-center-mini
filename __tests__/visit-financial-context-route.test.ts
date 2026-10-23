import { beforeEach, expect, it, vi } from "vitest";
const mock=vi.hoisted(()=>({requireSession:vi.fn(),canAccessPatient:vi.fn(),getClinicalVisit:vi.fn(),getVisitFinancialContext:vi.fn()}));
vi.mock("@/lib/session",()=>({requireSession:mock.requireSession}));
vi.mock("@/lib/patient-access",()=>({canAccessPatient:mock.canAccessPatient}));
vi.mock("@/lib/db",()=>({getClinicalVisit:mock.getClinicalVisit,CLINIC_TIME_ZONE:"Asia/Aden"}));
vi.mock("@/lib/visit-financial-context-db",()=>({getVisitFinancialContext:mock.getVisitFinancialContext}));
import { GET } from "../app/api/visits/[id]/financial-context/route";
import { canViewMoney } from "../lib/roles";
const get=(id="42")=>GET(new Request("https://test.invalid"),{params:Promise.resolve({id})});
beforeEach(()=>{
 vi.resetAllMocks();mock.requireSession.mockResolvedValue({role:"admin",partyId:7});mock.canAccessPatient.mockResolvedValue(true);
 mock.getClinicalVisit.mockResolvedValue({id:42,patientId:23,arrivedAt:new Date().toISOString()});
 mock.getVisitFinancialContext.mockResolvedValue({visitId:42,patientId:23,signed:true,directReferenceState:"current",directReference:{kind:"invoice",id:81,state:"current",path:"visit"},summary:"verified",work:[{key:"procedure:1",id:1,kind:"procedure",coverage:"verified",decision:"none",reasons:[],references:[{kind:"invoice",id:81,state:"current",path:"visit_procedure"}]}]});
});
it.each(["doctor","assistant","admin","reception","accountant","cashier"])("redacts actual GET for %s with existing money policy",async role=>{
 mock.requireSession.mockResolvedValue({role,partyId:7});const response=await get();expect(response.status).toBe(200);
 const body=await response.json();expect(body.work[0].references.length).toBe(canViewMoney(role)?1:0);expect(body.directReference!==null).toBe(canViewMoney(role));
 expect(mock.getVisitFinancialContext).toHaveBeenCalledWith(42,23);expect(response.headers.get("Cache-Control")).toContain("no-store");
});
it("rejects unauthenticated, invalid ID, foreign patient, and historical assistant reads before financial access",async()=>{
 mock.requireSession.mockResolvedValue(null);expect((await get()).status).toBe(401);
 mock.requireSession.mockResolvedValue({role:"doctor"});expect((await get("x")).status).toBe(400);
 mock.canAccessPatient.mockResolvedValue(false);expect((await get()).status).toBe(403);
 mock.requireSession.mockResolvedValue({role:"assistant"});mock.canAccessPatient.mockResolvedValue(true);mock.getClinicalVisit.mockResolvedValue({patientId:23,arrivedAt:"2000-01-01"});expect((await get()).status).toBe(403);
 expect(mock.getVisitFinancialContext).not.toHaveBeenCalled();
});
it("fails closed if snapshot ownership changes",async()=>{
 mock.getVisitFinancialContext.mockRejectedValue(new Error("Visit owner changed"));expect((await get()).status).toBe(500);
});
it("keeps restricted role clinical admission unchanged",async()=>{
 const {restrictedRouteAllowed}=await import("../lib/role-routes");
 for(const role of ["cashier","accountant"] as const)expect(restrictedRouteAllowed(role,"/api/visits/42/financial-context","GET")).toBe(false);
 expect(restrictedRouteAllowed("assistant","/api/visits/42/financial-context","GET")).toBe(true);
 expect(restrictedRouteAllowed("assistant","/api/visits/42/financial-context","POST")).toBe(false);
});
