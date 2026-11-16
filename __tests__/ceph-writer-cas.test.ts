import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeCephDiagnosis, parseCephCalibrationState, sameCephCalibrationState, parseCephCompletionDiagnosis, type CephCompletionDiagnosis, type CephCompletionSnapshot } from "../lib/ceph-completion-snapshot";
import { describeAudit, sanitizeDetails } from "../lib/audit";
import type { DbClient, DbPool, updateCephCalibration, updateCephDiagnosis } from "../lib/db";

// Exact current production writers and audit implementation, real minimal SQL.
// The fourth argument is deliberately ignored by the vulnerable baseline; the
// regressions demonstrate destructive stale writes and swallowed audit failures.
// Ordered interleavings do not claim real PostgreSQL18 row-lock concurrency.
const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
const declarations = [
  ["updateCephCalibration", "export interface CephLandmarkInput"],
  ["updateCephDiagnosis", "export interface CephReferenceSetRow"],
  ["insertAuditRow", "export async function recordAudit("],
  ["recordAudit", "interface AuditRow"],
].map(([name, next]) => {
  const start = source.indexOf(`export async function ${name}(`), end = source.indexOf(next, start);
  if (start < 0 || end < start) throw new Error("Missing production function " + name);
  return source.slice(start, end).replace(/^export /gm, "");
}).join("\n");
const compiled = transformSync(declarations, { loader: "ts", target: "node22" }).code
  + "\nexports.calibrate = updateCephCalibration; exports.diagnose = updateCephDiagnosis;";
type Calibration = NonNullable<CephCompletionSnapshot["calibration"]>;
type CalibrationState = Pick<CephCompletionSnapshot, "calibration" | "mmPerPixel">;
let sql: PGlite, pool: DbPool;
let calibrate: (id: number, desired: Calibration, actor: string, expected?: CalibrationState) => ReturnType<typeof updateCephCalibration>;
let diagnose: (id: number, desired: Parameters<typeof updateCephDiagnosis>[1], actor: string, expected?: CephCompletionDiagnosis | null) => ReturnType<typeof updateCephDiagnosis>;
let failAudit = false, loseCommitReply = false;
const statements: string[] = [];
const emptyCalibration: CalibrationState = { calibration: null, mmPerPixel: null };
const firstRuler: Calibration = { x1: 0, y1: 0, x2: 100, y2: 0, mm: 10 };
const secondRuler: Calibration = { x1: 10, y1: 20, x2: 210, y2: 20, mm: 10 };
const dx = (finalDx: string): CephCompletionDiagnosis => ({ skeletal: null, dental: null, softTissue: null, note: null, finalDx });
beforeAll(async () => {
  sql = new PGlite(); await sql.waitReady;
  await sql.exec(`
    CREATE TABLE ceph_analyses (id SERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft', document_id INT DEFAULT 22,
      cal_x1 DOUBLE PRECISION, cal_y1 DOUBLE PRECISION, cal_x2 DOUBLE PRECISION, cal_y2 DOUBLE PRECISION,
      cal_mm DOUBLE PRECISION, mm_per_pixel DOUBLE PRECISION);
    CREATE TABLE ceph_diagnoses (analysis_id INT PRIMARY KEY, skeletal TEXT, dental TEXT, soft_tissue TEXT,
      note TEXT, final_dx TEXT NOT NULL, created_by TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE audit_log (id BIGSERIAL PRIMARY KEY, action TEXT, entity TEXT, entity_id TEXT, summary TEXT, details JSONB,
      actor TEXT, actor_role TEXT, source_ip TEXT, user_agent TEXT);
  `);
  const query: DbClient["query"] = async <T>(text: string, values?: unknown[]) => {
    statements.push(text.trim());
    if (failAudit && /INSERT INTO audit_log/.test(text)) throw new Error("synthetic audit failure");
    const result = await sql.query<T>(text, values);
    if (loseCommitReply && text === "COMMIT") { loseCommitReply = false; throw new Error("synthetic lost commit reply"); }
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  pool = { query, connect: async () => ({ query, release: () => {} }) };
  const output: Record<string, unknown> = {};
  const dependencies = { ensureSchema: async () => {}, getPool: () => pool, cephWriterClient: () => pool.connect(), /* integration: ceph writers take their client from cephWriterClient (pooled outside a canonical operation) */ normalizeCephDiagnosis, parseCephCalibrationState, sameCephCalibrationState, parseCephCompletionDiagnosis,
    describeAudit, sanitizeDetails, currentAuditSource: async () => ({ ip: null, userAgent: null }) };
  new Function("exports", ...Object.keys(dependencies), compiled)(output, ...Object.values(dependencies));
  calibrate = output.calibrate as typeof calibrate; diagnose = output.diagnose as typeof diagnose;
}, 60_000);
afterAll(async () => { await sql?.close(); });
beforeEach(() => { failAudit = false; loseCommitReply = false; statements.length = 0; });
async function fixture() {
  const { rows: [a] } = await pool.query<{ id: number }>("INSERT INTO ceph_analyses DEFAULT VALUES RETURNING id");
  statements.length = 0; return a.id;
}
const state = async (id: number) => ({
  study: (await pool.query("SELECT * FROM ceph_analyses WHERE id=$1", [id])).rows[0],
  diagnosis: (await pool.query("SELECT * FROM ceph_diagnoses WHERE analysis_id=$1", [id])).rows,
  audit: (await pool.query("SELECT actor,details FROM audit_log WHERE entity_id=$1 ORDER BY id", [String(id)])).rows,
});

describe("clinical writer compare-and-swap and atomic provenance", () => {
  it("refuses a stale first-calibration write instead of overwriting another physician's ruler", async () => {
    const id = await fixture(); expect((await calibrate(id, firstRuler, "doctor-A", emptyCalibration)).ok).toBe(true);
    const before = await state(id); expect((await calibrate(id, secondRuler, "doctor-B", emptyCalibration)).ok).toBe(false);
    expect(await state(id)).toEqual(before);
  });
  it("refuses stale absent diagnosis and preserves the other physician's text", async () => {
    const id = await fixture(); expect((await diagnose(id, dx("Reviewed by A"), "doctor-A", null)).ok).toBe(true);
    const before = await state(id); expect((await diagnose(id, dx("Old tab B"), "doctor-B", null)).ok).toBe(false);
    expect(await state(id)).toEqual(before);
  });
  it("refuses a stale diagnosis retry after a different later edit", async () => {
    const id = await fixture(); await diagnose(id, dx("Original"), "doctor-A", null);
    await diagnose(id, dx("Newer"), "doctor-A", dx("Original")); const before = await state(id);
    expect((await diagnose(id, dx("Old retry"), "doctor-B", dx("Original"))).ok).toBe(false); expect(await state(id)).toEqual(before);
  });
  it("compares ruler endpoints, not merely the derived scale", async () => {
    const id = await fixture(); await calibrate(id, firstRuler, "doctor-A", emptyCalibration);
    const sameScale = { ...firstRuler, x1: 10, x2: 110 };
    await calibrate(id, sameScale, "doctor-A", { calibration: firstRuler, mmPerPixel: 0.1 }); const before = await state(id);
    expect((await calibrate(id, secondRuler, "doctor-B", { calibration: firstRuler, mmPerPixel: 0.1 })).ok).toBe(false);
    expect(await state(id)).toEqual(before);
  });
  it("accepts exact desired calibration replay without duplicate audit or provenance changes", async () => {
    const id = await fixture(); await calibrate(id, firstRuler, "doctor-A", emptyCalibration); const before = await state(id);
    expect((await calibrate(id, firstRuler, "retry-actor", emptyCalibration)).ok).toBe(true); expect(await state(id)).toEqual(before);
  });
  it("accepts normalized desired diagnosis replay without changing its timestamp/actor or audit", async () => {
    const id = await fixture(); await diagnose(id, dx("Reviewed"), "doctor-A", null); const before = await state(id);
    expect((await diagnose(id, dx("  Reviewed  "), "retry-actor", null)).ok).toBe(true); expect(await state(id)).toEqual(before);
  });
  it.each(["calibration", "diagnosis"])("audit failure rolls back the %s write", async kind => {
    const id = await fixture(), before = await state(id); failAudit = true;
    const pending = kind === "calibration" ? calibrate(id, firstRuler, "doctor-A", emptyCalibration) : diagnose(id, dx("New"), "doctor-A", null);
    await expect(pending).rejects.toThrow("synthetic audit failure"); expect(await state(id)).toEqual(before);
  });
  it.each(["calibration", "diagnosis"])("requires an explicit expected state for %s", async kind => {
    const id = await fixture(), before = await state(id);
    const result = kind === "calibration" ? await calibrate(id, firstRuler, "doctor-A") : await diagnose(id, dx("New"), "doctor-A");
    expect(result.ok).toBe(false); expect(await state(id)).toEqual(before);
  });
  it("does not edit completed history even for an exact desired replay", async () => {
    const id = await fixture(); await calibrate(id, firstRuler, "doctor-A", emptyCalibration); await diagnose(id, dx("Reviewed"), "doctor-A", null);
    await pool.query("UPDATE ceph_analyses SET status='completed' WHERE id=$1", [id]); const before = await state(id);
    expect((await calibrate(id, firstRuler, "doctor-B", emptyCalibration)).ok).toBe(false);
    expect((await diagnose(id, dx("Reviewed"), "doctor-B", null)).ok).toBe(false); expect(await state(id)).toEqual(before);
  });
  it("allows independent acknowledged category edits while holding the same draft lock", async () => {
    const id = await fixture(); expect((await calibrate(id, firstRuler, "doctor-A", emptyCalibration)).ok).toBe(true);
    expect((await diagnose(id, dx("Reviewed"), "doctor-B", null)).ok).toBe(true);
  });
});


describe("writer provenance and uncertain-outcome replays", () => {
  it("returns authoritative ruler data and records the actual previous calibration and method", async () => {
    const id = await fixture();
    expect(await calibrate(id, firstRuler, "doctor-A", emptyCalibration)).toEqual({ ok: true, calibration: firstRuler, mmPerPixel: 0.1 });
    await calibrate(id, secondRuler, "doctor-B", { calibration: firstRuler, mmPerPixel: 0.1 });
    const saved = await state(id);
    expect(saved.audit).toEqual([
      { actor: "doctor-A", details: expect.objectContaining({ documentId: 22, method: "two-image-points-known-length", coordinateSpace: "native-image-pixels",
        knownLengthUnit: "mm", previousCalibration: emptyCalibration, calibration: { calibration: firstRuler, mmPerPixel: 0.1 } }) },
      { actor: "doctor-B", details: expect.objectContaining({ previousCalibration: { calibration: firstRuler, mmPerPixel: 0.1 },
        calibration: { calibration: secondRuler, mmPerPixel: 0.05 } }) },
    ]);
  });
  it("records previous diagnosis including its stored attribution, plus the actor making the change", async () => {
    const id = await fixture(); await diagnose(id, dx("Original"), "doctor-A", null);
    await diagnose(id, dx("Amended"), "doctor-B", dx("Original"));
    const saved = await state(id);
    expect(saved.audit[1]).toEqual({ actor: "doctor-B", details: { category: "diagnosis",
      previousDiagnosis: expect.objectContaining({ ...dx("Original"), createdBy: "doctor-A" }), diagnosis: dx("Amended") } });
  });
  it.each(["calibration", "diagnosis"])("committed %s with a lost reply is audited once and safely replayed", async kind => {
    const id = await fixture(); loseCommitReply = true;
    const send = () => kind === "calibration" ? calibrate(id, firstRuler, "doctor-A", emptyCalibration) : diagnose(id, dx("Reviewed"), "doctor-A", null);
    await expect(send()).rejects.toThrow("synthetic lost commit reply"); const committed = await state(id); expect(committed.audit).toHaveLength(1);
    expect((await send()).ok).toBe(true); expect(await state(id)).toEqual(committed);
  });
  it.each(["calibration", "diagnosis"])("audit failure on a later %s preserves the earlier state and audit", async kind => {
    const id = await fixture(); await calibrate(id, firstRuler, "doctor-A", emptyCalibration); await diagnose(id, dx("Original"), "doctor-A", null);
    const before = await state(id); failAudit = true;
    const change = kind === "calibration" ? calibrate(id, secondRuler, "doctor-B", { calibration: firstRuler, mmPerPixel: 0.1 })
      : diagnose(id, dx("Later"), "doctor-B", dx("Original"));
    await expect(change).rejects.toThrow("synthetic audit failure"); expect(await state(id)).toEqual(before);
  });
  it("compares all diagnosis fields, not only its final text", async () => {
    const id = await fixture(); await diagnose(id, { ...dx("Original"), note: "New note" }, "doctor-A", null);
    const before = await state(id); expect((await diagnose(id, dx("Later"), "doctor-B", dx("Original"))).ok).toBe(false);
    expect(await state(id)).toEqual(before);
  });
  it("omission cannot exploit the exact-desired replay path", async () => {
    const id = await fixture(); await calibrate(id, firstRuler, "doctor-A", emptyCalibration); await diagnose(id, dx("Reviewed"), "doctor-A", null);
    const before = await state(id); expect((await calibrate(id, firstRuler, "doctor-A")).ok).toBe(false);
    expect((await diagnose(id, dx("Reviewed"), "doctor-A")).ok).toBe(false); expect(await state(id)).toEqual(before);
  });
});

it('retains partially populated legacy ruler fields in audit when a clinician recalibrates', async () => {
  const id = await fixture();
  await pool.query('UPDATE ceph_analyses SET cal_x1=17,cal_y1=23,mm_per_pixel=0.1 WHERE id=$1', [id]);
  expect((await calibrate(id, firstRuler, 'doctor-A', { calibration: null, mmPerPixel: 0.1 })).ok).toBe(true);
  expect((await state(id)).audit[0]).toEqual({ actor: 'doctor-A', details: expect.objectContaining({
    previousCalibrationRecord: { x1: 17, y1: 23, x2: null, y2: null, mm: null, mmPerPixel: 0.1 },
  }) });
});
