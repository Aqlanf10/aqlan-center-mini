import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFinanceLifecycle } from "../scripts/test-finance-lifecycle.mjs";
const state = vi.hoisted(() => ({ construct: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn(), spawn: vi.fn() }));
vi.mock("pg", () => ({ Client: class {
  constructor(options: unknown) { state.construct(options); }
  connect = state.connect; query = state.query; end = state.end;
} }));
vi.mock("node:child_process", () => ({ spawnSync: state.spawn }));
const url = "postgresql://synthetic:synthetic@127.0.0.1:55439/aqlan_finance_test";
const safe = { NODE_ENV: "test", DATABASE_ENVIRONMENT: "test", TEST_DATABASE_URL: url };
beforeEach(() => {
  vi.clearAllMocks();
  state.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("server_version_num")
    ? [{ name: "aqlan_finance_test", server_version_num: "180004", server_version: "18.4" }] : [] }));
  state.spawn.mockReturnValue({ status: 0 });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("finance lifecycle guard before destructive HTTP global setup", () => {
  it.each([
    { TEST_DATABASE_URL: undefined }, { NODE_ENV: undefined }, { DATABASE_ENVIRONMENT: undefined },
    { NODE_ENV: "production" }, { DATABASE_ENVIRONMENT: " Production " },
    { NODE_ENV: "development" }, { DATABASE_ENVIRONMENT: "staging" },
    { TEST_DATABASE_URL: url.replace("127.0.0.1", "example.invalid") },
    { TEST_DATABASE_URL: url.replace("aqlan_finance_test", "production") },
    { TEST_DATABASE_URL: `${url}?sslmode=disable` },
    { TEST_DATABASE_URL: `${url}?host=example.invalid` },
    { TEST_DATABASE_URL: `${url}?options=-csearch_path=public` },
    { TEST_DATABASE_URL: `${url}#fragment` }, { TEST_DATABASE_URL: ` ${url}` },
    { DATABASE_URL: url.replace("55439", "55440") },
    { POSTGRES_URL: url.replace("aqlan_finance_test", "other_test") },
    { POSTGRES_PRISMA_URL: "postgresql://synthetic@example.invalid/db" },
    { POSTGRES_URL_NON_POOLING: `${url}?sslmode=disable` },
    { SOURCE_DATABASE_URL: url.replace("55439", "55440") },
    { RAILWAY_ENVIRONMENT: "test" }, { RAILWAY_PROJECT_ID: "synthetic" },
    { USE_LOCAL_DB: "true" }, { PGOPTIONS: "-c search_path=public" },
    { PGSERVICE: "production" }, { PGHOST: "localhost" }, { PGHOSTADDR: "127.0.0.1" },
    { PGDATABASE: "production" }, { PGPORT: "55439" },
    { PGPASSFILE: "/synthetic/file" }, { PGSSLMODE: "require" }, { PGSSLROOTCERT: "/synthetic/cert" },
  ])("refuses unsafe original environment before constructing a client: %j", async overrides => {
    await expect(runFinanceLifecycle({ ...safe, ...overrides })).rejects.toThrow();
    expect(state.construct).not.toHaveBeenCalled();
    expect(state.connect).not.toHaveBeenCalled();
    expect(state.spawn).not.toHaveBeenCalled();
  });
  it.each(["160015", "170010", "190001", "0", "invalid"])("refuses PostgreSQL %s before setup", async version => {
    state.query.mockResolvedValue({ rows: [{ name: "aqlan_finance_test", server_version_num: version }] });
    await expect(runFinanceLifecycle(safe)).rejects.toThrow(/postgres.major.unsupported/);
    expect(state.query).toHaveBeenCalledTimes(1);
    expect(state.end).toHaveBeenCalledOnce();
    expect(state.spawn).not.toHaveBeenCalled();
  });
  it.each(["wrong-database", "nonempty-admin", "existing-harness"])("refuses %s before setup", async reason => {
    state.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("server_version_num")
      ? [{ name: reason === "wrong-database" ? "other" : "aqlan_finance_test", server_version_num: "180004", server_version: "18.4" }]
      : sql.includes("pg_tables") ? (reason === "nonempty-admin" ? [{ tablename: "patients" }] : [])
        : (reason === "existing-harness" ? [{ datname: "aqlan_sec_http" }] : []) }));
    await expect(runFinanceLifecycle(safe)).rejects.toThrow();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.end).toHaveBeenCalledOnce();
    expect(state.query.mock.calls.every(([sql]) => String(sql).startsWith("SELECT "))).toBe(true);
  });
  it("runs only after explicit test classification, PG18 and clean target checks", async () => {
    expect(await runFinanceLifecycle({ ...safe, DATABASE_URL: url })).toBe(0);
    expect(state.query).toHaveBeenCalledTimes(3);
    expect(state.end).toHaveBeenCalledOnce();
    expect(state.spawn).toHaveBeenCalledOnce();
    expect(state.spawn.mock.calls[0][2].env).toMatchObject({ NODE_ENV: "test", DATABASE_ENVIRONMENT: "test", DATABASE_URL: url });
  });
});
