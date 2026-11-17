import { createHmac } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const t = vi.hoisted(() => ({ cookie: undefined as string | undefined, authorization: null as string | null, find: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => t.cookie === undefined ? undefined : { value: t.cookie } }), headers: async () => ({ get: () => t.authorization }) }));
vi.mock("../lib/db", () => ({ findUserByUsername: t.find }));
import { SESSION_COOKIE, createSessionToken, sessionCredentialVersion } from "../lib/auth";
import { readSessionPayload, readSessionPayloadFromTransport, requireSession, requireSessionFromTransport } from "../lib/session";
const secret = "synthetic-document-pages-session-secret-0123456789";
const token = (userId = 7) => createSessionToken({ userId, username: `synthetic-user-${userId}`, role: "admin", expiresAt: Date.now() + 60_000, credentialVersion: sessionCredentialVersion("synthetic-password") });
const signed = (claims: unknown) => { const body = Buffer.from(JSON.stringify(claims)).toString("base64url"); return `${body}.${createHmac("sha256",secret).update(body).digest("base64url")}`; };
beforeEach(() => { vi.stubEnv("SESSION_SECRET",secret); t.cookie=undefined; t.authorization=null; t.find.mockReset().mockImplementation(async (name:string) => ({ id: Number(name.slice(-1)), username:name, isActive:true, role:"admin", passwordHash:"synthetic-password", partyId:null })); });
afterEach(() => { vi.unstubAllEnvs(); });
it.each(["cookie", "bearer", "invalid-cookie-fallback", "valid-cookie-priority", "signed-malformed-legacy-fallback", "canonical-invalid-no-fallback"])("matches legacy authentication transport selection for %s", async mode => {
  if (mode === "cookie") t.cookie=token();
  if (mode === "bearer") t.authorization=`Bearer ${token()}`;
  if (mode === "invalid-cookie-fallback") { t.cookie="invalid"; t.authorization=`Bearer ${token()}`; }
  if (mode === "valid-cookie-priority") { t.cookie=token(7); t.authorization=`Bearer ${token(8)}`; }
  if (mode === "signed-malformed-legacy-fallback") { t.cookie=signed({ userId:7, username:"synthetic-user-7", role:"admin" }); t.authorization=`Bearer ${token(8)}`; }
  if (mode === "canonical-invalid-no-fallback") { t.cookie=signed({ durableIdentity:{ invalid:true } }); t.authorization=`Bearer ${token(8)}`; }
  expect(await readSessionPayloadFromTransport(t.cookie,async()=>t.authorization)).toEqual(await readSessionPayload());
  expect(await requireSessionFromTransport(t.cookie,t.authorization)).toEqual(await requireSession());
});
it("does not fall back to Bearer when the selected cookie was revoked", async () => {
  t.cookie=token(7);t.authorization=`Bearer ${token(8)}`;
  t.find.mockImplementation(async (name:string)=> name.endsWith("7") ? null : ({id:8,username:name,isActive:true,role:"admin",passwordHash:"synthetic-password"}));
  expect(await requireSessionFromTransport(t.cookie,t.authorization)).toBeNull();
  expect(await requireSession()).toBeNull();
});
it("uses App Router cookie semantics for duplicate cookie names", () => {
  const first=token(7), last=token(8);
  const req=new NextRequest("http://localhost/api/documents/1",{headers:{cookie:`${SESSION_COOKIE}=${first}; ${SESSION_COOKIE}=${last}`}});
  expect(req.cookies.get(SESSION_COOKIE)?.value).toBe(last);
});
