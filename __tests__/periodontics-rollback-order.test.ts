// Reconstructed regression for the recovered 405de66 cleanup correction.
import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn(), ensureSchema: vi.fn() }));
vi.mock("../lib/db", () => ({
  ensureSchema: boundary.ensureSchema,
  getPool: () => ({ connect: boundary.connect }),
  insertAuditRow: vi.fn(),
}));
import { addPerioAddendum, savePerioExam } from "../lib/periodontics-db";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const writers = [
  ["save", () => savePerioExam({ patientId: 1, visitId: 2, actor: "recorder", expectedRevision: null,
    draft: { doctorId: 3, caseId: null, sites: [] } })],
  ["addendum", () => addPerioAddendum({ patientId: 1, examId: 2, actor: "recorder", text: "Correction", requestKey: "perio:rollback-test" })],
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  boundary.ensureSchema.mockResolvedValue(undefined);
  boundary.connect.mockResolvedValue({ query: boundary.query, release: boundary.release });
});

describe("periodontal refusal cleanup ordering", () => {
  it.each(writers)("%s waits for a deferred refusal rollback before returning or releasing", async (_name, write) => {
    const started = deferred<void>();
    const rollback = deferred<{ rows: never[] }>();
    boundary.query.mockImplementation((sql: string) => {
      if (sql === "ROLLBACK") { started.resolve(); return rollback.promise; }
      return Promise.resolve({ rows: [] }); // Missing authorized patient causes refusal.
    });
    let settled = false;
    const result = write();
    void result.finally(() => { settled = true; });
    await started.promise;
    await Promise.resolve();
    expect(boundary.release).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    rollback.resolve({ rows: [] });
    expect(await result).toEqual({ ok: false, reason: "not_found" });
    expect(boundary.release).toHaveBeenCalledTimes(1);
    expect(boundary.query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(1);
  });

  it.each(writers)("%s preserves a failed refusal rollback and awaits cleanup before release", async (_name, write) => {
    const firstStarted = deferred<void>();
    const cleanupStarted = deferred<void>();
    const firstRollback = deferred<{ rows: never[] }>();
    const cleanupRollback = deferred<{ rows: never[] }>();
    const failure = new Error("synthetic refusal rollback failed");
    let rollbackCalls = 0;
    boundary.query.mockImplementation((sql: string) => {
      if (sql !== "ROLLBACK") return Promise.resolve({ rows: [] });
      if (++rollbackCalls === 1) { firstStarted.resolve(); return firstRollback.promise; }
      cleanupStarted.resolve();
      return cleanupRollback.promise;
    });
    let settled = false;
    const result = write();
    const outcome = result.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }))
      .finally(() => { settled = true; });
    await firstStarted.promise;
    expect(boundary.release).not.toHaveBeenCalled();
    firstRollback.reject(failure);
    await cleanupStarted.promise;
    expect(boundary.release).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    cleanupRollback.reject(new Error("synthetic cleanup also failed"));
    expect((await outcome).error).toBe(failure);
    expect(rollbackCalls).toBe(2);
    expect(boundary.release).toHaveBeenCalledTimes(1);
  });
});
