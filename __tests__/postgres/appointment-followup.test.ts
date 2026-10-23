import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { setTimeout as pause } from "node:timers/promises";
import { assertRealPostgresUrl, stubPostgresEnv, dropPublicSchema } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { APPOINTMENT_FOLLOWUP_SQL } from "../../lib/appointment-followup-schema";
import { PLANNED_REBOOK_GENERATION_SQL } from "../../lib/planned-visit-rebooking-contract";
import type { FollowupCommand } from "../../lib/appointment-followup-contract";

// Candidate registration only in this isolated guarded PG suite. Production
// arrays remain unchanged until schema bootstrap/manifest are approved together.
vi.mock("../../lib/clinic-reset", async importOriginal => {
  const actual = await importOriginal<typeof import("../../lib/clinic-reset")>();
  return { ...actual,
    RESET_WIPE_TABLES: [...actual.RESET_WIPE_TABLES, ...actual.APPOINTMENT_FOLLOWUP_RESET_WIPE_TABLES],
    RESET_KEEP_TABLES: [...actual.RESET_KEEP_TABLES, ...actual.APPOINTMENT_FOLLOWUP_RESET_KEEP_TABLES],
  };
});

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
  for (const table of ["appointment_followups", "appointment_followup_links", "appointment_followup_events", "appointment_followup_receipts"])
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
const contradictoryEvidence = ["log_from", "log_to", "planned_inverse_visit", "planned_forward_visit", "planned_visit_pointer",
  "linked_in_progress", "linked_completed", "session_status", "session_completed_at", "session_visit",
  "item_done", "item_cancelled", "item_done_at", "item_visit"] as const;
async function addAttendanceEvidence(f: Awaited<ReturnType<typeof fixture>>, evidence: typeof contradictoryEvidence[number]) {
  await q("UPDATE appointments SET arrived_at=NULL,started_at=NULL WHERE id=$1", [f.input.appointmentId]);
  if (evidence === "log_from" || evidence === "log_to") {
    await q(`INSERT INTO appointment_status_log(appointment_id,from_status,to_status,actor)
      VALUES ($1,$2,$3,'synthetic')`, [f.input.appointmentId, evidence === "log_from" ? "arrived" : "booked", evidence === "log_from" ? "no_show" : "arrived"]);
    return;
  }
  const [planned] = await q(`INSERT INTO planned_visits(patient_id,sequence,title,status,appointment_id)
    VALUES ($1,1,'Synthetic source-linked session','scheduled',$2) RETURNING id`,
  [f.patientId, evidence === "planned_forward_visit" ? null : f.input.appointmentId]);
  if (evidence === "planned_forward_visit") await q("UPDATE appointments SET planned_visit_id=$2 WHERE id=$1", [f.input.appointmentId, planned.id]);
  // Each fixture isolates one predicate branch: no appointment stamps/logs,
  // no planned visit pointer and no directly linked visit hide the witness.
  if (evidence === "linked_in_progress" || evidence === "linked_completed") {
    await q("UPDATE planned_visits SET status=$2 WHERE id=$1", [planned.id, evidence === "linked_in_progress" ? "in_progress" : "completed"]);
    return;
  }
  if (evidence.startsWith("session_") || evidence.startsWith("item_")) {
    const [plan] = await q("INSERT INTO treatment_plans(patient_id,title,total_minor,status) VALUES ($1,'Synthetic witness plan',0,'active') RETURNING id", [f.patientId]);
    await q("UPDATE planned_visits SET plan_id=$2 WHERE id=$1", [planned.id, plan.id]);
    const [item] = await q("INSERT INTO plan_items(plan_id,service_name,unit_price_minor) VALUES ($1,'Synthetic witness item',0) RETURNING id", [plan.id]);
    const [session] = await q("INSERT INTO treatment_sessions(plan_item_id,sequence,planned_visit_id) VALUES ($1,1,$2) RETURNING id", [item.id, planned.id]);
    if (evidence === "session_status") await q("UPDATE treatment_sessions SET status='done' WHERE id=$1", [session.id]);
    if (evidence === "session_completed_at") await q("UPDATE treatment_sessions SET completed_at=NOW() WHERE id=$1", [session.id]);
    if (evidence === "item_done" || evidence === "item_cancelled") await q("UPDATE plan_items SET status=$2 WHERE id=$1", [item.id, evidence === "item_done" ? "done" : "cancelled"]);
    if (evidence === "item_done_at") await q("UPDATE plan_items SET done_at=NOW() WHERE id=$1", [item.id]);
    if (evidence === "session_visit" || evidence === "item_visit") {
      const [witness] = await q("INSERT INTO visits(patient_id,patient_name,status) VALUES ($1,'Synthetic clinical witness','waiting') RETURNING id", [f.patientId]);
      if (evidence === "session_visit") await q("UPDATE treatment_sessions SET visit_id=$2 WHERE id=$1", [session.id, witness.id]);
      else await q("UPDATE plan_items SET visit_id=$2 WHERE id=$1", [item.id, witness.id]);
    }
    return;
  }
  const [visit] = await q(`INSERT INTO visits(patient_id,patient_name,status,planned_visit_id)
    VALUES ($1,'Synthetic attendance','waiting',$2) RETURNING id`, [f.patientId, evidence === "planned_visit_pointer" ? null : planned.id]);
  if (evidence === "planned_visit_pointer") await q("UPDATE planned_visits SET visit_id=$2 WHERE id=$1", [planned.id, visit.id]);
}
it.each(contradictoryEvidence)("rejects source-linked %s evidence on creation without any partial write", async evidence => {
  const f = await fixture(); await addAttendanceEvidence(f, evidence);
  const before = await followupSnapshot();
  await expect(save(f.input, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_SOURCE_NOT_NO_SHOW" });
  expect(await followupSnapshot()).toEqual(before);
});
it.each(contradictoryEvidence)("queue blocks contact on %s while preserving source history for review", async evidence => {
  const f = await fixture(); const first = await save(f.input, reception);
  await addAttendanceEvidence(f, evidence);
  const before = await followupSnapshot();
  expect((await queue(reception)).items.find(row => row.id === first.followupId)).toMatchObject({
    sourceState: "source_ineligible_review_required", contactBlocked: true, rebookingBlocked: true,
  });
  expect(await followupSnapshot()).toEqual(before);
});
it.each([false, true])("replacement visit does not rewrite original no_show eligibility (existing followup=%s)", async existing => {
  const f = await fixture();
  if (existing) await save(f.input, reception);
  const [replacement] = await q(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,status,arrived_at)
    VALUES ($1,'2000-01-02','10:00','arrived',NOW()) RETURNING id`, [f.patientId]);
  // Final pointer shape of #420: the planned visit points to the replacement;
  // the original appointment's planned_visit_id is detached, preserving history.
  const [planned] = await q(`INSERT INTO planned_visits(patient_id,sequence,title,status,appointment_id)
    VALUES ($1,1,'Synthetic replacement session','in_progress',$2) RETURNING id`, [f.patientId, replacement.id]);
  await q("UPDATE appointments SET planned_visit_id=$2 WHERE id=$1", [replacement.id, planned.id]);
  const [visit] = await q(`INSERT INTO visits(patient_id,patient_name,status,appointment_id,planned_visit_id)
    VALUES ($1,'Synthetic replacement visit','waiting',$2,$3) RETURNING id`, [f.patientId, replacement.id, planned.id]);
  await q("UPDATE planned_visits SET visit_id=$2 WHERE id=$1", [planned.id, visit.id]);
  const sourceBefore = await q("SELECT to_jsonb(a) AS value FROM appointments a WHERE id=$1", [f.input.appointmentId]);
  const result = await save({ ...f.input, expectedRevision: existing ? 1 : 0,
    requestId: f.input.requestId + "-after-replacement" }, reception);
  expect((await queue(reception)).items.find(row => row.id === result.followupId)).toMatchObject({ sourceState: "available", contactBlocked: false });
  expect(await q("SELECT to_jsonb(a) AS value FROM appointments a WHERE id=$1", [f.input.appointmentId])).toEqual(sourceBefore);
  // An ambiguous stale forward pointer requires review, not a claim of attendance.
  await q("UPDATE appointments SET planned_visit_id=$2 WHERE id=$1", [f.input.appointmentId, planned.id]);
  expect((await queue(reception)).items.find(row => row.id === result.followupId)).toMatchObject({ sourceState: "source_ineligible_review_required", contactBlocked: true });
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
  // Isolated FK movement; the next test exercises the canonical merge entrypoint.
  const history = await q("SELECT to_jsonb(e) AS value FROM appointment_followup_events e WHERE followup_id=$1", [first.followupId]);
  await q("UPDATE appointment_followup_links SET patient_id=$2 WHERE followup_id=$1", [first.followupId, g.patientId]);
  const afterMove = await followupSnapshot();
  await expect(save(f.input, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_SOURCE_CHANGED" });
  expect(await followupSnapshot()).toEqual(afterMove);
  expect(await q("SELECT to_jsonb(e) AS value FROM appointment_followup_events e WHERE followup_id=$1", [first.followupId])).toEqual(history);
});
it("canonical patient merge moves live FKs without updating immutable events or receipts", async () => {
  const f = await fixture(); const target = await fixture(); const first = await save(f.input, reception);
  const taskBefore = await q("SELECT to_jsonb(f) AS value FROM appointment_followups f WHERE id=$1", [first.followupId]);
  const events = await q("SELECT to_jsonb(e) AS value FROM appointment_followup_events e WHERE followup_id=$1", [first.followupId]);
  const receipts = await q("SELECT to_jsonb(r) AS value FROM appointment_followup_receipts r WHERE request_id=$1", [f.input.requestId]);
  expect(await db.mergeDuplicatePatient(f.patientId, target.patientId, { actor: "synthetic-admin" })).toMatchObject({ ok: true });
  expect((await q("SELECT patient_id FROM appointment_followup_links WHERE followup_id=$1", [first.followupId]))[0].patient_id).toBe(target.patientId);
  expect((await queue(reception)).items.find(row => row.id === first.followupId)).toMatchObject({ patient_id: target.patientId, contactBlocked: false });
  expect(await q("SELECT to_jsonb(e) AS value FROM appointment_followup_events e WHERE followup_id=$1", [first.followupId])).toEqual(events);
  expect(await q("SELECT to_jsonb(r) AS value FROM appointment_followup_receipts r WHERE request_id=$1", [f.input.requestId])).toEqual(receipts);
  expect(await q("SELECT to_jsonb(f) AS value FROM appointment_followups f WHERE id=$1", [first.followupId])).toEqual(taskBefore);
  const afterMerge = await followupSnapshot();
  await expect(save(f.input, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_SOURCE_CHANGED" });
  expect(await followupSnapshot()).toEqual(afterMerge);
  const refreshed = await context(f.input.appointmentId, reception);
  expect(refreshed.expectedPatientId).toBe(target.patientId);
  // Do not silently rewrite an old attempt to the merged patient's identity.
  await expect(save({ ...f.input, ...refreshed }, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_KEY_CONFLICT" });
  expect(await followupSnapshot()).toEqual(afterMerge);
});
it("does not wait on the live link held by canonical patient merge", async () => {
  const f = await fixture(); const target = await fixture(); const first = await save(f.input, reception);
  const before = await followupSnapshot();
  const gate = await db.getPool().connect();
  const gateClass = 737434;
  let merging: ReturnType<typeof db.mergeDuplicatePatient> | undefined;
  let saving: Promise<unknown> | undefined;
  let blockedSavePid: number | undefined;
  await gate.query("SELECT pg_advisory_lock($1,$2)", [gateClass, first.followupId]);
  // AFTER UPDATE guarantees the merge owns the live link before pausing,
  // while its alphabetically later appointments update has not begun.
  await q(`CREATE FUNCTION synthetic_followup_merge_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(737434, NEW.followup_id); RETURN NEW; END $$;
    CREATE TRIGGER synthetic_followup_merge_gate AFTER UPDATE OF patient_id ON appointment_followup_links
    FOR EACH ROW WHEN (OLD.patient_id IS DISTINCT FROM NEW.patient_id)
    EXECUTE FUNCTION synthetic_followup_merge_gate()`);
  try {
    merging = db.mergeDuplicatePatient(f.patientId, target.patientId, { actor: "synthetic-admin" });
    // Handle rejection immediately even if a setup assertion fails first.
    void merging.catch(() => {});
    let mergePid: number | undefined;
    const gateDeadline = Date.now() + 10000;
    while (!mergePid && Date.now() < gateDeadline) {
      const [waiter] = await q(`SELECT pid FROM pg_locks WHERE locktype='advisory'
        AND classid=$1::oid AND objid=$2::oid AND objsubid=2 AND NOT granted`, [gateClass, first.followupId]);
      mergePid = waiter?.pid;
      if (!mergePid) await pause(10);
    }
    expect(mergePid, "real merge reached the held live link before appointments").toBeDefined();
    let outcome: { error: unknown } | { value: unknown } | undefined;
    saving = save({ ...f.input, expectedRevision: 1, requestId: f.input.requestId + "-merge-race", outcome: "no_answer" }, reception)
      .then(value => { outcome = { value }; }, error => { outcome = { error }; });
    const saveDeadline = Date.now() + 10000;
    while (!outcome && !blockedSavePid && Date.now() < saveDeadline) {
      const [blocked] = await q(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND $1::int = ANY(pg_blocking_pids(pid))
        AND query LIKE '%FROM appointment_followup_links WHERE followup_id%'`, [mergePid]);
      blockedSavePid = blocked?.pid;
      if (!outcome && !blockedSavePid) await pause(10);
    }
    // The old blocking FOR UPDATE is observably waiting here, before patient NOWAIT.
    // This assertion is lock-state based, not a fragile elapsed-time threshold.
    expect(blockedSavePid, "followup must not wait on merge while holding its appointment").toBeUndefined();
    expect(outcome).toMatchObject({ error: { status: 409, code: "FOLLOWUP_BUSY" } });
    expect(await followupSnapshot()).toEqual(before);
    await gate.query("SELECT pg_advisory_unlock($1,$2)", [gateClass, first.followupId]);
    expect(await merging).toMatchObject({ ok: true });
    expect((await q("SELECT patient_id FROM appointments WHERE id=$1", [f.input.appointmentId]))[0].patient_id).toBe(target.patientId);
    expect(await q("SELECT revision FROM appointment_followup_events WHERE followup_id=$1", [first.followupId])).toEqual([{ revision: 1 }]);
    expect(await q("SELECT event_id FROM appointment_followup_receipts WHERE request_id=$1", [f.input.requestId + "-merge-race"])).toEqual([]);
  } finally {
    // On a regression, cancel only the observed test writer blocked by this merge.
    if (blockedSavePid) await q("SELECT pg_cancel_backend($1)", [blockedSavePid]);
    await gate.query("SELECT pg_advisory_unlock($1,$2)", [gateClass, first.followupId]);
    gate.release();
    await Promise.allSettled([...(saving ? [saving] : []), ...(merging ? [merging] : [])]);
    await q("DROP TRIGGER synthetic_followup_merge_gate ON appointment_followup_links; DROP FUNCTION synthetic_followup_merge_gate()");
  }
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
  expect((await q("SELECT appointment_id FROM appointment_followup_links WHERE followup_id=$1", [first.followupId]))[0].appointment_id).toBeNull();
  await expect(save(f.input, reception)).rejects.toMatchObject({ code: "FOLLOWUP_SOURCE_CHANGED" });
  await q("INSERT INTO appointments(id,patient_id,scheduled_date,scheduled_time,status,created_at) VALUES ($1,$2,'2000-01-01','10:00','no_show','2020-01-01T00:00:00.123456Z')", [f.input.appointmentId, f.patientId]);
  await expect(save(f.input, reception)).rejects.toMatchObject({ code: "FOLLOWUP_SOURCE_CHANGED" });
  await expect(q("UPDATE appointment_followup_links SET appointment_id=$2 WHERE followup_id=$1", [first.followupId, f.input.appointmentId])).rejects.toThrow("immutable");
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
  expect(await q(`SELECT conname FROM pg_constraint WHERE contype='f' AND confrelid IN ('patients'::regclass,'appointments'::regclass,'appointment_followup_links'::regclass)
    AND conrelid IN ('appointment_followups'::regclass,'appointment_followup_events'::regclass,'appointment_followup_receipts'::regclass)`)).toEqual([]);
});
it("audit failure rolls back task, event and receipt and leaves source untouched", async () => {
  const f = await fixture(); const before = await fingerprint(); const followupBefore = await followupSnapshot();
  await q(`CREATE FUNCTION synthetic_fail_followup_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.entity='appointment_followup' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_fail_followup_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_fail_followup_audit()`);
  try { await expect(save(f.input, reception)).rejects.toThrow("synthetic audit failure"); }
  finally { await q("DROP TRIGGER synthetic_fail_followup_audit ON audit_log; DROP FUNCTION synthetic_fail_followup_audit()"); }
  expect(await q("SELECT id FROM appointment_followups WHERE source_appointment_id=$1", [f.input.appointmentId])).toEqual([]);
  expect(await q("SELECT event_id FROM appointment_followup_receipts WHERE actor_user_id=$1 AND request_id=$2", [reception.userId, f.input.requestId])).toEqual([]);
  expect(await fingerprint()).toEqual(before);
  expect(await followupSnapshot()).toEqual(followupBefore);
});

it("missing live link never reconstructs context or recreates a link on save/replay", async () => {
  const f = await fixture(); const first = await save(f.input, reception);
  await q("DELETE FROM appointment_followup_links WHERE followup_id=$1", [first.followupId]);
  const before = await followupSnapshot();
  expect((await queue(reception)).items.find(row => row.id === first.followupId)).toMatchObject({
    sourceState: "source_unavailable_review_required", contactBlocked: true, sourceIdentity: null,
  });
  await expect(save(f.input, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_SOURCE_CHANGED" });
  await expect(save({ ...f.input, expectedRevision: 1, requestId: f.input.requestId + "-missing" }, reception))
    .rejects.toMatchObject({ status: 409, code: "FOLLOWUP_SOURCE_CHANGED" });
  await expect(q("INSERT INTO appointment_followup_links(followup_id,appointment_id,patient_id) VALUES ($1,$2,$3)",
    [first.followupId, f.input.appointmentId, f.patientId])).rejects.toThrow("immutable");
  expect(await followupSnapshot()).toEqual(before);
});

it("canonical reset retains nonempty generation history, wipes links and rejects reused-ID intent", async () => {
  const f = await fixture(); const first = await save(f.input, reception);
  const unsaved = await fixture();
  const before = await followupSnapshot();
  const { RESET_WIPE_TABLES, RESET_KEEP_TABLES } = await import("../../lib/clinic-reset");
  expect(RESET_WIPE_TABLES).toContain("appointment_followup_links");
  for (const table of ["appointment_followups", "appointment_followup_events", "appointment_followup_receipts"]) {
    expect(RESET_KEEP_TABLES).toContain(table);
    expect(RESET_WIPE_TABLES).not.toContain(table);
  }
  const reset = await db.resetClinicData({ actor: "synthetic-reset", actorRole: "admin" },
    async () => ({ ok: true, backupId: "synthetic-followup-reset" }));
  expect(reset.ok).toBe(true);
  const after = await followupSnapshot();
  expect(after).toEqual({ ...before, appointment_followup_links: [] });
  const [generation] = await q(`SELECT ${PLANNED_REBOOK_GENERATION_SQL} AS value`);
  expect(generation.value).not.toBe(f.input.generation);
  expect((await queue(reception)).items).toEqual([]);
  // Reuse both identities AND the exact source timestamp, in the new generation.
  for (const old of [f, unsaved]) {
    await q("INSERT INTO patients(id,patient_number,full_name) VALUES ($1,$2,'Synthetic reused identity')",
      [old.patientId, `SYN-REUSED-${old.patientId}`]);
    await q(`INSERT INTO appointments(id,patient_id,scheduled_date,scheduled_time,status,created_at)
      VALUES ($1,$2,'2000-01-01','10:00','no_show','2020-01-01T00:00:00.123456Z')`, [old.input.appointmentId, old.patientId]);
    await expect(save(old.input, reception)).rejects.toMatchObject({ status: 409, code: "FOLLOWUP_GENERATION_CHANGED" });
  }
  expect(await followupSnapshot()).toEqual(after);
  const fresh = await context(f.input.appointmentId, reception);
  const next = await save({ ...f.input, ...fresh, requestId: f.input.requestId + "-new-generation" }, reception);
  expect(next.followupId).not.toBe(first.followupId);
  expect(await q("SELECT followup_id FROM appointment_followup_links WHERE followup_id=$1", [first.followupId])).toEqual([]);
  expect((await queue(reception)).items.map(row => row.id)).toEqual([next.followupId]);
  expect(await q("SELECT revision FROM appointment_followup_events WHERE followup_id=$1", [first.followupId])).toEqual([{ revision: 1 }]);
  // Explicit IDs above must not affect subsequent synthetic fixtures.
  await q("SELECT setval(pg_get_serial_sequence('patients','id'),(SELECT max(id) FROM patients))");
  await q("SELECT setval(pg_get_serial_sequence('appointments','id'),(SELECT max(id) FROM appointments))");
});

it("canonical reset failure after truncate rolls back links, history, sources and generation", async () => {
  const f = await fixture(); await save(f.input, reception);
  const before = await followupSnapshot(); const clinicalBefore = await fingerprint();
  const generationBefore = await q(`SELECT ${PLANNED_REBOOK_GENERATION_SQL} AS value`);
  const patientsBefore = await q("SELECT to_jsonb(p) AS value FROM patients p ORDER BY id");
  await q(`CREATE FUNCTION synthetic_fail_followup_reset() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='system.reset' THEN RAISE EXCEPTION 'synthetic reset audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_fail_followup_reset BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_fail_followup_reset()`);
  try {
    await expect(db.resetClinicData({ actor: "synthetic-reset", actorRole: "admin" },
      async () => ({ ok: true, backupId: "synthetic-rollback" }))).rejects.toThrow("synthetic reset audit failure");
  } finally { await q("DROP TRIGGER synthetic_fail_followup_reset ON audit_log; DROP FUNCTION synthetic_fail_followup_reset()"); }
  expect(await followupSnapshot()).toEqual(before);
  expect(await fingerprint()).toEqual(clinicalBefore);
  expect(await q("SELECT to_jsonb(p) AS value FROM patients p ORDER BY id")).toEqual(patientsBefore);
  expect(await q(`SELECT ${PLANNED_REBOOK_GENERATION_SQL} AS value`)).toEqual(generationBefore);
  expect(await save(f.input, reception)).toMatchObject({ replayed: true });
});
