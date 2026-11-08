import { assessCephCalculationReadiness } from "../lib/ceph-calculation-readiness";
import { cephProvenanceDependencies, installCephProvenanceFixture, syntheticCephSession, syntheticCephSources } from "./fixtures/ceph-provenance-sql";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeAll, isCephLandmarkCode, MEASUREMENTS, REQUIRED_LANDMARKS, summarize,
  type LandmarkMap, type MeasurementResult } from "../lib/ceph";
import { normalizeCephDiagnosis, parseCephCompletionDiagnosis, parseCephCompletionSnapshot, sameCephCompletionSnapshot, type CephCompletionSnapshot } from "../lib/ceph-completion-snapshot";
import { describeAudit, sanitizeDetails } from "../lib/audit";
import type { DbClient, DbPool, completeCephAnalysis, updateCephDiagnosis } from "../lib/db";

// Execute exact production completion/audit bodies against real minimal SQL,
// with real cephalometric computation. This is not the full app/schema bootstrap
// and does not claim PostgreSQL18 concurrent row-lock behavior.
const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
const declarations = [
  ["updateCephDiagnosis", "export interface CephReferenceSetRow"],
  ["completeCephAnalysis", "export async function discardCephAnalysis("],
  ["insertAuditRow", "export async function recordAudit("],
  ["recordAudit", "interface AuditRow"],
].map(([name, next]) => {
  const start = source.indexOf(`export async function ${name}(`), end = source.indexOf(next, start);
  if (start < 0 || end < start) throw new Error("Missing production function " + name);
  return source.slice(start, end).replace(/^export /gm, "");
}).join("\n");
const compiled = transformSync(declarations, { loader: "ts", target: "node22" }).code
  + "\nexports.completeCephAnalysis = completeCephAnalysis; exports.updateCephDiagnosis = updateCephDiagnosis;";
// Synthetic, deliberately nonclinical coordinates. All mandatory axes/frames are
// nondegenerate; no optional landmark is needed to complete this baseline.
const VALID: LandmarkMap = {
  S: { x: 100, y: 100 }, N: { x: 169, y: 92 }, A: { x: 167.57, y: 151.98 },
  B: { x: 163.84, y: 179.85 }, Pog: { x: 164.03, y: 186.87 }, Me: { x: 160, y: 205 },
  Go: { x: 82.97, y: 169.08 }, Or: { x: 160, y: 125 }, Po: { x: 100, y: 125 },
  U1A: { x: 160, y: 134 }, U1: { x: 174.08, y: 171.44 },
  L1A: { x: 149, y: 199.2 }, L1: { x: 168, y: 164 },
  OcclA: { x: 170, y: 148 }, OcclP: { x: 100, y: 135.3 }, Gn: { x: 161.5, y: 195.5 },
};
let sql: PGlite, pool: DbPool, completeDomain: typeof completeCephAnalysis, saveDiagnosis: typeof updateCephDiagnosis;
let failAudit = false, failMeasurement = false, failBeforeCommit = false, loseCommitReply = false;
let resultsOverride: MeasurementResult[] | undefined;
let expireDuringStamps: ReturnType<typeof syntheticCephSession> | null = null;
const statements: string[] = [];
const compute = vi.fn((map: LandmarkMap, scale: number) => resultsOverride ?? computeAll(map, scale));
beforeAll(async () => {
  sql = new PGlite(); await sql.waitReady;
  await sql.exec(`
    CREATE TABLE ceph_analyses (id SERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft', mm_per_pixel DOUBLE PRECISION,
      patient_id INT DEFAULT 11, document_id INT DEFAULT 22, ref_set TEXT DEFAULT 'builtin_default',
      cal_x1 DOUBLE PRECISION DEFAULT 0, cal_y1 DOUBLE PRECISION DEFAULT 0, cal_x2 DOUBLE PRECISION DEFAULT 100,
      cal_y2 DOUBLE PRECISION DEFAULT 0, cal_mm DOUBLE PRECISION DEFAULT 100,
      completed_by TEXT, completed_at TIMESTAMPTZ);
    CREATE TABLE ceph_landmarks (analysis_id INT NOT NULL, code TEXT NOT NULL,
      x DOUBLE PRECISION NOT NULL, y DOUBLE PRECISION NOT NULL, source TEXT NOT NULL, UNIQUE (analysis_id, code));
    CREATE TABLE ceph_diagnoses (analysis_id INT PRIMARY KEY, skeletal TEXT, dental TEXT, soft_tissue TEXT, note TEXT, final_dx TEXT, created_by TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE ceph_measurements (id BIGSERIAL PRIMARY KEY, analysis_id INT NOT NULL, code TEXT NOT NULL, value DOUBLE PRECISION NOT NULL,
      UNIQUE (analysis_id, code));
    CREATE TABLE audit_log (id BIGSERIAL PRIMARY KEY, action TEXT, entity TEXT, entity_id TEXT, summary TEXT, details JSONB,
      actor TEXT, actor_role TEXT, source_ip TEXT, user_agent TEXT);
  `);
  await installCephProvenanceFixture(sql);
  const query: DbClient["query"] = async <T>(text: string, values?: unknown[]) => {
    statements.push(text.trim());
    if (expireDuringStamps && /INSERT INTO ceph_measurements/.test(text)) expireDuringStamps.expiresAt=Date.now()-1;
    if (failAudit && /INSERT INTO audit_log/.test(text)) throw new Error("synthetic audit failure");
    if (failMeasurement && /INSERT INTO ceph_measurements/.test(text) && values?.[1] === "FMA") throw new Error("synthetic measurement failure");
    if (failBeforeCommit && text === "COMMIT") throw new Error("synthetic precommit failure");
    const result = await sql.query<T>(text, values);
    if (loseCommitReply && text === "COMMIT") { loseCommitReply = false; throw new Error("synthetic lost commit reply"); }
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  pool = { query, connect: async () => ({ query, release: () => {} }) };
  const output: Record<string, unknown> = {};
  const dependencies = { ...cephProvenanceDependencies, assessCephCalculationReadiness, ensureSchema: async () => {}, getPool: () => pool, isCephLandmarkCode, REQUIRED_LANDMARKS, MEASUREMENTS, normalizeCephDiagnosis, parseCephCompletionDiagnosis, parseCephCompletionSnapshot, sameCephCompletionSnapshot,
    describeAudit, sanitizeDetails, currentAuditSource: async () => ({ ip: null, userAgent: null }), computeAll: compute, summarize };
  new Function("exports", ...Object.keys(dependencies), compiled)(output, ...Object.values(dependencies));
  completeDomain = output.completeCephAnalysis as typeof completeCephAnalysis;
  saveDiagnosis = output.updateCephDiagnosis as typeof updateCephDiagnosis;
}, 60_000);
afterAll(async () => { await sql?.close(); });
beforeEach(() => {
  failAudit = false; failMeasurement = false; failBeforeCommit = false; loseCommitReply = false;
  expireDuringStamps = null; resultsOverride = undefined; statements.length = 0; compute.mockClear();
});
async function fixture(map: LandmarkMap = VALID) {
  const { rows: [study] } = await pool.query<{ id: number }>("INSERT INTO ceph_analyses (mm_per_pixel) VALUES (1) RETURNING id");
  for (const [code, point] of Object.entries(map)) if (point) {
    await pool.query("INSERT INTO ceph_landmarks (analysis_id,code,x,y,source) VALUES ($1,$2,$3,$4,'manual')", [study.id, code, point.x, point.y]);
  }
  statements.length = 0; return study.id;
}
// Test-only: direct callers describe their deliberately created synthetic state.
// An interactive editor must retain its displayed/acknowledged snapshot instead.
async function expectedSnapshot(id: number): Promise<CephCompletionSnapshot> {
  const { rows: [a] } = await pool.query("SELECT * FROM ceph_analyses WHERE id=$1", [id]);
  const { rows: landmarks } = await pool.query<CephCompletionSnapshot["landmarks"][number]>("SELECT code,x,y,source FROM ceph_landmarks WHERE analysis_id=$1", [id]);
  const { rows: [d] } = await pool.query("SELECT * FROM ceph_diagnoses WHERE analysis_id=$1", [id]);
  return { patientId: a.patient_id, documentId: a.document_id, refSet: a.ref_set,
    calibration: [a.cal_x1,a.cal_y1,a.cal_x2,a.cal_y2,a.cal_mm].some(v => v == null) ? null
      : { x1: a.cal_x1, y1: a.cal_y1, x2: a.cal_x2, y2: a.cal_y2, mm: a.cal_mm },
    mmPerPixel: a.mm_per_pixel, landmarks,
    diagnosis: d ? { skeletal: d.skeletal, dental: d.dental, softTissue: d.soft_tissue, note: d.note, finalDx: d.final_dx } : null };
}
async function complete(id: number, by: string, expected?: CephCompletionSnapshot) {
  const snapshot=expected ?? await expectedSnapshot(id);
  return completeDomain(id, by, snapshot, syntheticCephSession(by), await syntheticCephSources(pool,snapshot));
}
const state = async (id: number) => ({
  study: (await pool.query("SELECT status,completed_by,completed_at FROM ceph_analyses WHERE id=$1", [id])).rows[0],
  points: (await pool.query("SELECT code,x,y,source FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code", [id])).rows,
  diagnosis: (await pool.query("SELECT * FROM ceph_diagnoses WHERE analysis_id=$1", [id])).rows,
  stamped: (await pool.query("SELECT code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code", [id])).rows,
  audit: (await pool.query("SELECT action,actor,details FROM audit_log WHERE entity_id=$1 ORDER BY id", [String(id)])).rows,
});
async function refusesUnchanged(map: LandmarkMap) {
  const id = await fixture(map), before = await state(id);
  expect((await complete(id, "doctor")).ok).toBe(false); expect(await state(id)).toEqual(before);
}

describe("completion validates geometry and stamps a single audited transaction", () => {
  it("requires all baseline measurements but permits genuinely absent optional landmarks", async () => {
    const id = await fixture(); const result = await complete(id, "doctor"); expect(result.ok).toBe(true);
    const required = MEASUREMENTS.filter((def) => def.needs.every((code) => REQUIRED_LANDMARKS.includes(code)));
    expect(result.measurements?.map((row) => row.code).sort()).toEqual(required.map((row) => row.code).sort());
    expect(result.measurements?.every((row) => Number.isFinite(row.value))).toBe(true);
    const saved = await state(id); expect(saved.study).toMatchObject({ status: "completed", completed_by: "doctor" });
    expect([...saved.stamped].sort((a, b) => String(a.code).localeCompare(String(b.code)))).toEqual([...result.measurements!].sort((a, b) => a.code.localeCompare(b.code)));
    expect(saved.audit).toHaveLength(1);
  });
  it("refuses a full count of collapsed points rather than sealing partial/empty geometry", async () => {
    await refusesUnchanged(Object.fromEntries(REQUIRED_LANDMARKS.map((code) => [code, { x: 100, y: 100 }])));
  });
  it.each(["N", "Po", "U1A", "L1A", "OcclP"] as const)("refuses a collapsed required baseline at %s", async (code) => {
    const partner = { N: "S", Po: "Or", U1A: "U1", L1A: "L1", OcclP: "OcclA" } as const;
    await refusesUnchanged({ ...VALID, [code]: VALID[partner[code]] });
  });
  it("refuses a collinear S-N-Me handedness frame even when all points are distinct", async () => {
    await refusesUnchanged({ ...VALID, Me: { x: 238, y: 84 } });
  });
  it.each([NaN, Infinity, -Infinity])("refuses a nonfinite stored coordinate %s before computation", async (x) => {
    await refusesUnchanged({ ...VALID, N: { x, y: 92 } }); expect(compute).not.toHaveBeenCalled();
  });
  it("refuses corrupt optional coordinates even if their measurements would be skipped", async () => {
    await refusesUnchanged({ ...VALID, Ba: { x: NaN, y: 20 } }); expect(compute).not.toHaveBeenCalled();
  });
  it("blocks degenerate optional geometry when all its documented inputs are present", async () => {
    await refusesUnchanged({ ...VALID, ANS: { x: 170, y: 140 }, PNS: { x: 170, y: 140 } });
  });
  it("allows finite partial optional inputs without manufacturing unavailable measurements", async () => {
    const id = await fixture({ ...VALID, PNS: { x: 95, y: 136 } });
    const result = await complete(id, "doctor"); expect(result.ok).toBe(true);
    expect(result.measurements?.some((row) => row.code === "APDI" || row.code === "PP_FH")).toBe(false);
  });
  it("accepts legitimate zero-valued measurements and values outside reference ranges", async () => {
    const map = { ...VALID, U1: VALID.L1, U1A: { x: 10, y: 500 } };
    const id = await fixture(map), result = await complete(id, "doctor"); expect(result.ok).toBe(true);
    expect(result.measurements?.find((row) => row.code === "OVERJET")?.value).toBe(0);
    expect(result.measurements?.find((row) => row.code === "OVERBITE")?.value).toBe(0);
  });
  it.each(["missing", "duplicate", "unknown", "nan", "infinity"])("rejects invalid computed result contracts: %s", async (kind) => {
    const id = await fixture(); const before = await state(id); const normal = computeAll(VALID, 1);
    resultsOverride = kind === "missing" ? normal.filter((row) => row.code !== "SNA")
      : kind === "duplicate" ? [...normal, normal[0]]
      : kind === "unknown" ? [...normal, { ...normal[0], code: "UNVERIFIED" }]
      : normal.map((row) => row.code === "SNA" ? { ...row, value: kind === "nan" ? NaN : Infinity } : row);
    expect((await complete(id, "doctor")).ok).toBe(false); expect(await state(id)).toEqual(before);
  });
  it("rolls back stamps and status if the completion audit write fails", async () => {
    const id = await fixture(), before = await state(id); failAudit = true;
    await expect(complete(id, "doctor")).rejects.toThrow("synthetic audit failure");
    expect(await state(id)).toEqual(before);
    failAudit = false; expect((await complete(id, "doctor")).ok).toBe(true);
    expect((await state(id)).audit).toHaveLength(1);
  });
  it("rolls back partial stamps when a later measurement write fails", async () => {
    const id = await fixture(), before = await state(id); failMeasurement = true;
    await expect(complete(id, "doctor")).rejects.toThrow("synthetic measurement failure");
    expect(await state(id)).toEqual(before);
  });
  it("audit insert and all stamps occur before the one completion commit", async () => {
    const id = await fixture(); expect((await complete(id, "doctor")).ok).toBe(true);
    expect(statements.filter((text) => text === "COMMIT")).toHaveLength(1);
    expect(statements.findIndex((text) => /INSERT INTO audit_log/.test(text))).toBeLessThan(statements.indexOf("COMMIT"));
  });
  it("a precommit failure leaves no status, stamps or audit to misrepresent completion", async () => {
    const id = await fixture(), before = await state(id); failBeforeCommit = true;
    await expect(complete(id, "doctor")).rejects.toThrow("synthetic precommit failure");
    expect(await state(id)).toEqual(before);
  });
  it("a lost commit reply retains complete audited readback and retry does not rewrite history", async () => {
    const id = await fixture(); loseCommitReply = true;
    await expect(complete(id, "doctor")).rejects.toThrow("synthetic lost commit reply");
    const committed = await state(id); expect(committed.study).toMatchObject({ status: "completed", completed_by: "doctor" });
    expect(committed.stamped.length).toBeGreaterThan(0); expect(committed.audit).toHaveLength(1);
    compute.mockClear(); expect((await complete(id, "other-doctor")).ok).toBe(false);
    expect(await state(id)).toEqual(committed); expect(compute).not.toHaveBeenCalled();
  });
  it("does not retroactively rewrite historical completed geometry or old measurements", async () => {
    const id = await fixture({ ...VALID, S: VALID.N });
    await pool.query("UPDATE ceph_analyses SET status='completed',completed_by='historical-doctor' WHERE id=$1", [id]);
    await pool.query("INSERT INTO ceph_measurements (analysis_id,code,value) VALUES ($1,'EXT_INDEX',170)", [id]);
    const before = await state(id); expect((await complete(id, "doctor")).ok).toBe(false);
    expect(await state(id)).toEqual(before); expect(compute).not.toHaveBeenCalled();
  });
});


describe("completion matches the physician's reviewed snapshot", () => {
  it.each([
    ["point move", "UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1 AND code='A'"],
    ["point insertion", "INSERT INTO ceph_landmarks (analysis_id,code,x,y,source) VALUES ($1,'D',162,195,'manual')"],
    ["same-scale calibration source", "UPDATE ceph_analyses SET cal_x1=10,cal_x2=110 WHERE id=$1"],
    ["scale change", "UPDATE ceph_analyses SET cal_mm=50,mm_per_pixel=0.5 WHERE id=$1"],
    ["diagnosis insertion", "INSERT INTO ceph_diagnoses (analysis_id,final_dx) VALUES ($1,'New unseen text')"],
    ["reference selection", "UPDATE ceph_analyses SET ref_set='other_reference' WHERE id=$1"],
    ["image replacement", "UPDATE ceph_analyses SET document_id=23 WHERE id=$1"],
    ["patient identity", "UPDATE ceph_analyses SET patient_id=12 WHERE id=$1"],
  ])("rejects unseen %s after the reviewed snapshot was captured", async (_label, change) => {
    const id = await fixture(), expected = await expectedSnapshot(id);
    await pool.query(change, [id]); const before = await state(id); compute.mockClear();
    expect((await complete(id, "doctor", expected)).ok).toBe(false);
    expect(await state(id)).toEqual(before); expect(compute).not.toHaveBeenCalled();
  });
  it("rejects removal of an optional point previously reviewed on screen", async () => {
    const id = await fixture({ ...VALID, D: { x: 162, y: 195 } }), expected = await expectedSnapshot(id);
    await pool.query("DELETE FROM ceph_landmarks WHERE analysis_id=$1 AND code='D'", [id]);
    const before = await state(id); expect((await complete(id, "doctor", expected)).ok).toBe(false); expect(await state(id)).toEqual(before);
  });
  it.each(["skeletal", "dental", "soft_tissue", "note", "final_dx"])("detects unseen diagnosis field %s, including stored versus unsaved displayed text", async (field) => {
    const id = await fixture(); await pool.query("INSERT INTO ceph_diagnoses (analysis_id,final_dx) VALUES ($1,'Reviewed text')", [id]);
    const expected = await expectedSnapshot(id);
    await pool.query(`UPDATE ceph_diagnoses SET ${field}='Unseen text' WHERE analysis_id=$1`, [id]);
    const before = await state(id); expect((await complete(id, "doctor", expected)).ok).toBe(false); expect(await state(id)).toEqual(before);
  });
  it("rejects an omitted snapshot even for a complete valid draft", async () => {
    const id = await fixture(), before = await state(id);
    expect((await completeDomain(id, "doctor", undefined as unknown as CephCompletionSnapshot, syntheticCephSession("doctor"))).ok).toBe(false);
    expect(await state(id)).toEqual(before);
  });
  it("accepts the exact acknowledged state regardless of landmark array order", async () => {
    const id = await fixture(), expected = await expectedSnapshot(id); expected.landmarks.reverse();
    expect((await complete(id, "doctor", expected)).ok).toBe(true);
  });
  it.each([
    ["missing endpoint", "cal_x1=NULL"], ["coincident endpoints", "cal_x2=0"],
    ["missing known length", "cal_mm=NULL"], ["zero known length", "cal_mm=0"],
    ["inconsistent positive scale", "mm_per_pixel=2"],
  ])("requires real stored calibration inputs: %s", async (_label, set) => {
    const id = await fixture(); await pool.query(`UPDATE ceph_analyses SET ${set} WHERE id=$1`, [id]);
    const before = await state(id); expect((await complete(id, "doctor")).ok).toBe(false); expect(await state(id)).toEqual(before);
  });
});


describe("diagnosis acknowledgment remains tied to stored normalized fields", () => {
  it("returns the exact normalized saved fields so the editor can track reviewed text without a later GET", async () => {
    const id = await fixture();
    const result = await saveDiagnosis(id, { finalDx: "  reviewed  ", skeletal: "  note  ", dental: "   " }, "doctor", null);
    expect(result).toEqual({ ok: true, diagnosis: { skeletal: "note", dental: null, softTissue: null, note: null, finalDx: "reviewed" } });
    if (!result.ok) throw new Error(result.message);
    const expected = await expectedSnapshot(id); expect(expected.diagnosis).toEqual(result.diagnosis);
    expect((await complete(id, "doctor", expected)).ok).toBe(true);
  });
});

describe("new sealing cannot leave corrupt or expired attestations",()=>{
  it("preserves unsupported saved draft values instead of silently sealing mismatched evidence",async()=>{
    const id=await fixture();await pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'historical_unknown',123)",[id]);
    const before=await state(id);expect((await complete(id,"doctor")).ok).toBe(false);expect(await state(id)).toEqual(before);
    expect((await pool.query("SELECT 1 FROM ceph_completion_provenance WHERE analysis_id=$1",[id])).rows).toEqual([]);
  });
  it("rolls back partially inserted outputs when session expiry occurs before the signature",async()=>{
    const id=await fixture(),before=await state(id);expireDuringStamps=syntheticCephSession("doctor");
    const result=await completeDomain(id,"doctor",await expectedSnapshot(id),expireDuringStamps,await syntheticCephSources(pool,await expectedSnapshot(id)));
    expect(result.ok).toBe(false);expect(await state(id)).toEqual(before);
    expect((await pool.query("SELECT 1 FROM ceph_completion_provenance WHERE analysis_id=$1",[id])).rows).toEqual([]);
  });
});
