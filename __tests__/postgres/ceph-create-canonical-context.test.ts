import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-ceph-context-secret-0123456789");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-ceph-create-context"), saved = await import("../../lib/canonical-ceph-reads");
const UPLOAD = { "clinical.xrays.view": true, "clinical.xrays.upload": true };
const ACCOUNTS = {
 owner: { username: "SYN-CCC-OWNER", role: "admin" },
 own: { username: "SYN-CCC-OWN", role: "doctor", doctor: true, patientScope: "own", grants: UPLOAD },
 all: { username: "SYN-CCC-ALL", role: "reception", patientScope: "all", grants: UPLOAD },
 ortho: { username: "SYN-CCC-ORTHO", role: "reception", patientScope: "all", grants: { ...UPLOAD, "clinical.ortho.view": true } },
 read: { username: "SYN-CCC-READ", role: "admin", patientScope: "all", grants: { "clinical.xrays.view": true } },
 none: { username: "SYN-CCC-NONE", role: "doctor", doctor: true, patientScope: "none", grants: UPLOAD },
 unlinked: { username: "SYN-CCC-UNLINKED", role: "doctor", patientScope: "own", grants: UPLOAD },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, sequence = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
 const patientId = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-CCC-${++sequence}`, own ? fx.parties.own : null])).rows[0].id);
 const s = await seedCanonicalCeph(fx.pool, { patientId });
 const ortho = Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by,note) VALUES($1,'SYN','SYN hidden ortho note') RETURNING id", [patientId])).rows[0].id);
 return { ...s, ortho };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const read = async (key: Key, s: Scenario, before: number | null = null) => reads.readCanonicalCephCreateContext(await fx.session(key), s.patientId, before);
it.each(["owner", "own", "all"] as const)("%s obtains explicit owned choices with no file/clinical/financial excess", async key => {
 const s = await scenario(), result = await read(key, s); expect(result.images).toEqual([{ id: s.documentId, title: "SYN private image title", takenOn: null, uploadedAt: expect.any(String), previousStudies: 1 }]); expect(result.hasOpenDraft).toBe(false); expect(result.orthoCases).toEqual(key === "owner" ? [{ id: s.ortho }] : null);
 expect(JSON.stringify(result)).not.toMatch(/SYN saved clinical note|SYN machine|hidden ortho note|storage_key|mime_type|sha256|size_bytes|uploaded_by|visit_id|patient_number|invoice|calibration|diagnosis|SYN\/private.png/);
 expect(Object.keys(result).sort()).toEqual(["clinicTimeZone","hasOpenDraft","images","imagesBefore","nextImagesBefore","orthoCases","patientId","projection","referenceSets"].sort());
});
it("reader, none and unlinked cannot obtain creation context; default reader stays independent", async () => {
 const s = await scenario(); await expect(read("read", s)).rejects.toMatchObject({ code: "patient_filter_not_granted" }); for (const key of ["none", "unlinked"] as const) await expect(read(key, s)).rejects.toThrow(/SCOPE|UNLINKED/);
 expect(await saved.readCanonicalCephList(await fx.session("read"), s.patientId)).toMatchObject({ projection: "ceph-summary" });
});
it("missing and outside patient identity are indistinguishable", async () => {
 const s = await scenario(false); await expect(read("own", s)).rejects.toMatchObject({ code: "patient_not_found" }); await expect(reads.readCanonicalCephCreateContext(await fx.session("own"), 2147483647)).rejects.toMatchObject({ code: "patient_not_found" });
});
it("ortho chooser needs its independent view capability and never exposes other patient cases", async () => {
 const s = await scenario(), outside = await scenario(false); expect(outside.ortho).not.toBe(s.ortho); expect((await read("ortho", s)).orthoCases).toEqual([{ id: s.ortho }]); expect((await read("all", s)).orthoCases).toBeNull();
});
it("image pagination retains older choices with an honest keyset cursor and no foreign, removed or nonimage rows", async () => {
 const s = await scenario(); await scenario(false);
 await fx.pool.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) SELECT $1,'imaging','SYN page '||n,'image/png',1,'SYN','SYN/private','SYN' FROM generate_series(1,100) n", [s.patientId]);
 const hidden = (await fx.pool.query("INSERT INTO patient_documents(patient_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,removed_at) VALUES($1,'SYN removed','image/png',1,'SYN','SYN','SYN',NOW()),($1,'SYN pdf','application/pdf',1,'SYN','SYN','SYN',NULL) RETURNING id", [s.patientId])).rows;
 const first = await read("own", s); expect(first.images).toHaveLength(100); expect(first.nextImagesBefore).toBe(first.images.at(-1)!.id); expect(first.images.some(i => hidden.some(h => h.id === i.id))).toBe(false);
 const second = await read("own", s, first.nextImagesBefore); expect(second.images).toEqual([expect.objectContaining({ id: s.documentId, previousStudies: 1 })]); expect(second.nextImagesBefore).toBeNull();
 expect(new Set([...first.images,...second.images].map(i => i.id)).size).toBe(101);
});
it("prior study warning counts only non-discarded studies on that exact owned document", async () => {
 const s = await scenario(); await seedCanonicalCeph(fx.pool, { patientId: s.patientId, documentId: s.documentId, status: "discarded" }); const other = await seedCanonicalCeph(fx.pool, { patientId: s.patientId, status: "draft" });
 const result = await read("own", s); expect(result.hasOpenDraft).toBe(true); expect(result.images.find(i => i.id === s.documentId)?.previousStudies).toBe(1); expect(result.images.find(i => i.id === other.documentId)?.previousStudies).toBe(1);
});
it("whole-case chooser bounds refuse excess only for authorized ortho readers", async () => {
 const s = await scenario(); await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status,closed_at,closed_by) SELECT $1,'SYN','completed',NOW(),'SYN' FROM generate_series(1,299)", [s.patientId]); expect((await read("ortho", s)).orthoCases).toHaveLength(300);
 await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by,status,closed_at,closed_by) VALUES($1,'SYN','completed',NOW(),'SYN')", [s.patientId]); await expect(read("ortho", s)).rejects.toMatchObject({ code: "ceph_read_limit" }); expect((await read("own", s)).orthoCases).toBeNull(); expect((await saved.readCanonicalCephList(await fx.session("ortho"), s.patientId)).analyses).toHaveLength(1);
});
it("oversized stored image title is refused, not truncated or fully materialized into the projection", async () => {
 const s = await scenario(); await fx.pool.query("UPDATE patient_documents SET title=$1 WHERE id=$2", ["x".repeat(2*1024*1024), s.documentId]); await expect(read("owner", s)).rejects.toMatchObject({ code: "ceph_stored_data_invalid" }); expect((await saved.readCanonicalCephList(await fx.session("owner"), s.patientId)).analyses).toHaveLength(1);
});
it("one read-only RR snapshot keeps image metadata and draft state consistent across a concurrent commit", async () => {
 const s = await scenario(), session = await fx.session("own"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema"), original = db.patientInDoctorScopeWith;
 const spy = vi.spyOn(db, "patientInDoctorScopeWith").mockImplementationOnce(async(q, doctor, patient) => {
  expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read"); expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
  await side.query("UPDATE patient_documents SET title='SYN concurrent title' WHERE id=$1", [s.documentId]); await side.query("INSERT INTO ceph_analyses(patient_id,document_id,created_by) VALUES($1,$2,'SYN concurrent')", [s.patientId,s.documentId]); return original(q,doctor,patient);
 });
 try { const result = await reads.readCanonicalCephCreateContext(session,s.patientId); expect(result.images[0].title).toBe("SYN private image title");expect(result.images[0].previousStudies).toBe(1);expect(result.hasOpenDraft).toBe(false);expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled(); }
 finally {spy.mockRestore();connect.mockRestore();query.mockRestore();ensure.mockRestore();}
 const fresh = await read("own",s);expect(fresh.images[0].title).toBe("SYN concurrent title");expect(fresh.images[0].previousStudies).toBe(2);expect(fresh.hasOpenDraft).toBe(true);
});
it("upload revocation behind a real identity fence refuses both stale and fresh creation contexts", async () => {
 const s=await scenario(),session=await fx.session("all"),holder=await side.connect();let pending:Promise<unknown>|undefined;
 try {await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);await holder.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{"clinical.xrays.view":true},patientScope:"all"},2)),fx.ids.all]);pending=reads.readCanonicalCephCreateContext(session,s.patientId);void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await holder.query("COMMIT");await expect(pending).rejects.toThrow(/STALE/);await expect(read("all",s)).rejects.toMatchObject({code:"patient_filter_not_granted"});expect((await saved.readCanonicalCephList(await fx.session("all"),s.patientId)).analyses).toHaveLength(1);}
 finally {await holder.query("ROLLBACK");holder.release();if(pending)await pending.catch(()=>undefined);await fx.setGrants("all",UPLOAD,{patientScope:"all"});}
});
it("expired session waiting on the real fence cannot publish any choices", async () => {
 const s=await scenario(),session=await fx.session("own",1500),holder=await side.connect();let pending:Promise<unknown>|undefined;
 try {await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);pending=reads.readCanonicalCephCreateContext(session,s.patientId);void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await new Promise(r=>setTimeout(r,1700));await holder.query("COMMIT");await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);}
 finally {await holder.query("ROLLBACK");holder.release();if(pending)await pending.catch(()=>undefined);}
});
it("reference chooser accepts the complete200set boundary and refuses201 without silently changing defaults",async()=>{
 const s=await scenario(),base=Number((await fx.pool.query("SELECT count(*)::int n FROM ceph_reference_sets WHERE active=TRUE")).rows[0].n);expect(base).toBeLessThanOrEqual(200);
 try{await fx.pool.query("INSERT INTO ceph_reference_sets(key,name,version,active,created_by) SELECT 'SYN_CCC_REF_'||n,'SYN reference','1',TRUE,'SYN' FROM generate_series(1,$1::int)n",[200-base]);expect((await read("own",s)).referenceSets).toHaveLength(200);await fx.pool.query("INSERT INTO ceph_reference_sets(key,name,version,active,created_by) VALUES('SYN_CCC_REF_over','SYN extra','1',TRUE,'SYN')");await expect(read("own",s)).rejects.toMatchObject({code:"ceph_read_limit"});expect((await saved.readCanonicalCephList(await fx.session("own"),s.patientId)).analyses).toHaveLength(1);}
 finally{await fx.pool.query("DELETE FROM ceph_reference_sets WHERE key LIKE 'SYN_CCC_REF_%'");}
});
it("context reads preserve nonempty financial records, saved studies, source metadata and audits",async()=>{
 const s=await scenario();await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by) VALUES($1,$2,54321,'USD','SYN')",[`SYN-CCC-FIN-${s.id}`,s.patientId]);
 const snapshot=async()=>(await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ceph_analyses a) studies,(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM patient_documents d) documents,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a) audits")).rows;
 const before=await snapshot();await read("owner",s);await read("own",s);expect(await snapshot()).toEqual(before);
});
it("combined bounded choices over2MiB fail closed without changing the independent study reader",async()=>{
 const s=await scenario(),base=Number((await fx.pool.query("SELECT count(*)::int n FROM ceph_reference_sets WHERE active=TRUE")).rows[0].n);
 try{
  await fx.pool.query("UPDATE patient_documents SET title=repeat('x',8000) WHERE id=$1",[s.documentId]);
  await fx.pool.query("INSERT INTO patient_documents(patient_id,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) SELECT $1,repeat('x',8000),'image/png',1,'SYN','SYN','SYN' FROM generate_series(1,99)",[s.patientId]);
  await fx.pool.query("INSERT INTO ceph_reference_sets(key,name,version,active,created_by) SELECT 'SYN_CCC_BYTES_'||n,repeat('x',8000),'1',TRUE,'SYN' FROM generate_series(1,$1::int)n",[200-base]);
  await expect(read("own",s)).rejects.toThrow(/RESULT_BOUNDS/);
  expect((await saved.readCanonicalCephList(await fx.session("own"),s.patientId)).analyses).toHaveLength(1);
 }finally{await fx.pool.query("DELETE FROM ceph_reference_sets WHERE key LIKE 'SYN_CCC_BYTES_%'");}
});
