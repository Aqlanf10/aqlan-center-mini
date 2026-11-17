import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../lib/ortho-followup-coverage-db", () => ({ readFollowupCoverageSnapshotWith: probe.read }));
const stages = ["case", "clinical", "plan", "service", "invoice", "plan_item", "invoice_item", "source", "revision"] as const;
const notice = (stage: string) => `::notice title=Synthetic coverage seed stage::stage=${stage}\n`;
const detail = (category: string) => `::notice title=Synthetic coverage source detail::detail=${category}\n`;
const syntheticMarker = "SYNTHETIC_PRIVATE_0123456789\n::error::never-print";
const fakeSource = { fingerprint: "synthetic-fingerprint" };

beforeEach(() => { vi.resetModules(); probe.read.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

function database(failAt: number | null, failure: unknown) {
  const operations: string[] = [];
  const query = vi.fn(async (sql: string) => {
    let label = "unexpected";
    if (sql.startsWith("INSERT INTO ortho_cases")) label = "case";
    else if (sql.startsWith("INSERT INTO clinical_cases")) label = "clinical";
    else if (sql.startsWith("INSERT INTO treatment_plans")) label = "plan";
    else if (sql.startsWith("INSERT INTO services")) label = "service";
    else if (sql.startsWith("INSERT INTO invoices")) label = "invoice";
    else if (sql.startsWith("INSERT INTO plan_items")) label = "plan_item";
    else if (sql.startsWith("INSERT INTO invoice_items")) label = "invoice_item";
    else if (sql.startsWith("WITH candidates AS MATERIALIZED")) label = "source";
    else if (sql.startsWith("INSERT INTO ortho_followup_coverage_revisions")) label = "revision";
    operations.push(label);
    if (operations.length === failAt) throw failure;
    if (label === "unexpected") throw new Error("Unexpected synthetic operation");
    return label === "source" ? { rows: [{ sources: [{ snapshot: { synthetic: true } }] }] }
      : { rows: [{ id: label === "revision" ? "synthetic-revision" : operations.length }] };
  });
  return { query, operations };
}
function mockSource() {
  probe.read.mockImplementation(async (observed: { query(sql: string): Promise<unknown> }) => {
    await observed.query("WITH candidates AS MATERIALIZED");
    return { sources: [fakeSource] };
  });
}

describe("synthetic coverage seed stage observation", () => {
  it.each(stages)("reports only the fixed failing stage %s and rethrows the identical value", async stage => {
    const { seedCanonicalCoverage } = await import("./fixtures/canonical-ortho-coverage");
    const original = Object.assign(new Error(syntheticMarker), { code: syntheticMarker });
    const db = database(stages.indexOf(stage) + 1, original), output: string[] = [];
    mockSource();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    let identical = false;
    try { identical = await seedCanonicalCoverage(db as never, { patientId: 1, actorId: 1, doctorId: 1, save: true }).then(() => false, error => error === original); }
    finally { stdout.mockRestore(); info.mockRestore(); }
    expect(identical).toBe(true);
    expect(output).toEqual(stage === "source" ? [notice(stage), detail("query_exception")] : [notice(stage)]);
    expect(output.join("").includes(syntheticMarker)).toBe(false);
    expect(db.operations).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
  });

  it("preserves the full successful order and source identity without a diagnostic notice", async () => {
    const { seedCanonicalCoverage } = await import("./fixtures/canonical-ortho-coverage");
    const db = database(null, null), output: string[] = [];
    mockSource();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    let result: Awaited<ReturnType<typeof seedCanonicalCoverage>>;
    try { result = await seedCanonicalCoverage(db as never, { patientId: 1, actorId: 1, doctorId: 1, save: true }); }
    finally { stdout.mockRestore(); }
    expect(db.operations).toEqual(stages);
    expect(result.source === fakeSource && result.revision === "synthetic-revision").toBe(true); expect(output).toHaveLength(0);
  });

  it("preserves the optional existing case and skipped revision without adding operations", async () => {
    const { seedCanonicalCoverage } = await import("./fixtures/canonical-ortho-coverage");
    const db = database(null, null), output: string[] = [];
    mockSource();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    let result: Awaited<ReturnType<typeof seedCanonicalCoverage>>;
    try { result = await seedCanonicalCoverage(db as never, { patientId: 1, actorId: 1, doctorId: 1, caseId: 42, save: false }); }
    finally { stdout.mockRestore(); }
    expect(result.ortho === 42 && result.revision === null && result.source === fakeSource).toBe(true);
    expect(db.operations).toEqual(stages.slice(1, 8)); expect(output).toHaveLength(0);
  });

  it("classifies a missing synthetic source at source without emitting its message", async () => {
    const { seedCanonicalCoverage } = await import("./fixtures/canonical-ortho-coverage");
    const db = database(null, null), output: string[] = [];
    probe.read.mockResolvedValue({ sources: [] });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    let category = false;
    try { category = await seedCanonicalCoverage(db as never, { patientId: 1, actorId: 1, doctorId: 1, save: false }).then(() => false, error => error instanceof Error && error.message === "Synthetic coverage lineage was not valid"); }
    finally { stdout.mockRestore(); info.mockRestore(); }
    expect(category).toBe(true); expect(output).toEqual([detail("source_and_snapshot_missing"), notice("source")]);
    expect(output.join("").includes("Synthetic coverage lineage was not valid")).toBe(false);
    expect(db.operations).toEqual(stages.slice(0, 7));
  });

  it.each([
    ["source_missing", true, false],
    ["snapshot_missing", false, true],
  ] as const)("distinguishes %s without changing the original error", async (kind, querySnapshot, includeSource) => {
    const { seedCanonicalCoverage } = await import("./fixtures/canonical-ortho-coverage");
    const db = database(null, null), output: string[] = [];
    probe.read.mockImplementation(async (observed: { query(sql: string): Promise<unknown> }) => {
      if (querySnapshot) await observed.query("WITH candidates AS MATERIALIZED");
      return { sources: includeSource ? [fakeSource] : [] };
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    let original = false;
    try { original = await seedCanonicalCoverage(db as never, { patientId: 1, actorId: 1, doctorId: 1, save: false }).then(() => false, error => error instanceof Error && error.message === "Synthetic coverage lineage was not valid"); }
    finally { stdout.mockRestore(); info.mockRestore(); }
    expect(original).toBe(true); expect(output).toEqual([detail(kind), notice("source")]);
    expect(output.join("").includes(syntheticMarker)).toBe(false);
  });

  it("distinguishes a read exception from a query exception and rethrows the identical value", async () => {
    const { seedCanonicalCoverage } = await import("./fixtures/canonical-ortho-coverage");
    const original = new Error(syntheticMarker), db = database(null, null), output: string[] = [];
    probe.read.mockRejectedValue(original);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    let identical = false;
    try { identical = await seedCanonicalCoverage(db as never, { patientId: 1, actorId: 1, doctorId: 1, save: false }).then(() => false, error => error === original); }
    finally { stdout.mockRestore(); info.mockRestore(); }
    expect(identical).toBe(true); expect(output).toEqual([notice("source"), detail("read_exception")]);
    expect(output.join("").includes(syntheticMarker)).toBe(false);
  });

  it("only emits known source details once and never inspects arbitrary inputs", async () => {
    const { observeCoverageSourceDetail } = await import("./fixtures/coverage-seed-stage-diagnostic");
    const categories = ["query_exception", "read_exception", "source_missing", "snapshot_missing", "source_and_snapshot_missing"];
    const output: string[] = [], trap = vi.fn(() => { throw new Error(syntheticMarker); });
    const hostile = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap });
    for (const value of categories) { observeCoverageSourceDetail(value, line => output.push(line)); observeCoverageSourceDetail(value, line => output.push(line)); }
    for (const invalid of [syntheticMarker, "source_missing\n::error::SYNTHETIC_PRIVATE", null, 1, hostile]) observeCoverageSourceDetail(invalid, line => output.push(line));
    expect(output).toEqual(categories.map(detail)); expect(trap).not.toHaveBeenCalled();
    expect(output.join("").includes("SYNTHETIC_PRIVATE")).toBe(false);
  });

  it("accepts only the nine literal stages and emits each at most once per module instance", async () => {
    const { observeCoverageSeedFailure } = await import("./fixtures/coverage-seed-stage-diagnostic");
    const output: string[] = [], timer = vi.spyOn(globalThis, "setTimeout");
    const trap = vi.fn(() => { throw new Error(syntheticMarker); });
    const hostile = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap });
    for (const stage of stages) { observeCoverageSeedFailure(stage, line => output.push(line)); observeCoverageSeedFailure(stage, line => output.push(line)); }
    for (const bad of [syntheticMarker, "case\n::error::SYNTHETIC_PRIVATE", undefined, 1, hostile]) observeCoverageSeedFailure(bad, line => output.push(line));
    expect(output.length === stages.length && output.every((line, index) => line === notice(stages[index]))).toBe(true);
    expect(trap).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
    expect(output.join("").includes("SYNTHETIC_PRIVATE")).toBe(false);
  });

  it("does not replace the original failure when stdout throws", async () => {
    const { seedCanonicalCoverage } = await import("./fixtures/canonical-ortho-coverage");
    const original = new Error(syntheticMarker), db = database(1, original);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => { throw new Error("SYNTHETIC_WRITER"); });
    let identical = false;
    try { identical = await seedCanonicalCoverage(db as never, { patientId: 1, actorId: 1, doctorId: 1 }).then(() => false, error => error === original); }
    finally { stdout.mockRestore(); info.mockRestore(); }
    expect(identical).toBe(true); expect(db.operations).toEqual(["case"]);
  });
});
