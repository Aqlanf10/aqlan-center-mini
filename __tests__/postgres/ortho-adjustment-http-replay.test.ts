import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { createAdjustmentCommand, completeAdjustmentCommand, readAdjustmentCommand } from "../../lib/ortho-adjustment-command";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: context.token } : undefined }),
  headers: async () => new Headers(),
}));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ortho_adjustment_http_test");
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
  return { scope, storage, command, send, footprint };
}
describe("actual HTTP route with durable client command and real PostgreSQL", () => {
  it("reconciles a discarded first response through frozen client key/body without a duplicate financial or clinical write", async () => {
    const f = await fixture();
    const first = await f.send(); expect(first.status).toBe(201);
    // Deliberately discard the response, leaving the persisted client command unresolved.
    expect(readAdjustmentCommand(f.storage, f.scope)?.receipt).toBeNull();
    const before = await f.footprint();
    const replay = await f.send(); expect(replay.status).toBe(200);
    const completed = completeAdjustmentCommand(f.storage, f.command, await replay.json());
    expect(completed.receipt).toMatchObject({ patientId: f.scope.patientId, caseId: f.scope.caseId,
      requestKey: f.command.key, visitId: null, attachedToToday: false });
    expect(await f.footprint()).toEqual(before);
    expect(before[0]).toMatchObject({ adjustments: 1, commands: 1, invoices: 0, payments: 0, visits: 0 });
  });
  it("denies revoked session replay and reconciles the same command only after current authorization returns", async () => {
    const f = await fixture(); expect((await f.send()).status).toBe(201);
    const before = await f.footprint();
    await db.getPool().query("UPDATE users SET is_active=FALSE WHERE id=$1", [actorId]);
    try {
      expect((await f.send()).status).toBe(401);
      expect(readAdjustmentCommand(f.storage, f.scope)?.receipt).toBeNull();
      expect(await f.footprint()).toEqual(before);
    } finally { await db.getPool().query("UPDATE users SET is_active=TRUE WHERE id=$1", [actorId]); }
    const replay = await f.send(); expect(replay.status).toBe(200);
    expect(completeAdjustmentCommand(f.storage, f.command, await replay.json()).receipt).not.toBeNull();
    expect(await f.footprint()).toEqual(before);
  });
});
