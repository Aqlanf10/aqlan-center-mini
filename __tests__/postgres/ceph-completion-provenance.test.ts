import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { computeAll, MEASUREMENTS, type LandmarkCode } from "../../lib/ceph";
import { CEPH_ENGINE_VERSION } from "../../lib/ceph-engine-identity";
import { cephProvenanceHash, buildCephCompletionWitness } from "../../lib/ceph-completion-provenance";
import { parseCephCompletionSnapshot } from "../../lib/ceph-completion-snapshot";
import type { CephCompletionSnapshot } from "../../lib/ceph-completion-snapshot";
import { validateOwnershipHarnessEnvironment } from "../../scripts/verify-schema-ownership";

// Production module, genuine PostgreSQL locks and synthetic data only.
// Each run owns a disposable database; cleanup never terminates connections.
const database = `aqlan_ceph_provenance_${randomUUID().replace(/-/g, "")}`;
let maintenanceUrl: string;
let created = false;
let db: typeof import("../../lib/db") | undefined;
let fixtureNumber = 0;

beforeAll(async () => {
  const target = validateOwnershipHarnessEnvironment();
  if ([...target.testUrl.searchParams.keys()].some((key) => key !== "sslmode")) {
    throw new Error("Unexpected test connection override.");
  }
  if (!/^aqlan_ceph_provenance_[a-f0-9]{32}$/.test(database)) throw new Error("Unsafe fixture database name.");
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
  const sources = (await db!.getCephStudy(analysisId))?.completionSources;
  if (sources?.state !== "available") throw new Error("Synthetic completion source identity unavailable");
  return { expectedSources: sources.identity, id: analysisId, patientId: patient.id, documentId: document.id, referenceId: reference.id, session, snapshot, sha };
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

describe("future ceph completion provenance on real PostgreSQL 18", () => {
  it("shared readiness rejects all-present coincident draft geometry without completion effects", async () => {
    const f = await fixture();
    await db!.getPool().query("UPDATE ceph_landmarks SET x=100,y=100 WHERE analysis_id=$1",[f.id]);
    f.snapshot.landmarks=f.snapshot.landmarks.map(point=>({...point,x:100,y:100}));
    const before=await state(f.id);
    const result=await complete(f);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("SNA");
    expect(await state(f.id)).toEqual(before);
  });

  it("writes only descriptive future audit labels while preserving historical evidence and authored diagnosis", async () => {
    const f = await fixture(), pool = db!.getPool();
    await pool.query("UPDATE ceph_reference_values SET mean=95,sd=3 WHERE set_id=$1 AND code='SNA'", [f.referenceId]);
    const reviewed = (await db!.getCephStudy(f.id))!;
    expect(reviewed.completionSources?.state).toBe("available");
    if (reviewed.completionSources?.state !== "available") throw new Error("Missing synthetic selected source");
    expect(reviewed.completionSources.referenceSet.values.find(row => row.code === "SNA")?.mean).toBe(95);
    f.expectedSources = reviewed.completionSources.identity;
    // Synthetic historical sentinel only: an old stored audit must not be
    // rewritten merely because new output no longer generates classifications.
    const prior = (await pool.query(`INSERT INTO audit_log(action,entity,entity_id,summary,actor,created_at)
      VALUES('ceph.complete','ceph_analysis',$1,'Synthetic historical Class III label, preserve verbatim','synthetic-history','2020-01-01T00:00:00Z')
      RETURNING *`, [String(f.id)])).rows[0];
    const diagnosisBefore = (await pool.query("SELECT * FROM ceph_diagnoses WHERE analysis_id=$1", [f.id])).rows;
    const expectedValues = computeAll(VALID, 1).filter(row => row.value !== null)
      .map(row => ({code:row.code,value:row.value})).sort((a,b) => a.code.localeCompare(b.code));
    expect((await complete(f)).ok).toBe(true);
    const sealed = await state(f.id);
    expect(sealed.audit).toHaveLength(2);
    expect(sealed.audit[0]).toEqual(prior);
    expect((await pool.query("SELECT * FROM ceph_diagnoses WHERE analysis_id=$1", [f.id])).rows).toEqual(diagnosisBefore);
    expect(sealed.measurements.map(row => ({code:row.code,value:row.value})).sort((a,b) => a.code.localeCompare(b.code)))
      .toEqual(expectedValues);
    expect(sealed.witness[0].witness.snapshot.diagnosis).toEqual(f.snapshot.diagnosis);
    expect(sealed.witness[0].witness.referenceSet.values.find((row:{code:string;mean:number}) => row.code === "SNA")?.mean).toBe(95);
    expect(sealed.witness[0].witness_sha256).toBe(cephProvenanceHash(sealed.witness[0].witness));
    expect(sealed.audit[1].summary).toContain("ANB");
    expect(sealed.audit[1].summary).toContain("FMA");
    expect.soft(sealed.audit[1].summary).not.toMatch(/Class (?:I|II|III)|ميل لعلاقة هيكلية|صنف (?:أول|ثان|ثالث)|Normodivergent|Hyperdivergent|Hypodivergent|prognathic|retrognathic/);
    expect((await complete(f)).ok).toBe(true);
    expect(await state(f.id)).toEqual(sealed);
  });
  it("persists and reopens calibrated L1_APOG with noncohort evidence and no injected norm", async () => {
    const f = await fixture(), pool = db!.getPool();
    // A malicious/inapplicable catalog row must not convert a descriptive
    // distance into a population target. Re-review the changed catalog identity.
    await pool.query("INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,'L1_APOG',99,0.01)", [f.referenceId]);
    const reviewed = await db!.getCephStudy(f.id);
    if (reviewed?.completionSources?.state !== "available") throw new Error("Synthetic source identity unavailable");
    f.expectedSources = reviewed.completionSources.identity;
    const completed = await complete(f);
    expect(completed.ok).toBe(true);
    // Independently evaluated VALID fixture: A-Pog=(-3.54,34.89),
    // L1-A=(0.43,12.02): signed perpendicular1.6411443394mm at1mm/px.
    // Existing persisted display rule rounds the final result to1.6mm.
    const saved = await state(f.id);
    expect(saved.measurements.filter(row => row.code === "L1_APOG")).toEqual([
      expect.objectContaining({code:"L1_APOG",value:1.6}),
    ]);
    const witness = saved.witness[0].witness;
    expect(witness.measurements.find((row:{code:string}) => row.code === "L1_APOG")).toMatchObject({
      code:"L1_APOG",value:1.6,unit:"mm",
      algorithm:{id:"aqlan-ceph:L1_APOG",version:CEPH_ENGINE_VERSION,calculationVersion:"l1-apog-perpendicular-snme-v1"},
      reference:{origin:"descriptive_measurement_only",mean:null,sd:null,populationReference:null,patientSpecificSuitability:"not_validated"},
    });
    expect(witness.referenceSet.values.find((row:{code:string}) => row.code === "L1_APOG")).toEqual({code:"L1_APOG",mean:99,sd:0.01});
    expect(saved.witness[0].witness_sha256).toBe(cephProvenanceHash(witness));
    const reopened = await db!.getCephStudy(f.id);
    expect(reopened?.measurements.find(row => row.code === "L1_APOG")).toEqual({code:"L1_APOG",value:1.6});
    expect(reopened?.provenance).toEqual({state:"versioned",witness,witnessSha256:saved.witness[0].witness_sha256});
    expect(await state(f.id)).toEqual(saved);
    expect((await complete(f)).ok).toBe(true);
    expect(await state(f.id)).toEqual(saved);
  });
  it("persists direct anterior lengths, neutral evidence and unchanged ratios through reopen and exact replay", async () => {
    const f = await fixture(), pool = db!.getPool();
    // Independent integer fixture: N-Me=(6,8), length10; ANS-Me=(0,8),
    // length8; S-Go=(0,6), length6. Calibration1mm/px gives10mm/8mm,
    // unchanged LAFH80% and JARABAK60%, not a projected height.
    const changed = {N:{x:0,y:0},ANS:{x:6,y:0},Me:{x:6,y:8},S:{x:-10,y:0},Go:{x:-10,y:6}};
    for (const [code, point] of Object.entries(changed)) {
      await pool.query(`INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by)
        VALUES($1,$2,$3,$4,'manual',$5)
        ON CONFLICT(analysis_id,code) DO UPDATE SET x=EXCLUDED.x,y=EXCLUDED.y`,
        [f.id,code,point.x,point.y,f.session.username]);
    }
    f.snapshot.landmarks = [
      ...f.snapshot.landmarks.filter(row => !Object.hasOwn(changed,row.code)),
      ...Object.entries(changed).map(([code,point]) => ({code:code as LandmarkCode,...point,source:"manual" as const})),
    ];
    for (const code of ["AFH_N_ME","LAFH_ANS_ME"]) await pool.query(
      "INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,$2,99,0.01)", [f.referenceId,code]);
    const reviewed = await db!.getCephStudy(f.id);
    if (reviewed?.completionSources?.state !== "available") throw new Error("Synthetic source identity unavailable");
    f.expectedSources = reviewed.completionSources.identity;
    expect((await complete(f)).ok).toBe(true);
    const saved = await state(f.id), witness = saved.witness[0].witness;
    for (const [code,value] of [["AFH_N_ME",10],["LAFH_ANS_ME",8]] as const) {
      expect(saved.measurements.find(row => row.code === code)).toMatchObject({code,value});
      expect(witness.measurements.find((row:{code:string}) => row.code === code)).toMatchObject({
        code,value,unit:"mm",
        algorithm:{id:`aqlan-ceph:${code}`,version:CEPH_ENGINE_VERSION,calculationVersion:"anterior-direct-length-v1"},
        reference:{origin:"descriptive_measurement_only",mean:null,sd:null,populationReference:null,patientSpecificSuitability:"not_validated"},
      });
      expect(witness.referenceSet.values.find((row:{code:string}) => row.code === code)).toEqual({code,mean:99,sd:0.01});
    }
    for (const [code,value] of [["LAFH",80],["JARABAK",60]] as const) {
      expect(saved.measurements.find(row => row.code === code)).toMatchObject({code,value});
      expect(witness.measurements.find((row:{code:string}) => row.code === code)).toMatchObject({code,value,unit:"%"});
    }
    expect(saved.witness[0].witness_sha256).toBe(cephProvenanceHash(witness));
    const reopened = await db!.getCephStudy(f.id);
    expect(reopened?.measurements).toEqual(expect.arrayContaining([
      {code:"AFH_N_ME",value:10},{code:"LAFH_ANS_ME",value:8},{code:"LAFH",value:80},{code:"JARABAK",value:60},
    ]));
    expect(reopened?.provenance).toEqual({state:"versioned",witness,witnessSha256:saved.witness[0].witness_sha256});
    expect(await state(f.id)).toEqual(saved);
    expect((await complete(f)).ok).toBe(true);
    expect(await state(f.id)).toEqual(saved);
  });
  it("persists bony palatal length with neutral provenance through reopen and replay", async () => {
    const f = await fixture(), pool = db!.getPool();
    // Direct independent3-4-5 segment,1mm/px. Not horizontal3 or vertical4.
    for (const [code,x,y] of [["ANS",2,1],["PNS",5,5]] as const) {
      await pool.query(`INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by)
        VALUES($1,$2,$3,$4,'manual',$5)
        ON CONFLICT(analysis_id,code) DO UPDATE SET x=EXCLUDED.x,y=EXCLUDED.y`,
        [f.id,code,x,y,f.session.username]);
    }
    f.snapshot.landmarks = [
      ...f.snapshot.landmarks.filter(row => row.code !== "ANS" && row.code !== "PNS"),
      {code:"ANS",x:2,y:1,source:"manual"},{code:"PNS",x:5,y:5,source:"manual"},
    ];
    await pool.query("INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,'PALATAL_ANS_PNS',99,0.01)", [f.referenceId]);
    const reviewed = await db!.getCephStudy(f.id);
    if (reviewed?.completionSources?.state !== "available") throw new Error("Synthetic source identity unavailable");
    f.expectedSources = reviewed.completionSources.identity;
    expect((await complete(f)).ok).toBe(true);
    const saved = await state(f.id), witness = saved.witness[0].witness;
    expect(saved.measurements.find(row => row.code === "PALATAL_ANS_PNS")).toMatchObject({code:"PALATAL_ANS_PNS",value:5});
    expect(witness.measurements.find((row:{code:string}) => row.code === "PALATAL_ANS_PNS")).toMatchObject({
      code:"PALATAL_ANS_PNS",value:5,unit:"mm",
      algorithm:{id:"aqlan-ceph:PALATAL_ANS_PNS",version:CEPH_ENGINE_VERSION,calculationVersion:"palatal-direct-length-v1"},
      reference:{origin:"descriptive_measurement_only",mean:null,sd:null,populationReference:null,patientSpecificSuitability:"not_validated"},
    });
    expect(witness.referenceSet.values.find((row:{code:string}) => row.code === "PALATAL_ANS_PNS")).toEqual({code:"PALATAL_ANS_PNS",mean:99,sd:0.01});
    expect(saved.witness[0].witness_sha256).toBe(cephProvenanceHash(witness));
    const reopened = await db!.getCephStudy(f.id);
    expect(reopened?.measurements.find(row => row.code === "PALATAL_ANS_PNS")).toEqual({code:"PALATAL_ANS_PNS",value:5});
    expect(reopened?.provenance).toEqual({state:"versioned",witness,witnessSha256:saved.witness[0].witness_sha256});
    expect(await state(f.id)).toEqual(saved);
    expect((await complete(f)).ok).toBe(true);
    expect(await state(f.id)).toEqual(saved);
  });
  it("persists the posterior U1-PP angle without folding and reopens/replays exact evidence", async () => {
    const f = await fixture(), pool = db!.getPool();
    // Posterior palatal ray(-2,0), apex-to-edge ray(1,sqrt3):
    // dot=-2, magnitudes2*2 =>cos=-1/2 =>120deg, not60deg.
    const changed = {ANS:{x:0,y:0},PNS:{x:-2,y:0},U1A:{x:3,y:4},U1:{x:4,y:4+Math.sqrt(3)}};
    for (const [code,point] of Object.entries(changed)) await pool.query(
      `INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by)
       VALUES($1,$2,$3,$4,'manual',$5)
       ON CONFLICT(analysis_id,code) DO UPDATE SET x=EXCLUDED.x,y=EXCLUDED.y`,
      [f.id,code,point.x,point.y,f.session.username]);
    f.snapshot.landmarks = [
      ...f.snapshot.landmarks.filter(row => !Object.hasOwn(changed,row.code)),
      ...Object.entries(changed).map(([code,point]) => ({code:code as LandmarkCode,...point,source:"manual" as const})),
    ];
    await pool.query("INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,'U1_PP',99,0.01)", [f.referenceId]);
    const reviewed = await db!.getCephStudy(f.id);
    if (reviewed?.completionSources?.state !== "available") throw new Error("Synthetic source identity unavailable");
    f.expectedSources = reviewed.completionSources.identity;
    expect((await complete(f)).ok).toBe(true);
    const saved = await state(f.id), witness = saved.witness[0].witness;
    expect(saved.measurements.find(row => row.code === "U1_PP")).toMatchObject({code:"U1_PP",value:120});
    expect(witness.measurements.find((row:{code:string}) => row.code === "U1_PP")).toMatchObject({
      code:"U1_PP",value:120,unit:"°",
      algorithm:{id:"aqlan-ceph:U1_PP",version:CEPH_ENGINE_VERSION,calculationVersion:"u1-pp-posterior-v1"},
      reference:{origin:"descriptive_measurement_only",mean:null,sd:null,populationReference:null,patientSpecificSuitability:"not_validated"},
    });
    expect(witness.referenceSet.values.find((row:{code:string}) => row.code === "U1_PP")).toEqual({code:"U1_PP",mean:99,sd:0.01});
    expect(saved.witness[0].witness_sha256).toBe(cephProvenanceHash(witness));
    const reopened = await db!.getCephStudy(f.id);
    expect(reopened?.measurements.find(row => row.code === "U1_PP")).toEqual({code:"U1_PP",value:120});
    expect(reopened?.provenance).toEqual({state:"versioned",witness,witnessSha256:saved.witness[0].witness_sha256});
    expect(await state(f.id)).toEqual(saved);
    expect((await complete(f)).ok).toBe(true);
    expect(await state(f.id)).toEqual(saved);
  });
  it("persists the acute L1-APog axis angle with supplementary folding and reopens/replays exact evidence", async () => {
    const f = await fixture(), pool = db!.getPool();
    // A-Pog ray(-2,0), lower edge-to-apex ray(1,sqrt3):
    // dot=-2, magnitudes2*2 =>120deg; acute-axis protocol gives60deg.
    const changed = {A:{x:0,y:0},Pog:{x:-2,y:0},L1:{x:3,y:4},L1A:{x:4,y:4+Math.sqrt(3)}};
    for (const [code,point] of Object.entries(changed)) await pool.query(
      `INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by)
       VALUES($1,$2,$3,$4,'manual',$5)
       ON CONFLICT(analysis_id,code) DO UPDATE SET x=EXCLUDED.x,y=EXCLUDED.y`,
      [f.id,code,point.x,point.y,f.session.username]);
    f.snapshot.landmarks = [
      ...f.snapshot.landmarks.filter(row => !Object.hasOwn(changed,row.code)),
      ...Object.entries(changed).map(([code,point]) => ({code:code as LandmarkCode,...point,source:"manual" as const})),
    ];
    await pool.query("INSERT INTO ceph_reference_values(set_id,code,mean,sd) VALUES($1,'L1_APOG_ANGLE',99,0.01)", [f.referenceId]);
    const reviewed = await db!.getCephStudy(f.id);
    if (reviewed?.completionSources?.state !== "available") throw new Error("Synthetic source identity unavailable");
    f.expectedSources = reviewed.completionSources.identity;
    expect((await complete(f)).ok).toBe(true);
    const saved = await state(f.id), witness = saved.witness[0].witness;
    expect(saved.measurements.find(row => row.code === "L1_APOG_ANGLE")).toMatchObject({code:"L1_APOG_ANGLE",value:60});
    expect(witness.measurements.find((row:{code:string}) => row.code === "L1_APOG_ANGLE")).toMatchObject({
      code:"L1_APOG_ANGLE",value:60,unit:"°",
      algorithm:{id:"aqlan-ceph:L1_APOG_ANGLE",version:CEPH_ENGINE_VERSION,calculationVersion:"l1-apog-acute-axis-v1"},
      reference:{origin:"descriptive_measurement_only",mean:null,sd:null,populationReference:null,patientSpecificSuitability:"not_validated"},
    });
    expect(witness.referenceSet.values.find((row:{code:string}) => row.code === "L1_APOG_ANGLE")).toEqual({code:"L1_APOG_ANGLE",mean:99,sd:0.01});
    expect(saved.witness[0].witness_sha256).toBe(cephProvenanceHash(witness));
    const reopened = await db!.getCephStudy(f.id);
    expect(reopened?.measurements.find(row => row.code === "L1_APOG_ANGLE")).toEqual({code:"L1_APOG_ANGLE",value:60});
    expect(reopened?.provenance).toEqual({state:"versioned",witness,witnessSha256:saved.witness[0].witness_sha256});
    expect(await state(f.id)).toEqual(saved);
    expect((await complete(f)).ok).toBe(true);
    expect(await state(f.id)).toEqual(saved);
  });
  it("refuses correction-copy of a versioned source whose landmarks no longer match its seal", async () => {
    const f = await fixture(), pool = db!.getPool();
    expect((await complete(f)).ok).toBe(true);
    await pool.query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1 AND code='N'",[f.id]);
    expect((await db!.getCephStudy(f.id))?.provenance.state).toBe("integrity_unavailable");
    const before = await state(f.id);
    const copied = await db!.duplicateAuthorizedCephAnalysis(f.id,{patientId:f.patientId,documentId:f.documentId,session:f.session});
    expect(copied.ok).toBe(false);
    expect((await pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[f.patientId])).rows).toEqual([]);
    expect(await state(f.id)).toEqual(before);
  });
  it("returns409 from actual duplicate POST for sealed child mismatch with no new draft",async()=>{
    const f=await fixture(),pool=db!.getPool();expect((await complete(f)).ok).toBe(true);
    await pool.query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1 AND code='N'",[f.id]);
    const sessionModule=await import("../../lib/session");
    const cookieSession=vi.spyOn(sessionModule,"requireSession").mockResolvedValue(f.session);
    try{
      const {POST}=await import("../../app/api/ceph/[id]/duplicate/route");
      const response=await POST(new Request(`https://test.invalid/api/ceph/${f.id}/duplicate`,{method:"POST"}),
        {params:Promise.resolve({id:String(f.id)})});
      expect(response.status).toBe(409);expect(await response.json()).not.toHaveProperty("id");
      expect((await pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[f.patientId])).rows).toEqual([]);
    }finally{cookieSession.mockRestore();}
  });
  it.each(["reviewer","measurement","diagnosis","missing_landmark"] as const)("refuses correction-copy with mismatched sealed %s", async kind => {
    const f=await fixture(),pool=db!.getPool();expect((await complete(f)).ok).toBe(true);
    if(kind==="reviewer") await pool.query("UPDATE ceph_landmarks SET confirmed_by='synthetic-other' WHERE analysis_id=$1 AND code='N'",[f.id]);
    if(kind==="measurement") await pool.query("UPDATE ceph_measurements SET value=value+1 WHERE analysis_id=$1 AND code='SNA'",[f.id]);
    if(kind==="diagnosis") await pool.query("UPDATE ceph_diagnoses SET final_dx='synthetic changed' WHERE analysis_id=$1",[f.id]);
    if(kind==="missing_landmark") await pool.query("DELETE FROM ceph_landmarks WHERE analysis_id=$1 AND code='N'",[f.id]);
    const before=await state(f.id);
    expect(await db!.duplicateAuthorizedCephAnalysis(f.id,{patientId:f.patientId,documentId:f.documentId,session:f.session})).toMatchObject({ok:false});
    expect((await pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[f.patientId])).rows).toEqual([]);
    expect(await state(f.id)).toEqual(before);
  });
  it("does not downgrade a present malformed witness to legacy correction history", async()=>{
    const f=await fixture(),pool=db!.getPool();
    await pool.query("UPDATE ceph_analyses SET status='completed',completed_by=$2,completed_at='2020-01-01T00:00:00Z' WHERE id=$1",[f.id,f.session.username]);
    await pool.query(`INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,actor_user_id,sealed_by,sealed_at)
      VALUES($1,1,'{}',$2,$3,$4,'2020-01-01T00:00:00Z')`,[f.id,"a".repeat(64),f.session.userId,f.session.username]);
    expect(await db!.duplicateAuthorizedCephAnalysis(f.id,{patientId:f.patientId,documentId:f.documentId,session:f.session})).toMatchObject({ok:false});
    expect((await pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[f.patientId])).rows).toEqual([]);
  });
  it.each(["hash","dimensions"] as const)("refuses witnessed correction-copy when image %s no longer matches",async kind=>{
    const f=await fixture(),pool=db!.getPool();expect((await complete(f)).ok).toBe(true);
    if(kind==="hash")await pool.query("UPDATE patient_documents SET sha256=$2 WHERE id=$1",[f.documentId,"b".repeat(64)]);
    else await pool.query("UPDATE patient_documents SET width=456,height=789 WHERE id=$1",[f.documentId]);
    const before=await state(f.id);
    expect(await db!.duplicateAuthorizedCephAnalysis(f.id,{patientId:f.patientId,documentId:f.documentId,session:f.session})).toMatchObject({ok:false});
    expect((await pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[f.patientId])).rows).toEqual([]);
    expect(await state(f.id)).toEqual(before);
  });
  it.each(["valid","hidden","catalog_drift","legacy"] as const)("preserves %s correction-copy compatibility and original review metadata",async kind=>{
    const f=await fixture(),pool=db!.getPool();
    if(kind==="legacy")await pool.query("UPDATE ceph_analyses SET status='completed',completed_by=$2,completed_at='2020-01-01T00:00:00Z' WHERE id=$1",[f.id,f.session.username]);
    else expect((await complete(f)).ok).toBe(true);
    if(kind==="hidden")await pool.query("UPDATE patient_documents SET removed_at=now() WHERE id=$1",[f.documentId]);
    if(kind==="catalog_drift")await pool.query("UPDATE ceph_reference_sets SET active=false,version='changed' WHERE id=$1",[f.referenceId]);
    const before=await state(f.id);
    const original=(await pool.query("SELECT code,x,y,source,confirmed_by,confirmed_at FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code",[f.id])).rows;
    const copied=await db!.duplicateAuthorizedCephAnalysis(f.id,{patientId:f.patientId,documentId:f.documentId,session:f.session});
    expect(copied.ok).toBe(true);if(!copied.ok)throw new Error("Expected correction copy");
    expect((await pool.query("SELECT code,x,y,source,confirmed_by,confirmed_at FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code",[copied.id])).rows).toEqual(original);
    const draft=await state(copied.id);expect(draft.witness).toEqual([]);expect(draft.measurements).toEqual([]);
    expect(draft.analysis).toMatchObject({status:"draft",document_id:f.documentId,mm_per_pixel:1});
    expect((await pool.query("SELECT * FROM ceph_diagnoses WHERE analysis_id=$1",[copied.id])).rows).toEqual([]);
    expect(await state(f.id)).toEqual(before);
  });
  it("preserves valid version1 historical engine evidence during correction-copy",async()=>{
    const f=await fixture(),pool=db!.getPool(),sealedAt="2020-01-01T00:00:00.000Z";
    const reviews=(await pool.query(`SELECT code,confirmed_by AS "confirmedBy",
      to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "confirmedAt"
      FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code`,[f.id])).rows;
    const measurements=computeAll(VALID,1).flatMap(row=>row.value===null?[]:[{code:row.code,value:row.value}]);
    const witness=buildCephCompletionWitness({analysisId:f.id,actor:{userId:f.session.userId,username:f.session.username},
      sealedAt,snapshot:f.snapshot,image:{documentId:f.documentId,sha256:f.sha,width:null,height:null},
      landmarkReviews:reviews,referenceSet:{key:f.snapshot.refSet,name:"Historical reference",population:null,
        ageMin:null,ageMax:null,sex:null,version:"historical",active:true,values:[]},measurements});
    for(const row of witness.measurements)row.algorithm={...row.algorithm,version:"historical-engine-test",sourceSha256:"c".repeat(64)};
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("UPDATE ceph_analyses SET status='completed',completed_by=$2,completed_at=$3 WHERE id=$1",[f.id,f.session.username,sealedAt]);
      for(const row of measurements)await client.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,$2,$3)",[f.id,row.code,row.value]);
      await client.query(`INSERT INTO ceph_completion_provenance(analysis_id,schema_version,witness,witness_sha256,actor_user_id,sealed_by,sealed_at)
        VALUES($1,1,$2,$3,$4,$5,$6)`,[f.id,JSON.stringify(witness),cephProvenanceHash(witness),f.session.userId,f.session.username,sealedAt]);
      await client.query("COMMIT");
    }finally{await client.query("ROLLBACK");client.release();}
    expect((await db!.getCephStudy(f.id))?.provenance.state).toBe("versioned");
    const before=await state(f.id);
    expect(await db!.duplicateAuthorizedCephAnalysis(f.id,{patientId:f.patientId,documentId:f.documentId,session:f.session})).toMatchObject({ok:true});
    expect(await state(f.id)).toEqual(before);
  });
  it("rolls back a validated correction-copy when its atomic audit fails",async()=>{
    const f=await fixture(),pool=db!.getPool();expect((await complete(f)).ok).toBe(true);const before=await state(f.id);
    await pool.query(`CREATE FUNCTION synthetic_copy_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='ceph.create' THEN RAISE EXCEPTION 'synthetic copy audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_copy_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_copy_audit_failure()`);
    try{
      await expect(db!.duplicateAuthorizedCephAnalysis(f.id,{patientId:f.patientId,documentId:f.documentId,session:f.session})).rejects.toThrow("synthetic copy audit failure");
      expect((await pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[f.patientId])).rows).toEqual([]);
      expect(await state(f.id)).toEqual(before);
    }finally{await pool.query("DROP TRIGGER synthetic_copy_audit_failure ON audit_log; DROP FUNCTION synthetic_copy_audit_failure()");}
  });
  it("refuses a correction-copy with a concurrently locked child before any new draft",async()=>{
    const f=await fixture(),pool=db!.getPool();expect((await complete(f)).ok).toBe(true);
    const blocker=await pool.connect();
    try{
      await blocker.query("BEGIN");await blocker.query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1 AND code='N'",[f.id]);
      await expect(db!.duplicateAuthorizedCephAnalysis(f.id,{patientId:f.patientId,documentId:f.documentId,session:f.session})).rejects.toMatchObject({status:409});
      expect((await pool.query("SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status='draft'",[f.patientId])).rows).toEqual([]);
      await blocker.query("COMMIT");
      expect(await db!.duplicateAuthorizedCephAnalysis(f.id,{patientId:f.patientId,documentId:f.documentId,session:f.session})).toMatchObject({ok:false});
    }finally{await blocker.query("ROLLBACK");blocker.release();}
  });
  it("holds validated source children through observed copy audit wait",async()=>{
    const f=await fixture(),pool=db!.getPool();expect((await complete(f)).ok).toBe(true);
    const blocker=await pool.connect();let pending:ReturnType<NonNullable<typeof db>["duplicateAuthorizedCephAnalysis"]>|undefined;
    try{
      await blocker.query("BEGIN");const {rows:[{pid}]}=await blocker.query<{pid:number}>("SELECT pg_backend_pid() AS pid");
      await blocker.query("LOCK TABLE audit_log IN SHARE MODE");
      pending=db!.duplicateAuthorizedCephAnalysis(f.id,{patientId:f.patientId,documentId:f.documentId,session:f.session});void pending.catch(()=>undefined);
      let observed=false;
      for(let attempt=0;attempt<250;attempt++){
        await blocker.query("SELECT pg_stat_clear_snapshot()");
        const {rows:[{waiting}]}=await blocker.query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%INSERT INTO audit_log%' AND $1=ANY(pg_blocking_pids(pid))) AS waiting`,[pid]);
        if(waiting){observed=true;break;}await delay(20);
      }
      expect(observed).toBe(true);
      const contender=await pool.connect();
      try{await contender.query("BEGIN");await contender.query("SET LOCAL lock_timeout='100ms'");
        await expect(contender.query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1 AND code='N'",[f.id])).rejects.toMatchObject({code:"55P03"});
      }finally{await contender.query("ROLLBACK");contender.release();}
      const inserter=await pool.connect();
      try{await inserter.query("BEGIN");await inserter.query("SET LOCAL lock_timeout='100ms'");
        await expect(inserter.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'D',1,2,'manual','synthetic')",[f.id])).rejects.toMatchObject({code:"55P03"});
      }finally{await inserter.query("ROLLBACK");inserter.release();}
      await blocker.query("COMMIT");const copied=await pending;expect(copied.ok).toBe(true);
      if(copied.ok)expect((await pool.query("SELECT x FROM ceph_landmarks WHERE analysis_id=$1 AND code='N'",[copied.id])).rows[0].x).toBe(VALID.N.x);
    }finally{await blocker.query("ROLLBACK");blocker.release();await pending?.catch(()=>undefined);}
  });
  it("atomically saves reviewed inputs, image identity, actor, outputs and reference evidence", async () => {
    const f = await fixture();
    expect((await db!.getCephStudy(f.id))?.provenance).toEqual({ state: "not_completed" });
    const result = await complete(f); expect(result.ok).toBe(true);
    const saved = await state(f.id); expect(saved.witness).toHaveLength(1); expect(saved.measurements.length).toBeGreaterThan(0);
    expect(saved.analysis.status).toBe("completed");
    expect(saved.witness[0]).toMatchObject({ schema_version: 2, actor_user_id: f.session.userId, sealed_by: f.session.username });
    expect(saved.witness[0].sealed_at).toEqual(saved.analysis.completed_at);
    expect(saved.witness[0].witness_sha256).toMatch(/^[a-f0-9]{64}$/);
    const witness = saved.witness[0].witness;
    expect(witness.snapshot).toEqual(parseCephCompletionSnapshot(f.snapshot));
    expect(witness.image).toMatchObject({ documentId: f.documentId, sha256: f.sha });
    expect(witness.actor).toEqual({ userId: f.session.userId, username: f.session.username });
    expect(witness.sealedAt).toBe(saved.analysis.completed_at.toISOString());
    expect(cephProvenanceHash(witness)).toBe(saved.witness[0].witness_sha256);
    expect(witness.measurements.map((m: { code: string; value: number }) => ({ code: m.code, value: m.value })))
      .toEqual(saved.measurements.map(m => ({ code: m.code, value: m.value })));
    const serialized = JSON.stringify(witness);
    for (const expected of [f.sha, f.session.username, f.snapshot.diagnosis!.finalDx, "synthetic-v1"]) expect(serialized).toContain(expected);
    expect((await db!.getCephStudy(f.id))?.provenance).toEqual({ state: "versioned", witness: saved.witness[0].witness, witnessSha256: saved.witness[0].witness_sha256 });
    expect(saved.audit).toHaveLength(1);
  });
  it("replays identical actor and reviewed state without changing signature, evidence or audit", async () => {
    const f = await fixture(); expect((await complete(f)).ok).toBe(true); const before = await state(f.id);
    expect((await complete(f)).ok).toBe(true); expect(await state(f.id)).toEqual(before);
  });
  it("rejects a different replay actor or reviewed snapshot without mutation", async () => {
    const f = await fixture(), other = await fixture(); expect((await complete(f)).ok).toBe(true); const before = await state(f.id);
    expect((await complete(f, { ...f.snapshot, diagnosis: { ...f.snapshot.diagnosis!, finalDx: "Different" } })).ok).toBe(false);
    expect((await complete(f, f.snapshot, other.session)).ok).toBe(false); expect(await state(f.id)).toEqual(before);
  });
  it.each(["is_active=FALSE", "role='reception'", "password_hash='replacement'"])("revalidates current user at completion: %s", async mutation => {
    const f = await fixture(), before = await state(f.id);
    await db!.getPool().query(`UPDATE users SET ${mutation} WHERE id=$1`, [f.session.userId]);
    expect((await complete(f)).ok).toBe(false); expect(await state(f.id)).toEqual(before);
  });
  it("keeps sealed evidence unchanged when current references change", async () => {
    const f = await fixture(); expect((await complete(f)).ok).toBe(true); const before = await state(f.id);
    const provenance = (await db!.getCephStudy(f.id))!.provenance;
    await db!.getPool().query("UPDATE ceph_reference_values SET mean=mean+100 WHERE set_id=$1", [f.referenceId]);
    await db!.getPool().query("UPDATE ceph_reference_sets SET version='synthetic-v2' WHERE id=$1", [f.referenceId]);
    expect((await db!.getCephStudy(f.id))!.provenance).toEqual(provenance); expect(await state(f.id)).toEqual(before);
  });
  it("leaves historical completion unversioned without reconstructing or rewriting it", async () => {
    const f = await fixture(); await db!.getPool().query("UPDATE ceph_analyses SET status='completed',completed_by='historical-actor',completed_at='2020-01-01T00:00:00Z' WHERE id=$1", [f.id]);
    const before = await state(f.id);
    expect((await db!.getCephStudy(f.id))!.provenance).toEqual({ state: "unversioned", reason: "historical_completion_without_witness" });
    expect((await db!.getCephStudy(f.id))!.measurements.some(row => row.code === "L1_APOG_ANGLE")).toBe(false);
    expect((await complete(f)).ok).toBe(false); expect(await state(f.id)).toEqual(before);
  });
  it("rolls back witness, measurements and signature together when audit insertion fails", async () => {
    const f = await fixture(), before = await state(f.id), pool = db!.getPool();
    await pool.query(`CREATE FUNCTION synthetic_ceph_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.entity_id='${f.id}' AND NEW.entity='ceph_analysis' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_ceph_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_ceph_audit_failure()`);
    try { await expect(complete(f)).rejects.toThrow("synthetic audit failure"); expect(await state(f.id)).toEqual(before); }
    finally { await pool.query("DROP TRIGGER synthetic_ceph_audit_failure ON audit_log; DROP FUNCTION synthetic_ceph_audit_failure()"); }
  });
  it("serializes simultaneous identical completions into one witness and one audit", async () => {
    const f = await fixture(); const results = await Promise.all([complete(f), complete(f)]);
    expect(results.map(result => result.ok)).toEqual([true, true]);
    const saved = await state(f.id); expect(saved.witness).toHaveLength(1); expect(saved.audit).toHaveLength(1);
  });
  it("rolls back stamps and signature when witness insertion fails", async () => {
    const f = await fixture(), before = await state(f.id), pool = db!.getPool();
    await pool.query(`CREATE FUNCTION synthetic_ceph_witness_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.analysis_id=${f.id} THEN RAISE EXCEPTION 'synthetic witness failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_ceph_witness_failure BEFORE INSERT ON ceph_completion_provenance FOR EACH ROW EXECUTE FUNCTION synthetic_ceph_witness_failure()`);
    try { await expect(complete(f)).rejects.toThrow("synthetic witness failure"); expect(await state(f.id)).toEqual(before); }
    finally { await pool.query("DROP TRIGGER synthetic_ceph_witness_failure ON ceph_completion_provenance; DROP FUNCTION synthetic_ceph_witness_failure()"); }
  });
  it("reports altered current sealed clinical inputs as integrity unavailable, never silently refreshing evidence", async () => {
    const f = await fixture(); expect((await complete(f)).ok).toBe(true); const before = await state(f.id);
    await db!.getPool().query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1 AND code='S'", [f.id]);
    expect((await db!.getCephStudy(f.id))!.provenance.state).toBe("integrity_unavailable");
    expect((await state(f.id)).witness).toEqual(before.witness);
    expect((await complete(f)).ok).toBe(false);
  });
  it.each(["account", "ownership"] as const)("serializes against concurrent %s revocation before sealing", async kind => {
    const f = await fixture(), pool = db!.getPool();
    if (kind === "ownership") {
      const party = (await pool.query<{id:number}>("INSERT INTO parties(name,kind) VALUES('Synthetic doctor','doctor') RETURNING id")).rows[0];
      await pool.query("UPDATE users SET role='doctor',party_id=$2,permissions=$3 WHERE id=$1", [f.session.userId, party.id, JSON.stringify({canUploadXrays:true,canViewAllPatients:false})]);
      await pool.query("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [f.patientId,party.id]);
      f.session.role = "doctor"; f.session.partyId = party.id;
    }
    const before = await state(f.id), blocker = await pool.connect();
    let pending: ReturnType<typeof complete> | undefined;
    try {
      await blocker.query("BEGIN");
      const { rows: [{ pid: blockerPid }] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      if (kind === "account") await blocker.query("UPDATE users SET is_active=FALSE WHERE id=$1", [f.session.userId]);
      else await blocker.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [f.patientId]);
      pending = complete(f);
      const deadline = Date.now() + 5000;
      while (true) {
        const waiting = (await pool.query<{waiting:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting", [kind === "account" ? "%FROM users%FOR SHARE%" : "%FROM patients%FOR NO KEY UPDATE%", blockerPid])).rows[0].waiting;
        if (waiting) break;
        if (Date.now() >= deadline) throw new Error("Completion never reached the expected authority lock");
        await delay(20);
      }
      await blocker.query("COMMIT");
      expect((await pending).ok).toBe(false); expect(await state(f.id)).toEqual(before);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined); blocker.release();
      await pending?.catch(() => undefined);
    }
  });

});

describe("ceph completion final authority boundaries", () => {
  it.each(["final_audit", "sealed_replay"] as const)("refuses expiry during the exact %s lock without changing saved state", async boundary => {
    const f = await fixture(), pool = db!.getPool();
    if (boundary === "sealed_replay") expect((await complete(f)).ok).toBe(true);
    const before = await state(f.id), blocker = await pool.connect();
    let pending: ReturnType<typeof complete> | undefined;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await blocker.query("BEGIN");
      const { rows: [{ pid: blockerPid }] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      if (boundary === "final_audit") await blocker.query("LOCK TABLE audit_log IN SHARE MODE");
      else await blocker.query("SELECT id FROM ceph_analyses WHERE id=$1 FOR UPDATE", [f.id]);
      pending = complete(f); void pending.catch(() => undefined);
      let waitingPid: number | undefined;
      for (let attempt = 0; attempt < 250; attempt++) {
        await blocker.query("SELECT pg_stat_clear_snapshot()");
        const { rows } = await blocker.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
          WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'
            AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,
        [blockerPid, boundary === "final_audit" ? "%INSERT INTO audit_log%" : "%FROM ceph_analyses WHERE id = $1 FOR UPDATE%"]);
        if (rows.length === 1) { waitingPid = rows[0].pid; break; }
        await delay(10);
      }
      expect(waitingPid, "Must observe this completion backend blocked by this exact blocker").toBeTypeOf("number");
      console.info("Synthetic completion expiry boundary", { boundary, blockerPid, waitingPid });
      clock = vi.spyOn(Date, "now").mockReturnValue(f.session.expiresAt + 1);
      await blocker.query("COMMIT");
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("provenance");
      expect(result).not.toHaveProperty("measurements");
      expect(await state(f.id)).toEqual(before);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await pending?.catch(() => undefined); clock?.mockRestore(); blocker.release();
    }
    // Rejected expiry neither seals a draft nor damages the existing sealed receipt.
    expect((await complete(f)).ok).toBe(true);
    const authorized = await state(f.id);
    if (boundary === "sealed_replay") expect(authorized).toEqual(before);
    else { expect(authorized.witness).toHaveLength(1); expect(authorized.audit).toHaveLength(1); }
  }, 20_000);
});

describe("correction draft provenance",()=>{
  it("does not fabricate new landmark reviewer/time when copying a sealed study",async()=>{
    const f=await fixture();expect((await complete(f)).ok).toBe(true);
    const query="SELECT code,confirmed_by,confirmed_at::text FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code";
    const before=(await db!.getPool().query(query,[f.id])).rows;
    const copy=await db!.duplicateCephAnalysis(f.id,"synthetic-copy-operator");
    expect(copy.ok).toBe(true);if(!copy.ok)throw new Error(copy.message);
    expect((await db!.getPool().query(query,[copy.id])).rows).toEqual(before);
    expect((await db!.getCephStudy(copy.id))?.provenance).toEqual({state:"not_completed"});
    expect((await db!.getPool().query("SELECT 1 FROM ceph_completion_provenance WHERE analysis_id=$1",[copy.id])).rows).toEqual([]);
  });
});

describe("comparison projection consistency on PostgreSQL 18", () => {
  it("does not splice calibration A with landmarks B committed after the analysis SELECT", async () => {
    const f = await fixture(), pool = db!.getPool(), before = await db!.getCephAnalysisForCompare(f.id);
    const writer = await pool.connect(), original = pool.query.bind(pool);
    const order: string[] = [];
    let intercepted = false, committed = false;
    const spy = vi.spyOn(pool, "query").mockImplementation(async function<T>(sql: string, values?: unknown[]) {
      const result = await original<T>(sql, values);
      if (!intercepted && sql.includes("FROM ceph_analyses a JOIN patient_documents")) {
        intercepted = true; order.push("analysis SELECT finished at A");
        // A real independent connection atomically installs B after the initial
        // SELECT but before its result is consumed. No timing assumption.
        await writer.query("BEGIN");
        await writer.query("UPDATE ceph_analyses SET mm_per_pixel=2,cal_mm=200 WHERE id=$1", [f.id]);
        await writer.query("UPDATE ceph_landmarks SET x=x*2,y=y*2 WHERE analysis_id=$1", [f.id]);
        await writer.query("COMMIT"); committed = true; order.push("writer committed B");
      }
      return result;
    });
    try {
      const during = await db!.getCephAnalysisForCompare(f.id);
      order.push("comparison returned");
      expect(during?.points).toEqual(before?.points);
      expect(during?.mmPerPixel).toBe(1);
      expect(during?.projectionSha256).toBe(before?.projectionSha256);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["analysis SELECT finished at A", "writer committed B", "comparison returned"]);
    } finally {
      spy.mockRestore();
      if (!committed) await writer.query("ROLLBACK");
      writer.release();
    }
    const after = await db!.getCephAnalysisForCompare(f.id);
    expect(after?.mmPerPixel).toBe(2);
    expect(after?.points.N).toEqual({ x: VALID.N.x * 2, y: VALID.N.y * 2 });
    expect(after?.projectionSha256).not.toBe(before?.projectionSha256);
  });
  it("binds same-ID landmark and scale changes while excluding notes and landmark read order", async () => {
    const f = await fixture(), pool = db!.getPool(), before = await db!.getCephAnalysisForCompare(f.id);
    expect(before?.projectionSha256).toMatch(/^[a-f0-9]{64}$/);
    await pool.query("UPDATE ceph_analyses SET note='Synthetic unrelated note' WHERE id=$1", [f.id]);
    await pool.query("UPDATE ceph_landmarks SET confirmed_at=confirmed_at+interval '1 minute' WHERE analysis_id=$1 AND code='N'", [f.id]);
    expect((await db!.getCephAnalysisForCompare(f.id))?.projectionSha256).toBe(before?.projectionSha256);
    await pool.query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1 AND code='N'", [f.id]);
    const moved = await db!.getCephAnalysisForCompare(f.id);
    expect(moved?.projectionSha256).not.toBe(before?.projectionSha256);
    await pool.query("UPDATE ceph_analyses SET mm_per_pixel=2 WHERE id=$1", [f.id]);
    expect((await db!.getCephAnalysisForCompare(f.id))?.projectionSha256).not.toBe(moved?.projectionSha256);
  });
  it("does not reinterpret completed witnesses using changing current references", async () => {
    const f = await fixture(); expect((await complete(f)).ok).toBe(true);
    const before = await db!.getCephAnalysisForCompare(f.id), archived = await state(f.id);
    await db!.getPool().query("UPDATE ceph_reference_values SET mean=mean+100 WHERE set_id=$1", [f.referenceId]);
    await db!.getPool().query("UPDATE ceph_reference_sets SET version='comparison-fixture-v2' WHERE id=$1", [f.referenceId]);
    expect(await db!.getCephAnalysisForCompare(f.id)).toEqual(before);
    expect(await state(f.id)).toEqual(archived);
    expect(before?.measurements.every(m => m.mean === null)).toBe(true);
  });
  it("retains uncalibrated angle drafts without inventing a calibrated overlay source", async () => {
    const f = await fixture();
    await db!.getPool().query("UPDATE ceph_analyses SET mm_per_pixel=NULL,cal_mm=NULL WHERE id=$1", [f.id]);
    const result = await db!.getCephAnalysisForCompare(f.id);
    expect(result?.mmPerPixel).toBeNull(); expect(result?.projectionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.measurements.find(m => m.code === "SNA")?.value).toEqual(expect.any(Number));
  });
  it.each(["NaN", "Infinity", "-Infinity"])("refuses PostgreSQL JSONB nonfinite coordinate %s instead of issuing a source token", async value => {
    const f = await fixture();
    await db!.getPool().query("UPDATE ceph_landmarks SET x=$2::double precision WHERE analysis_id=$1 AND code='N'", [f.id, value]);
    await expect(db!.getCephAnalysisForCompare(f.id)).rejects.toThrow("Invalid cephalometric comparison projection");
  });
});
