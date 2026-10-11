import {beforeEach,afterEach,expect,it,vi} from "vitest";
import type {DbClient} from "../lib/db";
import type {SessionPayload} from "../lib/auth";
const mocks=vi.hoisted(()=>({find:vi.fn(),cookies:vi.fn(),headers:vi.fn()}));
vi.mock("../lib/db",()=>({findUserByUsername:mocks.find}));
vi.mock("next/headers",()=>({cookies:mocks.cookies,headers:mocks.headers}));
import {sessionCredentialVersion} from "../lib/auth";
import {revalidateSessionInTransaction} from "../lib/session";
const client={query:vi.fn()} as unknown as DbClient;
const passwordHash="synthetic-session-transaction-hash";
const user=()=>({id:701,username:"synthetic-admin",role:"admin",isActive:true,passwordHash,partyId:null,permissions:null});
const payload=():SessionPayload=>({userId:701,username:"synthetic-admin",role:"admin",expiresAt:Date.now()+60000,credentialVersion:sessionCredentialVersion(passwordHash)});
beforeEach(()=>{vi.stubEnv("SESSION_SECRET","synthetic-session-wrapper-unit-secret");mocks.find.mockReset();mocks.find.mockResolvedValue(user());mocks.cookies.mockReset();mocks.headers.mockReset();});
afterEach(()=>vi.unstubAllEnvs());
it("uses the canonical current-account check with the exact transaction client and no request-cookie dependency",async()=>{
 const admitted=payload();expect(await revalidateSessionInTransaction(admitted,client)).toMatchObject(admitted);
 expect(mocks.find).toHaveBeenCalledWith(admitted.username,client);expect(mocks.cookies).not.toHaveBeenCalled();expect(mocks.headers).not.toHaveBeenCalled();
});
it.each(["missing","disabled","identity","credential","role"])("refuses a changed %s witness",async(kind)=>{
 const current=user();if(kind==="disabled")current.isActive=false;if(kind==="identity")current.id=702;if(kind==="credential")current.passwordHash="changed";if(kind==="role")current.role="doctor";
 mocks.find.mockResolvedValue(kind==="missing"?null:current);
 expect(await revalidateSessionInTransaction(payload(),client)).toBeNull();
});
it("checks expiry after the current-account lookup wait",async()=>{
 const admitted=payload();mocks.find.mockImplementation(async()=>{admitted.expiresAt=Date.now()-1;return user();});
 expect(await revalidateSessionInTransaction(admitted,client)).toBeNull();
});
it("does not hide a failed transactional lookup or substitute another connection",async()=>{
 mocks.find.mockRejectedValue(new Error("Synthetic transaction refusal"));
 await expect(revalidateSessionInTransaction(payload(),client)).rejects.toThrow("Synthetic transaction refusal");expect(mocks.find).toHaveBeenCalledTimes(1);
});
