import {HTTP_PERMISSIONS} from "../lib/http-permissions";
import {beforeEach,expect,it,vi} from "vitest";
const mock=vi.hoisted(()=>({session:null as null|{role:string},read:vi.fn(),change:vi.fn(),preview:vi.fn(),configure:vi.fn()}));
vi.mock("../lib/session",()=>({requireSession:async()=>mock.session}));
vi.mock("../lib/patient-numbering-db",()=>({readPatientNumber:mock.read,changePatientNumber:mock.change,readNumberingPreview:mock.preview,changeNumberingFloor:mock.configure,PatientNumberingError:class extends Error {code="invalid";}}));
import * as numbers from "../app/api/patients/[id]/number/route";
import * as settings from "../app/api/settings/patient-numbering/route";
const request=(body:unknown)=>new Request("http://localhost/api/patients/42/number",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mock.session=null;mock.change.mockResolvedValue({patientId:42,patientNumber:"P-07000",version:"2"});mock.configure.mockResolvedValue({minimumNext:"8000",version:"2"});});
it("denies missing sessions before reading numbering data or commands",async()=>{
  expect((await numbers.PATCH()).status).toBe(401);
  expect((await settings.GET()).status).toBe(401);
  expect((await settings.PATCH(request({}))).status).toBe(401);
  expect(mock.change).not.toHaveBeenCalled();expect(mock.preview).not.toHaveBeenCalled();
});
it.each(["doctor","reception","assistant","cashier","accountant"])("current standalone boundary denies %s",async(role)=>{
  mock.session={role};
  expect((await numbers.PATCH()).status).toBe(403);expect((await settings.GET()).status).toBe(403);expect((await settings.PATCH(request({}))).status).toBe(403);
});
it("refuses existing-number edits even for admins without calling any DB command",async()=>{
  mock.session={role:"admin"};
  const response=await numbers.PATCH();
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({code:"number_edit_deferred"});
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(mock.change).not.toHaveBeenCalled();expect(mock.read).not.toHaveBeenCalled();
});
it("does not expose an unused identity read endpoint",()=>{expect(numbers).not.toHaveProperty("GET");});
it("uses the dedicated future-only floor command",async()=>{mock.session={role:"admin"};const body={minimumNext:"8000",expectedVersion:"1",expectedNextNumber:"P-07000",reason:"Future files"};expect((await settings.PATCH(request(body))).status).toBe(200);expect(mock.configure).toHaveBeenCalledWith(mock.session,body);});

it.each(["/api/patients/[id]/number","/api/settings/patient-numbering"])("registers the strict admin-only read/write boundary for %s",pattern=>{
 expect(HTTP_PERMISSIONS[pattern]).toEqual(pattern === "/api/patients/[id]/number" ? {PATCH:["admin"]} : {GET:["admin"],PATCH:["admin"]});
});
