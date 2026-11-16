/** Slice 48: real PostgreSQL authority, unchanged commercial lineage, isolated RR. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy, capabilityDocument } from "./_canonical-ready-fixture";
import { seedCanonicalCoverage } from "../fixtures/canonical-ortho-coverage";
vi.mock("server-only", () => ({}));
assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-coverage-secret-0123456789abcdef");
const db = await import("../../lib/db"), minimal = await import("../../lib/canonical-ortho-coverage"), reads = await import("../../lib/canonical-ortho-coverage-editor"), store = await import("../../lib/ortho-followup-coverage-db");
const GRANTS = { "finance.agreements.manage": true, "finance.patient-ledger.view": true, "finance.invoices.view": true, "clinical.plans.view": true, "clinical.ortho.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-CED-OWNER", role: "admin" },
  own: { username: "SYN-CED-OWN", role: "doctor", doctor: true, patientScope: "own", grants: GRANTS },
  all: { username: "SYN-CED-ALL", role: "reception", patientScope: "all", grants: GRANTS },
  invoice: { username: "SYN-CED-INVOICE", role: "reception", patientScope: "all", grants: { ...GRANTS, "finance.invoices.view": true } },
  adjacent: { username: "SYN-CED-ADJACENT", role: "admin", patientScope: "all", grants: { "finance.invoices.view": true, "finance.patient-ledger.view": true, "clinical.ortho.view": true } },
  none: { username: "SYN-CED-NONE", role: "doctor", doctor: true, patientScope: "none", grants: GRANTS },
  unlinked: { username: "SYN-CED-UNLINKED", role: "doctor", patientScope: "own", grants: GRANTS },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
const ids = { own: 0, outside: 0 };
let base: Awaited<ReturnType<typeof seedCanonicalCoverage>>;
const episode = (patientId = ids.own, save = true) => seedCanonicalCoverage(fx.pool, { patientId, actorId: fx.ids.owner, doctorId: fx.parties.own!, save });
const read = async (key: Key, f = base) => reads.readCanonicalCoverageEditor(await fx.session(key), f.patient, f.ortho);
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  for (const key of ["own", "outside"] as const) ids[key] = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-CED-${key}`, key === "own" ? fx.parties.own! : null])).rows[0].id;
  base = await episode();
  await fx.pool.query("UPDATE ortho_cases SET status='active' WHERE id=$1",[base.ortho]);
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
it.each(["owner","own","all"]as const)("%s reads the complete minimal explicit source choice",async key=>{
 const result=await read(key);expect(result).toMatchObject({projection:"ortho-followup-coverage-editor",patientId:base.patient,orthoCaseId:base.ortho,enabled:true,canEdit:true,applicable:true,current:{id:base.revision},sources:[base.source]});
 expect(Object.keys(result).sort()).toEqual(["applicable","canEdit","current","enabled","orthoCaseId","patientId","projection","sources"]);expect(Object.keys(result.current!).sort()).toEqual(["createdAt","createdBy","decision","id","reason","version"]);expect(JSON.stringify(result)).not.toMatch(/250000|snapshot|commandId|tooth|private clinical|private plan|phone|medical|requestFingerprint/);
});
it.each(["finance.invoices.view","clinical.plans.view","clinical.ortho.view"]as const)("%s is independent of agreement management; ordinary decision reading stays available",async grant=>{
 await fx.setGrants("all",{...GRANTS,[grant]:false},{patientScope:"all"});try{await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);expect((await minimal.readCanonicalOrthoCoverage(await fx.session("all"),base.patient,base.ortho)).current?.id).toBe(base.revision);}finally{await fx.setGrants("all",GRANTS,{patientScope:"all"});}
});
it.each(["none","unlinked","adjacent"]as const)("%s cannot obtain source context from a legacy role or adjacent grant",async key=>{await expect(read(key)).rejects.toThrow(/SCOPE|PROVIDER|CAPABILITY|UNLINKED/);});
it("missing, foreign and mismatched owner references remain indistinguishable",async()=>{
 const foreign=await episode(ids.outside),failures:unknown[]=[];for(const [patient,ortho]of[[foreign.patient,foreign.ortho],[ids.own,foreign.ortho],[2147483647,base.ortho],[ids.own,2147483647]])try{await reads.readCanonicalCoverageEditor(await fx.session("own"),patient,ortho);throw Error("Unexpected success");}catch(e){failures.push({code:(e as {code:string}).code,message:(e as Error).message});}expect(failures.every(f=>JSON.stringify(f)===JSON.stringify(failures[0]))).toBe(true);expect(failures[0]).toMatchObject({code:"patient_not_found"});
});
it.each(["completed","cancelled"]as const)("%s preserves the record but refuses future editing",async status=>{const s=await episode();await fx.pool.query("UPDATE ortho_cases SET status=$1 WHERE id=$2",[status,s.ortho]);expect(await read("owner",s)).toMatchObject({enabled:true,canEdit:false,current:{id:s.revision},sources:[s.source]});});
it("one fenced RR read-only snapshot contains case state, source fingerprint and authority",async()=>{
 const patient=(await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-CED-SNAPSHOT','SYN snapshot patient',$1) RETURNING id",[fx.parties.own])).rows[0].id;const s=await episode(patient);await fx.pool.query("UPDATE ortho_cases SET status='active' WHERE id=$1",[s.ortho]);const original=store.readFollowupCoverageSnapshotWith,spy=vi.spyOn(store,"readFollowupCoverageSnapshotWith").mockImplementationOnce(async(q,p,c)=>{expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");await side.query("UPDATE ortho_cases SET status='completed' WHERE id=$1",[s.ortho]);await side.query("UPDATE invoices SET total_minor=260000 WHERE id=$1",[s.invoice]);return original(q,p,c);});try{expect(await read("own",s)).toMatchObject({canEdit:true,applicable:true,sources:[s.source]});}finally{spy.mockRestore();}const next=await read("own",s);expect(next).toMatchObject({canEdit:false,applicable:false});expect(next.sources[0].fingerprint).not.toBe(s.source.fingerprint);
});
it("disabled substrate and absent head remain distinct without implicit initialization",async()=>{const s=await episode(ids.own,false);expect(await read("owner",s)).toMatchObject({enabled:true,current:null,applicable:false});await fx.pool.query("ALTER TABLE visits DISABLE TRIGGER ortho_followup_visit_manifest");try{expect(await read("owner",s)).toMatchObject({enabled:false,canEdit:false,current:null,applicable:false,sources:[]});}finally{await fx.pool.query("ALTER TABLE visits ENABLE TRIGGER ortho_followup_visit_manifest");}});
it("all persisted money, signed history and audit stay unchanged; one lease and no legacy wrapper",async()=>{
 const sql="SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ortho_followup_coverage_revisions r) revisions,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a) audit,(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM visits v) visits";const before=(await fx.pool.query(sql)).rows,session=await fx.session("own"),pool=db.getPool(),connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),ensure=vi.spyOn(db,"ensureSchema"),legacy=vi.spyOn(store,"readFollowupCoverage");try{expect((await reads.readCanonicalCoverageEditor(session,base.patient,base.ortho)).sources).toEqual([base.source]);expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();expect(legacy).not.toHaveBeenCalled();}finally{connect.mockRestore();query.mockRestore();ensure.mockRestore();legacy.mockRestore();}expect((await fx.pool.query(sql)).rows).toEqual(before);
});
it("source permission revoked behind the identity fence cannot use the stale session",async()=>{
 const session=await fx.session("all"),holder=await side.connect();let pending:Promise<unknown>|undefined;try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan.canonical.identity.substrate.v1:public',0))");pending=reads.readCanonicalCoverageEditor(session,base.patient,base.ortho);void pending.catch(()=>undefined);expect((await waitForBlockedBy(fx.pool,pid,7000)).length).toBeGreaterThan(0);await holder.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{...GRANTS,"finance.invoices.view":false},patientScope:"all"},50)),fx.ids.all]);await holder.query("COMMIT");await expect(pending).rejects.toThrow(/STALE/);await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);}finally{await holder.query("ROLLBACK");holder.release();await pending?.catch(()=>undefined);await fx.setGrants("all",GRANTS,{patientScope:"all"});}
});
it("2MiB source overflow and excessive label length fail closed without mutating the stored source",async()=>{const s=await episode();for(const size of[8001,2100000]){await fx.pool.query("UPDATE plan_items SET service_name=repeat('x',$1) WHERE id=$2",[size,s.item]);await expect(read("owner",s)).rejects.toThrow("STAFF_READ_READ_FAILED");expect((await fx.pool.query("SELECT length(service_name) n FROM plan_items WHERE id=$1",[s.item])).rows[0].n).toBe(size);}});
it("the complete 256-candidate bound is retained and the next row refuses the entire context",async()=>{const s=await episode(ids.own,false);await fx.pool.query(`INSERT INTO plan_items(plan_id,case_id,service_id,service_name,category,doctor_id,quantity,unit_price_minor,billing_status,billed_invoice_id,origin_invoice_id,origin,session_count) SELECT $1,$2,$3,'SYN source','ortho',$4,1,250000,'billed',$5,$5,'invoice',12 FROM generate_series(1,255)`,[s.plan,s.clinical,s.service,fx.parties.own,s.invoice]);expect((await read("owner",s)).enabled).toBe(true);await fx.pool.query(`INSERT INTO plan_items(plan_id,case_id,service_id,service_name,category,doctor_id,quantity,unit_price_minor,billing_status,billed_invoice_id,origin_invoice_id,origin,session_count) VALUES($1,$2,$3,'SYN source257','ortho',$4,1,250000,'billed',$5,$5,'invoice',12)`,[s.plan,s.clinical,s.service,fx.parties.own,s.invoice]);await expect(read("owner",s)).rejects.toThrow("STAFF_READ_READ_FAILED");});
it("an expired session after materializing choices cannot return them",async()=>{const session=await fx.session("own",1500),original=store.readFollowupCoverageSnapshotWith,spy=vi.spyOn(store,"readFollowupCoverageSnapshotWith").mockImplementationOnce(async(q,p,c)=>{const result=await original(q,p,c);await new Promise(r=>setTimeout(r,1700));return result;});try{await expect(reads.readCanonicalCoverageEditor(session,base.patient,base.ortho)).rejects.toThrow(/SESSION|EXPIRED/);}finally{spy.mockRestore();}});
