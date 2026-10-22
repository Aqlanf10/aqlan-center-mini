import { beforeAll, afterAll, expect, it } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv, dropPublicSchema } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { APPOINTMENT_FOLLOWUP_SQL } from "../../lib/appointment-followup-schema";
import { PLANNED_REBOOK_GENERATION_SQL } from "../../lib/planned-visit-rebooking-contract";
import type { FollowupCommand } from "../../lib/appointment-followup-contract";

// Validate the original environment BEFORE helpers replace it. No fallback target.
validatePostgresTestTarget(process.env);
assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const { saveAppointmentFollowup: save, readAppointmentFollowupQueue: queue, readAppointmentFollowupSource: context } = await import("../../lib/appointment-followup-db");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let serial = 0;
let reception: SessionPayload;
async function actor(role = "reception"): Promise<SessionPayload> {
  const username = `synthetic-followup-${++serial}`;
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES ($1,'Synthetic','synthetic-followup-hash',$2) RETURNING id", [username, role]);
  return { userId: user.id, username, role, credentialVersion: sessionCredentialVersion("synthetic-followup-hash"), expiresAt: Date.now() + 3600000 };
}
beforeAll(async () => {
  await dropPublicSchema(assertRealPostgresUrl());
  await db.ensureSchema();
  await q(APPOINTMENT_FOLLOWUP_SQL); // Candidate schema deliberately installed ONLY here.
  reception = await actor();
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(): Promise<{ patientId: number; input: FollowupCommand }> {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,'Synthetic followup patient') RETURNING id", [`SYN-FOLLOW-${++serial}`]);
  const [source] = await q(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,created_at)
    VALUES ($1,(clock_timestamp() AT TIME ZONE $2)::date - 1,'23:59','no_show','2020-01-01T00:00:00.123456Z')
    RETURNING id,EXTRACT(EPOCH FROM created_at)::text AS created`, [patient.id, db.CLINIC_TIME_ZONE]);
  const identity = await context(source.id, reception);
  expect(identity).toMatchObject({ appointmentId: source.id, expectedPatientId: patient.id, sourceCreatedAt: source.created });
  return { patientId: patient.id, input: { ...identity,
    requestId: `synthetic-followup-request-${serial}`, expectedRevision: 0, assigneeUserId: reception.userId,
    dueAt: new Date(Date.now() + 86400000).toISOString(), status: "open", outcome: "pending", nextStep: "call" } };
}
async function fingerprint() {
  const result: Record<string, string> = {};
  for (const table of ["appointments", "appointment_status_log", "visits", "payments", "invoices", "journal_manual", "journal_manual_lines"])
    result[table] = (await q(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS value FROM ${table} t`))[0].value;
  return result;
}
async function followupSnapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ["appointment_followups", "appointment_followup_events", "appointment_followup_receipts"])
    result[table] = await q(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`);
  result.audit = await q("SELECT to_jsonb(a) AS value FROM audit_log a WHERE entity='appointment_followup' ORDER BY id");
  return result;
}
it.each(["reassignment", "merge"])("rejects stale displayed patient before first save after %s without partial writes", async change => {
  const f = await fixture(); const target = await fixture();
  if (change === "merge") {
    expect(await db.mergeDuplicatePatient(f.patientId, target.patientId, { actor: "synthetic-admin" })).toMatchObject({ ok: true });
  } else {
    await q("UPDATE appointments SET patient_id=$2 WHERE id=$1", [f.input.appointmentId, target.patientId]);
  }
  const before = await followupSnapshot();
  await expect(save(f.input, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_SOURCE_CHANGED" });
  expect(await followupSnapshot()).toEqual(before);
});
it("creates explicitly and atomically, with no attendance, clinical or financial mutations", async () => {
  const f = await fixture(); const before = await fingerprint();
  const result = await save(f.input, reception);
  expect(result).toMatchObject({ revision: 1, replayed: false });
  expect(await fingerprint()).toEqual(before);
  expect(await q("SELECT id FROM appointment_followup_events WHERE followup_id=$1", [result.followupId])).toHaveLength(1);
  expect(await q("SELECT event_id FROM appointment_followup_receipts WHERE actor_user_id=$1 AND request_id=$2", [reception.userId, f.input.requestId])).toHaveLength(1);
  const [audit] = await q("SELECT details,actor FROM audit_log WHERE entity='appointment_followup' AND entity_id=$1", [String(result.followupId)]);
  expect(audit.actor).toBe(reception.username);
  expect(audit.details).toMatchObject({ actorUserId: reception.userId, requestId: f.input.requestId, revision: 1 });
  expect(JSON.stringify(audit.details)).not.toContain("Synthetic followup patient");
});
it("serializes two creators for one exact source", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([save(f.input, reception), save({ ...f.input, requestId: f.input.requestId + "-other" }, reception)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(await q("SELECT id FROM appointment_followups WHERE source_appointment_id=$1", [f.input.appointmentId])).toHaveLength(1);
});
it("replays an exact lost response; same key with changed content conflicts", async () => {
  const f = await fixture(); const first = await save(f.input, reception);
  expect(await save(f.input, reception)).toEqual({ ...first, replayed: true });
  await expect(save({ ...f.input, nextStep: "review" }, reception)).rejects.toMatchObject({ code: "FOLLOWUP_KEY_CONFLICT" });
  const other = await actor();
  await expect(save(f.input, other)).rejects.toMatchObject({ code: "FOLLOWUP_REVISION_CHANGED" });
});
it("competing identical attempts produce a single event and receipt", async () => {
  const f = await fixture(); const results = await Promise.all([save(f.input, reception), save(f.input, reception)]);
  expect(results.filter(result => !result.replayed)).toHaveLength(1);
  expect(await q("SELECT id FROM appointment_followup_events WHERE followup_id=$1", [results[0].followupId])).toHaveLength(1);
});
it.each(["no_answer", "awaiting_reply", "rebooking_review"] as const)("%s remains open with later work", async outcome => {
  const f = await fixture(); const first = await save(f.input, reception);
  const update = { ...f.input, expectedRevision: 1, requestId: f.input.requestId + "-update", outcome, nextStep: "review" as const };
  expect(await save(update, reception)).toMatchObject({ revision: 2 });
  expect((await q("SELECT status,outcome FROM appointment_followups WHERE id=$1", [first.followupId]))[0]).toEqual({ status: "open", outcome });
  await expect(save({ ...update, requestId: update.requestId + "-stale" }, reception)).rejects.toMatchObject({ code: "FOLLOWUP_REVISION_CHANGED" });
  await expect(save({ ...update, expectedRevision: 2, requestId: update.requestId + "-past", dueAt: "2000-01-01T00:00:00.000Z" }, reception)).rejects.toMatchObject({ code: "FOLLOWUP_DUE_MUST_BE_FUTURE" });
});
it.each(["booked", "arrived", "in_progress", "done", "cancelled"])("rejects source status %s", async status => {
  const f = await fixture(); await q("UPDATE appointments SET status=$2 WHERE id=$1", [f.input.appointmentId, status]);
  await expect(save(f.input, reception)).rejects.toMatchObject({ code: "FOLLOWUP_SOURCE_NOT_NO_SHOW" });
});
it("rejects future no_show and attendance evidence", async () => {
  const f = await fixture();
  await q("UPDATE appointments SET scheduled_date=(clock_timestamp() AT TIME ZONE $2)::date + 1 WHERE id=$1", [f.input.appointmentId, db.CLINIC_TIME_ZONE]);
  await expect(save(f.input, reception)).rejects.toMatchObject({ code: "FOLLOWUP_SOURCE_NOT_NO_SHOW" });
  const g = await fixture(); await q("UPDATE appointments SET arrived_at=NOW() WHERE id=$1", [g.input.appointmentId]);
  await expect(save(g.input, reception)).rejects.toMatchObject({ code: "FOLLOWUP_SOURCE_NOT_NO_SHOW" });
});
it.each(["doctor", "assistant", "cashier", "accountant"])("does not expand access to %s", async role => {
  const f = await fixture(); await expect(save(f.input, await actor(role))).rejects.toMatchObject({ status: 403 });
});
it("revalidates expired, revoked and role-changed sessions even on replay", async () => {
  const f = await fixture(); const user = await actor(); await save(f.input, user);
  await expect(save(f.input, { ...user, expiresAt: 0 })).rejects.toMatchObject({ status: 401 });
  await q("UPDATE users SET role='doctor' WHERE id=$1", [user.userId]);
  await expect(save(f.input, user)).rejects.toMatchObject({ status: 401 });
  await q("UPDATE users SET role='reception',is_active=false WHERE id=$1", [user.userId]);
  await expect(save(f.input, user)).rejects.toMatchObject({ status: 401 });
});
it("detects patient reassignment; a merge-shaped FK update preserves immutable history", async () => {
  const f = await fixture(); const g = await fixture(); const first = await save(f.input, reception);
  await q("UPDATE appointments SET patient_id=$2 WHERE id=$1", [f.input.appointmentId, g.patientId]);
  const before = await followupSnapshot();
  await expect(save(f.input, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_SOURCE_CHANGED" });
  await expect(save({ ...f.input, expectedRevision: 1, requestId: f.input.requestId + "-edit" }, reception))
    .rejects.toMatchObject({ status: 409, code: "FOLLOWUP_SOURCE_CHANGED" });
  expect(await followupSnapshot()).toEqual(before);
  // Mirrors FK-driven merge without editing events. Actual merge entrypoint remains a release gate.
  const history = await q("SELECT to_jsonb(e) AS value FROM appointment_followup_events e WHERE followup_id=$1", [first.followupId]);
  await q("UPDATE appointment_followups SET patient_id=$2 WHERE id=$1", [first.followupId, g.patientId]);
  const afterMove = await followupSnapshot();
  await expect(save(f.input, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_SOURCE_CHANGED" });
  expect(await followupSnapshot()).toEqual(afterMove);
  expect(await q("SELECT to_jsonb(e) AS value FROM appointment_followup_events e WHERE followup_id=$1", [first.followupId])).toEqual(history);
});
it("canonical patient merge moves live FKs without updating immutable events or receipts", async () => {
  const f = await fixture(); const target = await fixture(); const first = await save(f.input, reception);
  const events = await q("SELECT to_jsonb(e) AS value FROM appointment_followup_events e WHERE followup_id=$1", [first.followupId]);
  const receipts = await q("SELECT to_jsonb(r) AS value FROM appointment_followup_receipts r WHERE request_id=$1", [f.input.requestId]);
  expect(await db.mergeDuplicatePatient(f.patientId, target.patientId, { actor: "synthetic-admin" })).toMatchObject({ ok: true });
  expect((await q("SELECT patient_id FROM appointment_followups WHERE id=$1", [first.followupId]))[0].patient_id).toBe(target.patientId);
  expect(await q("SELECT to_jsonb(e) AS value FROM appointment_followup_events e WHERE followup_id=$1", [first.followupId])).toEqual(events);
  expect(await q("SELECT to_jsonb(r) AS value FROM appointment_followup_receipts r WHERE request_id=$1", [f.input.requestId])).toEqual(receipts);
  const afterMerge = await followupSnapshot();
  await expect(save(f.input, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_SOURCE_CHANGED" });
  expect(await followupSnapshot()).toEqual(afterMerge);
  const refreshed = await context(f.input.appointmentId, reception);
  expect(refreshed.expectedPatientId).toBe(target.patientId);
  // Do not silently rewrite an old attempt to the merged patient's identity.
  await expect(save({ ...f.input, ...refreshed }, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_KEY_CONFLICT" });
  expect(await followupSnapshot()).toEqual(afterMerge);
});
it("queue reads live context without creating tasks or counting a selected day", async () => {
  const f = await fixture(); const before = await q("SELECT count(*)::int AS n FROM appointment_followups");
  await queue(reception);
  expect(await q("SELECT count(*)::int AS n FROM appointment_followups")).toEqual(before);
  const first = await save(f.input, reception);
  expect((await queue(reception)).items.find(item => item.id === first.followupId)?.full_name).toBe("Synthetic followup patient");
  await q("UPDATE patients SET full_name='Synthetic renamed' WHERE id=$1", [f.patientId]);
  expect((await queue(reception)).items.find(item => item.id === first.followupId)?.full_name).toBe("Synthetic renamed");
  await q("DELETE FROM appointments WHERE id=$1", [f.input.appointmentId]);
  expect((await queue(reception)).items.find(item => item.id === first.followupId)).toMatchObject({ patient_id: null, full_name: null,
    sourceState: "source_unavailable_review_required", contactBlocked: true, rebookingBlocked: true, sourceIdentity: null });
  await expect(queue(await actor("doctor"))).rejects.toMatchObject({ status: 403 });
  await expect(queue({ ...reception, expiresAt: 0 })).rejects.toMatchObject({ status: 401 });
});
it("closes only explicitly and another missed appointment creates separate history", async () => {
  const f = await fixture(); const first = await save(f.input, reception);
  await save({ ...f.input, requestId: f.input.requestId + "-close", expectedRevision: 1, status: "closed", outcome: "declined", nextStep: "none" }, reception);
  const [replacement] = await q(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status)
    VALUES ($1,'2000-01-01','11:00','no_show') RETURNING id,EXTRACT(EPOCH FROM created_at)::text AS created`, [f.patientId]);
  const second = await save({ ...f.input, appointmentId: replacement.id, sourceCreatedAt: replacement.created, requestId: f.input.requestId + "-replacement" }, reception);
  expect(second.followupId).not.toBe(first.followupId);
  expect(await q("SELECT revision FROM appointment_followup_events WHERE followup_id=$1 ORDER BY revision", [first.followupId])).toEqual([{ revision: 1 }, { revision: 2 }]);
});
it("does not attach history to a deleted/reused appointment number", async () => {
  const f = await fixture(); const first = await save(f.input, reception);
  await q("DELETE FROM appointments WHERE id=$1", [f.input.appointmentId]);
  expect((await q("SELECT appointment_id FROM appointment_followups WHERE id=$1", [first.followupId]))[0].appointment_id).toBeNull();
  await expect(save(f.input, reception)).rejects.toMatchObject({ code: "FOLLOWUP_SOURCE_CHANGED" });
  await q("INSERT INTO appointments(id,patient_id,scheduled_date,scheduled_time,status) VALUES ($1,$2,'2000-01-01','10:00','no_show')", [f.input.appointmentId, f.patientId]);
  await expect(save(f.input, reception)).rejects.toMatchObject({ code: "FOLLOWUP_SOURCE_CHANGED" });
  await expect(q("UPDATE appointment_followups SET appointment_id=$2 WHERE id=$1", [first.followupId, f.input.appointmentId])).rejects.toThrow("immutable");
});
it("rejects sub-millisecond identity mismatch and old reset generation", async () => {
  const f = await fixture();
  await expect(save({ ...f.input, sourceCreatedAt: f.input.sourceCreatedAt.replace("123456", "123457") }, reception)).rejects.toMatchObject({ code: "FOLLOWUP_SOURCE_CHANGED" });
  await expect(save({ ...f.input, generation: "0".repeat(32) }, reception)).rejects.toMatchObject({ code: "FOLLOWUP_GENERATION_CHANGED" });
});
it.each([false, true])("rejects old reset-generation intent with reused source ID (saved=%s), with no partial writes", async saved => {
  const f = await fixture();
  if (saved) await save(f.input, reception);
  // Synthetic reset-generation transition, NOT activation/testing of a reset policy.
  // Keep identical source ID and timestamp to prove the generation is decisive.
  await q("DELETE FROM appointments WHERE id=$1", [f.input.appointmentId]);
  await db.insertAuditRow(db.getPool(), { action: "system.reset", actor: "synthetic-reset", entity: "system", details: { synthetic: true } });
  await q(`INSERT INTO appointments(id,patient_id,scheduled_date,scheduled_time,status,created_at)
    VALUES ($1,$2,'2000-01-01','10:00','no_show','2020-01-01T00:00:00.123456Z')`, [f.input.appointmentId, f.patientId]);
  const [generation] = await q(`SELECT ${PLANNED_REBOOK_GENERATION_SQL} AS value`);
  expect(generation.value).not.toBe(f.input.generation);
  const before = await followupSnapshot();
  await expect(save(f.input, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_GENERATION_CHANGED" });
  expect(await followupSnapshot()).toEqual(before);
});
it("database prevents history mutation, source substitution and patient FKs in history", async () => {
  const f = await fixture(); const result = await save(f.input, reception);
  await expect(q("UPDATE appointment_followups SET source_created_at='1000000000.000000' WHERE id=$1", [result.followupId])).rejects.toThrow("immutable");
  await expect(q("UPDATE appointment_followup_events SET outcome='pending' WHERE followup_id=$1", [result.followupId])).rejects.toThrow("append-only");
  await expect(q("DELETE FROM appointment_followup_receipts WHERE actor_user_id=$1", [reception.userId])).rejects.toThrow("append-only");
  await expect(q("TRUNCATE appointment_followup_receipts")).rejects.toThrow("append-only");
  expect(await q(`SELECT conname FROM pg_constraint WHERE contype='f' AND confrelid='patients'::regclass
    AND conrelid IN ('appointment_followup_events'::regclass,'appointment_followup_receipts'::regclass)`)).toEqual([]);
});
it("audit failure rolls back task, event and receipt and leaves source untouched", async () => {
  const f = await fixture(); const before = await fingerprint();
  await q(`CREATE FUNCTION synthetic_fail_followup_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.entity='appointment_followup' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_fail_followup_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_fail_followup_audit()`);
  try { await expect(save(f.input, reception)).rejects.toThrow("synthetic audit failure"); }
  finally { await q("DROP TRIGGER synthetic_fail_followup_audit ON audit_log; DROP FUNCTION synthetic_fail_followup_audit()"); }
  expect(await q("SELECT id FROM appointment_followups WHERE source_appointment_id=$1", [f.input.appointmentId])).toEqual([]);
  expect(await q("SELECT event_id FROM appointment_followup_receipts WHERE actor_user_id=$1 AND request_id=$2", [reception.userId, f.input.requestId])).toEqual([]);
  expect(await fingerprint()).toEqual(before);
});
