import { beforeAll, afterAll, expect, it } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv, dropPublicSchema, rawPool } from "./_setup";
assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const observer = rawPool(assertRealPostgresUrl(), 2);
beforeAll(async () => { await dropPublicSchema(assertRealPostgresUrl()); await db.ensureSchema(); });
afterAll(async () => { await db.resetPoolForTesting(); await observer.end(); });
let serial = 0;
async function fixture() {
  const { rows: [patient] } = await db.getPool().query("INSERT INTO patients(patient_number, full_name) VALUES ($1, 'Synthetic planned absence') RETURNING id", [`SYN-ABS-${++serial}`]);
  const { rows: [appointment] } = await db.getPool().query(`INSERT INTO appointments(patient_id, scheduled_date, scheduled_time)
    VALUES ($1, (NOW() AT TIME ZONE 'Asia/Aden')::date - 1, '10:00') RETURNING id`, [patient.id]);
  const { rows: [planned] } = await db.getPool().query(`INSERT INTO planned_visits(patient_id, sequence, title, status, appointment_id)
    VALUES ($1, 1, 'Synthetic planned session', 'scheduled', $2) RETURNING id`, [patient.id, appointment.id]);
  await db.getPool().query("UPDATE appointments SET planned_visit_id = $2 WHERE id = $1", [appointment.id, planned.id]);
  return { appointment: appointment.id as number, planned: planned.id as number };
}
async function assertConsistent(id: number) {
  const { rows } = await db.getPool().query(`SELECT a.status AS appointment_status, v.status AS visit_status
    FROM appointments a JOIN planned_visits pv ON pv.appointment_id = a.id
    JOIN visits v ON v.planned_visit_id = pv.id
    WHERE a.id = $1 AND a.status = 'no_show' AND v.status IN ('waiting', 'called', 'in_chair')`, [id]);
  expect(rows, "A missed appointment must not simultaneously carry a linked active visit").toEqual([]);
}
it("sequential: no_show then start planned session must not leave contradictory attendance", async () => {
  const f = await fixture();
  expect(await db.closeBookedAppointment(f.appointment, "no_show")).toBe(true);
  const started = await db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "synthetic" });
  expect(started).toEqual({ appointmentConflict: true });
  await assertConsistent(f.appointment);
});
async function waitForLock(advisory = true) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const { rows } = await observer.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type = 'Lock' AND (wait_event = 'advisory') = $1 AND pid <> pg_backend_pid()`, [advisory]);
    if (rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Controlled transaction never reached its advisory barrier");
}
it.each(["planned_start", "absence", "cancellation"] as const)("concurrent: %s crosses its writer boundary first", async first => {
  const f = await fixture();
  const table = first === "planned_start" ? "visits" : "appointments";
  const event = first === "planned_start" ? "INSERT" : "UPDATE";
  const condition = first === "planned_start" ? `NEW.planned_visit_id = ${f.planned}` : `NEW.id = ${f.appointment} AND NEW.status = '${first === "cancellation" ? "cancelled" : "no_show"}'`;
  await observer.query(`CREATE OR REPLACE FUNCTION synthetic_absence_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(812345); END IF; RETURN NEW; END $$`);
  await observer.query(`CREATE TRIGGER synthetic_absence_barrier BEFORE ${event} ON ${table}
    FOR EACH ROW EXECUTE FUNCTION synthetic_absence_barrier()`);
  const blocker = await observer.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("SELECT pg_advisory_lock(812345)");
    pending = first === "planned_start"
      ? db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "synthetic" })
      : first === "cancellation"
        ? db.transitionAppointment(f.appointment, "cancelled", { actor: "synthetic", reason: "synthetic cancellation" })
        : db.closeBookedAppointment(f.appointment, "no_show");
    await waitForLock();
    const other = first === "planned_start"
      ? db.closeBookedAppointment(f.appointment, "no_show")
      : db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "synthetic" });
    await waitForLock(false);
    await blocker.query("SELECT pg_advisory_unlock(812345)");
    expect(await pending).toBeTruthy();
    expect(await other).toEqual(first === "planned_start" ? false : { appointmentConflict: true });
    await assertConsistent(f.appointment);
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(812345)");
    blocker.release();
    await pending;
    await observer.query(`DROP TRIGGER synthetic_absence_barrier ON ${table}`);
    await observer.query("DROP FUNCTION synthetic_absence_barrier()");
  }
});

it.each(["cancelled", "done"])("rejects terminal %s without a new visit", async status => {
  const f = await fixture();
  await db.getPool().query("UPDATE appointments SET status = $2 WHERE id = $1", [f.appointment, status]);
  expect(await db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "synthetic" })).toEqual({ appointmentConflict: true });
  expect((await db.getPool().query("SELECT id FROM visits WHERE planned_visit_id = $1", [f.planned])).rows).toEqual([]);
});
it("records atomic arrival with actor and role exactly once on replay", async () => {
  const f = await fixture();
  const started = await db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "synthetic-reception", actorRole: "reception" });
  expect(started).toHaveProperty("id");
  expect((await db.getPool().query("SELECT status, arrived_at FROM appointments WHERE id = $1", [f.appointment])).rows[0]).toMatchObject({status: "arrived", arrived_at: expect.any(Date)});
  const replay = await db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "second" });
  expect(replay).toHaveProperty("alreadyActive", true);
  expect((await db.listAppointmentStatusLog(f.appointment)).map(row => ({from: row.from, to: row.to, actor: row.actor, actorRole: row.actorRole}))).toEqual([{from: "booked", to: "arrived", actor: "synthetic-reception", actorRole: "reception"}]);
});
it.each(["unlinked", "arrived"])("preserves %s planned starts", async mode => {
  const f = await fixture();
  if (mode === "unlinked") {
    await db.getPool().query("UPDATE appointments SET planned_visit_id = NULL WHERE id = $1", [f.appointment]);
    await db.getPool().query("UPDATE planned_visits SET appointment_id = NULL WHERE id = $1", [f.planned]);
  } else await db.getPool().query("UPDATE appointments SET status = 'arrived', arrived_at = NOW() WHERE id = $1", [f.appointment]);
  expect(await db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "synthetic" })).toHaveProperty("id");
});
it("rolls back visit, plan and arrival if the lifecycle audit fails", async () => {
  const f = await fixture();
  await observer.query(`CREATE FUNCTION synthetic_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
  await observer.query(`CREATE TRIGGER synthetic_fail_audit BEFORE INSERT ON appointment_status_log FOR EACH ROW EXECUTE FUNCTION synthetic_fail_audit()`);
  try {
    await expect(db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "synthetic" })).rejects.toThrow("synthetic audit failure");
    expect((await db.getPool().query("SELECT status FROM appointments WHERE id = $1", [f.appointment])).rows[0].status).toBe("booked");
    expect((await db.getPool().query("SELECT status, visit_id FROM planned_visits WHERE id = $1", [f.planned])).rows[0]).toEqual({status: "scheduled", visit_id: null});
    expect((await db.getPool().query("SELECT id FROM visits WHERE planned_visit_id = $1", [f.planned])).rows).toEqual([]);
  } finally {
    await observer.query("DROP TRIGGER synthetic_fail_audit ON appointment_status_log; DROP FUNCTION synthetic_fail_audit()");
  }
});
it("rejects ambiguous inverse appointment links", async () => {
  const f = await fixture();
  await db.getPool().query(`INSERT INTO appointments(patient_id, scheduled_date, scheduled_time, planned_visit_id)
    SELECT patient_id, scheduled_date, '11:00', planned_visit_id FROM appointments WHERE id = $1`, [f.appointment]);
  expect(await db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "synthetic" })).toEqual({appointmentConflict: true});
});
it.each(["retarget", "cancel"])("rechecks %s committed while waiting for the planned-row lock", async change => {
  const f = await fixture();
  // A legacy one-sided link is supported, but must not authorize a stale target.
  await db.getPool().query("UPDATE appointments SET planned_visit_id = NULL WHERE id = $1", [f.appointment]);
  const { rows: [replacement] } = await db.getPool().query(`INSERT INTO appointments(patient_id, scheduled_date, scheduled_time)
    SELECT patient_id, scheduled_date, '11:00' FROM appointments WHERE id = $1 RETURNING id`, [f.appointment]);
  const blocker = await observer.connect();
  let pending: ReturnType<typeof db.startVisitFromPlannedVisit> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM planned_visits WHERE id = $1 FOR UPDATE", [f.planned]);
    pending = db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "synthetic" });
    await waitForLock(false);
    if (change === "retarget") await blocker.query("UPDATE planned_visits SET appointment_id = $2 WHERE id = $1", [f.planned, replacement.id]);
    else await blocker.query("UPDATE planned_visits SET status = 'cancelled' WHERE id = $1", [f.planned]);
    await blocker.query("COMMIT");
    expect(await pending).toEqual(change === "retarget" ? { appointmentConflict: true } : null);
    expect((await db.getPool().query("SELECT status FROM appointments WHERE id = $1", [f.appointment])).rows[0].status).toBe("booked");
    expect((await db.getPool().query("SELECT id FROM visits WHERE planned_visit_id = $1", [f.planned])).rows).toEqual([]);
  } finally {
    await blocker.query("ROLLBACK"); blocker.release(); await pending;
  }
});
it.each(["direct", "planned"])("rejects completed %s visit evidence on a stale arrived appointment", async link => {
  const f = await fixture();
  await db.getPool().query("UPDATE appointments SET status = 'arrived' WHERE id = $1", [f.appointment]);
  await db.getPool().query(`INSERT INTO visits(patient_name, patient_id, appointment_id, planned_visit_id, signed_at, status)
    SELECT 'Synthetic signed visit', patient_id, $2::int, $3::int, NOW(), 'done' FROM appointments WHERE id = $1`,
    [f.appointment, link === "direct" ? f.appointment : null, link === "planned" ? f.planned : null]);
  expect(await db.startVisitFromPlannedVisit({ plannedVisitId: f.planned, actor: "synthetic" })).toEqual({appointmentConflict: true});
  expect((await db.getPool().query("SELECT count(*)::int AS n FROM visits WHERE appointment_id = $1 OR planned_visit_id = $2", [f.appointment, f.planned])).rows[0].n).toBe(1);
});
it("attaches an already-arrived referral case without a duplicate arrival audit", async () => {
  const f = await fixture();
  const {rows: [doctor]} = await db.getPool().query("INSERT INTO parties(kind, name) VALUES ('doctor', 'Synthetic specialist') RETURNING id");
  const {rows: [clinicalCase]} = await db.getPool().query(`INSERT INTO clinical_cases(patient_id, specialty, title, created_by)
    SELECT patient_id, 'endodontics', 'Synthetic case', 'synthetic' FROM appointments WHERE id = $1 RETURNING id`, [f.appointment]);
  const {rows: [referral]} = await db.getPool().query(`INSERT INTO patient_referrals(patient_id, to_name, to_specialty, reason, created_by, kind, to_party_id, workflow_state, case_id)
    SELECT patient_id, 'Synthetic specialist', 'endodontics', 'Synthetic referral', 'synthetic', 'internal', $2, 'arrived', $3 FROM appointments WHERE id = $1 RETURNING id`, [f.appointment, doctor.id, clinicalCase.id]);
  await db.getPool().query("UPDATE appointments SET status = 'arrived', referral_id = $2 WHERE id = $1", [f.appointment, referral.id]);
  const started = await db.startVisitFromPlannedVisit({plannedVisitId: f.planned, actor: "synthetic"});
  expect(started).toHaveProperty("id");
  expect((await db.getPool().query("SELECT case_id FROM visits WHERE appointment_id = $1", [f.appointment])).rows[0].case_id).toBe(clinicalCase.id);
  expect(await db.listAppointmentStatusLog(f.appointment)).toEqual([]);
  expect((await db.getPool().query("SELECT id FROM audit_log WHERE action = 'referral.arrive' AND entity_id = (SELECT patient_id FROM appointments WHERE id = $1)::text", [f.appointment])).rows).toEqual([]);
});
