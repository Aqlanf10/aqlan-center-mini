import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-ceph-discard-secret-0123456789");
const db = await import("../../lib/db"), command = await import("../../lib/canonical-ceph-discard-command");
const savedReads = await import("../../lib/canonical-ceph-reads");
const ANALYZE = { "clinical.xrays.view": true, "clinical.ceph.analyze": true };
const ACCOUNTS = {
  owner: { username: "SYN-CDS-OWNER", role: "admin" },
  own: { username: "SYN-CDS-OWN", role: "doctor", doctor: true, patientScope: "own", grants: ANALYZE },
  all: { username: "SYN-CDS-ALL", role: "reception", patientScope: "all", grants: ANALYZE },
  none: { username: "SYN-CDS-NONE", role: "doctor", doctor: true, patientScope: "none", grants: ANALYZE },
  unlinked: { username: "SYN-CDS-UNLINKED", role: "doctor", patientScope: "own", grants: ANALYZE },
  read: { username: "SYN-CDS-READ", role: "admin", patientScope: "all", grants: { "clinical.xrays.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, sequence = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-CDS-${++sequence}`, own ? fx.parties.own : null])).rows[0].id);
  const study = await seedCanonicalCeph(fx.pool, { patientId });
  await fx.pool.query("UPDATE ceph_analyses SET status='draft',completed_at=NULL,completed_by=NULL,phase='during',cal_x1=1,cal_y1=2,cal_x2=3,cal_y2=4,cal_mm=20,mm_per_pixel=0.125,ref_set='SYN historical reference' WHERE id=$1", [study.id]);
  await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'SYN_OLD_CODE',1.25,2.75,'manual','SYN original')", [study.id]);
  await fx.pool.query("INSERT INTO ceph_diagnoses(analysis_id,final_dx,created_by) VALUES($1,'SYN approved original diagnosis','SYN')", [study.id]);
  return study;
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const token = async (s: Scenario) => {
  const value = (await savedReads.readCanonicalCephStudy(await fx.session("owner"), s.id)).discardVersion;
  expect(value).toMatch(/^[a-f0-9]{64}$/); return value!;
};
const discard = async (key: Key, s: Scenario, version?: string, note: string | null = "SYN discard note") => command.commandCanonicalCephDiscard(await fx.session(key), String(s.id), { expectedVersion: version ?? await token(s), note });
const audits = async (s: Scenario) => (await fx.pool.query("SELECT action,actor,actor_role,summary FROM audit_log WHERE action='ceph.discard' AND entity_id=$1", [String(s.id)])).rows;
const status = async (s: Scenario) => (await fx.pool.query("SELECT status,note FROM ceph_analyses WHERE id=$1", [s.id])).rows[0];
const original = async (s: Scenario) => (await fx.pool.query(`SELECT (SELECT to_jsonb(a) FROM ceph_analyses a WHERE id=$1) study,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM ceph_landmarks l WHERE analysis_id=$1) landmarks,
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM ceph_measurements m WHERE analysis_id=$1) measurements,
  (SELECT to_jsonb(d) FROM ceph_diagnoses d WHERE analysis_id=$1) diagnosis`, [s.id])).rows;

it("owner, own and all analysts discard while preserving all child history and current actor", async () => {
  for (const key of ["owner", "own", "all"] as const) {
    const s = await scenario(), before = await original(s), result = await discard(key, s);
    expect(result).toEqual({ ok: true, studyId: s.id, status: "discarded" });
    const after = await original(s); expect(after[0]).toEqual({ ...before[0], study: { ...before[0].study, status: "discarded", note: "SYN discard note" } });
    expect(await audits(s)).toEqual([{ action: "ceph.discard", actor: ACCOUNTS[key].username, actor_role: ACCOUNTS[key].role, summary: expect.stringContaining("SYN discard note") }]);
  }
});
it("reader, none and unlinked actors cannot use a known current version to gain authority", async () => {
  const s = await scenario(), version = await token(s);
  for (const key of ["read", "none", "unlinked"] as const) await expect(discard(key, s, version)).rejects.toThrow(/SCOPE|CAPABILITY|UNLINKED/);
  expect((await status(s)).status).toBe("draft"); expect(await audits(s)).toEqual([]);
});
it("foreign, missing and previously discarded records stay unavailable without repeat effects", async () => {
  const s = await scenario(false), version = await token(s);
  await expect(discard("own", s, version)).rejects.toMatchObject({ code: "ceph_discard_not_found" });
  await expect(command.commandCanonicalCephDiscard(await fx.session("own"), "2147483647", { expectedVersion: version, note: null })).rejects.toMatchObject({ code: "ceph_discard_not_found" });
  await discard("owner", s, version);
  await expect(discard("owner", s, version)).rejects.toMatchObject({ code: "ceph_discard_not_found" });
  expect(await audits(s)).toHaveLength(1);
});
it("completed study and approved clinical results cannot be discarded with a stale draft version", async () => {
  const s = await scenario(), version = await token(s);
  await fx.pool.query("UPDATE ceph_analyses SET status='completed',completed_at=NOW(),completed_by='SYN approver' WHERE id=$1", [s.id]);
  const before = await original(s); expect((await savedReads.readCanonicalCephStudy(await fx.session("owner"), s.id)).discardVersion).toBeUndefined();
  await expect(discard("owner", s, version)).rejects.toMatchObject({ code: "ceph_discard_conflict" });
  expect(await original(s)).toEqual(before); expect(await audits(s)).toEqual([]);
});
it.each(["parent", "same-value-parent", "landmark", "measurement", "diagnosis", "child-add", "child-remove"] as const)("%s change invalidates the observed draft without overwriting it", async kind => {
  const s = await scenario(), version = await token(s);
  if (kind === "parent") await fx.pool.query("UPDATE ceph_analyses SET note='SYN newer note' WHERE id=$1", [s.id]);
  if (kind === "same-value-parent") await fx.pool.query("UPDATE ceph_analyses SET note=note WHERE id=$1", [s.id]);
  if (kind === "landmark") await fx.pool.query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1", [s.id]);
  if (kind === "measurement") await fx.pool.query("UPDATE ceph_measurements SET value=value+1 WHERE analysis_id=$1", [s.id]);
  if (kind === "diagnosis") await fx.pool.query("UPDATE ceph_diagnoses SET final_dx='SYN newer diagnosis' WHERE analysis_id=$1", [s.id]);
  if (kind === "child-add") await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'SYN_ADDED',1,2,'manual','SYN')", [s.id]);
  if (kind === "child-remove") await fx.pool.query("DELETE FROM ceph_landmarks WHERE analysis_id=$1", [s.id]);
  const before = await original(s); expect(await token(s)).not.toBe(version);
  await expect(discard("own", s, version)).rejects.toMatchObject({ code: "ceph_discard_conflict" });
  expect(await original(s)).toEqual(before); expect(await audits(s)).toEqual([]);
});
it("two canonical requests actually waiting on the patient create one discard and audit", async () => {
  const s = await scenario(), version = await token(s), sessions = [await fx.session("own"), await fx.session("all")], gate = await side.connect(); let pending: Promise<unknown>[] = [];
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = sessions.map(session => command.commandCanonicalCephDiscard(session, String(s.id), { expectedVersion: version, note: null })); pending.forEach(p => { void p.catch(() => undefined); });
    await vi.waitFor(async () => expect((await side.query(`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`, [pid])).rowCount).toBe(2), { timeout: 10000, interval: 10 });
    await gate.query("COMMIT"); const result = await Promise.allSettled(pending);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(result.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "ceph_discard_not_found" } }); expect(await audits(s)).toHaveLength(1);
  } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(pending); }
});
it("a proven waiting legacy discard and canonical refusal preserve one effect and audit", async () => {
  const s = await scenario(), version = await token(s), gate = await side.connect(); let pending: ReturnType<typeof db.discardCephAnalysis> | undefined;
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM ceph_analyses WHERE id=$1 FOR UPDATE", [s.id]);
    pending = db.discardCephAnalysis(s.id, "SYN legacy analyst", "SYN legacy discard"); void pending.catch(() => undefined);
    expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0);
    await expect(discard("own", s, version)).rejects.toMatchObject({ code: "ceph_discard_conflict" });
    await gate.query("COMMIT"); expect(await pending).toEqual({ ok: true }); expect(await audits(s)).toHaveLength(1); expect((await status(s)).note).toBe("SYN legacy discard");
  } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); }
});
it.each(["study", "document", "landmarks", "measurements", "diagnosis"] as const)("inverse %s lock refuses without changing the draft", async target => {
  const s = await scenario(), version = await token(s), before = await original(s), gate = await side.connect();
  const sql = { study: "SELECT id FROM ceph_analyses WHERE id=$1 FOR UPDATE", document: "SELECT id FROM patient_documents WHERE id=$1 FOR UPDATE", landmarks: "SELECT id FROM ceph_landmarks WHERE analysis_id=$1 FOR UPDATE", measurements: "SELECT id FROM ceph_measurements WHERE analysis_id=$1 FOR UPDATE", diagnosis: "SELECT analysis_id FROM ceph_diagnoses WHERE analysis_id=$1 FOR UPDATE" };
  try { await gate.query("BEGIN"); await gate.query(sql[target], [target === "document" ? s.documentId : s.id]); await expect(discard("all", s, version)).rejects.toMatchObject({ code: "ceph_discard_conflict" }); expect(await original(s)).toEqual(before); expect(await audits(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); }
});
it.each(["document", "ortho"] as const)("foreign %s references fail before accessing or waiting on foreign content", async kind => {
  const s = await scenario(), foreign = await scenario(false), version = await token(s), gate = await side.connect();
  const id = kind === "document" ? foreign.documentId : Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [foreign.patientId])).rows[0].id);
  await fx.pool.query(`UPDATE ceph_analyses SET ${kind === "document" ? "document_id" : "ortho_case_id"}=$1 WHERE id=$2`, [id, s.id]);
  try { await gate.query("BEGIN"); await gate.query(`SELECT id FROM ${kind === "document" ? "patient_documents" : "ortho_cases"} WHERE id=$1 FOR UPDATE`, [id]); await expect(discard("all", s, version)).rejects.toMatchObject({ code: "ceph_discard_reference_invalid" }); expect((await status(s)).status).toBe("draft"); expect(await audits(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); }
});
it("retained unavailable image and same-patient ortho association do not grant ownership or change finance", async () => {
  const s = await scenario(), ortho = Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [s.patientId])).rows[0].id);
  await fx.pool.query("UPDATE ceph_analyses SET ortho_case_id=$1 WHERE id=$2", [ortho, s.id]); await fx.pool.query("UPDATE patient_documents SET removed_at=NOW() WHERE id=$1", [s.documentId]);
  const snapshot = async () => (await fx.pool.query("SELECT (SELECT to_jsonb(d) FROM patient_documents d WHERE id=$1) document,(SELECT to_jsonb(o) FROM ortho_cases o WHERE id=$2) ortho,(SELECT primary_doctor_id FROM patients WHERE id=$3) doctor,(SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM payments)::int payments", [s.documentId, ortho, s.patientId])).rows;
  const before = await snapshot(); await discard("own", s); expect(await snapshot()).toEqual(before);
});
it("audit refusal rolls back the status and note with all source history intact", async () => {
  const s = await scenario(), version = await token(s), before = await original(s);
  await fx.pool.query("CREATE FUNCTION syn_discard_audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ceph.discard' THEN RAISE EXCEPTION 'SYN audit refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_discard_audit_refuse BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_discard_audit_refuse()");
  try { await expect(discard("own", s, version)).rejects.toThrow("SYN audit refused"); expect(await original(s)).toEqual(before); expect(await audits(s)).toEqual([]); }
  finally { await fx.pool.query("DROP TRIGGER syn_discard_audit_refuse ON audit_log; DROP FUNCTION syn_discard_audit_refuse()"); }
});
it.each(["expire", "scope", "source", "child"] as const)("%s change during the patient wait prevents a stale discard", async kind => {
  const s = await scenario(), version = await token(s), session = await fx.session("own", kind === "expire" ? 1500 : 60000), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = command.commandCanonicalCephDiscard(session, String(s.id), { expectedVersion: version, note: null }); void pending.catch(() => undefined);
    expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0);
    if (kind === "expire") await new Promise(r => setTimeout(r, 1700));
    if (kind === "scope") await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]);
    if (kind === "source") await gate.query("UPDATE ceph_analyses SET status='completed',completed_at=NOW(),completed_by='SYN other' WHERE id=$1", [s.id]);
    if (kind === "child") await gate.query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1", [s.id]);
    await gate.query("COMMIT");
    if (kind === "expire") await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
    else await expect(pending).rejects.toMatchObject({ code: kind === "scope" ? "ceph_discard_not_found" : "ceph_discard_conflict" });
    expect(await audits(s)).toEqual([]);
    expect((await status(s)).status).toBe(kind === "source" ? "completed" : "draft");
  } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); }
});
it("uses one admitted connection without a legacy initializer or post-commit reader", async () => {
  const s = await scenario(), version = await token(s), session = await fx.session("own"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema"), rich = vi.spyOn(db, "getCephStudy");
  try { await command.commandCanonicalCephDiscard(session, String(s.id), { expectedVersion: version, note: null }); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); expect(rich).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); rich.mockRestore(); }
});

it("analysis revocation at the identity fence defeats a previously signed discard", async () => {
  const s = await scenario(), version = await token(s), session = await fx.session("all"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await gate.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: { "clinical.xrays.view": true }, patientScope: "all" }, 2)), fx.ids.all]);
    pending = command.commandCanonicalCephDiscard(session, String(s.id), { expectedVersion: version, note: null }); void pending.catch(() => undefined);
    expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await gate.query("COMMIT");
    await expect(pending).rejects.toThrow(/STALE/); await expect(discard("all", s, version)).rejects.toThrow(/CAPABILITY_DENIED/); expect((await status(s)).status).toBe("draft"); expect(await audits(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); await fx.setGrants("all", ANALYZE, { patientScope: "all" }); }
});
it("expiry after the status update inside audit rolls back the entire discard", async () => {
  const s = await scenario(), version = await token(s), before = await original(s), session = await fx.session("own", 1500);
  await fx.pool.query("CREATE FUNCTION syn_discard_audit_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ceph.discard' THEN PERFORM pg_sleep(1.8); END IF; RETURN NEW; END $$; CREATE TRIGGER syn_discard_audit_delay BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_discard_audit_delay()");
  try { await expect(command.commandCanonicalCephDiscard(session, String(s.id), { expectedVersion: version, note: null })).rejects.toThrow(/SESSION|EXPIRED/); expect(await original(s)).toEqual(before); expect(await audits(s)).toEqual([]); }
  finally { await fx.pool.query("DROP TRIGGER syn_discard_audit_delay ON audit_log; DROP FUNCTION syn_discard_audit_delay()"); }
});
it("the observation is stable within a read-only repeatable snapshot and detects a later child change", async () => {
  const s = await scenario(), { cephDraftVersionWith } = await import("../../lib/canonical-ceph-draft-version"), gate = await side.connect();
  try {
    await gate.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const before = await cephDraftVersionWith(gate, s.id);
    await fx.pool.query("UPDATE ceph_landmarks SET y=y+1 WHERE analysis_id=$1", [s.id]);
    expect(await cephDraftVersionWith(gate, s.id)).toBe(before); await gate.query("COMMIT");
    expect(await token(s)).not.toBe(before); await expect(discard("own", s, before!)).rejects.toMatchObject({ code: "ceph_discard_conflict" });
  } finally { await gate.query("ROLLBACK"); gate.release(); }
});
