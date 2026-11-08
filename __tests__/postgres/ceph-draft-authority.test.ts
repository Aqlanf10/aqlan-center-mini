import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: context.token }) }), headers: async () => new Headers() }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ceph_draft_authority_test");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { PATCH } = await import("../../app/api/ceph/[id]/route");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let actorId: number, expiry: number, serial = 0;
beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-ceph-draft");
  [{ id: actorId }] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-ceph-draft','Synthetic ceph author',$1,'admin') RETURNING id", [hash]);
  expiry = Date.now() + 3_600_000;
  context.token = auth.createSessionToken({ userId: actorId, username: "synthetic-ceph-draft", role: "admin", expiresAt: expiry, credentialVersion: auth.sessionCredentialVersion(hash) });
});
afterAll(async () => { await db.resetPoolForTesting(); });
const commands = {
  calibration: { calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 }, expectedCalibration: { calibration: null, mmPerPixel: null } },
  landmarks: { landmarks: [{ code: "S", x: 20, y: 30, source: "manual" }], expectedLandmarks: [] },
  diagnosis: { diagnosis: { finalDx: "Synthetic reviewed documentary text" }, expectedDiagnosis: null },
};
async function fixture() {
  const [{ id: patientId }] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic ceph patient') RETURNING id", [`CEPH-AUTH-${++serial}`]);
  const [{ id: documentId }] = await q(`INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
    VALUES($1,'imaging','Synthetic image','image/jpeg',123,$2,$3,'synthetic-ceph-draft') RETURNING id`, [patientId, "a".repeat(64), `synthetic/no-file-${serial}.jpg`]);
  const created = await db.createCephAnalysis({ patientId, documentId, createdBy: "synthetic-ceph-draft" });
  if (!created.ok) throw new Error(created.message);
  const send = (kind: keyof typeof commands) => PATCH(new Request(`https://synthetic.invalid/api/ceph/${created.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(commands[kind]) }), { params: Promise.resolve({ id: String(created.id) }) });
  return { patientId, documentId, id: created.id, send };
}
function write(kind: keyof typeof commands, f: Awaited<ReturnType<typeof fixture>>, session = auth.readSessionToken(context.token)!) {
  const request = { patientId: f.patientId, documentId: f.documentId, session };
  if (kind === "calibration") return db.updateAuthorizedCephCalibration(f.id, commands.calibration.calibration, commands.calibration.expectedCalibration, request);
  if (kind === "diagnosis") return db.updateAuthorizedCephDiagnosis(f.id, commands.diagnosis.diagnosis, null, request);
  return db.updateAuthorizedCephLandmarks(f.id, [{ code: "S", x: 20, y: 30, source: "manual" }], [], [], request);
}
const snapshot = async () => Object.fromEntries(await Promise.all(["ceph_analyses", "ceph_landmarks", "ceph_diagnoses", "ceph_measurements", "ceph_completion_provenance", "patient_documents", "audit_log"].map(async table => [table, await q(`SELECT * FROM ${table} ORDER BY 1`)])));
describe("cephalometric draft writes use current authority after real row waits", () => {
  it("requires explicit public landmark expectations and preserves newer reviewed points", async () => {
    const f=await fixture(), point={code:"S" as const,x:20,y:30,source:"manual" as const};
    const request={patientId:f.patientId,documentId:f.documentId,session:auth.readSessionToken(context.token)!};
    const send=(body:unknown)=>PATCH(new Request(`https://synthetic.invalid/api/ceph/${f.id}`,{
      method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),{params:Promise.resolve({id:String(f.id)})});
    expect((await send({landmarks:[point],expectedLandmarks:[]})).status).toBe(200);
    const before=await snapshot();
    for(const expected of [undefined,null,{},"invalid"]){
      expect((await send({landmarks:[{...point,x:40}],...(expected===undefined?{}:{expectedLandmarks:expected})})).status).toBe(400);
      expect(()=>db.updateAuthorizedCephLandmarks(f.id,[{...point,x:40}],[],expected as never,request)).toThrow();
      expect(await snapshot()).toEqual(before);
    }
    // Explicit [] asserts absence and cannot overwrite the existing S point.
    expect((await send({landmarks:[{...point,x:40}],expectedLandmarks:[]})).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect((await send({landmarks:[{...point,x:40}],expectedLandmarks:[point]})).status).toBe(200);
    expect((await q("SELECT x FROM ceph_landmarks WHERE analysis_id=$1 AND code='S'",[f.id]))[0].x).toBe(40);
    // Desired-state replay remains accepted; existing landmark attribution/audit
    // semantics are not changed by this boundary requirement.
    expect((await send({landmarks:[{...point,x:40}],expectedLandmarks:[point]})).status).toBe(200);
    expect((await send({landmarks:[{...point,x:60}],expectedLandmarks:[point]})).status).toBe(409);
    expect((await q("SELECT x FROM ceph_landmarks WHERE analysis_id=$1 AND code='S'",[f.id]))[0].x).toBe(40);
  });

  it.each(["calibration", "landmarks", "diagnosis"] as const)("preserves authorized %s write", async kind => {
    const f = await fixture(); const response = await f.send(kind); expect(response.status, JSON.stringify(await response.json())).toBe(200);
  });
  for (const kind of ["calibration", "landmarks", "diagnosis"] as const) for (const change of ["expiry", "revocation"] as const) {
    it(`refuses ${kind} after ${change} during its exact analysis lock wait`, async () => {
      const f = await fixture(), before = await snapshot(), blocker = await db.getPool().connect();
      let pending: Promise<Response> | undefined; let clock: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await blocker.query("BEGIN");
        const { rows: [{ pid }] } = await blocker.query("SELECT pg_backend_pid() AS pid");
        await blocker.query("SELECT id FROM ceph_analyses WHERE id=$1 FOR UPDATE", [f.id]);
        if (change === "revocation") await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actorId]);
        pending = f.send(kind); void pending.catch(() => undefined);
        let waitingPid: number | undefined;
        for (let attempt = 0; attempt < 200; attempt++) {
          await blocker.query("SELECT pg_stat_clear_snapshot()");
          const { rows } = await blocker.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
            AND state='active' AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
            AND (query LIKE '%FROM ceph_analyses WHERE id = $1 FOR UPDATE%' OR ($2='revocation' AND query LIKE 'SELECT * FROM users%'))`, [pid, change]);
          if (rows.length === 1) { waitingPid = rows[0].pid; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waitingPid).toBeTypeOf("number"); console.info("Synthetic ceph authority blocker", { kind, change, blockerPid: pid, waitingPid });
        if (change === "expiry") clock = vi.spyOn(Date, "now").mockReturnValue(expiry + 1);
        else await blocker.query("UPDATE users SET is_active=FALSE WHERE id=$1", [actorId]);
        await blocker.query("COMMIT");
        const response = await pending; expect(response.status, JSON.stringify(await response.json())).toBe(401);
        expect(await snapshot()).toEqual(before);
      } finally {
        await blocker.query("ROLLBACK"); await pending?.catch(() => undefined); clock?.mockRestore(); blocker.release();
        await q("UPDATE users SET is_active=TRUE WHERE id=$1", [actorId]);
      }
    }, 20_000);
  }
  for (const kind of ["calibration", "landmarks", "diagnosis"] as const) {
    it.each(["patient", "document", "image_owner"] as const)(`${kind} refuses changed %s scope without mutation`, async change => {
      const f = await fixture(), other = await fixture();
      if (change === "patient") {
        // Avoid the independent one-draft-per-patient constraint in this scope-only fixture.
        await q("UPDATE ceph_analyses SET status='discarded' WHERE id=$1", [other.id]);
        await q("UPDATE ceph_analyses SET patient_id=$2 WHERE id=$1", [f.id, other.patientId]);
      }
      if (change === "document") await q("UPDATE ceph_analyses SET document_id=$2 WHERE id=$1", [f.id, other.documentId]);
      if (change === "image_owner") await q("UPDATE patient_documents SET patient_id=$2 WHERE id=$1", [f.documentId, other.patientId]);
      const before = await snapshot();
      await expect(write(kind, f)).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
    });
    it(`${kind} rolls back on audit failure`, async () => {
      const f = await fixture(), before = await snapshot();
      await q(`CREATE FUNCTION synthetic_reject_ceph_audit() RETURNS TRIGGER AS $$ BEGIN
        IF NEW.action='ceph.update' THEN RAISE EXCEPTION 'Synthetic ceph audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER synthetic_reject_ceph_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reject_ceph_audit()`);
      try { expect((await f.send(kind)).status).toBe(500); expect(await snapshot()).toEqual(before); }
      finally { await q("DROP TRIGGER synthetic_reject_ceph_audit ON audit_log; DROP FUNCTION synthetic_reject_ceph_audit()"); }
    });
    it(`${kind} rolls back if time expires after its executed audit`, async () => {
      const f = await fixture(), before = await snapshot();
      const realQuery = Client.prototype.query;
      let clock: ReturnType<typeof vi.spyOn> | undefined; let observed = false;
      const scheduler = vi.spyOn(Client.prototype, "query").mockImplementation(function(this: Client, ...args: unknown[]) {
        const result = Reflect.apply(realQuery, this, args);
        if (typeof args[0] === "string" && args[0].includes("INSERT INTO audit_log") && Array.isArray(args[1]) && args[1].includes("ceph.update")) {
          return Promise.resolve(result).then(value => { observed = true; clock = vi.spyOn(Date, "now").mockReturnValue(expiry + 1); return value; });
        }
        return result;
      } as typeof realQuery);
      try { expect((await f.send(kind)).status).toBe(401); expect(observed).toBe(true); expect(await snapshot()).toEqual(before); }
      finally { scheduler.mockRestore(); clock?.mockRestore(); }
    });
  }
  it.each(["calibration", "diagnosis"] as const)("retains %s exact lost-response replay without another audit", async kind => {
    const f = await fixture(); expect((await f.send(kind)).status).toBe(200); const before = await snapshot();
    expect((await f.send(kind)).status).toBe(200); expect(await snapshot()).toEqual(before);
    await expect(write(kind, f, { ...auth.readSessionToken(context.token)!, expiresAt: Date.now() - 1 })).rejects.toMatchObject({ status: 401 });
    expect(await snapshot()).toEqual(before);
  });
  it("fails closed on a busy document ownership witness", async () => {
    const f = await fixture(), before = await snapshot(), blocker = await db.getPool().connect();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM patient_documents WHERE id=$1 FOR UPDATE", [f.documentId]);
      await expect(write("calibration", f)).rejects.toMatchObject({ status: 409 }); expect(await snapshot()).toEqual(before);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });
  it("requires current doctor imaging permission and preserves permitted doctor writes", async () => {
    const admin = auth.readSessionToken(context.token)!, f = await fixture();
    const session = { ...admin, role: "doctor" as const };
    await q("UPDATE users SET role='doctor',permissions=$2 WHERE id=$1", [actorId, JSON.stringify({ canViewAllPatients: true, canUploadXrays: true })]);
    try {
      expect(await write("calibration", f, session)).toMatchObject({ ok: true });
      await q("UPDATE users SET permissions=$2 WHERE id=$1", [actorId, JSON.stringify({ canViewAllPatients: true, canUploadXrays: false })]);
      const before = await snapshot();
      await expect(write("diagnosis", f, session)).rejects.toMatchObject({ status: 403 }); expect(await snapshot()).toEqual(before);
    } finally { await q("UPDATE users SET role='admin',permissions='{}' WHERE id=$1", [actorId]); }
  });

});
