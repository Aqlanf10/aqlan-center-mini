import { STAFF_AUTHORIZATION_POLICY_VERSION } from "../lib/staff-capability-catalogue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { createSessionToken, readSessionToken, readSignedSessionEnvelope, sessionCredentialVersion } from "../lib/auth";
import { readVerifiedDurableSession, revalidateVerifiedDurableSession } from "../lib/staff-durable-session";
const secret="synthetic-phase2-test-secret-at-least-32-characters";
function signed(payload:unknown){const body=Buffer.from(JSON.stringify(payload)).toString("base64url");return `${body}.${createHmac("sha256",secret).update(body).digest("base64url")}`;}
const legacy=()=>({userId:1,username:"synthetic",role:"admin",expiresAt:Date.now()+60_000});
function claims(){return {userId:1,username:"synthetic",expiresAt:Date.now()+60_000,durableIdentity:{schemaVersion:2,policyVersion:STAFF_AUTHORIZATION_POLICY_VERSION,realmId:randomUUID(),subjectId:randomUUID(),generationId:randomUUID(),registryRevision:"2",controlEpoch:"3",accountEpoch:"2",permissionRevision:1,credentialVersion:sessionCredentialVersion("synthetic-password-hash"),provider:null}};}
beforeEach(()=>vi.stubEnv("SESSION_SECRET",secret));
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
it("preserves marker-free legacy and refuses exact suffix/tampering",()=>{
 const token=createSessionToken(legacy());expect(readSessionToken(token)?.userId).toBe(1);
 expect(readSignedSessionEnvelope(token+".ignored")).toBeNull();expect(readSessionToken(token+".ignored")).toBeNull();
 expect(readSessionToken(token+"x")).toBeNull();
});
it.each(["authority","staffAuthority","durableIdentity"])("rejects obsolete/canonical %s own fields even undefined on legacy issuance",key=>{
 expect(()=>createSessionToken({...legacy(),[key]:undefined})).toThrow("CANONICAL_SESSION_ISSUANCE_UNSUPPORTED");
 expect(readSessionToken(signed({...legacy(),[key]:{}}))).toBeNull();
});
it("verifies opaque signed durable handles without authorizing legacy entry",()=>{
 const token=signed(claims());const handle=readVerifiedDurableSession(token);expect(handle).not.toBeNull();
 expect(readSessionToken(token)).toBeNull();
 expect(revalidateVerifiedDurableSession(handle!)?.userId).toBe(1);
 expect(revalidateVerifiedDurableSession({...handle!})).toBeNull();
 expect(readVerifiedDurableSession(token+".extra")).toBeNull();
});
it("rejects wrong versions, malformed revisions, mixed claims and expired signatures",()=>{
 const good=claims();
 for(const d of [{...good.durableIdentity,policyVersion:1},{...good.durableIdentity,policyVersion:2},{...good.durableIdentity,policyVersion:3},{...good.durableIdentity,policyVersion:4},{...good.durableIdentity,schemaVersion:1},{...good.durableIdentity,accountEpoch:"0"},{...good.durableIdentity,provider:{partyId:1,clinicalEpoch:"0"}}])expect(readVerifiedDurableSession(signed({...good,durableIdentity:d}))).toBeNull();
 expect(readVerifiedDurableSession(signed({...good,authority:{}}))).toBeNull();
 expect(readVerifiedDurableSession(signed({...good,expiresAt:Date.now()}))).toBeNull();
 expect(readVerifiedDurableSession(createSessionToken(legacy()))).toBeNull();
});
it("rechecks original signature expiration on every private-handle inspection",()=>{
 vi.useFakeTimers();vi.setSystemTime(1_800_000_000_000);
 const handle=readVerifiedDurableSession(signed(claims()));expect(handle).not.toBeNull();
 vi.advanceTimersByTime(60_000);expect(revalidateVerifiedDurableSession(handle!)).toBeNull();
});
