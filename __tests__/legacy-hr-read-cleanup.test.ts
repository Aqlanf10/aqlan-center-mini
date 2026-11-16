/** Failure-injection unit tests for resource cleanup, not authorization acceptance. */
import type { QueryResult } from "../lib/db";
import { beforeEach, expect, it, vi } from "vitest";
const readers=vi.hoisted(()=>({authorize:vi.fn(),sources:vi.fn()}));
vi.mock("../lib/hr-identity-sources",()=>({authorizeIdentityAdmin:readers.authorize,readHrIdentitySources:readers.sources}));
vi.mock("../lib/hr-identity-preview",()=>({buildIdentityPreview:()=>({sourceDigest:"synthetic"}),parseIdentityPreviewRequest:(v:unknown)=>v,IdentityPreviewError:class extends Error{constructor(public status:number,message:string){super(message);}}}));
import { readHrIdentityPreview } from "../lib/hr-identity-read";
const session=()=>({userId:1,username:"synthetic",role:"admin",expiresAt:Date.now()+60_000,credentialVersion:"synthetic"});
beforeEach(()=>{vi.clearAllMocks();readers.authorize.mockResolvedValue(undefined);readers.sources.mockResolvedValue({});});
function fixture(fail:string|null=null,unlock=true){
 const query=vi.fn(async(sql:string):Promise<QueryResult<any>>=>{if(sql===fail)throw new Error("synthetic query failure");return {rows:sql.includes("pg_advisory_unlock_shared")?[{unlocked:unlock}]:[]};});
 const release=vi.fn();return {pool:{connect:async()=>({query,release})},query,release};
}
it("acquires session fence before RR snapshot and commits before unlock/release",async()=>{
 const f=fixture();await readHrIdentityPreview(f.pool,session());
 expect(f.query.mock.calls.map(c=>c[0])).toEqual(["SELECT pg_advisory_lock_shared(hashtextextended($1,0))","BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY","COMMIT","SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked"]);
 expect(f.release).toHaveBeenCalledWith(false);
});
it("reader failure rolls back before unlock and returns a clean backend",async()=>{
 const f=fixture();readers.sources.mockRejectedValue(new Error("synthetic reader failure"));
 await expect(readHrIdentityPreview(f.pool,session())).rejects.toThrow("reader failure");
 expect(f.query.mock.calls.map(c=>c[0]).slice(-2)).toEqual(["ROLLBACK","SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked"]);expect(f.release).toHaveBeenCalledWith(false);
});
it.each(["false","error"])("failed unlock %s discards backend rather than recycling locks",async(mode)=>{
 const f=fixture(mode==="error"?"SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked":null,mode!=="false");
 await readHrIdentityPreview(f.pool,session());expect(f.release).toHaveBeenCalledWith(true);
});
it("rollback failure discards the session even if explicit unlock succeeds",async()=>{
 const f=fixture("ROLLBACK");readers.sources.mockRejectedValue(new Error("synthetic reader failure"));
 await expect(readHrIdentityPreview(f.pool,session())).rejects.toThrow("reader failure");expect(f.release).toHaveBeenCalledWith(true);
});
it("uncertain lock-acquisition failure discards without taking a snapshot",async()=>{
 const f=fixture("SELECT pg_advisory_lock_shared(hashtextextended($1,0))");
 await expect(readHrIdentityPreview(f.pool,session())).rejects.toThrow("query failure");expect(f.query).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledWith(true);
});
