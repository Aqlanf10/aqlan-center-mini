import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
const context = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: context.token }) }), headers: async () => new Headers() }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_visit_sign_authority_test");
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const { POST } = await import("../../app/api/visits/[id]/clinical/route");
let actorId: number, expiry: number, serial = 0;
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-sign-authority");
  [{ id: actorId }] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES ('synthetic-signer','Synthetic signer',$1,'admin') RETURNING id", [hash]);
  expiry = Date.now() + 3_600_000;
  context.token = auth.createSessionToken({ userId: actorId, username: "synthetic-signer", role: "admin", expiresAt: expiry, credentialVersion: auth.sessionCredentialVersion(hash) });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(unlinked = false) {
  const [{ id: patientId }] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic sign patient') RETURNING id", [`SIGN-AUTH-${++serial}`]);
  const [{ id: visitId }] = await q("INSERT INTO visits(patient_name,patient_id,diagnosis,treatment_done) VALUES('Synthetic sign patient',$1,'Synthetic diagnosis','Synthetic documented work') RETURNING id", [unlinked ? null : patientId]);
  const send = () => POST(new Request(`https://synthetic.invalid/api/visits/${visitId}/clinical`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sign" }) }), { params: Promise.resolve({ id: String(visitId) }) });
  return { patientId, visitId, send };
}
const snapshot = async () => Object.fromEntries(await Promise.all(["patients", "visits", "invoices", "payments", "ortho_adjustments", "audit_log", "treatment_plans", "plan_items", "visit_procedures", "tooth_conditions", "lab_orders", "inventory_movements", "treatment_sessions", "planned_visits"].map(async table => [table, await q(`SELECT * FROM ${table} ORDER BY 1`)])));
describe("HTTP signing authority after a real database wait", () => {
  it("keeps ordinary authorized signing working", async () => {
    const f = await fixture(); const response = await f.send();
    expect(response.status, JSON.stringify(await response.json())).toBe(200);
    expect((await q("SELECT signed_by FROM visits WHERE id=$1", [f.visitId]))[0].signed_by).toBe("synthetic-signer");
  });
  for (const change of ["expiry", "revocation", "permission"] as const) it(`refuses ${change} after admission during an observed row-lock wait`, async () => {
    const originalToken = context.token;
    if (change === "permission") {
      await q("UPDATE users SET role='doctor',permissions=$2 WHERE id=$1", [actorId, JSON.stringify({ canViewAllPatients: true })]);
      context.token = auth.createSessionToken({ ...auth.readSessionToken(originalToken)!, role: "doctor" });
    }
    const f = await fixture(); const before = await snapshot();
    const blocker = await db.getPool().connect();
    let pending: Promise<Response> | undefined;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await blocker.query("BEGIN");
      const { rows: [{ pid }] } = await blocker.query("SELECT pg_backend_pid() AS pid");
      const lockQuery = change === "expiry" ? "SELECT id FROM visits WHERE id = $1 AND signed_at IS NULL FOR UPDATE" : "SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE";
      await blocker.query(change === "expiry" ? "SELECT id FROM visits WHERE id=$1 FOR UPDATE" : "SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [change === "expiry" ? f.visitId : f.patientId]);
      pending = f.send(); void pending.catch(() => undefined);
      let waitingPid: number | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        await blocker.query("SELECT pg_stat_clear_snapshot()");
        const { rows } = await blocker.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND state='active' AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
          AND (query=$2 OR ($3='expiry' AND query LIKE '%FROM visits WHERE id = $1 AND signed_at IS NULL FOR UPDATE%'))`, [pid, lockQuery, change]);
        if (rows.length === 1) { waitingPid = rows[0].pid; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waitingPid).toBeTypeOf("number");
      console.info("Synthetic signing blocker", { change, blockerPid: pid, waitingPid });
      if (change === "expiry") clock = vi.spyOn(Date, "now").mockReturnValue(expiry + 1);
      else if (change === "permission") await q("UPDATE users SET permissions='{}' WHERE id=$1", [actorId]);
      else await q("UPDATE users SET is_active=FALSE WHERE id=$1", [actorId]);
      await blocker.query("COMMIT");
      const response = await pending;
      expect(response.status, JSON.stringify(await response.json())).toBe(change === "permission" ? 403 : 401);
      expect(await snapshot()).toEqual(before);
    } finally {
      await blocker.query("ROLLBACK"); await pending?.catch(() => undefined);
      clock?.mockRestore(); blocker.release();
      context.token = originalToken;
      await q("UPDATE users SET is_active=TRUE,role='admin',permissions='{}' WHERE id=$1", [actorId]);
    }
  }, 20_000);
  it("keeps an admitted unlinked walk-in eligible and writes one exact sign audit", async () => {
    const f = await fixture(true);
    const response = await f.send(); expect(response.status).toBe(200);
    const body = await response.json(); expect(body.patientId).toBeGreaterThan(0);
    expect(await q("SELECT actor,actor_role,details FROM audit_log WHERE action='visit.sign' AND entity_id=$1", [String(f.visitId)]))
      .toEqual([expect.objectContaining({ actor: "synthetic-signer", actor_role: "admin", details: expect.objectContaining({ المنهي: "synthetic-signer", دور_المنهي: "admin", الفاتورة: null }) })]);
  });
  it("rolls back the signature and all effects when the exact sign audit fails", async () => {
    const f = await fixture(); const before = await snapshot();
    await q(`CREATE FUNCTION synthetic_reject_sign_audit() RETURNS TRIGGER AS $$ BEGIN
      IF NEW.action='visit.sign' THEN RAISE EXCEPTION 'Synthetic sign audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER synthetic_reject_sign_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reject_sign_audit()`);
    try { expect((await f.send()).status).toBe(500); expect(await snapshot()).toEqual(before); }
    finally { await q("DROP TRIGGER synthetic_reject_sign_audit ON audit_log; DROP FUNCTION synthetic_reject_sign_audit()"); }
    expect((await f.send()).status).toBe(200);
  });
  it("rolls back when the session expires after the transactional sign audit", async () => {
    const f = await fixture(); const before = await snapshot();
    const realQuery = Client.prototype.query;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    let observed = false;
    // Execute every statement against PostgreSQL. Only advance time after the actual audit INSERT.
    const scheduler = vi.spyOn(Client.prototype, "query").mockImplementation(function(this: Client, ...args: unknown[]) {
      const result = Reflect.apply(realQuery, this, args);
      if (typeof args[0] === "string" && args[0].includes("INSERT INTO audit_log") && Array.isArray(args[1]) && args[1].includes("visit.sign")) {
        return Promise.resolve(result).then(value => { observed = true; clock = vi.spyOn(Date, "now").mockReturnValue(expiry + 1); return value; });
      }
      return result;
    } as typeof realQuery);
    try { expect((await f.send()).status).toBe(401); expect(observed).toBe(true); expect(await snapshot()).toEqual(before); }
    finally { scheduler.mockRestore(); clock?.mockRestore(); }
  });

  it("refuses a different admitted patient and an admitted-null scope changed to linked", async () => {
    const f = await fixture(), other = await fixture();
    const session = auth.readSessionToken(context.token)!;
    for (const patientId of [other.patientId, null]) {
      const before = await snapshot();
      await expect(db.signAuthorizedClinicalVisit({ visitId: f.visitId, baseCurrency: "YER" }, { patientId, session })).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
    }
  });
  it("requires server context even when invoked outside the route", async () => {
    const f = await fixture(); const before = await snapshot();
    expect(() => db.signAuthorizedClinicalVisit({ visitId: f.visitId, baseCurrency: "YER" }, undefined as never)).toThrow("هوية طلب التوقيع");
    expect(await snapshot()).toEqual(before);
  });
  it("retains same-day assistant finalization but refuses historic visits and doctor-only decisions", async () => {
    const original = context.token;
    const admin = auth.readSessionToken(original)!;
    await q("UPDATE users SET role='assistant' WHERE id=$1", [actorId]);
    const session = { ...admin, role: "assistant" as const };
    context.token = auth.createSessionToken(session);
    try {
      const today = await fixture(); expect((await today.send()).status).toBe(200);
      const old = await fixture(); await q("UPDATE visits SET arrived_at=NOW()-INTERVAL '3 days' WHERE id=$1", [old.visitId]);
      const before = await snapshot();
      await expect(db.signAuthorizedClinicalVisit({ visitId: old.visitId, baseCurrency: "YER" }, { patientId: old.patientId, session })).rejects.toMatchObject({ status: 403 });
      expect(await snapshot()).toEqual(before);
      const fresh = await fixture(); const freshBefore = await snapshot();
      await expect(db.signAuthorizedClinicalVisit({ visitId: fresh.visitId, baseCurrency: "YER", outsideContractDecision: { decision: "no_charge", reason: "Synthetic reason" } }, { patientId: fresh.patientId, session })).rejects.toMatchObject({ status: 403 });
      expect(await snapshot()).toEqual(freshBefore);
      expect((await q("SELECT signed_at FROM visits WHERE id=$1", [old.visitId]))[0].signed_at).toBeNull();
    } finally { context.token = original; await q("UPDATE users SET role='admin' WHERE id=$1", [actorId]); }
  });

  it("uses the current doctor party rather than a stale session fallback and fails busy ownership closed", async () => {
    const admin = auth.readSessionToken(context.token)!;
    const [{ id: currentParty }] = await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic current signing doctor') RETURNING id");
    const [{ id: staleParty }] = await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic stale signing doctor') RETURNING id");
    await q("UPDATE users SET role='doctor',party_id=$2,permissions='{}' WHERE id=$1", [actorId, currentParty]);
    const session = { ...admin, role: "doctor" as const, partyId: staleParty };
    const f = await fixture();
    const [{ id: appointmentId }] = await q("INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,status) VALUES($1,$2,CURRENT_DATE,'10:30','booked') RETURNING id", [f.patientId, currentParty]);
    const [{ id: serviceId }] = await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('Synthetic signing service','cleaning',0,TRUE,TRUE) RETURNING id");
    await q("INSERT INTO visit_procedures(visit_id,service_id,quantity,unit_price_minor) VALUES($1,$2,1,0)", [f.visitId, serviceId]);
    const before = await snapshot(); const block = await db.getPool().connect();
    try {
      await block.query("BEGIN"); await block.query("SELECT id FROM appointments WHERE id=$1 FOR UPDATE", [appointmentId]);
      await expect(db.signAuthorizedClinicalVisit({ visitId: f.visitId, baseCurrency: "YER" }, { patientId: f.patientId, session })).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
      await block.query("COMMIT");
      expect(await db.signAuthorizedClinicalVisit({ visitId: f.visitId, baseCurrency: "YER" }, { patientId: f.patientId, session })).toMatchObject({ reason: null });
      expect(await q("SELECT doctor_id FROM visit_procedures WHERE visit_id=$1", [f.visitId])).toEqual([{ doctor_id: currentParty }]);
      expect(await q("SELECT actor,actor_role FROM audit_log WHERE action='visit.sign' AND entity_id=$1", [String(f.visitId)])).toEqual([{ actor: session.username, actor_role: "doctor" }]);
    } finally { await block.query("ROLLBACK"); block.release(); await q("UPDATE users SET role='admin',party_id=NULL WHERE id=$1", [actorId]); }
  });

});
