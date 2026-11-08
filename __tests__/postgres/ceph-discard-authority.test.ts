import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: context.token }) }), headers: async () => new Headers() }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ceph_discard_authority_test");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { DELETE } = await import("../../app/api/ceph/[id]/route");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let actorId: number, expiry: number, serial = 0;
beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-ceph-discard");
  [{ id: actorId }] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-ceph-discard','Synthetic ceph author',$1,'admin') RETURNING id", [hash]);
  expiry = Date.now() + 3_600_000;
  context.token = auth.createSessionToken({ userId: actorId, username: "synthetic-ceph-discard", role: "admin", expiresAt: expiry, credentialVersion: auth.sessionCredentialVersion(hash) });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture() {
  const [{ id: patientId }] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic ceph patient') RETURNING id", [`CEPH-AUTH-${++serial}`]);
  const [{ id: documentId }] = await q(`INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
    VALUES($1,'imaging','Synthetic image','image/jpeg',123,$2,$3,'synthetic-ceph-discard') RETURNING id`, [patientId, "a".repeat(64), `synthetic/no-file-${serial}.jpg`]);
  const created = await db.createCephAnalysis({ patientId, documentId, createdBy: "synthetic-ceph-discard" });
  if (!created.ok) throw new Error(created.message);
  const send = () => DELETE(new Request(`https://synthetic.invalid/api/ceph/${created.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: "  Synthetic discard reason  " }) }), { params: Promise.resolve({ id: String(created.id) }) });
  return { patientId, documentId, id: created.id, send };
}
const authority = (f: Awaited<ReturnType<typeof fixture>>) => ({ patientId: f.patientId, documentId: f.documentId, session: auth.readSessionToken(context.token)! });
const snapshot = async () => Object.fromEntries(await Promise.all(["ceph_analyses", "ceph_landmarks", "ceph_diagnoses", "ceph_measurements", "ceph_completion_provenance", "patient_documents", "audit_log"].map(async table => [table, await q(`SELECT * FROM ${table} ORDER BY 1`)])));
describe("transactional cephalometric soft discard", () => {
  it("preserves an authorized draft soft discard", async () => {
    const f = await fixture(); expect((await f.send()).status).toBe(200);
    expect(await q("SELECT status,note FROM ceph_analyses WHERE id=$1", [f.id])).toEqual([{ status: "discarded", note: "Synthetic discard reason" }]);
    expect(await q("SELECT actor FROM audit_log WHERE action='ceph.discard' AND entity_id=$1", [String(f.id)])).toEqual([{ actor: "synthetic-ceph-discard" }]);
  });
  for (const change of ["expiry", "revocation"] as const) it(`refuses ${change} during an observed row wait`, async () => {
    const f = await fixture(), before = await snapshot(), blocker = await db.getPool().connect();
    let pending: Promise<Response> | undefined; let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await blocker.query("BEGIN");
      const { rows: [{ pid }] } = await blocker.query("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT id FROM ceph_analyses WHERE id=$1 FOR UPDATE", [f.id]);
      if (change === "revocation") await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actorId]);
      pending = f.send(); void pending.catch(() => undefined);
      let waitingPid: number | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        await blocker.query("SELECT pg_stat_clear_snapshot()");
        const { rows } = await blocker.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND state='active' AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
          AND (query LIKE '%FROM ceph_analyses WHERE id = $1 FOR UPDATE%' OR ($2='revocation' AND query LIKE 'SELECT * FROM users%'))`, [pid, change]);
        if (rows.length === 1) { waitingPid = rows[0].pid; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waitingPid).toBeTypeOf("number"); console.info("Synthetic discard blocker", { change, blockerPid: pid, waitingPid });
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
  it("does not discard when its audit insert fails", async () => {
    const f = await fixture(), before = await snapshot();
    await q(`CREATE FUNCTION synthetic_reject_discard_audit() RETURNS TRIGGER AS $$ BEGIN
      IF NEW.action='ceph.discard' THEN RAISE EXCEPTION 'Synthetic discard audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER synthetic_reject_discard_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reject_discard_audit()`);
    try { expect((await f.send()).status).toBe(500); expect(await snapshot()).toEqual(before); }
    finally { await q("DROP TRIGGER synthetic_reject_discard_audit ON audit_log; DROP FUNCTION synthetic_reject_discard_audit()"); }
  });
  it("does not release an aborted transaction after a database update failure", async () => {
    const f = await fixture(), before = await snapshot(), observer = await db.getPool().connect();
    await q(`CREATE FUNCTION synthetic_reject_discard_update() RETURNS TRIGGER AS $$ BEGIN
      IF NEW.status='discarded' THEN RAISE EXCEPTION 'Synthetic discard update failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER synthetic_reject_discard_update BEFORE UPDATE ON ceph_analyses FOR EACH ROW EXECUTE FUNCTION synthetic_reject_discard_update()`);
    const realQuery = Client.prototype.query;
    let failedQuery: ((sql: string) => Promise<import("pg").QueryResult>) | undefined; let failedPid: number | undefined;
    const scheduler = vi.spyOn(Client.prototype, "query").mockImplementation(function(this: Client, ...args: unknown[]) {
      if (typeof args[0] === "string" && args[0].includes("UPDATE ceph_analyses SET status='discarded'")) {
        failedQuery = (sql: string) => this.query(sql); failedPid = (this as unknown as { processID: number }).processID;
      }
      return Reflect.apply(realQuery, this, args);
    } as typeof realQuery);
    try {
      expect((await f.send()).status).toBe(500); expect(failedPid).toBeTypeOf("number");
      const { rows } = await observer.query("SELECT pid,state,xact_start FROM pg_stat_activity WHERE pid=$1", [failedPid]);
      console.info("Synthetic failed discard connection", rows);
      expect(rows).toEqual([{ pid: failedPid, state: "idle", xact_start: null }]);
      expect((await failedQuery!("SELECT pg_backend_pid() AS pid, 1 AS ready")).rows).toEqual([{ pid: failedPid, ready: 1 }]);
      expect(await snapshot()).toEqual(before);
    } finally {
      scheduler.mockRestore();
      // Exact synthetic failed backend cleanup also makes the vulnerable baseline safe to rerun.
      await failedQuery?.("ROLLBACK"); observer.release();
      await q("DROP TRIGGER synthetic_reject_discard_update ON ceph_analyses; DROP FUNCTION synthetic_reject_discard_update()");
    }
  });
  it.each(["reception", "doctor"] as const)("preserves permitted %s discard with current actor attribution", async role => {
    const original = context.token, admin = auth.readSessionToken(original)!;
    await q("UPDATE users SET role=$2,permissions=$3 WHERE id=$1", [actorId, role, JSON.stringify({ canViewAllPatients: true, canUploadXrays: true })]);
    context.token = auth.createSessionToken({ ...admin, role });
    try {
      const f = await fixture(); expect((await f.send()).status).toBe(200);
      expect(await q("SELECT actor,actor_role FROM audit_log WHERE action='ceph.discard' AND entity_id=$1", [String(f.id)])).toEqual([{ actor: admin.username, actor_role: role }]);
    } finally { context.token = original; await q("UPDATE users SET role='admin',permissions='{}' WHERE id=$1", [actorId]); }
  });
  it("denies assistant and a doctor without current imaging permission", async () => {
    const original = context.token, admin = auth.readSessionToken(original)!;
    try {
      for (const role of ["assistant", "doctor"] as const) {
        await q("UPDATE users SET role=$2,permissions=$3 WHERE id=$1", [actorId, role, JSON.stringify({ canViewAllPatients: true, canUploadXrays: false })]);
        context.token = auth.createSessionToken({ ...admin, role });
        const f = await fixture(), before = await snapshot();
        expect((await f.send()).status).toBe(403);
        await expect(db.discardAuthorizedCephAnalysis(f.id, null, authority(f))).rejects.toMatchObject({ status: 403 });
        expect(await snapshot()).toEqual(before);
      }
    } finally { context.token = original; await q("UPDATE users SET role='admin',permissions='{}' WHERE id=$1", [actorId]); }
  });
  it.each(["patient", "document", "image_owner"] as const)("refuses changed %s scope", async change => {
    const f = await fixture(), other = await fixture();
    if (change === "patient") {
      await q("UPDATE ceph_analyses SET status='discarded' WHERE id=$1", [other.id]);
      await q("UPDATE ceph_analyses SET patient_id=$2 WHERE id=$1", [f.id, other.patientId]);
    }
    if (change === "document") await q("UPDATE ceph_analyses SET document_id=$2 WHERE id=$1", [f.id, other.documentId]);
    if (change === "image_owner") await q("UPDATE patient_documents SET patient_id=$2 WHERE id=$1", [f.documentId, other.patientId]);
    const before = await snapshot();
    await expect(db.discardAuthorizedCephAnalysis(f.id, null, authority(f))).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
  });
  it("retains draft clinical rows and image when soft-hidden, and refuses completed history", async () => {
    for (const completed of [false, true]) {
      const f = await fixture();
      await q("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'S',20,30,'manual','synthetic')", [f.id]);
      await q("INSERT INTO ceph_diagnoses(analysis_id,final_dx,created_by) VALUES($1,'Synthetic documentary text','synthetic')", [f.id]);
      await q("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'SNA',82)", [f.id]);
      if (completed) await q("UPDATE ceph_analyses SET status='completed',completed_by='synthetic-historical',completed_at=NOW() WHERE id=$1", [f.id]);
      const before = await snapshot();
      expect((await f.send()).status).toBe(completed ? 409 : 200);
      const after = await snapshot();
      if (completed) expect(after).toEqual(before);
      else {
        for (const table of ["ceph_landmarks", "ceph_diagnoses", "ceph_measurements", "ceph_completion_provenance", "patient_documents"]) expect(after[table]).toEqual(before[table]);
        const retained = await snapshot();
        expect(await db.discardAuthorizedCephAnalysis(f.id, "different note", authority(f))).toMatchObject({ ok: false });
        expect(await snapshot()).toEqual(retained);
      }
    }
  });
  it("rolls back discard and audit when expiry occurs after the actual audit insert", async () => {
    const f = await fixture(), before = await snapshot();
    const realQuery = Client.prototype.query;
    let clock: ReturnType<typeof vi.spyOn> | undefined, observed = false;
    const scheduler = vi.spyOn(Client.prototype, "query").mockImplementation(function(this: Client, ...args: unknown[]) {
      const result = Reflect.apply(realQuery, this, args);
      if (typeof args[0] === "string" && args[0].includes("INSERT INTO audit_log") && Array.isArray(args[1]) && args[1].includes("ceph.discard")) {
        return Promise.resolve(result).then(value => { observed = true; clock = vi.spyOn(Date, "now").mockReturnValue(expiry + 1); return value; });
      }
      return result;
    } as typeof realQuery);
    try { expect((await f.send()).status).toBe(401); expect(observed).toBe(true); expect(await snapshot()).toEqual(before); }
    finally { scheduler.mockRestore(); clock?.mockRestore(); }
  });
  it("requires server context and fails a busy image witness closed", async () => {
    const f = await fixture(), before = await snapshot(), blocker = await db.getPool().connect();
    expect(() => db.discardAuthorizedCephAnalysis(f.id, null, undefined as never)).toThrow();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM patient_documents WHERE id=$1 FOR UPDATE", [f.documentId]);
      await expect(db.discardAuthorizedCephAnalysis(f.id, null, authority(f))).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

});
