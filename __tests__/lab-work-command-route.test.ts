import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({session:vi.fn(),active:vi.fn(),query:vi.fn(),release:vi.fn(),supported:vi.fn(),read:vi.fn(),connect:vi.fn()}));
vi.mock("../lib/db",()=>({getPool:()=>({connect:mocks.connect})}));
vi.mock("../lib/session",()=>({requireSession:mocks.session,revalidateSessionInTransaction:mocks.active}));
vi.mock("../lib/lab-work-intent-db",()=>({labWorkIntentSupported:mocks.supported,readLabWorkCommandInTransaction:mocks.read,LabWorkIntentError:class extends Error{constructor(readonly code:string,readonly status:number){super(code);}}}));
import {GET as capability} from "../app/api/lab/work-intents/capability/route";
import {GET as reconcile} from "../app/api/visits/[id]/lab-work-command/route";
const actor={userId:17,username:"synthetic-doctor",role:"doctor"};
const request=()=>new Request(`http://localhost/api/visits/7/lab-work-command?key=synthetic-key&hash=${"a".repeat(64)}`);
const context={params:Promise.resolve({id:"7"})};
beforeEach(()=>{vi.clearAllMocks();mocks.connect.mockResolvedValue({query:mocks.query,release:mocks.release});mocks.session.mockResolvedValue(actor);mocks.active.mockResolvedValue(actor);mocks.supported.mockResolvedValue(true);mocks.query.mockImplementation(async(sql:string)=>({rows:sql.startsWith("SELECT patient_id")?[{patient_id:9}]:[]}));mocks.read.mockResolvedValue({labWork:[]});});
describe("lab operation reference endpoints",()=>{
 it("absent session is 401 before database access",async()=>{
  mocks.session.mockResolvedValue(null);const response=await capability();
  expect(response.status).toBe(401);expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({supported:false,message:expect.stringMatching(/[\u0600-\u06ff]/)});
  expect(mocks.connect).not.toHaveBeenCalled();expect(mocks.supported).not.toHaveBeenCalled();
 });
 it("revoked fresh session is 401 without schema reads or writes",async()=>{
  mocks.active.mockResolvedValue(null);const response=await capability();
  expect(response.status).toBe(401);expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({supported:false,message:expect.stringMatching(/[\u0600-\u06ff]/)});
  expect(mocks.supported).not.toHaveBeenCalled();expect(mocks.query.mock.calls).toEqual([["BEGIN"],["ROLLBACK"]]);
  expect(mocks.release).toHaveBeenCalledTimes(1);expect(mocks.release).toHaveBeenCalledWith();
 });
 it.each(["reception","cashier","accountant","assistant"])("fresh active %s is denied before capability schema reads",async role=>{
  const denied={...actor,role};mocks.session.mockResolvedValue(denied);mocks.active.mockResolvedValue(denied);
  const response=await capability();expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({supported:false,message:expect.stringMatching(/[\u0600-\u06ff]/)});
  expect(mocks.active).toHaveBeenCalledWith(denied,{query:mocks.query,release:mocks.release});
  expect(mocks.supported).not.toHaveBeenCalled();expect(mocks.query.mock.calls).toEqual([["BEGIN"],["ROLLBACK"]]);
  expect(mocks.release).toHaveBeenCalledTimes(1);expect(mocks.release).toHaveBeenCalledWith();
 });
 it.each(["admin","doctor"])("eligible %s gets only the proposal availability boolean",async role=>{
  mocks.session.mockResolvedValue({...actor,role});mocks.active.mockResolvedValue({...actor,role});
  for(const supported of [true,false]){
   mocks.supported.mockResolvedValue(supported);const response=await capability();
   expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");
   expect(await response.json()).toEqual({supported});
  }
  expect(mocks.supported).toHaveBeenCalledTimes(2);
  expect(mocks.query.mock.calls).toEqual([["BEGIN"],["ROLLBACK"],["BEGIN"],["ROLLBACK"]]);
  expect(mocks.release.mock.calls).toEqual([[],[]]);
 });
 it("fresh changed role cannot retain admitted doctor authority",async()=>{
  mocks.active.mockResolvedValue({...actor,role:"reception"});const response=await capability();
  expect(response.status).toBe(403);expect(mocks.supported).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls).toEqual([["BEGIN"],["ROLLBACK"]]);expect(mocks.release).toHaveBeenCalledTimes(1);expect(mocks.release).toHaveBeenCalledWith();
 });
 it("thrown authentication lookup becomes an uncached 503 before pool access",async()=>{
  mocks.session.mockRejectedValue(new Error("synthetic authentication lookup failure"));const response=await capability();
  expect(response.status).toBe(503);expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({supported:false,message:expect.stringMatching(/[\u0600-\u06ff]/)});
  expect(mocks.connect).not.toHaveBeenCalled();expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.supported).not.toHaveBeenCalled();expect(mocks.release).not.toHaveBeenCalled();
 });
 it.each(["eligible","revoked","denied"])("failed rollback discards the %s client instead of reusing uncertain transaction state",async state=>{
  if(state==="revoked")mocks.active.mockResolvedValue(null);
  if(state==="denied")mocks.active.mockResolvedValue({...actor,role:"reception"});
  mocks.query.mockImplementation(async(sql:string)=>{if(sql==="ROLLBACK")throw new Error("synthetic rollback failure");return {rows:[]};});
  const response=await capability();expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toContain("no-store");expect(await response.json()).toMatchObject({supported:false});
  expect(mocks.query.mock.calls).toEqual([["BEGIN"],["ROLLBACK"]]);
  expect(mocks.release.mock.calls).toEqual([[true]]);
  if(state!=="eligible")expect(mocks.supported).not.toHaveBeenCalled();
 });
 it.each(["begin","capability"])("%s query failure followed by rollback failure discards the connection",async stage=>{
  mocks.query.mockImplementation(async(sql:string)=>{
   if(sql==="ROLLBACK"||(stage==="begin"&&sql==="BEGIN"))throw new Error("synthetic query failure");return {rows:[]};
  });
  if(stage==="capability")mocks.supported.mockRejectedValue(new Error("synthetic capability query failure"));
  const response=await capability();expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toContain("no-store");expect(await response.json()).toMatchObject({supported:false});
  expect(mocks.query.mock.calls).toEqual([["BEGIN"],["ROLLBACK"]]);expect(mocks.release.mock.calls).toEqual([[true]]);
  if(stage==="begin")expect(mocks.supported).not.toHaveBeenCalled();
 });
 it("pool failure is an uncached unavailable response, not an unhandled rejection",async()=>{
  mocks.connect.mockRejectedValue(new Error("synthetic connection unavailable"));const response=await capability();
  expect(response.status).toBe(503);expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({supported:false,message:expect.stringMatching(/[\u0600-\u06ff]/)});
  expect(mocks.query).not.toHaveBeenCalled();expect(mocks.release).not.toHaveBeenCalled();expect(mocks.supported).not.toHaveBeenCalled();
 });
 it("capability read failure rolls back and releases without installing schema",async()=>{
  mocks.supported.mockRejectedValue(new Error("synthetic read failure"));const response=await capability();
  expect(response.status).toBe(503);expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toMatchObject({supported:false});
  expect(mocks.query.mock.calls).toEqual([["BEGIN"],["ROLLBACK"]]);expect(mocks.release).toHaveBeenCalledTimes(1);expect(mocks.release).toHaveBeenCalledWith();
 });
 it("reconciliation returns only exact actor/patient/visit reference and stored receipt",async()=>{const response=await reconcile(request(),context);expect(await response.json()).toEqual({found:true,receipt:{requestKey:"synthetic-key",requestHash:"a".repeat(64),visitId:7,patientId:9,actor:actor.username},result:{labWork:[]}});expect(mocks.read.mock.calls[0][1]).toMatchObject({session:actor,patientId:9,sourceId:7,sourceKind:"visit",requestKey:"synthetic-key",requestHash:"a".repeat(64)});expect(mocks.release).toHaveBeenCalled();});
 it("source relinking during recovery cannot leak a receipt",async()=>{mocks.query.mockImplementation(async(sql:string)=>({rows:sql.startsWith("SELECT patient_id")?[{patient_id:sql.includes("FOR SHARE")?99:9}]:[]}));expect((await reconcile(request(),context)).status).toBe(409);expect(mocks.read).not.toHaveBeenCalled();});
 it("unknown outcome is not acknowledged",async()=>{mocks.read.mockResolvedValue(null);expect(await (await reconcile(request(),context)).json()).toEqual({found:false});});
 it.each(["reception","cashier","assistant"])("does not grant %s clinical recovery authority",async(role)=>{mocks.session.mockResolvedValue({...actor,role});expect((await reconcile(request(),context)).status).toBe(403);expect(mocks.read).not.toHaveBeenCalled();});
 it("invalid reference never reaches database",async()=>{expect((await reconcile(new Request("http://localhost/?key=x&hash=invalid"),context)).status).toBe(400);expect(mocks.query).not.toHaveBeenCalled();});
});
