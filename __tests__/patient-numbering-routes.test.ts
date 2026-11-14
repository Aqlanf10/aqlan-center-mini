import {HTTP_PERMISSIONS} from "../lib/http-permissions";
import {beforeEach,expect,it,vi} from "vitest";
const mock=vi.hoisted(()=>({session:null as null|{role:string},read:vi.fn(),change:vi.fn(),preview:vi.fn(),configure:vi.fn()}));
vi.mock("../lib/session",()=>({requireSession:async()=>mock.session}));
vi.mock("../lib/patient-numbering-db",()=>({readPatientNumber:mock.read,changePatientNumber:mock.change,readNumberingPreview:mock.preview,changeNumberingFloor:mock.configure,PatientNumberingError:class extends Error {code="invalid";}}));
import * as numbers from "../app/api/patients/[id]/number/route";
import * as settings from "../app/api/settings/patient-numbering/route";
const context={params:Promise.resolve({id:"42"})};
const request=(body:unknown)=>new Request("http://localhost/api/patients/42/number",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mock.session=null;mock.change.mockResolvedValue({patientId:42,patientNumber:"P-07000",version:"2"});mock.configure.mockResolvedValue({minimumNext:"8000",version:"2"});});
it("denies missing sessions before reading numbering data or commands",async()=>{
  expect((await numbers.GET(new Request("http://localhost"),context)).status).toBe(401);
  expect((await numbers.PATCH(request({}),context)).status).toBe(401);
  expect((await settings.GET()).status).toBe(401);
  expect((await settings.PATCH(request({}))).status).toBe(401);
  expect(mock.change).not.toHaveBeenCalled();expect(mock.preview).not.toHaveBeenCalled();
});
it.each(["doctor","reception","assistant","cashier","accountant"])("current standalone boundary denies %s",async(role)=>{
  mock.session={role};expect((await numbers.GET(new Request("http://localhost"),context)).status).toBe(403);
  expect((await numbers.PATCH(request({}),context)).status).toBe(403);expect((await settings.GET()).status).toBe(403);expect((await settings.PATCH(request({}))).status).toBe(403);
});
it("passes only the exact number command and server session, never body authority or patient ID",async()=>{
  mock.session={role:"admin"};const body={patientNumber:"7000",expectedVersion:"1",expectedPatientNumber:"P-00042",reason:"Correct paper file",patientId:99,session:{role:"admin"},actor:"forged"};
  expect((await numbers.PATCH(request(body),context)).status).toBe(200);
  expect(mock.change).toHaveBeenCalledWith(mock.session,42,{patientNumber:"7000",expectedVersion:"1",expectedPatientNumber:"P-00042",reason:"Correct paper file"});
});
it.each([null,[],"invalid"])("refuses malformed bounded body %s",async(body)=>{mock.session={role:"admin"};expect((await numbers.PATCH(request(body),context)).status).toBe(400);expect(mock.change).not.toHaveBeenCalled();});
it("uses the dedicated future-only floor command",async()=>{mock.session={role:"admin"};const body={minimumNext:"8000",expectedVersion:"1",expectedNextNumber:"P-07000",reason:"Future files"};expect((await settings.PATCH(request(body))).status).toBe(200);expect(mock.configure).toHaveBeenCalledWith(mock.session,body);});

it.each(["/api/patients/[id]/number","/api/settings/patient-numbering"])("registers the strict admin-only read/write boundary for %s",pattern=>{
 expect(HTTP_PERMISSIONS[pattern]).toEqual({GET:["admin"],PATCH:["admin"]});
});
