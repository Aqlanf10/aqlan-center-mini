import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-ceph-create-secret-0123456789");
const db = await import("../../lib/db"), command = await import("../../lib/canonical-ceph-create-command");
const UPLOAD = { "clinical.xrays.view": true, "clinical.xrays.upload": true };
const ACCOUNTS = {
  owner: { username: "SYN-CCR-OWNER", role: "admin" },
  own: { username: "SYN-CCR-OWN", role: "doctor", doctor: true, patientScope: "own", grants: { ...UPLOAD, "clinical.ortho.view": true } },
  all: { username: "SYN-CCR-ALL", role: "reception", patientScope: "all", grants: UPLOAD },
  none: { username: "SYN-CCR-NONE", role: "doctor", doctor: true, patientScope: "none", grants: UPLOAD },
  unlinked: { username: "SYN-CCR-UNLINKED", role: "doctor", patientScope: "own", grants: UPLOAD },
  read: { username: "SYN-CCR-READ", role: "admin", patientScope: "all", grants: { "clinical.xrays.view": true } },
  analyze: { username: "SYN-CCR-ANALYZE", role: "admin", patientScope: "all", grants: { "clinical.xrays.view": true, "clinical.ceph.analyze": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, sequence = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-CCR-${++sequence}`, own ? fx.parties.own : null])).rows[0].id);
  return seedCanonicalCeph(fx.pool, { patientId });
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const create = async (key: Key, s: Scenario, extra: Record<string, unknown> = {}) => command.commandCanonicalCephCreate(await fx.session(key), String(s.patientId), { documentId: s.documentId, ...extra });
const drafts = async (s: Scenario) => (await fx.pool.query("SELECT * FROM ceph_analyses WHERE patient_id=$1 AND status='draft'", [s.patientId])).rows;
const audits = async (s: Scenario) => (await fx.pool.query("SELECT action,actor,actor_role FROM audit_log WHERE action='ceph.create' AND entity_id IN (SELECT id::text FROM ceph_analyses WHERE patient_id=$1)", [s.patientId])).rows;
it("owner, own and all uploaders create; read-only, analyst-only, none and unlinked refuse", async () => {
  for (const key of ["owner", "own", "all"] as const) { const s = await scenario(), result = await create(key, s); expect(result).toEqual({ id: expect.any(Number), duplicateWarning: expect.any(String) }); expect(await drafts(s)).toHaveLength(1); expect(await audits(s)).toEqual([{ action: "ceph.create", actor: ACCOUNTS[key].username, actor_role: ACCOUNTS[key].role }]); }
  const s = await scenario(); for (const key of ["read", "analyze", "none", "unlinked"] as const) await expect(create(key, s)).rejects.toThrow(/SCOPE|CAPABILITY|UNLINKED/); expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]);
});
it("outside and missing patient identities have the same unavailable result without effects", async () => {
  const outside = await scenario(false), own = await scenario();
  await expect(create("own", outside)).rejects.toMatchObject({ code: "ceph_create_not_found", status: 404 });
  await expect(command.commandCanonicalCephCreate(await fx.session("own"), "2147483647", { documentId: own.documentId })).rejects.toMatchObject({ code: "ceph_create_not_found", status: 404 });
  expect(await drafts(outside)).toEqual([]); expect(await audits(outside)).toEqual([]);
});
it("preserves native calendar fields and empty unapproved content without rewriting prior clinical, document or financial facts", async () => {
  const s = await scenario(), ortho = Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [s.patientId])).rows[0].id);
  const snapshot = async () => (await fx.pool.query("SELECT (SELECT to_jsonb(a) FROM ceph_analyses a WHERE id=$1) original,(SELECT to_jsonb(d) FROM patient_documents d WHERE id=$2) document,(SELECT to_jsonb(o) FROM ortho_cases o WHERE id=$3) ortho,(SELECT primary_doctor_id FROM patients WHERE id=$4) doctor,(SELECT jsonb_agg(to_jsonb(i)) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(p)) FROM payments p) payments", [s.id, s.documentId, ortho, s.patientId])).rows;
  await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by) VALUES($1,$2,76543,'USD','SYN')", [`SYN-CCR-FIN-${s.id}`, s.patientId]);
  const before = await snapshot(), result = await create("own", s, { orthoCaseId: ortho, phase: "during", xrayDate: "2024-02-29", device: " SYN device ", refSet: " SYN historical " });
  expect((await drafts(s))[0]).toMatchObject({ id: String(result.id), patient_id: s.patientId, document_id: s.documentId, ortho_case_id: ortho, created_by: ACCOUNTS.own.username, phase: "during", device: "SYN device", ref_set: "SYN historical", completed_at: null, completed_by: null, cal_mm: null, note: null });
  expect((await fx.pool.query("SELECT xray_date::text AS recorded_day,(SELECT count(*)::int FROM ceph_measurements WHERE analysis_id=$1) measurements,(SELECT count(*)::int FROM ceph_landmarks WHERE analysis_id=$1) landmarks,(SELECT count(*)::int FROM ceph_diagnoses WHERE analysis_id=$1) diagnoses FROM ceph_analyses WHERE id=$1", [result.id])).rows[0]).toEqual({ recorded_day: "2024-02-29", measurements: 0, landmarks: 0, diagnoses: 0 }); expect(await snapshot()).toEqual(before);
});
it.each(["foreign", "missing", "removed", "non-image"] as const)("%s document refuses with the same minimal reference response", async kind => {
  const s = await scenario(), foreign = await scenario(false);
  if (kind === "removed") await fx.pool.query("UPDATE patient_documents SET removed_at=NOW() WHERE id=$1", [s.documentId]);
  if (kind === "non-image") await fx.pool.query("UPDATE patient_documents SET mime_type='application/pdf' WHERE id=$1", [s.documentId]);
  await expect(create("all", s, { documentId: kind === "foreign" ? foreign.documentId : kind === "missing" ? 2147483647 : s.documentId })).rejects.toMatchObject({ code: "ceph_create_reference_invalid", status: 409 }); expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]);
});
it("foreign or missing ortho links refuse without reading or waiting on foreign content", async () => {
  const s = await scenario(), foreign = await scenario(false), ortho = Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [foreign.patientId])).rows[0].id), gate = await side.connect();
  try { await gate.query("BEGIN"); await gate.query("SELECT id FROM ortho_cases WHERE id=$1 FOR UPDATE", [ortho]); for (const id of [ortho, 2147483647]) await expect(create("owner", s, { orthoCaseId: id })).rejects.toMatchObject({ code: "ceph_create_reference_invalid" }); expect(await drafts(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); }
});
it("duplicate warning excludes discarded history, stays bounded, and does not prevent a legitimate new draft", async () => {
  const s = await scenario(); await fx.pool.query("UPDATE ceph_analyses SET status='discarded' WHERE id=$1", [s.id]);
  const first = await create("own", s); expect(first.duplicateWarning).toBeNull(); await fx.pool.query("UPDATE ceph_analyses SET status='completed' WHERE id=$1", [first.id]);
  await fx.pool.query("INSERT INTO ceph_analyses(patient_id,document_id,status,created_by) SELECT $1,$2,'completed','SYN history' FROM generate_series(1,301)", [s.patientId, s.documentId]);
  const next = await create("own", s); expect(next.duplicateWarning).toContain("302"); expect(JSON.stringify(next).length).toBeLessThan(180); expect(await drafts(s)).toHaveLength(1);
});
it("single-draft refusal is not a permanent receipt after a later closure; no command is silently replayed", async () => {
  const s = await scenario(), first = await create("own", s); await expect(create("own", s)).rejects.toMatchObject({ code: "ceph_create_conflict" }); expect(await audits(s)).toHaveLength(1);
  await fx.pool.query("UPDATE ceph_analyses SET status='discarded' WHERE id=$1", [first.id]); const second = await create("own", s); expect(second.id).not.toBe(first.id); expect(await audits(s)).toHaveLength(2);
});
it.each(["canonical", "legacy"] as const)("actual %s contender creates only one draft under the native uniqueness rule", async kind => {
  const s = await scenario(), gate = await side.connect(), session = await fx.session("own"); let pending: Promise<unknown>[] = [];
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = [command.commandCanonicalCephCreate(session, String(s.patientId), { documentId: s.documentId }), kind === "canonical" ? command.commandCanonicalCephCreate(await fx.session("all"), String(s.patientId), { documentId: s.documentId }) : db.createCephAnalysis({ patientId: s.patientId, documentId: s.documentId, createdBy: "SYN legacy" })]; pending.forEach(p => { void p.catch(() => undefined); });
    await vi.waitFor(async () => expect((await side.query(`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`, [pid])).rowCount).toBe(2), { timeout: 10000, interval: 10 });
    await gate.query("COMMIT"); await Promise.allSettled(pending); expect(await drafts(s)).toHaveLength(1); expect(await audits(s)).toHaveLength(1);
  } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(pending); }
});
it("audit failure rolls back the entire new study", async () => {
  const s = await scenario(); await fx.pool.query("CREATE FUNCTION syn_create_audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ceph.create' THEN RAISE EXCEPTION 'SYN ceph audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_create_audit_refuse BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_create_audit_refuse()");
  try { await expect(create("own", s)).rejects.toThrow("SYN ceph audit unavailable"); expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]); }
  finally { await fx.pool.query("DROP TRIGGER syn_create_audit_refuse ON audit_log; DROP FUNCTION syn_create_audit_refuse()"); }
});
it("uses one owned connection with no initialization, rich reader or pool query", async () => {
  const s = await scenario(), session = await fx.session("own"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema"), reader = vi.spyOn(db, "listPatientCephAnalyses");
  try { await command.commandCanonicalCephCreate(session, String(s.patientId), { documentId: s.documentId }); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); reader.mockRestore(); }
});
it.each(["expire", "scope", "document"] as const)("fresh %s state after patient-lock waiting governs admission", async kind => {
  const s = await scenario(), session = await fx.session("own", kind === "expire" ? 1500 : 60000), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = command.commandCanonicalCephCreate(session, String(s.patientId), { documentId: s.documentId }); void pending.catch(() => undefined); expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0);
    if (kind === "expire") await new Promise(r => setTimeout(r, 1700)); else if (kind === "scope") await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]); else await gate.query("UPDATE patient_documents SET removed_at=NOW() WHERE id=$1", [s.documentId]);
    await gate.query("COMMIT"); if (kind === "expire") await expect(pending).rejects.toThrow(/SESSION|EXPIRED/); else await expect(pending).rejects.toMatchObject({ code: kind === "scope" ? "ceph_create_not_found" : "ceph_create_reference_invalid" }); expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); if (pending) await pending.catch(() => undefined); }
});
it("upload revocation at the identity fence defeats the previously signed request", async () => {
  const s = await scenario(), session = await fx.session("all"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]); await gate.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: { "clinical.xrays.view": true }, patientScope: "all" }, 2)), fx.ids.all]); pending = command.commandCanonicalCephCreate(session, String(s.patientId), { documentId: s.documentId }); void pending.catch(() => undefined); expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await gate.query("COMMIT"); await expect(pending).rejects.toThrow(/STALE/); await expect(create("all", s)).rejects.toThrow(/CAPABILITY_DENIED/); expect(await drafts(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); if (pending) await pending.catch(() => undefined); await fx.setGrants("all", UPLOAD, { patientScope: "all" }); }
});
it("post-INSERT expiry inside audit rolls back the draft and audit", async () => {
  const s = await scenario(), session = await fx.session("own", 1500); await fx.pool.query("CREATE FUNCTION syn_create_audit_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ceph.create' THEN PERFORM pg_sleep(1.8); END IF; RETURN NEW; END $$; CREATE TRIGGER syn_create_audit_delay BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_create_audit_delay()");
  try { await expect(command.commandCanonicalCephCreate(session, String(s.patientId), { documentId: s.documentId })).rejects.toThrow(/SESSION|EXPIRED/); expect(await drafts(s)).toEqual([]); expect(await audits(s)).toEqual([]); }
  finally { await fx.pool.query("DROP TRIGGER syn_create_audit_delay ON audit_log; DROP FUNCTION syn_create_audit_delay()"); }
});
it.each(["document", "ortho"] as const)("inverse %s lock refuses without hanging or partial effect", async target => {
  const s = await scenario(), ortho = Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [s.patientId])).rows[0].id), gate = await side.connect();
  try { await gate.query("BEGIN"); await gate.query(`SELECT id FROM ${target === "document" ? "patient_documents" : "ortho_cases"} WHERE id=$1 FOR UPDATE`, [target === "document" ? s.documentId : ortho]); await expect(create("own", s, { orthoCaseId: ortho })).rejects.toMatchObject({ code: "ceph_create_conflict" }); expect(await drafts(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); }
});
it("an uploader without ortho view cannot submit an undisclosed case link directly",async()=>{
 const s=await scenario(),ortho=Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id",[s.patientId])).rows[0].id);
 await expect(create("all",s,{orthoCaseId:ortho})).rejects.toThrow(/CAPABILITY_DENIED/);
 expect(await drafts(s)).toEqual([]);expect(await audits(s)).toEqual([]);
});

it("ortho view withdrawal behind the identity fence forbids an otherwise authorized link",async()=>{
 const s=await scenario(),ortho=Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id",[s.patientId])).rows[0].id),session=await fx.session("own"),gate=await side.connect();let pending:Promise<unknown>|undefined;
 try{await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);pending=command.commandCanonicalCephCreate(session,String(s.patientId),{documentId:s.documentId,orthoCaseId:ortho});void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);
 // Use the actual authority-writer fence. Mutating a locked user behind a
 // patient lock instead creates an inverse-lock deadlock, not a revocation witness.
 await gate.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:UPLOAD,patientScope:"own"},2)),fx.ids.own]);await gate.query("COMMIT");await expect(pending).rejects.toThrow(/STALE|AUTHORITY_CHANGED|CAPABILITY_DENIED/);await expect(create("own",s,{orthoCaseId:ortho})).rejects.toThrow(/CAPABILITY_DENIED/);expect(await drafts(s)).toEqual([]);expect(await audits(s)).toEqual([]);
 }finally{await gate.query("ROLLBACK");gate.release();if(pending)await pending.catch(()=>undefined);await fx.setGrants("own",{...UPLOAD,"clinical.ortho.view":true},{patientScope:"own"});}
});
