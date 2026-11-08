import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { MEASUREMENTS, computeAll, type LandmarkCode } from "../../lib/ceph";
import { cephProvenanceHash, buildCephCompletionWitness, CEPH_ENGINE_VERSION, CEPH_ENGINE_SOURCE_SHA256 } from "../../lib/ceph-completion-provenance";
import type { CephCompletionSnapshot } from "../../lib/ceph-completion-snapshot";
import { validateOwnershipHarnessEnvironment } from "../../scripts/verify-schema-ownership";

// Production module, genuine PostgreSQL locks and synthetic data only.
// Each run owns a disposable database; cleanup never terminates connections.
const database = `aqlan_ceph_sources_${randomUUID().replace(/-/g, "")}`;
let maintenanceUrl: string;
let created = false;
let db: typeof import("../../lib/db") | undefined;
let fixtureNumber = 0;

beforeAll(async () => {
  const target = validateOwnershipHarnessEnvironment();
  if ([...target.testUrl.searchParams.keys()].some((key) => key !== "sslmode")) {
    throw new Error("Unexpected test connection override.");
  }
  if (!/^aqlan_ceph_sources_[a-f0-9]{32}$/.test(database)) throw new Error("Unsafe fixture database name.");
  maintenanceUrl = target.maintenanceUrl.toString();
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
  } finally {
    await admin.end();
  }
  target.testUrl.pathname = `/${database}`;
  vi.stubEnv("DATABASE_URL", target.testUrl.toString());
  vi.stubEnv("DATABASE_ENVIRONMENT", "test");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("USE_LOCAL_DB", "false");
  vi.stubEnv("SKIP_SEED", "true");
  vi.stubEnv("SESSION_SECRET", "synthetic-only-ceph-provenance-session-secret");
  db = await import("../../lib/db");
  await db.resetPoolForTesting();
  await db.ensureSchema();
});

/** pool.end() may finish before all backend sockets have disconnected. */
async function waitForFixtureConnectionsToClose(admin: Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const { rows: [row] } = await admin.query<{ connection_count: number }>(
      "SELECT count(*)::int AS connection_count FROM pg_stat_activity WHERE datname = $1",
      [database],
    );
    if (row.connection_count === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out draining owned ceph fixture ${database}: ${row.connection_count} connections remain`);
    }
    await delay(25);
  }
}

afterAll(async () => {
  try {
    await db?.resetPoolForTesting();
  } finally {
    vi.unstubAllEnvs();
    if (created) {
      const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
      await admin.connect();
      try {
        await waitForFixtureConnectionsToClose(admin);
        // A new/unexpected connection must fail cleanup, never be force-killed.
        await admin.query(`DROP DATABASE ${database}`);
      }
      finally { await admin.end(); }
    }
  }
});

const VALID = {
  S: { x: 100, y: 100 }, N: { x: 169, y: 92 }, A: { x: 167.57, y: 151.98 },
  B: { x: 163.84, y: 179.85 }, Pog: { x: 164.03, y: 186.87 }, Me: { x: 160, y: 205 },
  Go: { x: 82.97, y: 169.08 }, Or: { x: 160, y: 125 }, Po: { x: 100, y: 125 },
  U1A: { x: 160, y: 134 }, U1: { x: 174.08, y: 171.44 },
  L1A: { x: 149, y: 199.2 }, L1: { x: 168, y: 164 },
  OcclA: { x: 170, y: 148 }, OcclP: { x: 100, y: 135.3 }, Gn: { x: 161.5, y: 195.5 },
};
async function fixture() {
  const n = ++fixtureNumber, pool = db!.getPool(), username = `synthetic-ceph-${n}`;
  const actor = (await pool.query<{id:number}>(`INSERT INTO users(username,display_name,password_hash,role)
    VALUES($1,$1,'synthetic-hash','admin') RETURNING id`, [username])).rows[0];
  const session: SessionPayload = { userId: actor.id, username, role: "admin", expiresAt: Date.now() + 60_000,
    credentialVersion: sessionCredentialVersion("synthetic-hash") };
  const patient = (await pool.query<{id:number}>(`INSERT INTO patients(patient_number,full_name,birth_year)
    VALUES($1,'Synthetic provenance patient',1990) RETURNING id`, [username])).rows[0];
  const sha = createHash("sha256").update(`synthetic-image-${n}`).digest("hex");
  const document = (await pool.query<{id:number}>(`INSERT INTO patient_documents
    (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
    VALUES($1,'imaging','Synthetic image','image/jpeg',123,$2,$3,$4) RETURNING id`,
    [patient.id, sha, `synthetic/no-file-${n}.jpg`, username])).rows[0];
  const refKey = `synthetic_ref_${n}`;
  const reference = (await pool.query<{id:number}>(`INSERT INTO ceph_reference_sets(key,name,population,version,created_by)
    VALUES($1,'Synthetic reference','synthetic population','synthetic-v1',$2) RETURNING id`, [refKey, username])).rows[0];
  for (const def of MEASUREMENTS) if (def.mean != null && def.tol != null && def.tol > 0) {
    await pool.query("INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,$2,$3,$4)", [reference.id, def.code, def.mean, def.tol]);
  }
  const analysis = (await pool.query<{id:number}>(`INSERT INTO ceph_analyses
    (patient_id,document_id,created_by,ref_set,mm_per_pixel,cal_x1,cal_y1,cal_x2,cal_y2,cal_mm)
    VALUES($1,$2,$3,$4,1,0,0,100,0,100) RETURNING id`, [patient.id, document.id, username, refKey])).rows[0];
  for (const [code, point] of Object.entries(VALID)) await pool.query(
    "INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,$2,$3,$4,'manual',$5)", [analysis.id, code, point.x, point.y, username]);
  const diagnosis = { skeletal: "Synthetic skeletal", dental: null, softTissue: null, note: null, finalDx: "Synthetic reviewed diagnosis" };
  await pool.query("INSERT INTO ceph_diagnoses(analysis_id,skeletal,final_dx,created_by) VALUES($1,$2,$3,$4)",
    [analysis.id, diagnosis.skeletal, diagnosis.finalDx, username]);
  const snapshot: CephCompletionSnapshot = { patientId: patient.id, documentId: document.id, refSet: refKey,
    calibration: { x1:0,y1:0,x2:100,y2:0,mm:100 }, mmPerPixel: 1,
    landmarks: Object.entries(VALID).map(([code, point]) => ({code:code as LandmarkCode, ...point, source: "manual"})), diagnosis };
  const analysisId = Number(analysis.id);
  if (!Number.isSafeInteger(analysisId) || analysisId <= 0) throw new Error("Unsafe synthetic analysis ID");
  // Test-owned declared display snapshot, not a submission-time production reread.
  const referenceSet={key:refKey,name:"Synthetic reference",population:"synthetic population",ageMin:null,ageMax:null,sex:null,version:"synthetic-v1",active:true,
    values:MEASUREMENTS.filter(d=>d.mean!=null&&d.tol!=null&&d.tol>0).map(d=>({code:d.code,mean:d.mean!,sd:d.tol!})).sort((a,b)=>a.code<b.code?-1:a.code>b.code?1:0)};
  const expectedSources={schemaVersion:1 as const,documentId:document.id,imageSha256:sha,referenceSetKey:refKey,referenceSetSha256:cephProvenanceHash(referenceSet),engineVersion:CEPH_ENGINE_VERSION,engineSourceSha256:CEPH_ENGINE_SOURCE_SHA256};
  return {expectedSources,referenceSet,id:analysisId,patientId:patient.id,documentId:document.id,referenceId:reference.id,session,snapshot,sha};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const complete = (f: Fixture, snapshot = f.snapshot, session = f.session) => db!.completeCephAnalysis(f.id, session.username, snapshot, session, f.expectedSources);
async function state(id:number) {
  const pool = db!.getPool();
  return {
    analysis: (await pool.query("SELECT * FROM ceph_analyses WHERE id=$1", [id])).rows[0],
    witness: (await pool.query("SELECT * FROM ceph_completion_provenance WHERE analysis_id=$1", [id])).rows,
    measurements: (await pool.query("SELECT * FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code", [id])).rows,
    audit: (await pool.query("SELECT * FROM audit_log WHERE entity='ceph_analysis' AND entity_id=$1 ORDER BY id", [String(id)])).rows,
  };
}


describe("displayed source identity CAS on PostgreSQL",()=>{
  it("rejects a same-version catalog edit after the displayed source snapshot",async()=>{
    const f=await fixture();await db!.getPool().query("UPDATE ceph_reference_values SET mean=mean+1 WHERE set_id=$1 AND code='SNA'",[f.referenceId]);
    const before=await state(f.id);expect((await complete(f)).ok).toBe(false);expect(await state(f.id)).toEqual(before);
  });
  it.each(["image_digest","reference_metadata","reference_membership","reference_deletion","engine_version","engine_digest"])("rejects unseen %s changes without a completion or audit",async(kind)=>{
    const f=await fixture();
    if(kind==="image_digest")await db!.getPool().query("UPDATE patient_documents SET sha256=$2 WHERE id=$1",[f.documentId,"b".repeat(64)]);
    if(kind==="reference_metadata")await db!.getPool().query("UPDATE ceph_reference_sets SET population='unseen cohort' WHERE id=$1",[f.referenceId]);
    if(kind==="reference_membership")await db!.getPool().query("INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,'UNSEEN',1,1)",[f.referenceId]);
    if(kind==="reference_deletion")await db!.getPool().query("DELETE FROM ceph_reference_values WHERE set_id=$1 AND code='SNA'",[f.referenceId]);
    if(kind==="engine_version")f.expectedSources.engineVersion="older-engine";
    if(kind==="engine_digest")f.expectedSources.engineSourceSha256="b".repeat(64);
    const before=await state(f.id);expect((await complete(f)).ok).toBe(false);expect(await state(f.id)).toEqual(before);
  });
  it("requires explicit source identity for every new draft completion",async()=>{
    const f=await fixture(),before=await state(f.id);
    expect((await db!.completeCephAnalysis(f.id,f.session.username,f.snapshot,f.session,null)).ok).toBe(false);
    expect(await state(f.id)).toEqual(before);
  });
  it("binds exact returned display references to identity and saves v2 only for a matching submission",async()=>{
    const f=await fixture(),sources=(await db!.getCephStudy(f.id))?.completionSources;
    expect(sources).toEqual({state:"available",identity:f.expectedSources,referenceSet:f.referenceSet});
    const result=await complete(f);expect(result.ok).toBe(true);
    const saved=await state(f.id);expect(saved.witness[0].schema_version).toBe(2);
    expect(saved.witness[0].witness.sourceReview).toEqual({schemaVersion:1,identity:f.expectedSources});
    expect(saved.witness[0].witness.sourceIdentityMeaning).toBe("submitted_source_identity_matches_server_capture");
    expect(saved.witness[0].witness.referenceSet).toEqual(f.referenceSet);
  });
  it("exact v2 retry uses original source identity after catalog changes, never a newly fetched substitute",async()=>{
    const f=await fixture();expect((await complete(f)).ok).toBe(true);const before=await state(f.id);
    await db!.getPool().query("UPDATE ceph_reference_values SET mean=mean+2 WHERE set_id=$1 AND code='SNA'",[f.referenceId]);
    expect((await complete(f)).ok).toBe(true);expect(await state(f.id)).toEqual(before);
    expect((await db!.completeCephAnalysis(f.id,f.session.username,f.snapshot,f.session,null)).ok).toBe(false);
    const replacement={...f.expectedSources,referenceSetSha256:"b".repeat(64)};
    expect((await db!.completeCephAnalysis(f.id,f.session.username,f.snapshot,f.session,replacement)).ok).toBe(false);
    expect(await state(f.id)).toEqual(before);
  });
  it("an exact historical v1 retry cannot promote the stored assurance",async()=>{
    const f=await fixture(),pool=db!.getPool();
    const reviews=(await pool.query<{code:string;confirmedBy:string;confirmedAt:string}>(`SELECT code,confirmed_by AS "confirmedBy",to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "confirmedAt" FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code`,[f.id])).rows;
    const measurements=computeAll(VALID,1).filter(r=>r.value!==null).map(r=>({code:r.code,value:r.value!}));
    const witness=buildCephCompletionWitness({analysisId:f.id,actor:{userId:f.session.userId,username:f.session.username},sealedAt:new Date().toISOString(),snapshot:f.snapshot,
      image:{documentId:f.documentId,sha256:f.sha,width:null,height:null},landmarkReviews:reviews,referenceSet:f.referenceSet,measurements});
    const client=await pool.connect();try{
      await client.query("BEGIN");
      for(const row of measurements)await client.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,$2,$3)",[f.id,row.code,row.value]);
      await client.query("UPDATE ceph_analyses SET status='completed',completed_by=$2,completed_at=$3::timestamptz WHERE id=$1",[f.id,f.session.username,witness.sealedAt]);
      await client.query("INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,actor_user_id,sealed_by,sealed_at) VALUES($1,1,$2::jsonb,$3,$4,$5,$6::timestamptz)",[f.id,JSON.stringify(witness),cephProvenanceHash(witness),f.session.userId,f.session.username,witness.sealedAt]);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    const before=await state(f.id);const result=await db!.completeCephAnalysis(f.id,f.session.username,f.snapshot,f.session,null);
    expect(result.ok).toBe(true);expect(result.provenance).toMatchObject({state:"versioned",witness:{schemaVersion:1,sourceIdentityMeaning:"server_captured_at_completion_not_confirmed_as_viewed"}});
    expect(await state(f.id)).toEqual(before);expect((await state(f.id)).witness[0].witness.sourceReview).toBeUndefined();
  });
  it.each(["reference","image"])("observes an in-flight %s source edit and rejects the stale review",async(kind)=>{
    const f=await fixture(),pool=db!.getPool(),blocker=await pool.connect();let pending:ReturnType<typeof complete>|undefined;
    try{
      await blocker.query("BEGIN");
      const blockerPid=(await blocker.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      if(kind==="reference")await blocker.query("UPDATE ceph_reference_values SET mean=mean+1 WHERE set_id=$1 AND code='SNA'",[f.referenceId]);
      else await blocker.query("UPDATE patient_documents SET sha256=$2 WHERE id=$1",[f.documentId,"b".repeat(64)]);
      const before=await state(f.id);pending=complete(f);const deadline=Date.now()+5_000;
      while(true){
        const waiting=(await pool.query<{waiting:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting",[kind==="reference"?"LOCK TABLE ceph_reference_sets, ceph_reference_values%":"%FROM patient_documents%FOR SHARE%",blockerPid]).then(r=>r.rows[0].waiting));
        if(waiting)break;if(Date.now()>deadline)throw new Error("Expected source lock wait was not observed");await delay(20);
      }
      await blocker.query("COMMIT");expect((await pending).ok).toBe(false);expect(await state(f.id)).toEqual(before);
    }finally{await blocker.query("ROLLBACK").catch(()=>undefined);blocker.release();await pending?.catch(()=>undefined);}
  });
  it.each(["reference","image"])("holds %s source locks through the atomic seal commit",async(kind)=>{
    const f=await fixture(),pool=db!.getPool(),auditBarrier=await pool.connect(),editor=await pool.connect();
    let pending:ReturnType<typeof complete>|undefined,editing:Promise<unknown>|undefined;
    const waitFor = async (sql:string,values:unknown[]) => {
      const deadline=Date.now()+5_000;
      while(true) {
        // Statistics snapshots persist for the observing transaction; refresh
        // them without borrowing a fourth connection from the bounded pool.
        await auditBarrier.query("SELECT pg_stat_clear_snapshot()");
        if((await auditBarrier.query<{waiting:boolean}>(sql,values)).rows[0].waiting)return;
        if(Date.now()>deadline)throw new Error("Expected transaction lock wait was not observed");
        await delay(20);
      }
    };
    try {
      // Block only the final audit INSERT, after source capture and witness write.
      // The uncommitted seal must continue to retain both source locks.
      await auditBarrier.query("BEGIN");await auditBarrier.query("LOCK TABLE audit_log IN SHARE MODE");
      const barrierPid=(await auditBarrier.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending=complete(f);
      await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%INSERT INTO audit_log%' AND $1=ANY(pg_blocking_pids(pid))) AS waiting",[barrierPid]);
      const sealingPid=(await auditBarrier.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%INSERT INTO audit_log%' AND $1=ANY(pg_blocking_pids(pid))",[barrierPid])).rows[0].pid;
      const editorPid=(await editor.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      editing=kind==="reference"
        ? editor.query("UPDATE ceph_reference_values SET mean=mean+1 WHERE set_id=$1 AND code='SNA'",[f.referenceId])
        : editor.query("UPDATE patient_documents SET sha256=$2 WHERE id=$1",[f.documentId,"b".repeat(64)]);
      await waitFor("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid))) AS waiting",[editorPid,sealingPid]);
      expect((await auditBarrier.query("SELECT analysis_id FROM ceph_completion_provenance WHERE analysis_id=$1",[f.id])).rows).toEqual([]);
      await auditBarrier.query("COMMIT");expect((await pending).ok).toBe(true);await editing;
      const saved=await state(f.id);
      expect(saved.analysis.status).toBe("completed");
      expect(saved.witness[0].witness.sourceReview.identity).toEqual(f.expectedSources);
      expect(saved.witness[0].witness.referenceSet).toEqual(f.referenceSet);
      expect(saved.witness[0].witness.image.sha256).toBe(f.sha);
      expect(saved.audit).toHaveLength(1);
    } finally {
      await auditBarrier.query("ROLLBACK").catch(()=>undefined);auditBarrier.release();
      await pending?.catch(()=>undefined);await editing?.catch(()=>undefined);editor.release();
    }
  });

});
