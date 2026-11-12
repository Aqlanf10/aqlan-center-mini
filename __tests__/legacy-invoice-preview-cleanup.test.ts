/** Failure injection proves cleanup only; real PG suite proves authorization. */
import {beforeEach,expect,it,vi} from "vitest";
import type {QueryResult} from "../lib/db";
const state=vi.hoisted(()=>({pool:undefined as unknown,ensure:vi.fn(),schema:vi.fn(),authorize:vi.fn()}));
vi.mock("../lib/db",()=>({getPool:()=>state.pool,ensureSchema:state.ensure,CLINIC_TIME_ZONE:"Asia/Aden"}));
vi.mock("../lib/legacy-staff-boundary",()=>({readLegacyStaffSchema:state.schema}));
vi.mock("../lib/session",()=>({revalidateLegacySessionReadOnlySnapshot:state.authorize,revalidateSessionInTransaction:vi.fn()}));
import {readInvoiceRevision} from "../lib/invoice-revision-db";
const session={userId:1,username:"synthetic",role:"admin",expiresAt:Date.now()+600000,credentialVersion:"synthetic"};
const lock="SELECT pg_advisory_lock_shared(hashtextextended($1,0))",unlock="SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked";
beforeEach(()=>{vi.clearAllMocks();state.schema.mockResolvedValue("base");state.ensure.mockResolvedValue(undefined);state.authorize.mockRejectedValue(new Error("synthetic authorization refusal"));});
function fixture(fail:string|null=null,unlocked=true){
 const query=vi.fn(async(sql:string):Promise<QueryResult<any>>=>{if(sql===fail)throw new Error("synthetic query failure");return {rows:sql===unlock?[{unlocked}]:[]};});
 const release=vi.fn(),connect=vi.fn(async()=>({query,release}));state.pool={connect};return {query,release,connect};
}
it("authorization occurs inside RR read-only after session fence; failure rolls back then unlocks",async()=>{
 const f=fixture();await expect(readInvoiceRevision(1,session)).rejects.toThrow("authorization refusal");
 expect(f.query.mock.calls.map(c=>c[0])).toEqual([lock,"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY","ROLLBACK",unlock]);expect(f.release).toHaveBeenCalledWith(false);
});
it.each(["false","error"])("unlock %s discards backend",async(mode)=>{
 const f=fixture(mode==="error"?unlock:null,mode!=="false");await expect(readInvoiceRevision(1,session)).rejects.toThrow("authorization refusal");expect(f.release).toHaveBeenCalledWith(true);
});
it("rollback failure discards even when unlock succeeds",async()=>{
 const f=fixture("ROLLBACK");await expect(readInvoiceRevision(1,session)).rejects.toThrow("authorization refusal");expect(f.release).toHaveBeenCalledWith(true);
});
it("uncertain lock acquisition discards and never begins snapshot",async()=>{
 const f=fixture(lock);await expect(readInvoiceRevision(1,session)).rejects.toThrow("query failure");expect(f.query).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledWith(true);
});
it("original schema refusal never initializes or checks out another client",async()=>{
 const f=fixture();state.schema.mockRejectedValue(new Error("schema held"));await expect(readInvoiceRevision(1,session)).rejects.toThrow("schema held");expect(state.ensure).not.toHaveBeenCalled();expect(f.connect).not.toHaveBeenCalled();
});
