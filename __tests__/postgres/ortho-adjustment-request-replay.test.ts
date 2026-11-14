import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";

assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_ortho_adjustment_replay_test");
const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const { clinicDateString } = await import("../../lib/schedule");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query(sql, values)).rows as T[];
let session: SessionPayload;
let serial = 0;
beforeAll(async () => {
  await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-ortho-replay-user");
  const [{ id }] = await q<{ id: number }>(`INSERT INTO users(username, display_name, role, password_hash, is_active)
    VALUES ('synthetic-ortho-replay', 'Synthetic replay', 'admin', $1, TRUE) RETURNING id`, [hash]);
  session = { userId: id, username: "synthetic-ortho-replay", role: "admin",
    credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture() {
  serial++;
  const [{ id: patientId }] = await q<{ id: number }>(`INSERT INTO patients(patient_number, full_name)
    VALUES ($1, 'Synthetic replay patient') RETURNING id`, [`ORTHO-REPLAY-${serial}`]);
  const opened = await db.createOrthoCase({ patientId, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: null, startDate: "2026-10-01", plannedMonths: 18, planId: null, note: null, createdBy: session.username });
  if (!opened.ok) throw new Error(opened.message);
  return { patientId, caseId: opened.id };
}
function command(scope: { patientId: number; caseId: number }, key: string) {
  return { caseId: scope.caseId, visitId: null, doneOn: "2026-10-02", phase: "working" as const,
    upperWire: "016 NiTi", lowerWire: null, elastics: "none" as const, elasticNote: null,
    done: "Synthetic standalone adjustment", nextWeeks: 4, note: null,
    recordedBy: session.username, actorRole: session.role,
    request: { key, patientId: scope.patientId, session } };
}
async function footprint(caseId: number) {
  return {
    adjustments: await q("SELECT id, visit_id, upper_wire, done FROM ortho_adjustments WHERE case_id=$1 ORDER BY id", [caseId]),
    case: await q("SELECT upper_wire, lower_wire, phase FROM ortho_cases WHERE id=$1", [caseId]),
    finance: await q(`SELECT (SELECT count(*) FROM invoices)::int AS invoices,
      (SELECT count(*) FROM payments)::int AS payments, (SELECT count(*) FROM treatment_plans)::int AS plans,
      (SELECT count(*) FROM visits)::int AS visits`),
    audit: await q("SELECT id FROM audit_log WHERE action='ortho.adjustment' ORDER BY id"),
  };
}

describe("durable standalone orthodontic adjustment request", () => {
  it("reconciles a lost response using the same key without another adjustment, audit, visit or invoice", async () => {
    const scope = await fixture(); const input = command(scope, "ortho-lost-response-001");
    const first = await db.recordAdjustment(input); expect(first).toMatchObject({ ok: true, created: true, visitId: null });
    if (!first.ok) throw new Error(first.message);
    const before = await footprint(scope.caseId);
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, id: first.id, created: false, visitId: null });
    expect(await footprint(scope.caseId)).toEqual(before);
  });
  it("serializes identical concurrent requests to one persisted result", async () => {
    const scope = await fixture(); const input = command(scope, "ortho-concurrent-001");
    const results = await Promise.all([db.recordAdjustment(input), db.recordAdjustment(input), db.recordAdjustment(input)]);
    expect(results.every(row => row.ok)).toBe(true);
    expect(new Set(results.map(row => row.ok ? row.id : null)).size).toBe(1);
    expect(results.filter(row => row.ok && row.created)).toHaveLength(1);
    expect((await footprint(scope.caseId)).adjustments).toHaveLength(1);
  });
  it("conflicts on changed content using an already committed key", async () => {
    const scope = await fixture(); const input = command(scope, "ortho-content-conflict-001");
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true });
    const before = await footprint(scope.caseId);
    expect(await db.recordAdjustment({ ...input, upperWire: "018 SS" })).toMatchObject({ ok: false });
    expect(await footprint(scope.caseId)).toEqual(before);
  });
  it("does not collapse two explicitly distinct, equal-content legitimate adjustments", async () => {
    const scope = await fixture();
    const a = await db.recordAdjustment(command(scope, "ortho-legitimate-equal-001"));
    const b = await db.recordAdjustment(command(scope, "ortho-legitimate-equal-002"));
    expect(a).toMatchObject({ ok: true, created: true }); expect(b).toMatchObject({ ok: true, created: true });
    if (!a.ok || !b.ok) throw new Error("Expected two legitimate commands");
    expect(a.id).not.toBe(b.id); expect((await footprint(scope.caseId)).adjustments).toHaveLength(2);
  });
  it("does not reuse the same actor's command key for another patient or case", async () => {
    const first = await fixture(), second = await fixture(); const key = "ortho-cross-patient-001";
    expect(await db.recordAdjustment(command(first, key))).toMatchObject({ ok: true });
    const before = await footprint(second.caseId);
    expect(await db.recordAdjustment(command(second, key))).toMatchObject({ ok: false });
    expect(await footprint(second.caseId)).toEqual(before);
  });

  it("keeps the original standalone outcome when a new visit appears before retry", async () => {
    const scope = await fixture();
    const input = { ...command(scope, "ortho-later-visit-001"), doneOn: clinicDateString(new Date(), db.CLINIC_TIME_ZONE) };
    const first = await db.recordAdjustment(input); expect(first).toMatchObject({ ok: true, visitId: null });
    await q("INSERT INTO visits(patient_name, patient_id, status) VALUES ('Synthetic later visit', $1, 'waiting')", [scope.patientId]);
    const before = await footprint(scope.caseId);
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: false, visitId: null, attachedToToday: false });
    expect(await footprint(scope.caseId)).toEqual(before);
  });

  it("replays an older command without reverting later wire changes or reopening the case", async () => {
    const scope = await fixture(); const input = command(scope, "ortho-old-command-001");
    const first = await db.recordAdjustment(input); expect(first).toMatchObject({ ok: true });
    await db.recordAdjustment({ ...command(scope, "ortho-new-command-001"), upperWire: "018 SS" });
    await q("UPDATE ortho_cases SET status='completed' WHERE id=$1", [scope.caseId]);
    const before = await footprint(scope.caseId);
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: false });
    expect(await footprint(scope.caseId)).toEqual(before);
  });

  it("rechecks a revoked account before replaying an already committed outcome", async () => {
    const scope = await fixture(); const input = command(scope, "ortho-revoked-actor-001");
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true });
    const before = await footprint(scope.caseId);
    await q("UPDATE users SET is_active=FALSE WHERE id=$1", [session.userId]);
    try {
      expect(await db.recordAdjustment(input)).toMatchObject({ ok: false, status: 401 });
      expect(await footprint(scope.caseId)).toEqual(before);
    } finally { await q("UPDATE users SET is_active=TRUE WHERE id=$1", [session.userId]); }
  });

  it("refuses an expired replay after its exact visit lock wait without returning a receipt or changing history", async () => {
    const scope = await fixture();
    const [{ id: visitId }] = await q<{ id: number }>(
      "INSERT INTO visits(patient_name, patient_id) VALUES ('Synthetic expiry visit', $1) RETURNING id", [scope.patientId]);
    const input = { ...command(scope, "ortho-replay-expiry-001"), visitId };
    const first = await db.recordAdjustment(input);
    expect(first).toMatchObject({ ok: true, created: true });
    if (!first.ok) throw new Error(first.message);
    const allRows = async () => Object.fromEntries(await Promise.all([
      "patients", "ortho_cases", "ortho_adjustments", "ortho_adjustment_requests", "visits",
      "invoices", "payments", "treatment_plans", "plan_items", "visit_procedures", "audit_log",
    ].map(async table => [table, await q(`SELECT * FROM ${table} ORDER BY 1`)])));
    const before = await allRows();
    const receipts = await q("SELECT * FROM ortho_adjustment_requests WHERE case_id=$1", [scope.caseId]);
    const blocker = await db.getPool().connect();
    let replay: ReturnType<typeof db.recordAdjustment> | undefined;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await blocker.query("BEGIN");
      const { rows: [{ pid: blockerPid }] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE", [visitId]);
      replay = db.recordAdjustment(input);
      void replay.catch(() => undefined);
      let waitingPid: number | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        await blocker.query("SELECT pg_stat_clear_snapshot()");
        const { rows } = await blocker.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'
            AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
            AND query='SELECT id FROM visits WHERE id = $1 FOR UPDATE'`, [blockerPid]);
        if (rows.length === 1) { waitingPid = rows[0].pid; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waitingPid, "Replay must wait for this exact blocker on the visit row").toBeTypeOf("number");
      console.info("Synthetic replay expiry blocker", { blockerPid, waitingPid, visitId });
      clock = vi.spyOn(Date, "now").mockReturnValue(session.expiresAt + 1);
      await blocker.query("COMMIT");
      const result = await replay;
      expect(result).toMatchObject({ ok: false, status: 401, code: "session_expired" });
      expect(result).not.toHaveProperty("id");
      expect(result).not.toHaveProperty("replayed");
    } finally {
      await blocker.query("ROLLBACK");
      await replay?.catch(() => undefined);
      clock?.mockRestore();
      blocker.release();
    }
    expect(await allRows()).toEqual(before);
    expect(await q("SELECT * FROM ortho_adjustment_requests WHERE case_id=$1", [scope.caseId])).toEqual(receipts);
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, id: first.id, created: false, replayed: true });
    expect(await allRows()).toEqual(before);
  }, 20_000);

  it("rolls back adjustment, wires and audit if saving the command outcome fails, then safely retries", async () => {
    const scope = await fixture(); const input = command(scope, "ortho-atomic-rollback-001");
    await q(`CREATE FUNCTION synthetic_reject_adjustment_request() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'Synthetic request storage failure'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER synthetic_reject_adjustment_request BEFORE INSERT ON ortho_adjustment_requests
        FOR EACH ROW WHEN (NEW.request_key='ortho-atomic-rollback-001') EXECUTE FUNCTION synthetic_reject_adjustment_request()`);
    const before = await footprint(scope.caseId);
    try {
      await expect(db.recordAdjustment(input)).rejects.toThrow("Synthetic request storage failure");
      expect(await footprint(scope.caseId)).toEqual(before);
      expect(await q("SELECT request_key FROM ortho_adjustment_requests WHERE request_key=$1", [input.request.key])).toEqual([]);
    } finally {
      await q("DROP TRIGGER synthetic_reject_adjustment_request ON ortho_adjustment_requests; DROP FUNCTION synthetic_reject_adjustment_request()");
    }
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: true });
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: false });
  });

  // One session per visit is kept. Review #483 6871207083: a separately keyed request is a different
  // intention, so it is refused with the existing session named and never receives that session's receipt.
  it("retains one session per visit and refuses a separately keyed request without a receipt", async () => {
    const scope = await fixture();
    const [{ id: visitId }] = await q<{ id: number }>("INSERT INTO visits(patient_name, patient_id) VALUES ('Synthetic owned visit', $1) RETURNING id", [scope.patientId]);
    const a = await db.recordAdjustment({ ...command(scope, "ortho-visit-key-001"), visitId });
    const bInput = { ...command(scope, "ortho-visit-key-002"), visitId };
    expect(a).toMatchObject({ ok: true, created: true });
    if (!a.ok) throw new Error(a.message);
    const before = await footprint(scope.caseId);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await db.recordAdjustment(bInput)).toMatchObject({ ok: false, status: 409,
        code: "adjustment_visit_already_recorded", existingAdjustmentId: a.id, visitId });
    }
    expect(await footprint(scope.caseId)).toEqual(before);
    expect(before.adjustments).toHaveLength(1);
    expect(await q("SELECT request_key FROM ortho_adjustment_requests WHERE case_id=$1", [scope.caseId])).toEqual([{ request_key: "ortho-visit-key-001" }]);
    // The original key still replays its own receipt.
    expect(await db.recordAdjustment({ ...command(scope, "ortho-visit-key-001"), visitId })).toMatchObject({ ok: true, id: a.id, created: false, replayed: true });
  });

  it("does not permit mutation of the durable command outcome", async () => {
    const scope = await fixture(); const input = command(scope, "ortho-immutable-outcome-001");
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true });
    await expect(q("UPDATE ortho_adjustment_requests SET attached_to_today=TRUE WHERE request_key=$1", [input.request.key])).rejects.toThrow("immutable");
    await expect(q("DELETE FROM ortho_adjustment_requests WHERE request_key=$1", [input.request.key])).rejects.toThrow("immutable");
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: false });
  });
  it("refuses direct truncation of nonempty command history without erasing proof", async () => {
    const scope = await fixture(); const input = command(scope, "ortho-truncate-proof-001");
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true });
    const client = await db.getPool().connect();
    try {
      await client.query("BEGIN");
      await expect(client.query("TRUNCATE ortho_adjustment_requests")).rejects.toThrow("immutable");
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: false });
  });

  it("refuses reset before backup and keeps command proof and patient identities", async () => {
    const scope = await fixture(); const input = command(scope, "ortho-reset-proof-001");
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true });
    const before = await footprint(scope.caseId); let backupCalled = false;
    await expect(db.resetClinicData({ actor: session.username, actorRole: session.role }, async () => {
      backupCalled = true;
      // Negative-control safety: even the unfixed reset cannot wipe this synthetic fixture.
      return { ok: false as const, failure: "Synthetic backup intentionally refused" };
    })).rejects.toMatchObject({ name: "ProtectedOrthoAdjustmentHistoryError" });
    expect(backupCalled).toBe(false); expect(await footprint(scope.caseId)).toEqual(before);
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: false });
  });

  it("returns an explicit nonfinancial merge refusal rather than mutating immutable command ownership", async () => {
    const scope = await fixture(), target = await fixture(); const input = command(scope, "ortho-merge-proof-001");
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true });
    const before = await footprint(scope.caseId);
    expect(await db.mergeDuplicatePatient(scope.patientId, target.patientId, { actor: session.username }))
      .toMatchObject({ ok: false, reason: "source_has_clinical_command_history", counts: { orthoAdjustmentRequests: 1 } });
    expect(await footprint(scope.caseId)).toEqual(before);
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: false });
  });

  it("refuses a different-patient visit relink after adjustment while allowing an idempotent same-patient link", async () => {
    const scope = await fixture(), other = await fixture();
    const [{ id: visitId }] = await q<{ id: number }>("INSERT INTO visits(patient_name, patient_id) VALUES ('Synthetic linked history', $1) RETURNING id", [scope.patientId]);
    const input = { ...command(scope, "ortho-relink-proof-001"), visitId };
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true });
    const before = await footprint(scope.caseId);
    expect(await db.linkVisitToPatient(visitId, other.patientId)).toMatchObject({ ok: false });
    expect(await q("SELECT patient_id FROM visits WHERE id=$1", [visitId])).toEqual([{ patient_id: scope.patientId }]);
    expect(await db.linkVisitToPatient(visitId, scope.patientId)).toMatchObject({ ok: true });
    expect(await footprint(scope.caseId)).toEqual(before);
    expect(await db.recordAdjustment(input)).toMatchObject({ ok: true, created: false });
  });

  it("does not invert plan ownership locks against the actual visit signer", async () => {
    const scope = await fixture();
    const [{ id: doctorId }] = await q<{ id: number }>("INSERT INTO parties(name, kind) VALUES ('Synthetic command doctor', 'doctor') RETURNING id");
    const [{ id: signerId }] = await q<{ id: number }>("INSERT INTO parties(name, kind) VALUES ('Synthetic signing doctor', 'doctor') RETURNING id");
    const hash = await auth.hashPassword("synthetic-plan-owner");
    const [{ id: userId }] = await q<{ id: number }>(`INSERT INTO users(username, display_name, role, password_hash, party_id, permissions)
      VALUES ('synthetic-plan-owner', 'Synthetic owner', 'doctor', $1, $2, '{}') RETURNING id`, [hash, doctorId]);
    const doctor: SessionPayload = { userId, username: "synthetic-plan-owner", role: "doctor", partyId: doctorId,
      credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3_600_000 };
    const [{ id: planId }] = await q<{ id: number }>(`INSERT INTO treatment_plans(patient_id, title, total_minor, primary_doctor_id, consent_at)
      VALUES ($1, 'Synthetic lock order', 0, $2, NOW()) RETURNING id`, [scope.patientId, doctorId]);
    const [{ id: serviceId }] = await q<{ id: number }>(`INSERT INTO services(name, category, price_minor, price_configured)
      VALUES ('Synthetic zero-cost work', 'cleaning', 0, TRUE) RETURNING id`);
    const [{ id: itemId }] = await q<{ id: number }>(`INSERT INTO plan_items(plan_id, service_id, service_name, category, quantity, unit_price_minor, billing_rule, session_count, status)
      VALUES ($1,$2,'Synthetic zero-cost work','cleaning',1,0,'on_completion',1,'planned') RETURNING id`, [planId, serviceId]);
    const [{ id: visitId }] = await q<{ id: number }>("INSERT INTO visits(patient_name, patient_id, doctor_id) VALUES ('Synthetic lock-order visit', $1, $2) RETURNING id", [scope.patientId, signerId]);
    await q("INSERT INTO visit_procedures(visit_id, service_id, plan_item_id, doctor_id, quantity, unit_price_minor) VALUES($1,$2,$3,$4,1,0)", [visitId, serviceId, itemId, signerId]);
    const blocker = await db.getPool().connect();
    let adjustmentOutcome: unknown;
    let releaseSigner!: () => void, signalSigner!: () => void;
    const signerPaused = new Promise<void>(resolve => { signalSigner = resolve; });
    const signerResume = new Promise<void>(resolve => { releaseSigner = resolve; });
    const realQuery = Client.prototype.query;
    let paused = false;
    // Test-only scheduler: every SQL statement still runs on real PostgreSQL.
    // Pause the actual signer after its patient+visit locks, just before its plan lock.
    const scheduler = vi.spyOn(Client.prototype, "query").mockImplementation(function(this: Client, ...args: unknown[]) {
      const forward = () => Reflect.apply(realQuery, this, args);
      if (!paused && args[0] === "SELECT id FROM treatment_plans WHERE patient_id = $1 ORDER BY id FOR UPDATE"
        && Array.isArray(args[1]) && args[1][0] === scope.patientId) {
        paused = true; signalSigner(); return signerResume.then(forward);
      }
      return forward();
    } as typeof realQuery);
    const waitFor = async (fragment: string) => {
      for (let tries = 0; tries < 200; tries++) {
        await blocker.query("SELECT pg_stat_clear_snapshot()");
        const { rows } = await blocker.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND state='active' AND wait_event_type='Lock' AND query LIKE $1`, [`%${fragment}%`]);
        if (rows.length) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const activity = (await blocker.query("SELECT query, state, wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")).rows;
      throw new Error(`Synthetic synchronization timed out: ${fragment}: ${JSON.stringify({ activity, adjustmentOutcome })}`);
    };
    let signing: Promise<unknown> | undefined, adjustment: Promise<unknown> | undefined;
    try {
      signing = db.signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "synthetic-signer", signerDoctorPartyId: signerId });
      // Prevent an unhandled rejection in the negative control while the peer is still being observed.
      void signing.catch(() => undefined);
      await signerPaused;
      adjustment = db.recordAdjustment({ ...command(scope, "ortho-lock-order-001"), visitId,
        recordedBy: doctor.username, actorRole: doctor.role, request: { key: "ortho-lock-order-001", patientId: scope.patientId, session: doctor } });
      void adjustment.then(value => { adjustmentOutcome = value; }, error => { adjustmentOutcome = { error: String(error) }; });
      // Before the fix this waits for the visit while holding the plan SHARE witness;
      // after the fix it waits for the canonical patient lock without holding the plan.
      await waitFor("WHERE id = $1 FOR");
      releaseSigner();
      const result = await Promise.allSettled([signing, adjustment]);
      expect(result, JSON.stringify(result)).toEqual([expect.objectContaining({ status: "fulfilled" }), expect.objectContaining({ status: "fulfilled" })]);
      expect(result[0]).toMatchObject({ status: "fulfilled", value: { reason: null } });
      expect(result[1]).toMatchObject({ status: "fulfilled", value: { ok: false } });
      expect(await q("SELECT id FROM ortho_adjustments WHERE case_id=$1", [scope.caseId])).toEqual([]);
      // The explicit signer owns the ordinary invoice; the refused adjustment adds none.
      expect(await q("SELECT id FROM invoices WHERE patient_id=$1", [scope.patientId])).toHaveLength(1);
      expect(await q("SELECT id FROM payments WHERE patient_id=$1", [scope.patientId])).toEqual([]);
    } finally {
      releaseSigner();
      await Promise.allSettled([signing, adjustment].filter(Boolean));
      scheduler.mockRestore(); blocker.release();
    }
  }, 20_000);

});
