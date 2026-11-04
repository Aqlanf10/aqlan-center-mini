import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({session:vi.fn(),complete:vi.fn(),get:vi.fn(),status:vi.fn(),money:vi.fn()}));
vi.mock("../lib/session",()=>({requireSession:mocks.session}));
vi.mock("../lib/db",()=>({deleteLabOrder:vi.fn(),getLabOrderById:mocks.get,getSettings:vi.fn(),labOrderEvents:vi.fn(),recordAudit:vi.fn(),setLabOrderDueDate:vi.fn(),setLabOrderStatus:mocks.status,updateLabOrderAccounting:mocks.money}));
vi.mock("../lib/lab-prescription-write",()=>({completeLabPrescription:mocks.complete,LabPrescriptionError:class extends Error{status=409;}}));
import { PATCH } from "../app/api/lab/[id]/route";
const prescription={partyId:47,shade:"A2",stumpShade:"",toothNumbers:"27(Crown)",dueDate:"2026-11-01",impressionType:"physical",priority:"normal"};
const call=(body:unknown,id="381")=>PATCH(new Request(`http://localhost/api/lab/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),{params:Promise.resolve({id})});
beforeEach(()=>{vi.resetAllMocks();mocks.session.mockResolvedValue({username:"synthetic",role:"admin"});mocks.complete.mockResolvedValue({id:381,status:"needed"});mocks.get.mockResolvedValue({id:381,status:"needed"});});
describe("lab prescription API",()=>{
 it("requires authentication",async()=>{mocks.session.mockResolvedValue(null);expect((await call({action:"complete_prescription"})).status).toBe(401);expect(mocks.complete).not.toHaveBeenCalled();});
 it("blocks legacy bare dispatch of incomplete pending requests",async()=>{expect((await call({status:"sent"})).status).toBe(409);expect(mocks.status).not.toHaveBeenCalled();});
 it.each([{expected:undefined},{dispatch:undefined},{prescription:{...prescription,shade:"bad shade"}},{prescription:{...prescription,cost:50}}])("refuses malformed completion %j",async change=>{expect((await call({action:"complete_prescription",prescription,expected:"snapshot",dispatch:false,...change})).status).toBe(400);expect(mocks.complete).not.toHaveBeenCalled();});
 it("only invokes the clinical completion writer and returns its minimal result",async()=>{
  const result=await call({action:"complete_prescription",prescription,expected:"snapshot",dispatch:false});
  expect(result.status).toBe(200);expect(await result.json()).toEqual({id:381,status:"needed"});
  expect(mocks.complete).toHaveBeenCalledWith(381,prescription,"snapshot",false,{username:"synthetic",role:"admin"});
  expect(mocks.money).not.toHaveBeenCalled();expect(mocks.status).not.toHaveBeenCalled();
 });
});
