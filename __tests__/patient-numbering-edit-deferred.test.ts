import {expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({ensureSchema:vi.fn(),getPool:vi.fn(),audit:vi.fn()}));
vi.mock("../lib/db",()=>({ensureSchema:mocks.ensureSchema,getPool:mocks.getPool,insertAuditRow:mocks.audit}));
vi.mock("../lib/session",()=>({revalidateSessionInTransaction:vi.fn()}));
import {changePatientNumber} from "../lib/patient-numbering-db";
import type {SessionPayload} from "../lib/auth";
it.each(["admin","doctor","reception"])("service refuses %s existing-number changes before DB initialization or writes",async role=>{
 const session={username:"synthetic",role,expiresAt:Date.now()+60000} as SessionPayload;
 await expect(changePatientNumber(session,42,{patientNumber:"150",expectedVersion:"1",expectedPatientNumber:"P-00880",reason:"Synthetic forbidden correction"})).rejects.toMatchObject({code:"forbidden"});
 expect(mocks.ensureSchema).not.toHaveBeenCalled();expect(mocks.getPool).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();
});
