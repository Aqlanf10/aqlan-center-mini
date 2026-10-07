import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbClient, DbPool, QueryResult } from "../../lib/db";
import { createSessionToken, sessionCredentialVersion } from "../../lib/auth";
import { createPeriodontalDomain } from "../../lib/periodontal-db";
import { emptyPeriodontalSites } from "../../lib/periodontal";
import { openPeriodontalFixture } from "./_periodontal-fixture";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: request.token }) }),
  headers: async () => ({ get: () => null }) }));
import { requireSession } from "../../lib/session";
import { canAccessPatient } from "../../lib/patient-access";

// CI-only real PostgreSQL in a fresh owned fixture. The request-cookie transport is
// synthetic; actual signed-token/session/access owners, SQL locks and audit execute.
// This is not a registered production route/adapter or activation acceptance.
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let serial = 0;
const pool = () => fixture.pool;
const passwordHash = "synthetic-periodontal-auth-hash";
const next = () => `perio-auth-${++serial}`;
async function setup(allPatients = false) {
  const name = next();
  const { rows: [doctor] } = await pool().query<{ id: number }>(
    "INSERT INTO parties (kind,name,is_active) VALUES ('doctor',$1,true) RETURNING id", [name]);
  const { rows: [other] } = await pool().query<{ id: number }>(
    "INSERT INTO parties (kind,name,is_active) VALUES ('doctor',$1,true) RETURNING id", [name + "-other"]);
  const { rows: [user] } = await pool().query<{ id: number }>(`INSERT INTO users
    (username,display_name,password_hash,role,is_active,party_id,permissions)
    VALUES ($1,$1,$2,'doctor',true,$3,$4) RETURNING id`,
  [name, passwordHash, doctor.id, JSON.stringify({ canViewAllPatients: allPatients })]);
  const { rows: [patient] } = await pool().query<{ id: number }>(
    "INSERT INTO patients (patient_number,full_name) VALUES ($1,$1) RETURNING id", [name]);
  request.token = createSessionToken({ userId: user.id, username: name, role: "doctor", partyId: doctor.id,
    expiresAt: Date.now() + 60_000, credentialVersion: sessionCredentialVersion(passwordHash) });
  return { username: name, userId: user.id, doctorId: doctor.id, otherId: other.id, patientId: patient.id };
}
type Scope = Awaited<ReturnType<typeof setup>>;
const draft = () => {
  const sites = emptyPeriodontalSites(); sites[0].depthMm = "3";
  return { toothCode: 16, expectedHeadId: null, requestKey: next(), sites };
};
async function state(patientId: number) {
  return {
    records: (await pool().query("SELECT * FROM periodontal_records WHERE patient_id=$1 ORDER BY id", [patientId])).rows,
    sites: (await pool().query(`SELECT s.* FROM periodontal_sites s JOIN periodontal_records r ON r.id=s.record_id
      WHERE r.patient_id=$1 ORDER BY s.record_id,s.surface,s.position`, [patientId])).rows,
    audits: (await pool().query("SELECT * FROM audit_log WHERE action='perio.record' AND entity_id=$1 ORDER BY id", [String(patientId)])).rows,
  };
}
function gate() { let resolve!: () => void; let isOpen = false; const promise = new Promise<void>((done) => { resolve = done; });
  return { open: () => { isOpen = true; resolve(); }, promise, get isOpen() { return isOpen; } }; }
const observe = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
function unwrap<T>(result: { value: T } | { error: unknown }): T { if ("error" in result) throw result.error; return result.value; }
async function until(check: () => Promise<boolean>, label: string) {
  const end = performance.now() + 6_000;
  while (performance.now() < end) { if (await check()) return; await delay(10); }
  throw new Error(`Authorization lock witness timed out: ${label}`);
}
function subject(afterAuthorization?: () => Promise<void>, lockTimeout = "8s", failAudit = false) {
  const pids: number[] = []; const authorizedClients: DbClient[] = []; const auditClients: DbClient[] = [];
  const source: DbPool = {
    query: async () => { throw new Error("Authorization/domain unexpectedly escaped the transaction client"); },
    async connect() {
      const client = await pool().connect(); const query = client.query.bind(client);
      try { pids.push((await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid); }
      catch (error) { client.release(); throw error; }
      return {
        async query<T>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
          const result = await query<T>(sql, values);
          if (sql === "BEGIN") {
            await query("SET LOCAL statement_timeout='8s'");
            await query("SELECT set_config('lock_timeout',$1,true)", [lockTimeout]);
          }
          return result;
        }, release: () => client.release(),
      };
    },
  };
  const domain = createPeriodontalDomain({ pool: source,
    async authorizePatient(client, patientId) {
      authorizedClients.push(client);
      const session = await requireSession(client);
      if (!session || !await canAccessPatient(session, patientId, undefined, client)) return null;
      if (afterAuthorization) await afterAuthorization();
      return session;
    },
    async insertAudit(client, input) {
      expect(authorizedClients).toContain(client); auditClients.push(client);
      await fixture.db.insertAuditRow(client, input);
      if (failAudit) throw new Error("synthetic post-audit failure");
    },
  });
  return { domain, pids, authorizedClients, auditClients };
}
async function primary(s: Scope) { await pool().query("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [s.patientId, s.doctorId]); }
async function visit(s: Scope) {
  return (await pool().query<{ id: number }>(`INSERT INTO visits (patient_id,patient_name,doctor_id)
    VALUES ($1,'synthetic',$2) RETURNING id`, [s.patientId, s.doctorId])).rows[0].id;
}
async function transactionClient() {
  const client = await pool().connect(); await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout='8s'");
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  return { client, pid };
}
async function isBlocked(pid: number, blocker: number) {
  return (await pool().query<{ blocked: boolean }>("SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked", [pid, blocker])).rows[0].blocked;
}
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "isolated-periodontal-auth-32-character-secret");
  fixture = await openPeriodontalFixture();
});
afterAll(async () => { try { await fixture?.close(); } finally { vi.unstubAllEnvs(); } });

describe("canonical transactional periodontal authorization, isolated real PostgreSQL", () => {
  const accountChanges = ["deactivate", "role", "credential", "relink", "permission"] as const;
  async function changeAccount(client: DbClient, s: Scope, kind: typeof accountChanges[number]) {
    if (kind === "deactivate") return client.query("UPDATE users SET is_active=false WHERE id=$1", [s.userId]);
    if (kind === "role") return client.query("UPDATE users SET role='assistant' WHERE id=$1", [s.userId]);
    if (kind === "credential") return client.query("UPDATE users SET password_hash='changed-synthetic-hash' WHERE id=$1", [s.userId]);
    if (kind === "relink") return client.query("UPDATE users SET party_id=$2 WHERE id=$1", [s.userId, s.otherId]);
    return client.query("UPDATE users SET permissions=$2 WHERE id=$1", [s.userId, JSON.stringify({ canViewAllPatients: false })]);
  }
  it.each(accountChanges)("denies %s committed before the account lock, without observation or audit", async (kind) => {
    const s = await setup(kind === "permission"); if (kind !== "permission") await primary(s);
    const before = await state(s.patientId); const blocker = await transactionClient(); const target = subject();
    let pending: ReturnType<typeof observe<Awaited<ReturnType<typeof target.domain.save>>>> | undefined;
    try {
      await changeAccount(blocker.client, s, kind);
      pending = observe(target.domain.save(s.patientId, draft()));
      await until(async () => target.pids.length === 1 && await isBlocked(target.pids[0], blocker.pid), "save waits for account updater");
      await blocker.client.query("COMMIT");
      expect(unwrap(await pending)).toMatchObject({ ok: false, reason: "denied" });
      expect(await state(s.patientId)).toEqual(before); expect(target.auditClients).toHaveLength(0);
    } finally { await blocker.client.query("ROLLBACK").catch(() => {}); blocker.client.release(); if (pending) await pending; }
  });
  it.each(accountChanges)("holds %s behind the admitted observation and denies its later replay/read", async (kind) => {
    const s = await setup(kind === "permission"); if (kind !== "permission") await primary(s);
    const admitted = gate(); const release = gate(); const target = subject(async () => { admitted.open(); await release.promise; });
    const input = draft(); const pending = observe(target.domain.save(s.patientId, input)); const updater = await transactionClient();
    let update: ReturnType<typeof observe<unknown>> | undefined;
    try {
      await until(async () => admitted.isOpen, "authorization callback reached"); update = observe(changeAccount(updater.client, s, kind));
      await until(() => isBlocked(updater.pid, target.pids[0]), "account updater waits for the same-client shared lock");
      release.open(); expect(unwrap(await pending)).toMatchObject({ ok: true, replayed: false });
      unwrap(await update); await updater.client.query("COMMIT");
      const before = await state(s.patientId); expect(before.records).toHaveLength(1); expect(before.audits).toHaveLength(1);
      expect(target.auditClients[0]).toBe(target.authorizedClients[0]);
      expect(await subject().domain.save(s.patientId, input)).toMatchObject({ reason: "denied" });
      expect(await subject().domain.read(s.patientId)).toMatchObject({ reason: "denied" });
      expect(await state(s.patientId)).toEqual(before);
    } finally { release.open(); await pending; if (update) await update; await updater.client.query("ROLLBACK").catch(() => {}); updater.client.release(); }
  });
  it.each(["relink", "delete"])("denies a last visit witness %s committed before its lock", async (kind) => {
    const s = await setup(); const id = await visit(s); const blocker = await transactionClient(); const target = subject();
    let pending: ReturnType<typeof observe<Awaited<ReturnType<typeof target.domain.save>>>> | undefined;
    try {
      await blocker.client.query(kind === "delete" ? "DELETE FROM visits WHERE id=$1" : "UPDATE visits SET doctor_id=NULL WHERE id=$1", [id]);
      pending = observe(target.domain.save(s.patientId, draft()));
      await until(async () => target.pids.length === 1 && await isBlocked(target.pids[0], blocker.pid), "visit-first updater owns the witness");
      await blocker.client.query("COMMIT"); expect(unwrap(await pending)).toMatchObject({ reason: "denied" });
      expect(await state(s.patientId)).toEqual({ records: [], sites: [], audits: [] });
    } finally { await blocker.client.query("ROLLBACK").catch(() => {}); blocker.client.release(); if (pending) await pending; }
  });
  it("holds the actual last visit witness until a successful save commits", async () => {
    const s = await setup(); const id = await visit(s); const admitted = gate(); const release = gate();
    const target = subject(async () => { admitted.open(); await release.promise; });
    const pending = observe(target.domain.save(s.patientId, draft())); const updater = await transactionClient();
    let update: ReturnType<typeof observe<unknown>> | undefined;
    try {
      await until(async () => admitted.isOpen, "authorization callback reached"); update = observe(updater.client.query("UPDATE visits SET doctor_id=NULL WHERE id=$1", [id]));
      await until(() => isBlocked(updater.pid, target.pids[0]), "visit revocation waits on granting row");
      release.open(); expect(unwrap(await pending)).toMatchObject({ ok: true }); unwrap(await update); await updater.client.query("COMMIT");
      expect(await subject().domain.read(s.patientId)).toMatchObject({ reason: "denied" });
    } finally { release.open(); await pending; if (update) await update; await updater.client.query("ROLLBACK").catch(() => {}); updater.client.release(); }
  });
  it("serializes the actual visit relink owner after a protected save and preserves observation ownership", async () => {
    const s = await setup(); const id = await visit(s);
    const { rows: [destination] } = await pool().query<{ id: number }>(
      "INSERT INTO patients (patient_number,full_name) VALUES ($1,$1) RETURNING id", [next()]);
    const admitted = gate(); const release = gate();
    const target = subject(async () => { admitted.open(); await release.promise; });
    const pending = observe(target.domain.save(s.patientId, draft()));
    let relink: ReturnType<typeof observe<Awaited<ReturnType<typeof fixture.db.linkVisitToPatient>>>> | undefined;
    try {
      await until(async () => admitted.isOpen, "authorization callback reached");
      relink = observe(fixture.db.linkVisitToPatient(id, destination.id));
      await until(async () => (await pool().query<{ count: number }>(`SELECT count(*)::int AS count
        FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))
          AND query LIKE '%SELECT signed_at, patient_id FROM visits WHERE id = $1 FOR UPDATE%'`,
      [target.pids[0]])).rows[0].count === 1, "canonical linkVisitToPatient waits on its visit-first lock");
      release.open(); expect(unwrap(await pending)).toMatchObject({ ok: true });
      expect(unwrap(await relink)).toMatchObject({ ok: true });
      expect((await pool().query<{ patient_id: number }>("SELECT patient_id FROM visits WHERE id=$1", [id])).rows[0].patient_id).toBe(destination.id);
      expect(await subject().domain.read(s.patientId)).toMatchObject({ reason: "denied" });
      expect(await subject().domain.read(destination.id)).toMatchObject({ ok: true, records: [] });
      const original = await state(s.patientId); expect(original.records).toHaveLength(1); expect(original.audits).toHaveLength(1);
      expect(await state(destination.id)).toEqual({ records: [], sites: [], audits: [] });
    } finally { release.open(); await pending; if (relink) await relink; }
  });
  it("protects primary-doctor read ownership with SHARE, beyond the reader's initial KEY SHARE", async () => {
    const s = await setup(); await primary(s); const admitted = gate(); const release = gate();
    const target = subject(async () => { admitted.open(); await release.promise; });
    const pending = observe(target.domain.read(s.patientId)); const updater = await transactionClient();
    let update: ReturnType<typeof observe<unknown>> | undefined;
    try {
      await until(async () => admitted.isOpen, "authorization callback reached"); update = observe(updater.client.query("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [s.patientId, s.otherId]));
      await until(() => isBlocked(updater.pid, target.pids[0]), "non-key patient reassignment waits for protected witness");
      release.open(); expect(unwrap(await pending)).toMatchObject({ ok: true, records: [] });
      unwrap(await update); await updater.client.query("COMMIT"); expect(await subject().domain.read(s.patientId)).toMatchObject({ reason: "denied" });
    } finally { release.open(); await pending; if (update) await update; await updater.client.query("ROLLBACK").catch(() => {}); updater.client.release(); }
  });
  it("fails closed on a visit-first lock timeout, then permits a fresh authorized attempt", async () => {
    const s = await setup(); const id = await visit(s); const blocker = await transactionClient();
    try {
      await blocker.client.query("SELECT id FROM visits WHERE id=$1 FOR UPDATE", [id]);
      expect(await subject(undefined, "50ms").domain.save(s.patientId, draft())).toMatchObject({ reason: "denied" });
      expect(await state(s.patientId)).toEqual({ records: [], sites: [], audits: [] });
    } finally { await blocker.client.query("ROLLBACK"); blocker.client.release(); }
    expect(await subject().domain.save(s.patientId, draft())).toMatchObject({ ok: true });
  });
  it("rolls observation and canonical same-client audit back together and releases access locks", async () => {
    const s = await setup(); await primary(s); const target = subject(undefined, "8s", true);
    await expect(target.domain.save(s.patientId, draft())).rejects.toThrow("synthetic post-audit failure");
    expect(target.auditClients[0]).toBe(target.authorizedClients[0]);
    expect(await state(s.patientId)).toEqual({ records: [], sites: [], audits: [] });
    await pool().query("UPDATE users SET is_active=false WHERE id=$1", [s.userId]);
    expect(await subject().domain.read(s.patientId)).toMatchObject({ reason: "denied" });
  });
  it("denies expired admission after a real account-lock wait", async () => {
    const s = await setup(); await primary(s); const blocker = await transactionClient(); const target = subject();
    const expiresAt = Date.now() + 3_000;
    request.token = createSessionToken({ userId: s.userId, username: s.username, role: "doctor", expiresAt,
      credentialVersion: sessionCredentialVersion(passwordHash) });
    let pending: ReturnType<typeof observe<Awaited<ReturnType<typeof target.domain.save>>>> | undefined;
    try {
      await blocker.client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [s.userId]); pending = observe(target.domain.save(s.patientId, draft()));
      await until(async () => target.pids.length === 1 && await isBlocked(target.pids[0], blocker.pid), "signed session waits for account row");
      await delay(Math.max(1, expiresAt - Date.now() + 20)); await blocker.client.query("COMMIT"); expect(unwrap(await pending)).toMatchObject({ reason: "denied" });
      expect(await state(s.patientId)).toEqual({ records: [], sites: [], audits: [] });
    } finally { await blocker.client.query("ROLLBACK").catch(() => {}); blocker.client.release(); if (pending) await pending; }
  });
  it("preserves captured command intent while the real patient lock blocks admission", async () => {
    const s = await setup(); await primary(s); const blocker = await transactionClient(); const target = subject();
    const input = draft(); const original = structuredClone(input);
    let pending: ReturnType<typeof observe<Awaited<ReturnType<typeof target.domain.save>>>> | undefined;
    try {
      await blocker.client.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
      pending = observe(target.domain.save(s.patientId, input));
      await until(async () => target.pids.length === 1 && await isBlocked(target.pids[0], blocker.pid), "captured save waits for patient lock");
      input.toothCode = 17; input.requestKey = next(); input.sites[0].depthMm = "9"; input.sites[1].bleeding = true;
      await blocker.client.query("COMMIT");
      expect(unwrap(await pending)).toMatchObject({ ok: true, record: { toothCode: 16 } });
      const stored = await state(s.patientId); expect(stored.records).toHaveLength(1);
      expect(stored.records[0]).toMatchObject({ tooth_code: 16, request_key: original.requestKey });
      expect(await subject().domain.save(s.patientId, original)).toMatchObject({ ok: true, replayed: true });
      expect(await state(s.patientId)).toEqual(stored);
    } finally { await blocker.client.query("ROLLBACK").catch(() => {}); blocker.client.release(); if (pending) await pending; }
  });
  it("preserves captured history tooth and cursor while the real patient lock blocks its read", async () => {
    const s = await setup(); await primary(s);
    const first = await subject().domain.save(s.patientId, draft()); expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    const other = draft(); other.toothCode = 17;
    const second = await subject().domain.save(s.patientId, other); expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.message);
    const blocker = await transactionClient(); const target = subject();
    const history = { toothCode: 16, beforeId: second.record.id };
    let pending: ReturnType<typeof observe<Awaited<ReturnType<typeof target.domain.read>>>> | undefined;
    try {
      await blocker.client.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
      pending = observe(target.domain.read(s.patientId, history));
      await until(async () => target.pids.length === 1 && await isBlocked(target.pids[0], blocker.pid), "captured history waits for patient lock");
      history.toothCode = 17; history.beforeId = first.record.id;
      await blocker.client.query("COMMIT"); const result = unwrap(await pending); expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.records.map((record) => [record.id, record.toothCode])).toEqual([[first.record.id, 16]]);
    } finally { await blocker.client.query("ROLLBACK").catch(() => {}); blocker.client.release(); if (pending) await pending; }
  });
  it.each(["plan", "visit", "planned", "primary", "appointment", "referral"])("preserves ordinary/locked %s witness policy", async (kind) => {
    const s = await setup();
    if (kind === "plan") await pool().query(`INSERT INTO treatment_plans (patient_id,title,total_minor,primary_doctor_id)
      VALUES ($1,'synthetic',0,$2)`, [s.patientId, s.doctorId]);
    if (kind === "visit") await visit(s);
    if (kind === "planned") await pool().query(`INSERT INTO planned_visits (patient_id,sequence,title,doctor_id)
      VALUES ($1,1,'synthetic',$2)`, [s.patientId, s.doctorId]);
    if (kind === "primary") await primary(s);
    // Cancellation never removed this historical relationship in the canonical policy.
    if (kind === "appointment") await pool().query(`INSERT INTO appointments
      (patient_id,scheduled_date,scheduled_time,status,doctor_id) VALUES ($1,CURRENT_DATE,'09:00','cancelled',$2)`, [s.patientId, s.doctorId]);
    if (kind === "referral") await pool().query(`INSERT INTO patient_referrals
      (patient_id,to_name,to_specialty,reason,created_by,kind,to_party_id,workflow_state)
      VALUES ($1,'synthetic','general','synthetic','synthetic','internal',$2,'requested')`, [s.patientId, s.doctorId]);
    const session = await requireSession(); expect(session).not.toBeNull();
    expect(await canAccessPatient(session!, s.patientId)).toBe(true);
    expect(await subject().domain.read(s.patientId)).toMatchObject({ ok: true });
    // Party activity is not an extra canonical access predicate.
    await pool().query("UPDATE parties SET is_active=false WHERE id=$1", [s.doctorId]);
    expect(await subject().domain.read(s.patientId)).toMatchObject({ ok: true });
  });
  it("retains the schema refusal of an internal NULL workflow state and grants no access", async () => {
    const s = await setup();
    await expect(pool().query(`INSERT INTO patient_referrals
      (patient_id,to_name,to_specialty,reason,created_by,kind,to_party_id,workflow_state)
      VALUES ($1,'synthetic','general','synthetic','synthetic','internal',$2,NULL)`, [s.patientId, s.doctorId]))
      .rejects.toMatchObject({ code: "23514", constraint: "patient_referrals_internal_receiver_check" });
    expect(await subject().domain.read(s.patientId)).toMatchObject({ reason: "denied" });
  });
  it.each(["declined", "cancelled"])("does not grant through a referral with workflow state %s", async (workflow) => {
    const s = await setup();
    await pool().query(`INSERT INTO patient_referrals
      (patient_id,to_name,to_specialty,reason,created_by,kind,to_party_id,workflow_state,status,closed_at,outcome_note)
      VALUES ($1,'synthetic','general','synthetic','synthetic','internal',$2,$3,'cancelled',NOW(),'synthetic')`,
    [s.patientId, s.doctorId, workflow]);
    const session = await requireSession(); expect(await canAccessPatient(session!, s.patientId)).toBe(false);
    expect(await subject().domain.read(s.patientId)).toMatchObject({ reason: "denied" });
  });
});
