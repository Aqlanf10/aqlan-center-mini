import { assessCephCalculationReadiness } from "../lib/ceph-calculation-readiness";
import { cephProvenanceDependencies, installCephProvenanceFixture, syntheticCephSession, syntheticCephSources } from "./fixtures/ceph-provenance-sql";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isCephLandmarkCode, MEASUREMENTS, REQUIRED_LANDMARKS, type LandmarkCode } from "../lib/ceph";
import { parseCephCompletionSnapshot, sameCephCompletionSnapshot, type CephCompletionSnapshot } from "../lib/ceph-completion-snapshot";
import { describeAudit, sanitizeDetails } from "../lib/audit";
import type { DbClient, DbPool, updateCephLandmarks, completeCephAnalysis } from "../lib/db";

// Exact production mutation/completion/audit bodies and real minimal PGlite SQL.
// Ordered interleavings prove gate outcomes; actual PG18 row-lock concurrency is
// not claimed by this in-process SQL fixture.
const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
const declarations = [
  ["updateCephLandmarks", "export interface CephCompleteResult"],
  ["completeCephAnalysis", "export async function discardCephAnalysis("],
  ["insertAuditRow", "export async function recordAudit("],
].map(([name, next]) => {
  const start = source.indexOf(`export async function ${name}(`), end = source.indexOf(next, start);
  if (start < 0 || end < start) throw new Error("Missing production function " + name);
  return source.slice(start, end).replace(/^export /gm, "");
}).join("\n");
const compiled = transformSync(declarations, { loader: "ts", target: "node22" }).code
  + "\nexports.updateCephLandmarks = updateCephLandmarks; exports.completeCephAnalysis = completeCephAnalysis; exports.insertAuditRow = insertAuditRow;";
let sql: PGlite, pool: DbPool, write: typeof updateCephLandmarks, completeDomain: typeof completeCephAnalysis;
const mockResults = MEASUREMENTS.map((definition) => ({ code: definition.code,
  value: definition.needs.every((code) => REQUIRED_LANDMARKS.includes(code)) ? 82 : null }));
const compute = vi.fn(() => mockResults);
const point = (code: LandmarkCode, source: "manual" | "suggested" = "manual", x = 100, y = 200) => ({ code, source, x, y });
beforeAll(async () => {
  sql = new PGlite(); await sql.waitReady;
  await sql.exec(`
    CREATE TABLE ceph_analyses (id SERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft', mm_per_pixel DOUBLE PRECISION,
      patient_id INT DEFAULT 11, document_id INT DEFAULT 22, ref_set TEXT DEFAULT 'builtin_default',
      cal_x1 DOUBLE PRECISION DEFAULT 0, cal_y1 DOUBLE PRECISION DEFAULT 0, cal_x2 DOUBLE PRECISION DEFAULT 100,
      cal_y2 DOUBLE PRECISION DEFAULT 0, cal_mm DOUBLE PRECISION DEFAULT 10,
      completed_by TEXT, completed_at TIMESTAMPTZ);
    CREATE TABLE ceph_landmarks (id BIGSERIAL PRIMARY KEY, analysis_id INT NOT NULL REFERENCES ceph_analyses(id), code TEXT NOT NULL,
      x DOUBLE PRECISION NOT NULL, y DOUBLE PRECISION NOT NULL, source TEXT, confirmed_by TEXT NOT NULL,
      confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (analysis_id, code));
    CREATE TABLE ceph_diagnoses (analysis_id INT PRIMARY KEY, skeletal TEXT, dental TEXT, soft_tissue TEXT, note TEXT, final_dx TEXT);
    CREATE TABLE ceph_measurements (id BIGSERIAL PRIMARY KEY, analysis_id INT NOT NULL, code TEXT NOT NULL, value DOUBLE PRECISION NOT NULL,
      UNIQUE (analysis_id, code));
    CREATE TABLE audit_log (id BIGSERIAL PRIMARY KEY, action TEXT, entity TEXT, entity_id TEXT, summary TEXT, details JSONB,
      actor TEXT, actor_role TEXT, source_ip TEXT, user_agent TEXT);
  `);
  await installCephProvenanceFixture(sql);
  const query: DbClient["query"] = async <T>(text: string, values?: unknown[]) => {
    const result = await sql.query<T>(text, values); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  pool = { query, connect: async () => ({ query, release: () => {} }) };
  const output: Record<string, unknown> = {};
  const dependencies = { ...cephProvenanceDependencies, assessCephCalculationReadiness, ensureSchema: async () => {}, getPool: () => pool, cephWriterClient: () => pool.connect(), /* integration: ceph writers take their client from cephWriterClient (pooled outside a canonical operation) */ isCephLandmarkCode, MEASUREMENTS, REQUIRED_LANDMARKS, parseCephCompletionSnapshot, sameCephCompletionSnapshot,
    describeAudit, sanitizeDetails, currentAuditSource: async () => ({ ip: null, userAgent: null }),
    computeAll: compute, summarize: () => ({ skeletal: "Synthetic summary", vertical: "Synthetic vertical" }),
    recordAudit: (input: unknown) => (output.insertAuditRow as (pool: DbPool, input: unknown) => Promise<void>)(pool, input),
  };
  new Function("exports", ...Object.keys(dependencies), compiled)(output, ...Object.values(dependencies));
  write = output.updateCephLandmarks as typeof updateCephLandmarks;
  completeDomain = output.completeCephAnalysis as typeof completeCephAnalysis;
}, 60_000);
afterAll(async () => { await sql?.close(); });
async function fixture(source: "manual" | "suggested" = "manual", optional = false) {
  const { rows: [study] } = await pool.query<{ id: number }>("INSERT INTO ceph_analyses (mm_per_pixel) VALUES (0.1) RETURNING id");
  for (const code of [...REQUIRED_LANDMARKS, ...(optional ? ["Co" as const] : [])]) {
    await pool.query("INSERT INTO ceph_landmarks (analysis_id,code,x,y,source,confirmed_by) VALUES ($1,$2,100,200,$3,'original-generator')",
      [study.id, code, optional && code === "Co" ? "suggested" : source]);
  }
  compute.mockClear(); return study.id;
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
  study: (await pool.query("SELECT status, completed_by FROM ceph_analyses WHERE id=$1", [id])).rows[0],
  points: (await pool.query("SELECT code,x,y,source,confirmed_by FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code", [id])).rows,
  stamped: (await pool.query("SELECT code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code", [id])).rows,
});
const review = (id: number, expected = point("S", "suggested")) => write(id, [point("S")], "reviewing-doctor", [], [expected]);

describe("clinical completion requires individual manual landmark review", () => {
  it("refuses a full geometric suggested template before computation/stamping and preserves its data", async () => {
    const id = await fixture("suggested"), before = await state(id);
    const result = await complete(id, "doctor"); expect(result.ok).toBe(false); expect(result.message).toContain("S");
    expect(compute).not.toHaveBeenCalled(); expect(await state(id)).toEqual(before);
  });
  it("also blocks optional suggested points that can influence measurements", async () => {
    const id = await fixture("manual", true), before = await state(id);
    const result = await complete(id, "doctor"); expect(result.ok).toBe(false); expect(result.message).toContain("Co");
    expect(await state(id)).toEqual(before); expect(compute).not.toHaveBeenCalled();
  });
  it("fails closed on missing provenance instead of treating it as manual", async () => {
    const id = await fixture(); await pool.query("UPDATE ceph_landmarks SET source=NULL WHERE analysis_id=$1 AND code='S'", [id]);
    expect((await complete(id, "doctor")).ok).toBe(false); expect(compute).not.toHaveBeenCalled();
  });
  it("keeps historical completed records and measurements unchanged, even if their old source is suggested", async () => {
    const id = await fixture("suggested");
    await pool.query("UPDATE ceph_analyses SET status='completed', completed_by='historical-doctor' WHERE id=$1", [id]);
    await pool.query("INSERT INTO ceph_measurements (analysis_id,code,value) VALUES ($1,'SNA',83)", [id]);
    const before = await state(id); expect((await complete(id, "new-doctor")).ok).toBe(false);
    expect(await state(id)).toEqual(before); expect(compute).not.toHaveBeenCalled();
  });
  it("records unchanged-coordinate explicit review with previous source/actor, then permits completion", async () => {
    const id = await fixture(); await pool.query("UPDATE ceph_landmarks SET source='suggested' WHERE analysis_id=$1 AND code='S'", [id]);
    expect((await review(id)).ok).toBe(true);
    const { rows: [audit] } = await pool.query<{ details: { previousLandmarks: unknown[]; reviewedLandmarks: string[] }; actor: string }>(
      "SELECT details,actor FROM audit_log WHERE entity_id=$1 AND action='ceph.update' ORDER BY id DESC LIMIT 1", [String(id)]);
    expect(audit.actor).toBe("reviewing-doctor"); expect(audit.details.reviewedLandmarks).toEqual(["S"]);
    expect(audit.details.previousLandmarks).toEqual([expect.objectContaining({ ...point("S", "suggested"), confirmed_by: "original-generator" })]);
    expect((await complete(id, "doctor")).ok).toBe(true);
    expect((await state(id)).stamped).toEqual(expect.arrayContaining([{ code: "SNA", value: 82 }]));
    expect((await state(id)).stamped).toHaveLength(mockResults.filter((result) => result.value != null).length);
    expect((await state(id)).points.find((p) => p.code === "S")).toMatchObject({ ...point("S"), confirmed_by: "reviewing-doctor" });
  });
  it("refuses stale review if another editor moved the suggestion", async () => {
    const id = await fixture(); await pool.query("UPDATE ceph_landmarks SET source='suggested',x=101 WHERE analysis_id=$1 AND code='S'", [id]);
    const before = await state(id); expect((await review(id)).ok).toBe(false); expect(await state(id)).toEqual(before);
    expect((await complete(id, "doctor")).ok).toBe(false);
  });
  it("Undo restores suggested provenance and blocks completion; Redo of that explicit review restores it", async () => {
    const id = await fixture(); await pool.query("UPDATE ceph_landmarks SET source='suggested' WHERE analysis_id=$1 AND code='S'", [id]);
    await review(id);
    expect((await write(id, [point("S", "suggested")], "reviewing-doctor", [], [point("S")])).ok).toBe(true);
    expect((await complete(id, "doctor")).ok).toBe(false);
    expect((await review(id)).ok).toBe(true); expect((await complete(id, "doctor")).ok).toBe(true);
  });
  it("accepts a lost-response review replay without claiming a second suggested-to-manual review", async () => {
    const id = await fixture(); await pool.query("UPDATE ceph_landmarks SET source='suggested' WHERE analysis_id=$1 AND code='S'", [id]);
    expect((await review(id)).ok).toBe(true); expect((await review(id)).ok).toBe(true);
    const { rows } = await pool.query<{ details: { reviewedLandmarks: string[] } }>("SELECT details FROM audit_log WHERE entity_id=$1 AND action='ceph.update'", [String(id)]);
    expect(rows.flatMap((r) => r.details.reviewedLandmarks)).toEqual(["S"]);
  });
  it("completion winning the lock prevents later undo/reclassification of sealed points", async () => {
    const id = await fixture(); expect((await complete(id, "doctor")).ok).toBe(true); const before = await state(id);
    expect((await write(id, [point("S", "suggested")], "doctor", [], [point("S")])).ok).toBe(false);
    expect(await state(id)).toEqual(before);
  });
  it.each([0, -0.1, Infinity, NaN])("refuses corrupt stored scale %s before sealing", async (scale) => {
    const id = await fixture(); await pool.query("UPDATE ceph_analyses SET mm_per_pixel=$2 WHERE id=$1", [id, scale]);
    expect((await complete(id, "doctor")).ok).toBe(false); expect(compute).not.toHaveBeenCalled();
  });
  it("both mutation and completion serialize on the same analysis row before landmark reads", () => {
    expect(declarations.match(/SELECT (?:status|\*) FROM ceph_analyses WHERE id = \$1 FOR UPDATE/g)).toHaveLength(2);
  });
});
