import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-ceph-copy-secret-0123456789");
const db = await import("../../lib/db"), command = await import("../../lib/canonical-ceph-copy-command");
const savedReads = await import("../../lib/canonical-ceph-reads");
const ANALYZE = { "clinical.xrays.view": true, "clinical.ceph.analyze": true };
const ACCOUNTS = {
  owner: { username: "SYN-CCP-OWNER", role: "admin" },
  own: { username: "SYN-CCP-OWN", role: "doctor", doctor: true, patientScope: "own", grants: ANALYZE },
  all: { username: "SYN-CCP-ALL", role: "reception", patientScope: "all", grants: ANALYZE },
  none: { username: "SYN-CCP-NONE", role: "doctor", doctor: true, patientScope: "none", grants: ANALYZE },
  unlinked: { username: "SYN-CCP-UNLINKED", role: "doctor", patientScope: "own", grants: ANALYZE },
  read: { username: "SYN-CCP-READ", role: "admin", patientScope: "all", grants: { "clinical.xrays.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, sequence = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-CCP-${++sequence}`, own ? fx.parties.own : null])).rows[0].id);
  const study = await seedCanonicalCeph(fx.pool, { patientId });
  await fx.pool.query("UPDATE ceph_analyses SET phase='during',cal_x1=1,cal_y1=2,cal_x2=3,cal_y2=4,cal_mm=20,mm_per_pixel=0.125,ref_set='SYN historical reference' WHERE id=$1", [study.id]);
  await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'SYN_OLD_CODE',1.25,2.75,'manual','SYN original')", [study.id]);
  await fx.pool.query("INSERT INTO ceph_diagnoses(analysis_id,final_dx,created_by) VALUES($1,'SYN approved original diagnosis','SYN')", [study.id]);
  return study;
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const copy = async (key: Key, s: Scenario) => command.commandCanonicalCephCopy(await fx.session(key), String(s.id), {});
const drafts = async (s: Scenario) => (await fx.pool.query("SELECT * FROM ceph_analyses WHERE patient_id=$1 AND status='draft'", [s.patientId])).rows;
const audits = async (s: Scenario) => (await fx.pool.query("SELECT action,actor,actor_role FROM audit_log WHERE action='ceph.create' AND entity_id IN (SELECT id::text FROM ceph_analyses WHERE patient_id=$1)", [s.patientId])).rows;
const original = async (s: Scenario) => (await fx.pool.query(`SELECT (SELECT to_jsonb(a) FROM ceph_analyses a WHERE id=$1) study,
  (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM ceph_landmarks l WHERE analysis_id=$1) landmarks,
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM ceph_measurements m WHERE analysis_id=$1) measurements,
  (SELECT to_jsonb(d) FROM ceph_diagnoses d WHERE analysis_id=$1) diagnosis`, [s.id])).rows;
it("owner, own and all analysts can copy; read, none and unlinked actors cannot", async () => {
  for (const key of ["owner", "own", "all"] as const) { const s = await scenario(), result = await copy(key, s); expect(result).toEqual({ ok: true, studyId: expect.any(Number) }); expect(await drafts(s)).toHaveLength(1); expect(await audits(s)).toEqual([{ action: "ceph.create", actor: ACCOUNTS[key].username, actor_role: ACCOUNTS[key].role }]); }
  const s = await scenario(); for (const key of ["read", "none", "unlinked"] as const) await expect(copy(key, s)).rejects.toThrow(/SCOPE|CAPABILITY|UNLINKED/);
  expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]);
});
it("outside, missing and discarded studies are unavailable without effects", async () => {
  const outside = await scenario(false), own = await scenario();
  await expect(copy("own", outside)).rejects.toMatchObject({ code: "ceph_copy_not_found" });
  await expect(command.commandCanonicalCephCopy(await fx.session("own"), "2147483647", {})).rejects.toMatchObject({ code: "ceph_copy_not_found" });
  await fx.pool.query("UPDATE ceph_analyses SET status='discarded' WHERE id=$1", [own.id]);
  await expect(copy("owner", own)).rejects.toMatchObject({ code: "ceph_copy_not_found" }); expect(await drafts(outside)).toEqual([]); expect(await audits(own)).toEqual([]);
});
it("copies original calibration, date, phase, reference and unknown historical landmarks without new approved results", async () => {
  const s = await scenario(), before = await original(s), result = await copy("own", s), [draft] = await drafts(s);
  expect(draft).toMatchObject({ id: String(result.studyId), patient_id: s.patientId, document_id: s.documentId, status: "draft", phase: "during", device: "SYN machine", ref_set: "SYN historical reference", study_kind: "lateral", cal_x1: 1, cal_y1: 2, cal_x2: 3, cal_y2: 4, cal_mm: 20, mm_per_pixel: 0.125, completed_at: null, completed_by: null, created_by: ACCOUNTS.own.username });
  expect((await fx.pool.query("SELECT xray_date::text AS recorded_day FROM ceph_analyses WHERE id=$1", [result.studyId])).rows[0].recorded_day).toBe("2024-02-29");
  expect((await fx.pool.query("SELECT code,x,y,source,confirmed_by FROM ceph_landmarks WHERE analysis_id=$1", [result.studyId])).rows).toEqual([{ code: "SYN_OLD_CODE", x: 1.25, y: 2.75, source: "manual", confirmed_by: ACCOUNTS.own.username }]);
  expect((await fx.pool.query("SELECT (SELECT count(*)::int FROM ceph_measurements WHERE analysis_id=$1) measurements,(SELECT count(*)::int FROM ceph_diagnoses WHERE analysis_id=$1) diagnoses", [result.studyId])).rows[0]).toEqual({ measurements: 0, diagnoses: 0 });
  expect(await original(s)).toEqual(before);
});
it("draft-only and existing-draft refusals preserve the original one-draft rule", async () => {
  const s = await scenario(), created = await copy("own", s);
  await expect(copy("own", s)).rejects.toMatchObject({ code: "ceph_copy_conflict" });
  await expect(command.commandCanonicalCephCopy(await fx.session("own"), String(created.studyId), {})).rejects.toMatchObject({ code: "ceph_copy_conflict" });
  expect(await drafts(s)).toHaveLength(1); expect(await audits(s)).toHaveLength(1);
});
it.each(["calibration", "scale", "landmark-code", "landmark-coordinate"] as const)("copied source validity: refuses invalid %s already refused by the saved reader", async kind => {
  const s = await scenario();
  if (kind === "calibration") await fx.pool.query("UPDATE ceph_analyses SET cal_y2=NULL WHERE id=$1", [s.id]);
  else if (kind === "scale") await fx.pool.query("UPDATE ceph_analyses SET mm_per_pixel='NaN' WHERE id=$1", [s.id]);
  else if (kind === "landmark-code") await fx.pool.query("UPDATE ceph_landmarks SET code='' WHERE analysis_id=$1", [s.id]);
  else await fx.pool.query("UPDATE ceph_landmarks SET x='Infinity' WHERE analysis_id=$1", [s.id]);
  const before = await original(s);
  await expect(savedReads.readCanonicalCephStudy(await fx.session("own"), s.id)).rejects.toMatchObject({ code: "ceph_stored_data_invalid" });
  await expect(copy("own", s)).rejects.toMatchObject({ code: "ceph_copy_stored_data_invalid" });
  expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]); expect(await original(s)).toEqual(before);
});
it("uncopied approved measurements cannot become replacement results or prevent a valid correction copy", async () => {
  const s = await scenario(); await fx.pool.query("UPDATE ceph_measurements SET value='NaN' WHERE analysis_id=$1 AND code='ANB'", [s.id]);
  const before = await original(s), created = await copy("own", s);
  expect((await fx.pool.query("SELECT 1 FROM ceph_measurements WHERE analysis_id=$1", [created.studyId])).rows).toEqual([]);
  expect(await original(s)).toEqual(before);
});
it.each(["document", "ortho"] as const)("foreign %s reference refuses before reading or locking foreign content", async kind => {
  const s = await scenario(), foreign = await scenario(false), gate = await side.connect();
  const id = kind === "document" ? foreign.documentId : Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [foreign.patientId])).rows[0].id);
  await fx.pool.query(`UPDATE ceph_analyses SET ${kind === "document" ? "document_id" : "ortho_case_id"}=$1 WHERE id=$2`, [id, s.id]);
  try { await gate.query("BEGIN"); await gate.query(`SELECT id FROM ${kind === "document" ? "patient_documents" : "ortho_cases"} WHERE id=$1 FOR UPDATE`, [id]); await expect(copy("all", s)).rejects.toMatchObject({ code: "ceph_copy_reference_invalid" }); expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); }
});
it("retained unavailable image and same-patient ortho association are preserved without file or responsibility changes", async () => {
  const s = await scenario(), ortho = Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [s.patientId])).rows[0].id);
  await fx.pool.query("UPDATE ceph_analyses SET ortho_case_id=$1 WHERE id=$2", [ortho, s.id]); await fx.pool.query("UPDATE patient_documents SET removed_at=NOW() WHERE id=$1", [s.documentId]);
  const snapshot = async () => (await fx.pool.query("SELECT (SELECT to_jsonb(d) FROM patient_documents d WHERE id=$1) document,(SELECT to_jsonb(o) FROM ortho_cases o WHERE id=$2) ortho,(SELECT primary_doctor_id FROM patients WHERE id=$3) doctor,(SELECT count(*) FROM invoices)::int invoices,(SELECT count(*) FROM payments)::int payments", [s.documentId, ortho, s.patientId])).rows;
  const before = await snapshot(); await copy("own", s); expect((await drafts(s))[0]).toMatchObject({ document_id: s.documentId, ortho_case_id: ortho }); expect(await snapshot()).toEqual(before);
});
it("copy bounds refuse oversized stored data without truncating a historical study", async () => {
  const s = await scenario(); await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) SELECT $1,'SYN_'||n,1,2,'manual','SYN' FROM generate_series(1,255) n", [s.id]);
  const accepted = await copy("own", s); expect((await fx.pool.query("SELECT count(*)::int n FROM ceph_landmarks WHERE analysis_id=$1", [accepted.studyId])).rows[0].n).toBe(256);
  const tooMany = await scenario(); await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) SELECT $1,'SYN_'||n,1,2,'manual','SYN' FROM generate_series(1,256) n", [tooMany.id]);
  await expect(copy("owner", tooMany)).rejects.toMatchObject({ code: "ceph_copy_limit" }); expect(await drafts(tooMany)).toEqual([]);
  const tooLarge = await scenario(); await fx.pool.query("UPDATE ceph_analyses SET note=$1 WHERE id=$2", ["x".repeat(2 * 1024 * 1024 + 1), tooLarge.id]);
  await expect(copy("owner", tooLarge)).rejects.toMatchObject({ code: "ceph_copy_limit" }); expect(await audits(tooLarge)).toEqual([]);
});
it("two actual canonical waiters create one draft and one audit", async () => {
  const s = await scenario(), sessions = [await fx.session("own"), await fx.session("all")], gate = await side.connect(); let pending: Promise<unknown>[] = [];
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = sessions.map(session => command.commandCanonicalCephCopy(session, String(s.id), {})); pending.forEach(p => { void p.catch(() => undefined); });
    await vi.waitFor(async () => expect((await side.query(`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`, [pid])).rowCount).toBe(2), { timeout: 10000, interval: 10 });
    await gate.query("COMMIT"); const result = await Promise.allSettled(pending); expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(result.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "ceph_copy_conflict" } }); expect(await drafts(s)).toHaveLength(1); expect(await audits(s)).toHaveLength(1);
  } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(pending); }
});
it("legacy and canonical copy contend safely on the same original and unique draft constraint", async () => {
  const s = await scenario(), before = await original(s), gate = await side.connect(), session = await fx.session("own"); let pending: Promise<unknown>[] = [];
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = [command.commandCanonicalCephCopy(session, String(s.id), {}), db.duplicateCephAnalysis(s.id, "SYN legacy analyst")]; pending.forEach(p => { void p.catch(() => undefined); });
    await vi.waitFor(async () => expect((await side.query(`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`, [pid])).rowCount).toBe(2), { timeout: 10000, interval: 10 });
    await gate.query("COMMIT"); await Promise.allSettled(pending);
    expect(await drafts(s)).toHaveLength(1); expect(await audits(s)).toHaveLength(1); expect(await original(s)).toEqual(before);
  } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(pending); }
});
it("audit failure rolls back the new study and copied landmarks", async () => {
  const s = await scenario(), before = await original(s);
  await fx.pool.query("CREATE FUNCTION syn_ceph_audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ceph.create' THEN RAISE EXCEPTION 'SYN ceph audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_ceph_audit_refuse BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_ceph_audit_refuse()");
  try { await expect(copy("own", s)).rejects.toThrow("SYN ceph audit unavailable"); expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]); expect(await original(s)).toEqual(before); }
  finally { await fx.pool.query("DROP TRIGGER syn_ceph_audit_refuse ON audit_log; DROP FUNCTION syn_ceph_audit_refuse()"); }
});
it("uses one admitted connection without a schema initializer or rich legacy reader", async () => {
  const s = await scenario(), session = await fx.session("own"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema"), rich = vi.spyOn(db, "getCephStudy");
  try { await command.commandCanonicalCephCopy(session, String(s.id), {}); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); expect(rich).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); rich.mockRestore(); }
});
it.each(["expire", "scope", "source"] as const)("%s changes during the patient-lock wait prevent copying", async kind => {
  const s = await scenario(), foreign = kind === "source" ? await scenario(false) : null, session = await fx.session("own", kind === "expire" ? 1500 : 60000), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = command.commandCanonicalCephCopy(session, String(s.id), {}); void pending.catch(() => undefined); expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0);
    if (kind === "expire") await new Promise(r => setTimeout(r, 1700));
    else if (kind === "scope") await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]);
    else await gate.query("UPDATE ceph_analyses SET patient_id=$1 WHERE id=$2", [foreign!.patientId, s.id]);
    await gate.query("COMMIT"); if (kind === "expire") await expect(pending).rejects.toThrow(/SESSION|EXPIRED/); else await expect(pending).rejects.toMatchObject({ code: "ceph_copy_not_found" });
    expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); if (pending) await pending.catch(() => undefined); }
});
it("analysis revocation at the identity fence defeats a previously signed request", async () => {
  const s = await scenario(), session = await fx.session("all"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await gate.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: { "clinical.xrays.view": true }, patientScope: "all" }, 2)), fx.ids.all]);
    pending = command.commandCanonicalCephCopy(session, String(s.id), {}); void pending.catch(() => undefined); expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await gate.query("COMMIT");
    await expect(pending).rejects.toThrow(/STALE/); await expect(copy("all", s)).rejects.toThrow(/CAPABILITY_DENIED/); expect(await drafts(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); if (pending) await pending.catch(() => undefined); await fx.setGrants("all", ANALYZE, { patientScope: "all" }); }
});
it("expiry after the INSERT inside audit rolls back the entire copy", async () => {
  const s = await scenario(), session = await fx.session("own", 1500);
  await fx.pool.query("CREATE FUNCTION syn_ceph_audit_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ceph.create' THEN PERFORM pg_sleep(1.8); END IF; RETURN NEW; END $$; CREATE TRIGGER syn_ceph_audit_delay BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_ceph_audit_delay()");
  try { await expect(command.commandCanonicalCephCopy(session, String(s.id), {})).rejects.toThrow(/SESSION|EXPIRED/); expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]); }
  finally { await fx.pool.query("DROP TRIGGER syn_ceph_audit_delay ON audit_log; DROP FUNCTION syn_ceph_audit_delay()"); }
});
it.each(["study", "document", "landmark"] as const)("inverse %s lock refuses rather than hanging or leaving a draft", async target => {
  const s = await scenario(), gate = await side.connect();
  try { await gate.query("BEGIN"); await gate.query(target === "landmark" ? "SELECT id FROM ceph_landmarks WHERE analysis_id=$1 FOR UPDATE" : `SELECT id FROM ${target === "study" ? "ceph_analyses" : "patient_documents"} WHERE id=$1 FOR UPDATE`, [target === "document" ? s.documentId : s.id]); await expect(copy("all", s)).rejects.toMatchObject({ code: "ceph_copy_conflict" }); expect(await drafts(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); }
});
