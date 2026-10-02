import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ end: vi.fn(), destroy: vi.fn(), mode: "async-error" }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  return { Client: class extends EventEmitter {
    connection = { stream: { destroy: state.destroy } };
    async connect() {
      if (state.mode === "async-error") {
        queueMicrotask(() => this.emit("error", Object.assign(new Error("private server detail"), { code: "57P01" })));
      }
    }
    query(sql: string) {
      if (state.mode.startsWith("cleanup")) {
        if (sql.includes("AS read_only")) return Promise.resolve({ rows: [{
          version: state.mode === "cleanup" ? 170000 : 180000, read_only: "on", isolation: "repeatable read",
        }] });
        if (sql.includes("FROM pg_database")) return Promise.resolve({ rows: [{ version_num: 180000 }] });
        return Promise.resolve({ rows: [] });
      }
      return new Promise(() => {});
    }
    async end() { state.end(); if (state.mode !== "async-error") await new Promise(() => {}); }
  } };
});

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); state.mode = "async-error"; });

it("handles asynchronous pg errors without an unhandled event or partial report", async () => {
  const { runPreflightCli } = await import("../scripts/db-preflight");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(runPreflightCli([], {
    NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/aqlan_p1_test?sslmode=disable",
  })).rejects.toMatchObject({ code: "57P01" });
  expect(output).not.toHaveBeenCalled();
  expect(state.end).toHaveBeenCalledOnce();
});

it("bounds a blackholed query and stalled cleanup, destroying the dedicated socket", async () => {
  const { runPreflightCli } = await import("../scripts/db-preflight");
  vi.useFakeTimers();
  state.mode = "blackhole";
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const running = runPreflightCli([], { NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/aqlan_p1_test" });
  const result = expect(running).rejects.toMatchObject({ code: "CLIENT_TIMEOUT" });
  // Filesystem provenance loads before network timers are installed.
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(42_000);
  await result;
  expect(state.destroy).toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds stalled cleanup after a primary validation failure without losing its stable code", async () => {
  const { runPreflightCli } = await import("../scripts/db-preflight");
  vi.useFakeTimers();
  state.mode = "cleanup";
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const running = runPreflightCli([], { NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/aqlan_p1_test" });
  const result = expect(running).rejects.toMatchObject({ code: "PG_VERSION_UNSUPPORTED" });
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(2_000);
  await result;
  expect(state.destroy).toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("reports CLEANUP_TIMEOUT instead of publishing success when idle end never settles", async () => {
  const { runPreflightCli } = await import("../scripts/db-preflight");
  vi.useFakeTimers();
  state.mode = "cleanup-success";
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const running = runPreflightCli([], { NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/aqlan_p1_test" });
  const result = expect(running).rejects.toMatchObject({ code: "CLEANUP_TIMEOUT" });
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
  await vi.advanceTimersByTimeAsync(2_000);
  await result;
  expect(state.destroy).toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
