import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { openLegacyStaffFixture } from "./_legacy-staff-fixture";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
const requestState=vi.hoisted(()=>({cookie:undefined as string|undefined}));
vi.mock("next/headers",()=>({cookies:async()=>({get:()=>requestState.cookie?{value:requestState.cookie}:undefined}),headers:async()=>({get:()=>null})}));
import { hashPassword, SESSION_COOKIE } from "../../lib/auth";
import { requireSession } from "../../lib/session";
import { POST as login } from "../../app/api/auth/login/route";
import { POST as password } from "../../app/api/auth/password/route";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");
let fixture:Awaited<ReturnType<typeof openLegacyStaffFixture>>,id:number,originalCookie:string;
const savedUrl=process.env.DATABASE_URL,username=`session_bnd_${randomBytes(6).toString("hex")}`,originalPassword="Synthetic-original-password-123",newPassword="Synthetic-new-password-456";
const request=(path:string,body:unknown)=>new Request(`https://clinic.example.test/api/auth/${path}`,{method:"POST",headers:{"Content-Type":"application/json",Host:"clinic.example.test"},body:JSON.stringify(body)});
beforeAll(async()=>{
 fixture=await openLegacyStaffFixture({...process.env});process.env.DATABASE_URL=fixture.url;await db.resetPoolForTesting();await db.ensureSchema();
 id=(await db.getPool().query<{id:number}>("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,$1,$2,'admin') RETURNING id",[username,await hashPassword(originalPassword)])).rows[0].id;
});
afterAll(async()=>{try{await db.resetPoolForTesting();await fixture?.close();}finally{process.env.DATABASE_URL=savedUrl;}});
it("ordinary unchanged-base login produces a genuinely usable legacy session",async()=>{
 const response=await login(request("login",{username,password:originalPassword}));expect(response.status).toBe(200);
 originalCookie=response.cookies.get(SESSION_COOKIE)!.value;requestState.cookie=originalCookie;
 expect((await requireSession())?.userId).toBe(id);
});
it("marker-free old token, login and password renewal all refuse raw canonical conversion",async()=>{
 const before=(await db.getPool().query("SELECT password_hash FROM users WHERE id=$1",[id])).rows[0].password_hash;
 await db.getPool().query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify({schemaVersion:2,confirmation:"owner",revision:1,patientScope:"none",appointmentScope:"none",grants:{}}),id]);
 try{
  expect(await requireSession()).toBeNull();
  const denied=await login(request("login",{username,password:originalPassword}));expect(denied.status).toBeGreaterThanOrEqual(400);expect(denied.cookies.get(SESSION_COOKIE)).toBeUndefined();
  expect((await password(request("password",{currentPassword:originalPassword,newPassword}))).status).toBe(401);
  expect((await db.getPool().query("SELECT password_hash FROM users WHERE id=$1",[id])).rows[0].password_hash).toBe(before);
 }finally{await db.getPool().query("UPDATE users SET permissions=NULL WHERE id=$1",[id]);}
});
it("ordinary legacy self-password renewal uses private proof and revokes its old cookie",async()=>{
 requestState.cookie=originalCookie;
 const response=await password(request("password",{currentPassword:originalPassword,newPassword}));expect(response.status).toBe(200);
 const renewed=response.cookies.get(SESSION_COOKIE)?.value;expect(renewed).toBeTruthy();
 expect(await requireSession()).toBeNull();requestState.cookie=renewed;expect((await requireSession())?.userId).toBe(id);
});
