import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { isCephLandmarkCode, type LandmarkCode } from "../lib/ceph";
import type { CephLandmarkInput, updateCephLandmarks } from "../lib/db";

// The exact production function runs against a transaction protocol double.
// These tests do not claim PostgreSQL row-lock/concurrency integration coverage.
const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("db.ts", source, ts.ScriptTarget.Latest, true);
const node = parsed.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "updateCephLandmarks");
if (!node) throw new Error("Production ceph landmark writer not found");
const compiled = ts.transpileModule(node.getFullText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
type Stored = CephLandmarkInput & { analysis_id: number; confirmed_by: string; confirmed_at: Date };
const point = (code: LandmarkCode, x = 10, y = 20): CephLandmarkInput => ({ code, x, y, source: "manual" });
function harness(initial: CephLandmarkInput[] = []) {
  let rows: Stored[] = initial.map((pt) => ({ ...pt, analysis_id: 71, confirmed_by: "synthetic-doctor", confirmed_at: new Date("2026-01-01") }));
  let before: Stored[] = [], status: string | null = "draft", audits: unknown[] = [], oldAudits: unknown[] = [];
  let failAudit = false;
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql === "BEGIN") { before = structuredClone(rows); oldAudits = structuredClone(audits); }
    else if (sql === "ROLLBACK") { rows = before; audits = oldAudits; }
    else if (sql.includes("SELECT status FROM ceph_analyses")) return { rows: status === null ? [] : [{ status }] };
    else if (sql.includes("SELECT code, x, y, source")) return { rows: rows.filter((pt) => pt.analysis_id === args[0]) };
    else if (sql.includes("DELETE FROM ceph_landmarks")) {
      expect(sql).toContain("analysis_id = $1"); expect(sql).toContain("code = ANY($2::text[])");
      rows = rows.filter((pt) => pt.analysis_id !== args[0] || !(args[1] as string[]).includes(pt.code));
    } else if (sql.includes("INSERT INTO ceph_landmarks")) {
      const next: Stored = { analysis_id: args[0] as number, code: args[1] as LandmarkCode, x: args[2] as number, y: args[3] as number,
        source: args[4] as "manual" | "suggested", confirmed_by: args[5] as string, confirmed_at: new Date() };
      rows = [...rows.filter((pt) => pt.analysis_id !== next.analysis_id || pt.code !== next.code), next];
    } else if (!["COMMIT"].includes(sql)) throw new Error("Unexpected SQL: " + sql);
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const audit = async (_executor: unknown, input: unknown) => { if (failAudit) throw new Error("Synthetic audit failure"); audits.push(input); };
  const dependencies = {
    ensureSchema: async () => {}, getPool: () => ({ connect: async () => client }), isCephLandmarkCode,
    insertAuditRow: audit, recordAudit: async (input: unknown) => audit(null, input),
  };
  const output: Record<string, unknown> = {};
  new Function("exports", ...Object.keys(dependencies), compiled)(output, ...Object.values(dependencies));
  const write = output.updateCephLandmarks as typeof updateCephLandmarks;
  return { write, query, client,
    points: () => rows.filter((pt) => pt.analysis_id === 71).map(({ code, x, y, source }) => ({ code, x, y, source })),
    audit: () => audits,
    setStatus: (value: string | null) => { status = value; },
    failAudit: () => { failAudit = true; },
    addOther: () => { rows.push({ ...point("S"), analysis_id: 72, confirmed_by: "other", confirmed_at: new Date() }); },
    allRows: () => rows,
  };
}

describe("ceph landmark writer transaction protocol", () => {
  it("undoes initial placement, survives readback, retries idempotently, and redoes once", async () => {
    const h = harness();
    await h.write(71, [point("S")], "synthetic-doctor");
    expect((await h.write(71, [], "synthetic-doctor", ["S"], [point("S")])).ok).toBe(true);
    expect(h.points()).toEqual([]);
    expect((await h.write(71, [], "synthetic-doctor", ["S"], [point("S")])).ok).toBe(true);
    await h.write(71, [point("S")], "synthetic-doctor"); await h.write(71, [point("S")], "synthetic-doctor");
    expect(h.points()).toEqual([point("S")]);
  });
  it("combines scoped remove and upsert without touching other studies", async () => {
    const h = harness([point("S"), point("N")]); h.addOther();
    await h.write(71, [point("N", 30, 40)], "synthetic-doctor", ["S"], [point("S"), point("N")]);
    expect(h.points()).toEqual([point("N", 30, 40)]);
    expect(h.allRows().find((pt) => pt.analysis_id === 72)?.code).toBe("S");
    expect(h.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(["BEGIN", "SELECT status FROM ceph_analyses WHERE id = $1 FOR UPDATE", "COMMIT"]));
  });
  it("rejects stale removal after another tab moved the point", async () => {
    const h = harness([point("S", 30, 40)]);
    expect((await h.write(71, [], "synthetic-doctor", ["S"], [point("S")])).ok).toBe(false);
    expect(h.points()).toEqual([point("S", 30, 40)]);
    expect(h.audit()).toEqual([]); expect(h.query).toHaveBeenCalledWith("ROLLBACK");
  });
  it("rejects stale source changes as well as changed coordinates", async () => {
    const h = harness([{ ...point("S"), source: "suggested" }]);
    expect((await h.write(71, [], "synthetic-doctor", ["S"], [point("S")])).ok).toBe(false);
    expect(h.points()).toEqual([{ ...point("S"), source: "suggested" }]);
  });
  it("guards optional expected upserts but accepts exact replay", async () => {
    const h = harness([point("S")]);
    expect((await h.write(71, [point("S", 30, 40)], "synthetic-doctor", [], [point("S")])).ok).toBe(true);
    expect((await h.write(71, [point("S", 30, 40)], "synthetic-doctor", [], [point("S")])).ok).toBe(true);
    expect((await h.write(71, [point("S", 50, 60)], "synthetic-doctor", [], [point("S")])).ok).toBe(false);
    expect(h.points()).toEqual([point("S", 30, 40)]);
  });
  it.each(["completed", "discarded", null])("refuses non-draft/missing study %s", async (status) => {
    const h = harness([point("S")]); h.setStatus(status);
    expect((await h.write(71, [], "synthetic-doctor", ["S"], [point("S")])).ok).toBe(false);
    expect(h.points()).toEqual([point("S")]); expect(h.audit()).toEqual([]); expect(h.client.release).toHaveBeenCalledOnce();
  });
  it("rejects missing expected snapshot and mixed malformed batches before opening a transaction", async () => {
    const h = harness([point("S")]);
    expect((await h.write(71, [], "synthetic-doctor", ["S"])).ok).toBe(false);
    expect((await h.write(71, [point("N"), point("S", NaN)], "synthetic-doctor")).ok).toBe(false);
    expect((await h.write(71, [point("S")], "synthetic-doctor", ["S"], [point("S")])).ok).toBe(false);
    expect(h.query).not.toHaveBeenCalled(); expect(h.points()).toEqual([point("S")]);
  });
  it("keeps removed coordinates and attribution in the audit before COMMIT", async () => {
    const h = harness([point("S")]); await h.write(71, [], "synthetic-doctor", ["S"], [point("S")]);
    expect(h.audit()).toEqual([expect.objectContaining({ details: expect.objectContaining({ removedLandmarks: [expect.objectContaining({ ...point("S"), confirmed_by: "synthetic-doctor" })] }) })]);
  });
  it("rolls back removal and upsert together when audit insertion fails", async () => {
    const h = harness([point("S")]); h.failAudit();
    await expect(h.write(71, [point("N")], "synthetic-doctor", ["S"], [point("S")])).rejects.toThrow("Synthetic audit failure");
    expect(h.points()).toEqual([point("S")]); expect(h.audit()).toEqual([]);
    expect(h.query).toHaveBeenCalledWith("ROLLBACK"); expect(h.client.release).toHaveBeenCalledOnce();
  });
});


describe("ceph calibration writer finite scale", () => {
  const declaration = parsed.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "updateCephCalibration");
  if (!declaration) throw new Error("Production calibration writer not found");
  const code = ts.transpileModule(declaration.getFullText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  it.each([
    { x1: 0, y1: 0, x2: 1e308, y2: 0, mm: Number.MIN_VALUE },
    { x1: 0, y1: 0, x2: Number.MIN_VALUE, y2: 0, mm: 1e308 },
  ])("refuses a zero/infinite derived scale before persistence", async (calibration) => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("SELECT status") ? [{ status: "draft" }] : [] }));
    const release = vi.fn(), output: Record<string, unknown> = {};
    new Function("exports", "ensureSchema", "getPool", "recordAudit", code)(output, async () => {},
      () => ({ connect: async () => ({ query, release }) }), async () => {});
    const write = output.updateCephCalibration as typeof import("../lib/db").updateCephCalibration;
    expect((await write(71, calibration, "synthetic-doctor")).ok).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE ceph_analyses"))).toBe(false);
    expect(query).toHaveBeenCalledWith("ROLLBACK"); expect(release).toHaveBeenCalledOnce();
  });
});
