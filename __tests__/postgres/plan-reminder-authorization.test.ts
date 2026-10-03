import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import type { PlanReminderActor } from "../../lib/plan-reminders";
import type { QueryResult } from "../../lib/db";

// This suite may reset only the explicitly guarded, disposable PostgreSQL18 target.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
// The original environment was guarded above, before any test-only normalization.
// CI supplies a guarded URL but may omit this optional classification.
process.env.DATABASE_ENVIRONMENT ??= "test";
// The shared stub clears this flag; these fixtures intentionally require no seed data.
process.env.SKIP_SEED = "true";
process.env.SESSION_SECRET ??= "plan-reminder-synthetic-test-secret-0123456789";
const db = await import("../../lib/db");
const { sessionCredentialVersion } = await import("../../lib/auth");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;
const passwordHash = "synthetic-reminder-credential-hash";
let doctor = 0;
let userId = 0;
let serial = 0;
let actor: PlanReminderActor;
const sources = ["plan", "visit", "planned", "patient", "appointment", "referral"] as const;
type Source = typeof sources[number];
type Fixture = { patientId: number; planId: number; witnessId?: number; revokeSql: string; revokeValues: unknown[] };
const save = (planIds: number[], who = actor) => db.recordPlanInstallmentReminder({ actor: who, target: { kind: "bulk", planIds } });
async function fixture(source?: Source): Promise<Fixture> {
  const patientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic reminder patient') RETURNING id`,
    [`REMINDER-${++serial}`]))[0].id;
  const planId = (await q<{ id: number }>(`INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, 'Reminder target', 3000) RETURNING id`, [patientId]))[0].id;
  await q(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
    VALUES ($1, 1, CURRENT_DATE - 1, 1000), ($1, 2, CURRENT_DATE, 1000), ($1, 3, CURRENT_DATE + 1, 1000)`, [planId]);
  const result: Fixture = { patientId, planId, revokeSql: "", revokeValues: [] };
  if (source === "plan") {
    result.witnessId = (await q<{ id: number }>(`INSERT INTO treatment_plans (patient_id, title, total_minor, primary_doctor_id)
      VALUES ($1, 'Different ownership plan', 1, $2) RETURNING id`, [patientId, doctor]))[0].id;
    result.revokeSql = "UPDATE treatment_plans SET status = 'cancelled' WHERE id = $1";
  } else if (source === "visit") {
    result.witnessId = (await q<{ id: number }>(`INSERT INTO visits (patient_id, patient_name, doctor_id) VALUES ($1, 'Reminder visit', $2) RETURNING id`, [patientId, doctor]))[0].id;
    result.revokeSql = "UPDATE visits SET doctor_id = NULL WHERE id = $1";
  } else if (source === "planned") {
    result.witnessId = (await q<{ id: number }>(`INSERT INTO planned_visits (patient_id, plan_id, sequence, title, doctor_id)
      VALUES ($1, $2, 1, 'Reminder planned visit', $3) RETURNING id`, [patientId, planId, doctor]))[0].id;
    result.revokeSql = "UPDATE planned_visits SET doctor_id = NULL WHERE id = $1";
  } else if (source === "patient") {
    await q("UPDATE patients SET primary_doctor_id = $2 WHERE id = $1", [patientId, doctor]);
    result.witnessId = patientId;
    result.revokeSql = "UPDATE patients SET primary_doctor_id = NULL WHERE id = $1";
  } else if (source === "appointment") {
    result.witnessId = (await q<{ id: number }>(`INSERT INTO appointments (patient_id, doctor_id, scheduled_date, scheduled_time)
      VALUES ($1, $2, CURRENT_DATE, '10:00') RETURNING id`, [patientId, doctor]))[0].id;
    result.revokeSql = "UPDATE appointments SET doctor_id = NULL WHERE id = $1";
  } else if (source === "referral") {
    result.witnessId = (await q<{ id: number }>(`INSERT INTO patient_referrals
      (patient_id, to_name, to_specialty, reason, kind, to_party_id, workflow_state, created_by)
      VALUES ($1, 'Reminder receiver', 'general', 'Synthetic reason', 'internal', $2, 'requested', 'fixture') RETURNING id`, [patientId, doctor]))[0].id;
    result.revokeSql = `UPDATE patient_referrals SET workflow_state = 'cancelled', status = 'cancelled',
      closed_at = NOW(), outcome_note = 'Synthetic cancellation' WHERE id = $1`;
  }
  result.revokeValues = [result.witnessId];
  return result;
}
async function snapshot(ids: number[]) {
  return (await q<{ data: unknown }>(`SELECT jsonb_build_object(
    'plans', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM treatment_plans t WHERE id = ANY($1::int[])),
    'installments', (SELECT jsonb_agg(to_jsonb(i) ORDER BY plan_id, number) FROM plan_installments i WHERE plan_id = ANY($1::int[])),
    'audits', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a
      WHERE action = 'plan.installment_reminder' AND entity_id = ANY($2::text[]))) AS data`, [ids, ids.map(String)]))[0].data;
}
beforeAll(async () => {
  // Revalidate after shared setup, immediately before any destructive test fixture.
  expect(process.env.NODE_ENV).toBe("test");
  expect(process.env.DATABASE_ENVIRONMENT).toBe("test");
  expect(process.env.SKIP_SEED).toBe("true");
  expect(validatePostgresTestTarget(process.env).testUrl.toString()).toBe(target.testUrl.toString());
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  doctor = (await q<{ id: number }>("INSERT INTO parties (kind, name) VALUES ('doctor', 'Reminder doctor') RETURNING id"))[0].id;
  userId = (await q<{ id: number }>(`INSERT INTO users (username, display_name, password_hash, role, party_id)
    VALUES ('reminder-actor', 'Reminder actor', $1, 'doctor', $2) RETURNING id`, [passwordHash, doctor]))[0].id;
  actor = { userId, username: "reminder-actor", role: "doctor", credentialVersion: sessionCredentialVersion(passwordHash) };
});
beforeEach(async () => {
  await q(`UPDATE users SET username = 'reminder-actor', role = 'doctor', is_active = TRUE,
    party_id = $2, password_hash = $3, permissions = NULL WHERE id = $1`, [userId, doctor, passwordHash]);
  await q("UPDATE parties SET is_active = TRUE, kind = 'doctor' WHERE id = $1", [doctor]);
});
afterAll(async () => { vi.restoreAllMocks(); await db.resetPoolForTesting(); });

describe("fresh authority, canonical ownership and atomic stamping on real PostgreSQL", () => {
  it.each(sources)("preserves both ownership readers and reminder authorization via %s", async (source) => {
    const f = await fixture(source);
    const foreign = await fixture();
    expect(await db.doctorOwnsPatient(doctor, f.patientId)).toBe(true);
    expect(await db.doctorOwnedPatientIds(doctor, [f.patientId, foreign.patientId])).toEqual(new Set([f.patientId]));
    expect(await save([f.planId])).toMatchObject({ ok: true, updatedCount: 1 });
    await q(f.revokeSql, f.revokeValues);
    expect(await db.doctorOwnsPatient(doctor, f.patientId)).toBe(false);
    expect(await db.doctorOwnedPatientIds(doctor, [f.patientId, foreign.patientId])).toEqual(new Set());
    const before = await snapshot([f.planId]);
    expect(await save([f.planId])).toMatchObject({ ok: false, status: 403 });
    expect(await snapshot([f.planId])).toEqual(before);
  });
  it.each(["declined", "cancelled"])("excludes %s referrals while completed history still owns", async (state) => {
    const f = await fixture("referral");
    await q(`UPDATE patient_referrals SET workflow_state = 'completed', status = 'completed', closed_at = NOW() WHERE id = $1`, [f.witnessId]);
    expect(await db.doctorOwnsPatient(doctor, f.patientId)).toBe(true);
    await q(`UPDATE patient_referrals SET workflow_state = $2, status = 'cancelled', outcome_note = 'Synthetic close' WHERE id = $1`, [f.witnessId, state]);
    expect(await db.doctorOwnedPatientIds(doctor, [f.patientId])).toEqual(new Set());
    expect(await save([f.planId])).toMatchObject({ ok: false, status: 403 });
  });
  it("does not let canViewAllPatients widen writes or require money-read permission", async () => {
    const own = await fixture("patient");
    const foreign = await fixture();
    await q(`UPDATE users SET permissions = '{"canEditPlans":true,"canViewAllPatients":true,"canViewMoney":false}' WHERE id = $1`, [userId]);
    expect(await save([own.planId])).toMatchObject({ ok: true });
    const before = await snapshot([own.planId, foreign.planId]);
    expect(await save([own.planId, foreign.planId])).toMatchObject({ ok: false, status: 403 });
    expect(await snapshot([own.planId, foreign.planId])).toEqual(before);
  });
  it.each(["admin", "reception"])("keeps %s eligible without a doctor linkage or plan-edit grant", async (role) => {
    const f = await fixture();
    for (const permissions of [null, "", "{", '{"canEditPlans":false}', '{"canEditPlans":"true"}',
      '{"schemaVersion":1,"revision":1,"patientScope":"none","appointmentScope":"none","grants":{}}']) {
      await q(`UPDATE users SET role = $2, party_id = NULL, permissions = $3 WHERE id = $1`, [userId, role, permissions]);
      expect(await save([f.planId], { ...actor, role })).toMatchObject({ ok: true });
    }
  });
  it.each([
    ["permissions = '{\"canEditPlans\":false}'", 403], ["permissions = '{'", 403],
    ["permissions = '{\"canEditPlans\":\"true\"}'", 403], ["permissions = '[]'", 403],
    ["permissions = '{\"schemaVersion\":1}'", 403],
    ["permissions = '{\"schemaVersion\":1,\"revision\":1,\"patientScope\":\"all\",\"appointmentScope\":\"all\",\"grants\":{\"clinical.plans.view\":true,\"clinical.plans.edit\":true}}'", 403],
    ["party_id = NULL", 403],
    ["is_active = FALSE", 401], ["role = 'reception'", 401], ["username = 'renamed-reminder'", 401],
    ["password_hash = 'changed'", 401],
  ])("rejects current account change %s before writes", async (change, status) => {
    const f = await fixture("patient");
    const before = await snapshot([f.planId]);
    await q(`UPDATE users SET ${change} WHERE id = $1`, [userId]);
    expect(await save([f.planId])).toMatchObject({ ok: false, status });
    expect(await snapshot([f.planId])).toEqual(before);
  });
  it.each(["is_active = FALSE", "kind = 'supplier'"])("requires a current active doctor party: %s", async (change) => {
    const f = await fixture("patient");
    const before = await snapshot([f.planId]);
    await q(`UPDATE parties SET ${change} WHERE id = $1`, [doctor]);
    expect(await save([f.planId])).toMatchObject({ ok: false, status: 403 });
    expect(await snapshot([f.planId])).toEqual(before);
  });
  it("rejects malformed internal target/actor and stale credential snapshots", async () => {
    const f = await fixture("patient");
    const before = await snapshot([f.planId]);
    expect(await db.recordPlanInstallmentReminder({ actor, target: { kind: "bulk", planIds: [f.planId, 0] } })).toMatchObject({ ok: false, status: 400 });
    expect(await db.recordPlanInstallmentReminder({ actor, target: { kind: "single", planId: f.planId, installmentNumber: -1 } })).toMatchObject({ ok: false, status: 400 });
    for (const who of [{ ...actor, credentialVersion: undefined }, { ...actor, userId: 2147483647 }, { ...actor, credentialVersion: "old" }]) {
      expect(await save([f.planId], who)).toMatchObject({ ok: false, status: 401 });
    }
    expect(await snapshot([f.planId])).toEqual(before);
  });
  it("rejects a missing batch target or explicit installment before any stamp/audit", async () => {
    const f = await fixture("patient");
    const before = await snapshot([f.planId]);
    expect(await save([f.planId, 2147483647])).toMatchObject({ ok: false, status: 404 });
    expect(await db.recordPlanInstallmentReminder({ actor, target: { kind: "single", planId: f.planId, installmentNumber: 99 } })).toMatchObject({ ok: false, status: 404 });
    expect(await snapshot([f.planId])).toEqual(before);
  });
  it("deduplicates audits/count and gives all due rows and plans exactly one timestamp", async () => {
    const a = await fixture("patient"); const b = await fixture("patient");
    const result = await save([b.planId, a.planId, b.planId]);
    expect(result).toMatchObject({ ok: true, updatedCount: 2 });
    if (!result.ok) throw new Error(result.message);
    const plans = await q<{ stamp: string }>("SELECT last_reminder_at AS stamp FROM treatment_plans WHERE id = ANY($1::int[])", [[a.planId, b.planId]]);
    expect(plans.map((row) => new Date(row.stamp).toISOString())).toEqual([result.lastReminderAt, result.lastReminderAt]);
    const rows = await q<{ number: number; stamp: string | null }>("SELECT number, last_reminder_at AS stamp FROM plan_installments WHERE plan_id = ANY($1::int[]) ORDER BY plan_id, number", [[a.planId, b.planId]]);
    expect(rows.map((r) => r.stamp ? new Date(r.stamp).toISOString() : null)).toEqual([result.lastReminderAt, result.lastReminderAt, null, result.lastReminderAt, result.lastReminderAt, null]);
    const audits = await q<{ entity_id: string; actor: string; details: unknown }>("SELECT entity_id, actor, details FROM audit_log WHERE action = 'plan.installment_reminder' AND entity_id = ANY($1::text[]) ORDER BY entity_id", [[a.planId, b.planId].map(String)]);
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => row.actor === actor.username)).toBe(true);
    expect(audits.map((row) => row.details)).toEqual([{ جماعي: true }, { جماعي: true }]);
  });
  it("an explicit future installment remains eligible without stamping other installments", async () => {
    const f = await fixture("patient");
    expect(await db.recordPlanInstallmentReminder({ actor, target: { kind: "single", planId: f.planId, installmentNumber: 3 } })).toMatchObject({ ok: true });
    expect((await q<{ number: number }>("SELECT number FROM plan_installments WHERE plan_id = $1 AND last_reminder_at IS NOT NULL", [f.planId])).map((row) => row.number)).toEqual([3]);
  });
  it.each(["installment", "audit"])("rolls back the whole batch when a later %s write throws", async (failure) => {
    const a = await fixture("patient"); const b = await fixture("patient");
    const before = await snapshot([a.planId, b.planId]);
    const table = failure === "audit" ? "audit_log" : "plan_installments";
    const condition = failure === "audit"
      ? `NEW.action = 'plan.installment_reminder' AND NEW.entity_id = '${b.planId}'`
      : `NEW.plan_id = ${b.planId}`;
    await q(`CREATE FUNCTION reject_reminder_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'synthetic reminder failure'; END IF; RETURN NEW; END $$`);
    await q(`CREATE TRIGGER reject_reminder_write BEFORE ${failure === "audit" ? "INSERT" : "UPDATE"} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION reject_reminder_write()`);
    try {
      await expect(save([a.planId, b.planId])).rejects.toThrow("synthetic reminder failure");
      expect(await snapshot([a.planId, b.planId])).toEqual(before);
    } finally {
      await q(`DROP TRIGGER reject_reminder_write ON ${table}`); await q("DROP FUNCTION reject_reminder_write()");
    }
  });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function pauseTransaction(afterSql: RegExp) {
  const paused = deferred(); const release = deferred(); let stopped = false; let pid = 0;
  const pool = db.getPool(); const connect = pool.connect.bind(pool);
  const spy = vi.spyOn(pool, "connect").mockImplementation(async (...args: unknown[]) => {
    if (args.length > 0) return Reflect.apply(connect, pool, args);
    const client = await connect(); const query = client.query.bind(client);
    pid = (await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
      const result = await query<T>(sql, values);
      if (!stopped && afterSql.test(sql)) { stopped = true; paused.resolve(); await release.promise; }
      return result;
    }, release: () => client.release() };
  });
  return { paused, release, spy, pid: () => pid };
}
async function connection() {
  const client = new Client({ connectionString: target.testUrl.toString(), ssl: false });
  await client.connect(); await client.query("SET statement_timeout = '15s'"); return client;
}
async function blocked(observer: Client, blockingPid: number) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const { rows: [row] } = await observer.query<{ blocked: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS blocked`, [blockingPid]);
    if (row.blocked) return;
    await new Promise<void>((done) => setImmediate(done));
  }
  throw new Error("Expected actual PostgreSQL row-lock contention");
}
async function barrier(gate: ReturnType<typeof pauseTransaction>, saving: Promise<unknown>) {
  await Promise.race([gate.paused.promise, saving.then(() => { throw new Error("Reminder ended before the expected SQL barrier"); })]);
}

describe("real two-connection reminder authorization races", () => {
  it.each(sources)("held %s ownership revocation returns409, then committed revocation denies without writes", async (source) => {
    const f = await fixture(source); const before = await snapshot([f.planId]); const revoker = await connection();
    try {
      await revoker.query("BEGIN"); await revoker.query(f.revokeSql, f.revokeValues);
      expect(await save([f.planId])).toMatchObject({ ok: false, status: 409 });
      expect(await snapshot([f.planId])).toEqual(before);
      await revoker.query("COMMIT");
      expect(await save([f.planId])).toMatchObject({ ok: false, status: 403 });
      expect(await snapshot([f.planId])).toEqual(before);
    } finally { await revoker.query("ROLLBACK"); await revoker.end(); }
  });
  it.each(sources)("an accepted reminder holds its %s witness until commit before revocation", async (source) => {
    const f = await fixture(source); const gate = pauseTransaction(/SELECT id FROM plan_installments/);
    const revoker = await connection(); const observer = await connection();
    const saving = save([f.planId]); let revoking: Promise<unknown> | undefined;
    try {
      await barrier(gate, saving);
      revoking = revoker.query(f.revokeSql, f.revokeValues);
      await blocked(observer, gate.pid());
      gate.release.resolve(); expect(await saving).toMatchObject({ ok: true }); await revoking;
      expect(await save([f.planId])).toMatchObject({ ok: false, status: 403 });
    } finally { gate.release.resolve(); await saving.catch(() => {}); await revoking?.catch(() => {}); gate.spy.mockRestore(); await revoker.end(); await observer.end(); }
  });
  it.each([
    ["permission", "UPDATE users SET permissions = '{\"canEditPlans\":false}' WHERE id = $1", () => userId, 403],
    ["link", "UPDATE users SET party_id = NULL WHERE id = $1", () => userId, 403],
    ["credential", "UPDATE users SET password_hash = 'changed' WHERE id = $1", () => userId, 401],
    ["party", "UPDATE parties SET is_active = FALSE WHERE id = $1", () => doctor, 403],
  ] as const)("serializes a concurrent %s revocation after accepted authority", async (_name, sql, id, status) => {
    const f = await fixture("patient"); const gate = pauseTransaction(/SELECT id FROM plan_installments/);
    const revoker = await connection(); const observer = await connection(); const saving = save([f.planId]); let revoking: Promise<unknown> | undefined;
    try {
      await barrier(gate, saving); revoking = revoker.query(sql, [id()]); await blocked(observer, gate.pid());
      gate.release.resolve(); expect(await saving).toMatchObject({ ok: true }); await revoking;
      expect(await save([f.planId])).toMatchObject({ ok: false, status });
    } finally { gate.release.resolve(); await saving.catch(() => {}); await revoking?.catch(() => {}); gate.spy.mockRestore(); await revoker.end(); await observer.end(); }
  });
  it.each([
    ["permission", "UPDATE users SET permissions = '{\"canEditPlans\":false}' WHERE id = $1", () => userId, 403],
    ["link", "UPDATE users SET party_id = NULL WHERE id = $1", () => userId, 403],
    ["credential", "UPDATE users SET password_hash = 'changed' WHERE id = $1", () => userId, 401],
    ["party", "UPDATE parties SET is_active = FALSE WHERE id = $1", () => doctor, 403],
  ] as const)("an already-held %s revocation yields409, then current denial after its commit", async (_name, sql, id, status) => {
    const f = await fixture("patient"); const before = await snapshot([f.planId]); const revoker = await connection();
    try {
      await revoker.query("BEGIN"); await revoker.query(sql, [id()]);
      expect(await save([f.planId])).toMatchObject({ ok: false, status: 409 });
      expect(await snapshot([f.planId])).toEqual(before); await revoker.query("COMMIT");
      expect(await save([f.planId])).toMatchObject({ ok: false, status }); expect(await snapshot([f.planId])).toEqual(before);
    } finally { await revoker.query("ROLLBACK"); await revoker.end(); }
  });
  it("holds the target plan mapping through commit before a patient reassignment", async () => {
    const own = await fixture("patient"); const foreign = await fixture();
    const gate = pauseTransaction(/SELECT id FROM plan_installments/); const mover = await connection(); const observer = await connection();
    const saving = save([own.planId]); let moving: Promise<unknown> | undefined;
    try {
      await barrier(gate, saving);
      moving = mover.query("UPDATE treatment_plans SET patient_id = $2 WHERE id = $1", [own.planId, foreign.patientId]);
      await blocked(observer, gate.pid()); gate.release.resolve(); expect(await saving).toMatchObject({ ok: true }); await moving;
      expect(await save([own.planId])).toMatchObject({ ok: false, status: 403 });
    } finally { gate.release.resolve(); await saving.catch(() => {}); await moving?.catch(() => {}); gate.spy.mockRestore(); await mover.end(); await observer.end(); }
  });
  it("the actual patient merger waits for a fully committed reminder before moving children", async () => {
    const own = await fixture("patient"); const destination = await fixture();
    const gate = pauseTransaction(/SELECT id FROM plan_installments/); const observer = await connection();
    const saving = save([own.planId]); let merging: ReturnType<typeof db.mergeDuplicatePatient> | undefined;
    try {
      await barrier(gate, saving); const reminderPid = gate.pid();
      merging = db.mergeDuplicatePatient(own.patientId, destination.patientId, { actor: "synthetic-reminder-merge", actorRole: "admin" });
      await blocked(observer, reminderPid); gate.release.resolve(); expect(await saving).toMatchObject({ ok: true });
      expect(await merging).toMatchObject({ ok: true });
      expect((await q<{ patient_id: number; last_reminder_at: unknown }>("SELECT patient_id, last_reminder_at FROM treatment_plans WHERE id = $1", [own.planId]))[0])
        .toMatchObject({ patient_id: destination.patientId, last_reminder_at: expect.any(Date) });
      expect(await q("SELECT id FROM patients WHERE id = $1", [own.patientId])).toEqual([]);
    } finally { gate.release.resolve(); await saving.catch(() => {}); await merging?.catch(() => {}); gate.spy.mockRestore(); await observer.end(); }
  });
  it("does not follow a plan to a new patient discovered after its preview", async () => {
    const own = await fixture("patient"); const foreign = await fixture();
    const gate = pauseTransaction(/SELECT id, patient_id FROM treatment_plans WHERE id = ANY.*ORDER BY id$/);
    const mover = await connection(); const saving = save([own.planId]);
    try {
      await barrier(gate, saving);
      await mover.query("UPDATE treatment_plans SET patient_id = $2 WHERE id = $1", [own.planId, foreign.patientId]);
      const before = await snapshot([own.planId]); gate.release.resolve();
      expect(await saving).toMatchObject({ ok: false, status: 409 });
      expect(await snapshot([own.planId])).toEqual(before);
    } finally { gate.release.resolve(); await saving.catch(() => {}); gate.spy.mockRestore(); await mover.end(); }
  });
  it("merge/delete-style patient locks and locked later installments return409 with no earlier writes", async () => {
    const a = await fixture("patient"); const b = await fixture("patient"); const blocker = await connection();
    const before = await snapshot([a.planId, b.planId]);
    try {
      for (const sql of ["SELECT id FROM patients WHERE id = $1 FOR UPDATE", "SELECT id FROM plan_installments WHERE plan_id = $1 AND number = 1 FOR UPDATE"]) {
        await blocker.query("BEGIN"); await blocker.query(sql, [sql.includes("patients") ? b.patientId : b.planId]);
        expect(await save([a.planId, b.planId])).toMatchObject({ ok: false, status: 409 });
        expect(await snapshot([a.planId, b.planId])).toEqual(before); await blocker.query("ROLLBACK");
      }
      // A prior409 has released its own earlier locks; a normal retry is possible.
      expect(await save([a.planId, b.planId])).toMatchObject({ ok: true });
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
  });
  it("overlapping reversed batches fail closed under contention and retry as whole batches", async () => {
    const a = await fixture("patient"); const b = await fixture("patient");
    const before = await snapshot([a.planId, b.planId]); const gate = pauseTransaction(/SELECT id FROM plan_installments/);
    const first = save([b.planId, a.planId]);
    try {
      await barrier(gate, first);
      expect(await save([a.planId, b.planId])).toMatchObject({ ok: false, status: 409 });
      expect(await snapshot([a.planId, b.planId])).toEqual(before);
      gate.release.resolve(); expect(await first).toMatchObject({ ok: true, updatedCount: 2 });
      expect(await save([a.planId, b.planId])).toMatchObject({ ok: true, updatedCount: 2 });
    } finally { gate.release.resolve(); await first.catch(() => {}); gate.spy.mockRestore(); }
  });
});
