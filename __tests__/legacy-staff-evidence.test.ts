import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
const request=vi.hoisted(()=>({cookie:undefined as string|undefined,bearer:undefined as string|undefined}));
vi.mock("next/headers",()=>({cookies:async()=>({get:()=>request.cookie?{value:request.cookie}:undefined}),headers:async()=>({get:()=>request.bearer?`Bearer ${request.bearer}`:null})}));
vi.mock("../lib/db",()=>({findUserByUsername:vi.fn()}));
import { createSessionToken, readSessionToken, legacySessionEvidence, revalidateLegacySessionEvidence, carryLegacySessionEvidence } from "../lib/auth";
import { readSessionPayload } from "../lib/session";
import { assertLegacyPermissionEnvelope } from "../lib/legacy-staff-boundary";
const secret="synthetic-legacy-boundary-secret-at-least-32-characters";
const payload=()=>({userId:1,username:"synthetic",role:"admin",expiresAt:Date.now()+60_000,credentialVersion:"synthetic"});
beforeEach(()=>{vi.stubEnv("SESSION_SECRET",secret);request.cookie=undefined;request.bearer=undefined;});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
it("only genuine parser identity can produce original signed evidence",()=>{
 const parsed=readSessionToken(createSessionToken(payload()))!;
 const evidence=legacySessionEvidence(parsed);expect(evidence).not.toBeNull();
 expect(revalidateLegacySessionEvidence(evidence!)?.userId).toBe(1);
 expect(legacySessionEvidence({...parsed})).toBeNull();
 expect(legacySessionEvidence(payload())).toBeNull();
 expect(revalidateLegacySessionEvidence({...evidence!})).toBeNull();
 const derived=carryLegacySessionEvidence(parsed,{...parsed,role:"doctor"});
 expect(revalidateLegacySessionEvidence(legacySessionEvidence(derived)!)?.role).toBe("admin");
 const fake=carryLegacySessionEvidence(payload(),payload());expect(legacySessionEvidence(fake)).toBeNull();
});
it.each(["authority","staffAuthority","durableIdentity"])("signed %s cookie cannot fall back to legacy Bearer",async marker=>{
 const body=Buffer.from(JSON.stringify({...payload(),[marker]:{}})).toString("base64url");
 request.cookie=`${body}.${createHmac("sha256",secret).update(body).digest("base64url")}`;
 request.bearer=createSessionToken(payload());expect(await readSessionPayload()).toBeNull();
});
it("unsigned invalid cookie retains ordinary valid Bearer fallback",async()=>{
 request.cookie="invalid.cookie";request.bearer=createSessionToken(payload());expect((await readSessionPayload())?.userId).toBe(1);
});
it("evidence rechecks expiry and never authorizes from a changed public payload",()=>{
 const parsed=readSessionToken(createSessionToken(payload()))!;const evidence=legacySessionEvidence(parsed)!;
 parsed.role="doctor";expect(revalidateLegacySessionEvidence(evidence)?.role).toBe("admin");
 vi.spyOn(Date,"now").mockReturnValue(parsed.expiresAt+1);expect(revalidateLegacySessionEvidence(evidence)).toBeNull();
});
it("legacy envelope guard rejects canonical and malformed payloads before permissive mapping",()=>{
 expect(()=>assertLegacyPermissionEnvelope(null)).not.toThrow();
 expect(()=>assertLegacyPermissionEnvelope({financeAccess:{collectPayments:true}})).not.toThrow();
 for(const raw of ["not json",{schemaVersion:2,confirmation:"owner",revision:1,patientScope:"none",appointmentScope:"none",grants:{}},{schemaVersion:1}])expect(()=>assertLegacyPermissionEnvelope(raw)).toThrow("PERMISSION_ENVELOPE_HELD");
});
