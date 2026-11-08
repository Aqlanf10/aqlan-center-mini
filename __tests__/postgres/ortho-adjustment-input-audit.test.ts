// Real PostgreSQL server-route fixture, outside Next's server-module resolver.
// Only the framework marker is stubbed; transactional authority and storage stay real.
vi.mock("server-only", () => ({}));

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { createAdjustmentCommand, completeAdjustmentCommand, readAdjustmentCommand } from "../../lib/ortho-adjustment-command";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ortho_adjustment_input_test");
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
async function fixture(done = "Synthetic HTTP adjustment") {
  const { rows: [patient] } = await db.getPool().query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic replay patient') RETURNING id", [`ORTHO-HTTP-${++serial}`]);
  const created = await db.createOrthoCase({ patientId: patient.id, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: null, startDate: "2026-10-01", plannedMonths: 18, planId: null, note: null, createdBy: "synthetic-http-replay" });
  if (!created.ok) throw new Error(created.message);
  const scope = { patientId: patient.id, caseId: created.id, authority: `user:${actorId}` };
  const rows = new Map<string, string>();
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
  let command = createAdjustmentCommand(storage, scope, { doneOn: "2026-10-02", upperWire: "016 NiTi", lowerWire: "",
    elastics: "none", elasticNote: "", done: "Synthetic HTTP adjustment", nextWeeks: 4 });
  // Simulate a command frozen by the pre-fix client, without weakening the new
  // authoring guard. The legacy read/retry contract must not rewrite this body.
  command = {...command, body:JSON.stringify({...JSON.parse(command.body),done})};
  storage.setItem([...rows.keys()][0],JSON.stringify(command));
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
  return { scope, storage, command, send, footprint };
}
describe("legacy adjustment reconciliation compatibility",()=>{
 it("retains existing oversized frozen command recovery without a second mutation",async()=>{
  const authored="x".repeat(400)+"IMPORTANT END";
  const f=await fixture(authored);
  expect(JSON.parse(f.command.body).done).toBe(authored);
  // Model an already committed pre-admission journal via the unchanged trusted
  // writer, not a new lossy HTTP request under the repaired route.
  const seeded=await db.recordAdjustment({caseId:f.scope.caseId,visitId:null,doneOn:"2026-10-02",phase:null,
   upperWire:"016 NiTi",lowerWire:null,elastics:"none",elasticNote:null,done:"x".repeat(400),nextWeeks:4,note:null,
   recordedBy:"synthetic-http-replay",actorRole:"admin",
   request:{key:f.command.key,patientId:f.scope.patientId,session:auth.readSessionToken(context.token)!}});
  expect(seeded.ok).toBe(true);
  const originalFootprint=await f.footprint();
  const response=await f.send();
  expect(await f.footprint()).toEqual(originalFootprint);
  const rows=(await db.getPool().query("SELECT done FROM ortho_adjustments WHERE case_id=$1",[f.scope.caseId])).rows;
  if(response.ok) expect(completeAdjustmentCommand(f.storage,f.command,await response.json()).receipt).not.toBeNull();
  // Existing committed normalized receipt is recovered without a new write.
  expect({status:response.status,stored:rows[0]?.done??null}).toEqual({status:200,stored:"x".repeat(400)});
  const before=await f.footprint();
  expect((await f.send()).status).toBe(200);
  expect(await f.footprint()).toEqual(before);
  expect(readAdjustmentCommand(f.storage,f.scope)?.body).toBe(f.command.body);
 });
});
