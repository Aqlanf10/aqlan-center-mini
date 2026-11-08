// Real PostgreSQL server-route fixture, outside Next's server-module resolver.
// Only the framework marker is stubbed; transactional authority and storage stay real.
vi.mock("server-only", () => ({}));

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { adjustmentCommandStorageKey, createAdjustmentCommand, completeAdjustmentCommand, readAdjustmentCommand } from "../../lib/ortho-adjustment-command";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_adjustment_api_input_test");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { POST } = await import("../../app/api/ortho/[id]/route");
let actorId: number, serial = 0;
beforeAll(async () => {
  await db.ensureSchema();
  const passwordHash = await auth.hashPassword("synthetic-http-replay");
  const { rows: [user] } = await db.getPool().query(`INSERT INTO users(username,display_name,password_hash,role)
    VALUES ('synthetic-http-replay','Synthetic HTTP replay',$1,'admin') RETURNING id`, [passwordHash]);
  actorId = user.id;
  context.token = auth.createSessionToken({ userId: actorId, username: "synthetic-http-replay", role: "admin",
    expiresAt: Date.now() + 3_600_000, credentialVersion: auth.sessionCredentialVersion(passwordHash) });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture() {
  const { rows: [patient] } = await db.getPool().query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic replay patient') RETURNING id", [`ORTHO-HTTP-${++serial}`]);
  const created = await db.createOrthoCase({ patientId: patient.id, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: null, startDate: "2026-10-01", plannedMonths: 18, planId: null, note: null, createdBy: "synthetic-http-replay" });
  if (!created.ok) throw new Error(created.message);
  const scope = { patientId: patient.id, caseId: created.id, authority: `user:${actorId}` };
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  const command = createAdjustmentCommand(storage, scope, { doneOn: "2026-10-02", upperWire: "016 NiTi", lowerWire: "",
    elastics: "none", elasticNote: "", done: "Synthetic HTTP adjustment", nextWeeks: 4 });
  const send = () => POST(new Request(`https://synthetic.invalid/api/ortho/${scope.caseId}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": command.key }, body: command.body,
  }), { params: Promise.resolve({ id: String(scope.caseId) }) });
  const footprint = async () => (await db.getPool().query(`SELECT
    (SELECT count(*) FROM ortho_adjustments WHERE case_id=$1)::int AS adjustments,
    (SELECT count(*) FROM ortho_adjustment_requests WHERE case_id=$1)::int AS commands,
    (SELECT count(*) FROM audit_log WHERE action='ortho.adjustment')::int AS audits,
    (SELECT count(*) FROM invoices)::int AS invoices,
    (SELECT count(*) FROM payments)::int AS payments,
    (SELECT count(*) FROM visits)::int AS visits`, [scope.caseId])).rows;
  const sendRaw=(body:unknown,key=command.key)=>POST(new Request(`https://synthetic.invalid/api/ortho/${scope.caseId}`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key},body:JSON.stringify(body)}),{params:Promise.resolve({id:String(scope.caseId)})});
  return { scope, storage, command, send, footprint, sendRaw };
}

const limits = [["upperWire",40],["lowerWire",40],["elasticNote",120],["done",400],["note",300]] as const;
describe("new API adjustment admission with legacy journal reconciliation",()=>{
 it.each(limits)("refuses new oversized %s without any footprint",async(field,limit)=>{
  const f=await fixture(), before=await f.footprint();
  const response=await f.sendRaw({...JSON.parse(f.command.body),[field]:"x".repeat(limit+1)});
  expect(response.status).toBe(400); expect(await f.footprint()).toEqual(before);
 });
 it.each(limits)("refuses new nontext %s without any footprint",async(field)=>{
  const f=await fixture(), before=await f.footprint();
  for(const value of [12,false,{},[]]) {
   const response=await f.sendRaw({...JSON.parse(f.command.body),[field]:value});
   expect(response.status).toBe(400); expect(await f.footprint()).toEqual(before);
  }
 });
});

async function seedLegacy(f: Awaited<ReturnType<typeof fixture>>, body: Record<string,unknown>) {
 const text=(value:unknown,limit:number)=>typeof value==="string" && value.trim()?value.trim().slice(0,limit):null;
 return db.recordAdjustment({caseId:f.scope.caseId,visitId:typeof body.visitId==="number"?body.visitId:null,doneOn:String(body.doneOn),phase:null,
  upperWire:text(body.upperWire,40),lowerWire:text(body.lowerWire,40),elastics:"none",elasticNote:text(body.elasticNote,120),
  done:text(body.done,400),nextWeeks:4,note:text(body.note,300),recordedBy:"synthetic-http-replay",actorRole:"admin",
  request:{key:f.command.key,patientId:f.scope.patientId,session:auth.readSessionToken(context.token)!}});
}
it("reconciles the old normalized fingerprint without rewriting body, journal or clinical/financial rows",async()=>{
 const f=await fixture(), body={...JSON.parse(f.command.body),done:"x".repeat(400)+"old suffix"};
 const original={...f.command,body:JSON.stringify(body)};
 f.storage.setItem(adjustmentCommandStorageKey(f.scope),JSON.stringify(original));
 const seeded=await seedLegacy(f,body); expect(seeded.ok).toBe(true);
 const before=await f.footprint();
 const response=await f.sendRaw(body); expect(response.status).toBe(200);
 const receipt=await response.json(); expect(receipt).toMatchObject({existing:true,replayed:true});
 const completed=completeAdjustmentCommand(f.storage,original,receipt);
 expect(completed.body).toBe(original.body); expect(completed.key).toBe(original.key);
 expect(readAdjustmentCommand(f.storage,f.scope)).toEqual(completed);
 expect(await f.footprint()).toEqual(before);
 // Legacy normalized hashes never recorded the discarded raw suffix. This may
 // return the existing receipt, but cannot insert or alter any clinical record.
 expect((await f.sendRaw({...body,done:"x".repeat(400)+"different suffix"})).status).toBe(200);
 expect(await f.footprint()).toEqual(before);
 expect((await f.sendRaw({...body,done:"different prefix"})).status).toBe(409);
 expect(await f.footprint()).toEqual(before);
 await db.getPool().query("UPDATE users SET is_active=FALSE WHERE id=$1",[actorId]);
 try {expect((await f.sendRaw(body)).status).toBe(401);expect(await f.footprint()).toEqual(before);}
 finally {await db.getPool().query("UPDATE users SET is_active=TRUE WHERE id=$1",[actorId]);}
});
it("accepts trimmed boundaries, null and omitted text without changing existing normalization",async()=>{
 const f=await fixture(), body={...JSON.parse(f.command.body),upperWire:"  "+"a".repeat(40)+"  ",lowerWire:null,
  elasticNote:"b".repeat(120),done:"c".repeat(400),note:"d".repeat(300)};
 expect((await f.sendRaw(body)).status).toBe(201);
 const {rows:[row]}=await db.getPool().query("SELECT upper_wire,lower_wire,elastic_note,done,note FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId]);
 expect(row).toEqual({upper_wire:"a".repeat(40),lower_wire:null,elastic_note:"b".repeat(120),done:"c".repeat(400),note:"d".repeat(300)});
 const before=await f.footprint(); expect((await f.sendRaw(body)).status).toBe(200);expect(await f.footprint()).toEqual(before);
});
it("serializes invalid and valid same-key requests without reserving the rejected key",async()=>{
 const f=await fixture(), body={...JSON.parse(f.command.body),done:"x".repeat(400)}, blocker=new Client({connectionString:process.env.DATABASE_URL});
 await blocker.connect();
 try {
  await blocker.query("BEGIN");const {rows:[{pid}]}=await blocker.query("SELECT pg_backend_pid() AS pid");
  await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`aqlan-ortho-adjustment:${actorId}:${f.command.key}`]);
  const bad=f.sendRaw({...body,done:"x".repeat(401)}), good=f.sendRaw(body);
  let waiting=0;
  for(let i=0;i<100;i++){
   await blocker.query("SELECT pg_stat_clear_snapshot()");
   const {rows:[r]}=await blocker.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'",[pid]);
   waiting=r.n;if(waiting>=2)break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(waiting).toBeGreaterThanOrEqual(2);
  await blocker.query("COMMIT");
  const badResponse=await bad,goodResponse=await good;
  expect([400,200]).toContain(badResponse.status);expect(goodResponse.status).toBe(201);
  if(badResponse.status===200) expect((await badResponse.json()).id).toBe((await goodResponse.json()).id);
  expect((await f.footprint())[0]).toMatchObject({adjustments:1,commands:1,invoices:0,payments:0,visits:0});
  const before=await f.footprint();expect((await f.sendRaw(body)).status).toBe(200);expect(await f.footprint()).toEqual(before);
 }finally {await blocker.query("ROLLBACK").catch(()=>{});await blocker.end();}
});

it("replays the legacy receipt after its visit is signed but cannot create a new invalid session",async()=>{
 const f=await fixture();
 const {rows:[visit]}=await db.getPool().query("INSERT INTO visits(patient_name,patient_id) VALUES('Synthetic signed replay visit',$1) RETURNING id",[f.scope.patientId]);
 const body={...JSON.parse(f.command.body),visitId:visit.id,done:"x".repeat(401)};
 expect((await seedLegacy(f,body)).ok).toBe(true);
 // Fixture signature state, not an assertion about the signer workflow itself.
 await db.getPool().query("UPDATE visits SET signed_at=NOW(),signed_by='synthetic-http-replay' WHERE id=$1",[visit.id]);
 const before=await f.footprint(), stored=(await db.getPool().query("SELECT * FROM visits WHERE id=$1",[visit.id])).rows;
 expect((await f.sendRaw(body)).status).toBe(200);
 expect((await f.sendRaw(body,f.command.key+"-new")).status).toBe(400);
 expect(await f.footprint()).toEqual(before);
 expect((await db.getPool().query("SELECT * FROM visits WHERE id=$1",[visit.id])).rows).toEqual(stored);
});
