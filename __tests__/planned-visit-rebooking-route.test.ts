import { beforeEach, expect, it, vi } from "vitest";
const deps=vi.hoisted(()=>({session:vi.fn(),rebook:vi.fn()}));
vi.mock("../lib/session",()=>({requireSession:deps.session}));
vi.mock("../lib/planned-visit-rebooking",()=>({rebookPlannedVisit:deps.rebook}));
import { POST } from "../app/api/planned-visits/[id]/rebook/route";
import { parsePlannedRebookIntent } from "../lib/planned-visit-rebooking-contract";
import { apiRouteVerdict } from "../lib/http-permissions";
const body={expectedAppointmentId:12,expectedGeneration:"a".repeat(32),date:"2026-12-23",time:"16:00",reason:"طلب موعد بديل",requestId:"synthetic-rebook-attempt-1"};
const post=(value:unknown=body,id="10")=>POST(new Request("http://localhost/api/planned-visits/10/rebook",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)}),{params:Promise.resolve({id})});
beforeEach(()=>{vi.clearAllMocks();deps.session.mockResolvedValue({username:"synthetic",role:"reception"});deps.rebook.mockResolvedValue({ok:true,appointmentId:44,title:"Synthetic session",replayed:false});});
it("requires a live session before parsing or writing",async()=>{deps.session.mockResolvedValue(null);expect((await post()).status).toBe(401);expect(deps.rebook).not.toHaveBeenCalled();});
it.each(["assistant","cashier","accountant","unknown"])("rejects direct route invocation by %s",async role=>{deps.session.mockResolvedValue({role});expect((await post()).status).toBe(403);expect(deps.rebook).not.toHaveBeenCalled();});
it.each(["0","01","1e2","1.0","-1","2147483648"])("rejects path identifier %s",async id=>{expect((await post(body,id)).status).toBe(400);expect(deps.rebook).not.toHaveBeenCalled();});
it.each([
  null, [], {}, {...body,expectedGeneration:undefined}, {...body,expectedGeneration:"bad"}, {...body,expectedAppointmentId:"12"}, {...body,expectedAppointmentId:0}, {...body,expectedAppointmentId:2147483648}, {...body,date:"0000-01-01"},
  {...body,date:"2026-02-30"}, {...body,date:"2026-13-01"}, {...body,time:"24:00"}, {...body,time:"16:61"},
  {...body,reason:" "}, {...body,reason:"a".repeat(501)}, {...body,requestId:"short"},
  {...body,patientId:99}, {...body,doctorId:99}, {...body,overrideReason:"bypass"}, {...body,amountMinor:1},
])("rejects malformed or scope-expanding payload %#",async value=>{expect((await post(value)).status).toBe(400);expect(deps.rebook).not.toHaveBeenCalled();});
it("passes canonical body plus authenticated server session only",async()=>{
  const response=await post(); expect(response.status).toBe(201);expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({appointmentId:44,title:"Synthetic session",replayed:false});
  expect(deps.rebook).toHaveBeenCalledWith({plannedVisitId:10,...body},{username:"synthetic",role:"reception"});
});
it("maps recovered retry to 200 and every domain refusal without inventing success",async()=>{
  deps.rebook.mockResolvedValue({ok:true,appointmentId:44,title:"Synthetic session",replayed:true});expect((await post()).status).toBe(200);
  for(const status of [400,401,403,404,409]){deps.rebook.mockResolvedValue({ok:false,status,message:"Synthetic refusal"});expect((await post()).status).toBe(status);}
  deps.rebook.mockRejectedValue(new Error("Synthetic failure"));const failure=await post();expect(failure.status).toBe(500);expect((await failure.json()).message).toContain("المحاولة نفسها");
});
it("preserves complete 500-character reasons in canonical intent",()=>{
  expect(parsePlannedRebookIntent(10,{...body,reason:"x".repeat(500)})?.reason).toHaveLength(500);
});
it("registers exactly existing clinical appointment permissions",()=>{
  expect(apiRouteVerdict("/api/planned-visits/10/rebook","POST")).toEqual({kind:"registered",pattern:"/api/planned-visits/[id]/rebook",access:["admin","reception","doctor"]});
});
