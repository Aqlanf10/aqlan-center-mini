/** Lifetime/error-injection tests; actual PG suites prove account authorization. */
import {beforeEach,afterEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({pool:undefined as unknown,schema:vi.fn(),ensure:vi.fn(),authority:vi.fn()}));
vi.mock("../lib/db",()=>({getPool:()=>mocks.pool,ensureSchema:mocks.ensure}));
vi.mock("../lib/legacy-staff-boundary",()=>({readLegacyStaffSchema:mocks.schema}));
vi.mock("../lib/session",()=>({revalidateLegacySessionReadOnlySnapshot:mocks.authority}));
import {withLegacyStaffReadOnlySnapshot} from "../lib/legacy-staff-readonly-snapshot";
const lock="SELECT pg_advisory_lock_shared(hashtextextended($1,0))",unlock="SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked";
beforeEach(()=>{vi.clearAllMocks();mocks.schema.mockResolvedValue("base");});
afterEach(()=>vi.restoreAllMocks());
function setup(){
 const session={userId:1,username:"synthetic",role:"admin",expiresAt:Date.now()+1000,credentialVersion:"synthetic"};
 const query=vi.fn(async(sql:string)=>({rows:sql===unlock?[{unlocked:true}]:[]})),release=vi.fn();
 mocks.pool={connect:async()=>({query,release})};mocks.authority.mockResolvedValue(session);
 const policy={allows:(current:{role:string})=>current.role==="admin",unauthorized:()=>new Error("domain-unauthorized"),expired:()=>new Error("domain-expired")};
 return {session,query,release,policy};
}
it("expires after successful callback and rolls back rather than returning its facts",async()=>{
 const f=setup(),read=vi.fn(async()=>{vi.spyOn(Date,"now").mockReturnValue(f.session.expiresAt);return {privateFacts:123};});
 await expect(withLegacyStaffReadOnlySnapshot(f.session,f.policy,read)).rejects.toThrow("domain-expired");expect(read).toHaveBeenCalledTimes(1);
 expect(f.query.mock.calls.map(([sql])=>sql)).toEqual([lock,"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY","ROLLBACK",unlock]);expect(f.release).toHaveBeenCalledWith(false);
});
it("returns facts only after successful commit and explicit unlock",async()=>{
 const f=setup();expect(await withLegacyStaffReadOnlySnapshot(f.session,f.policy,async()=>({fact:123}))).toEqual({fact:123});
 expect(f.query.mock.calls.map(([sql])=>sql)).toEqual([lock,"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY","COMMIT",unlock]);expect(f.release).toHaveBeenCalledWith(false);
});
it("domain role refusal prevents callback while retaining rollback/unlock",async()=>{
 const f=setup(),read=vi.fn();mocks.authority.mockResolvedValue({...f.session,role:"doctor"});
 await expect(withLegacyStaffReadOnlySnapshot(f.session,f.policy,read)).rejects.toThrow("domain-unauthorized");expect(read).not.toHaveBeenCalled();
 expect(f.query.mock.calls.map(([sql])=>sql).slice(-2)).toEqual(["ROLLBACK",unlock]);expect(f.release).toHaveBeenCalledWith(false);
});
