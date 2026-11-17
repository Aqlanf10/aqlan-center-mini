import { afterEach, beforeEach, expect, it, vi } from "vitest";

const probes = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../lib/ortho-followup-coverage-db", () => ({ readFollowupCoverageSnapshotWith: probes.read }));
import { seedCanonicalCoverage } from "./fixtures/canonical-ortho-coverage";

beforeEach(() => { probes.read.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

it("classifies the existing missing-lineage fixture error without a diagnostic query", async () => {
  const sink = vi.spyOn(console, "info").mockImplementation(() => {}), timer = vi.spyOn(globalThis, "setTimeout");
  const operations: string[] = [];
  const db = { query: vi.fn(async (sql: string) => {
    operations.push(sql);
    if (/^\s*INSERT\b/i.test(sql)) return { rows: [{ id: 1 }] };
    throw new Error("unexpected synthetic operation");
  }) };
  probes.read.mockResolvedValue({ sources: [] });
  await expect(seedCanonicalCoverage(db as never, { patientId: 1, actorId: 1, doctorId: 1, save: false })).rejects.toThrow("Synthetic coverage lineage was not valid");
  expect(sink).toHaveBeenCalledTimes(1);
  expect(sink.mock.calls[0][0]).toBe("::notice::synthetic_coverage_fixture kind=lineage_unavailable error=other");
  expect(operations).toHaveLength(7);
  expect(operations.every(sql => /^\s*INSERT\b/i.test(sql))).toBe(true);
  expect(timer).not.toHaveBeenCalled();
});

it("rethrows an identical underlying error while emitting only fixed categories", async () => {
  const sink = vi.spyOn(console, "info").mockImplementation(() => {});
  const marker = "SYNTHETIC_SQL_AND_PRIVATE_VALUE_0123456789";
  const original = Object.assign(new Error(marker), { code: "23503" });
  const operations: string[] = [];
  const db = { query: vi.fn(async (sql: string) => {
    operations.push(sql);
    if (/^\s*INSERT\b/i.test(sql)) return { rows: [{ id: 1 }] };
    throw new Error("unexpected synthetic operation");
  }) };
  probes.read.mockRejectedValue(original);
  await expect(seedCanonicalCoverage(db as never, { patientId: 1, actorId: 1, doctorId: 1, save: false })).rejects.toBe(original);
  expect(sink.mock.calls[0][0]).toBe("::notice::synthetic_coverage_fixture kind=other error=23503");
  expect(String(sink.mock.calls[0][0]).includes(marker)).toBe(false);
  expect(operations).toHaveLength(7);
  expect(operations.every(sql => /^\s*INSERT\b/i.test(sql))).toBe(true);
});
