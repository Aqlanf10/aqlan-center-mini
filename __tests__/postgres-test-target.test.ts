import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RAILWAY_ENV_NAMES } from "../scripts/verify-schema-ownership";
import { validatePostgresTestTarget } from "./postgres/_safe-target";
import setupPostgres from "./postgres/_global-setup";

const state = vi.hoisted(() => ({
  construct: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn(),
}));
// No real pg client exists in this suite: all unsafe cases prove rejection before
// construction/connect, not by attempting a network connection and expecting failure.
vi.mock("pg", () => ({
  Client: class {
    constructor(options: unknown) { state.construct(options); }
    connect = state.connect;
    query = state.query;
    end = state.end;
  },
  Pool: class {},
}));

const canonical = "postgresql://synthetic@127.0.0.1:54329/aqlan_p1_test?sslmode=disable";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TEST_DATABASE_URL", canonical);
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_ENVIRONMENT", "test");
  for (const name of RAILWAY_ENV_NAMES) vi.stubEnv(name, undefined);
  state.query.mockImplementation(async (sql: string) => ({
    rows: [sql.includes("server_version_num")
      ? { server_version_num: "180004" } : { server_version: "18.4" }],
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function rejectedBeforeConnection() {
  await expect(setupPostgres()).rejects.toThrow();
  expect(state.construct).not.toHaveBeenCalled();
  expect(state.connect).not.toHaveBeenCalled();
  expect(state.query).not.toHaveBeenCalled();
}

describe("PostgreSQL test infrastructure target guard", () => {
  it.each([
    canonical,
    "postgresql://synthetic@127.0.0.1:54329/aqlan_p1_test",
    "postgresql://synthetic@localhost:5432/aqlan_p1_test?sslmode=disable",
    "postgresql://synthetic@[::1]:5432/aqlan_p1_test?sslmode=disable",
  ])("accepts the exact canonical target before the version check: %s", async (url) => {
    vi.stubEnv("TEST_DATABASE_URL", url);
    expect(validatePostgresTestTarget().testUrl.toString()).toBe(url);
    await setupPostgres();
    expect(state.construct).toHaveBeenCalledExactlyOnceWith({ connectionString: url, ssl: false });
    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(state.end).toHaveBeenCalledTimes(1);
  });

  it("preserves global setup's canonical DATABASE_URL fallback only when TEST_DATABASE_URL is unset", async () => {
    vi.stubEnv("TEST_DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_URL", canonical);
    // The FK suite's stricter, existing TEST_DATABASE_URL requirement is retained.
    expect(() => validatePostgresTestTarget()).toThrow("TEST_DATABASE_URL is required");
    await setupPostgres();
    expect(state.construct).toHaveBeenCalledExactlyOnceWith({ connectionString: canonical, ssl: false });
    expect(state.connect).toHaveBeenCalledTimes(1);
  });

  it.each(["", " ", "not-a-url", "postgresql://remote.invalid/aqlan_p1_test"])(
    "never rescues an invalid supplied test URL with a valid fallback: %j", async (url) => {
      vi.stubEnv("TEST_DATABASE_URL", url);
      vi.stubEnv("DATABASE_URL", canonical);
      await rejectedBeforeConnection();
    },
  );

  it.each([
    "host=remote.invalid&sslmode=disable",
    "%68ost=remote.invalid&sslmode=disable",
    "hostaddr=203.0.113.1",
    "port=6543",
    "database=postgres",
    "dbname=postgres",
    "user=another_user",
    "options=-c%20search_path%3Dother",
    "sslcert=%2Fprivate%2Fcertificate.pem",
    "application_name=unexpected",
    "sslmode=disable&sslmode=disable",
    "sslmode=require",
    "sslmode=prefer",
    "sslmode=no-verify",
    "sslmode=",
  ])("rejects query overrides before any client is constructed: %s", async (query) => {
    vi.stubEnv("TEST_DATABASE_URL", `postgresql://synthetic@127.0.0.1:54329/aqlan_p1_test?${query}`);
    expect(() => validatePostgresTestTarget()).toThrow("POSTGRES_TEST_UNSAFE_QUERY");
    await rejectedBeforeConnection();
  });

  it.each([
    "postgresql://remote.invalid/aqlan_p1_test",
    "postgresql://127.0.0.1/postgres",
    "postgresql://127.0.0.1/aqlan_p1_test_extra",
    "https://127.0.0.1/aqlan_p1_test",
    "not-a-url",
  ])("rejects an unsafe target before any client is constructed: %s", async (url) => {
    vi.stubEnv("TEST_DATABASE_URL", url);
    await rejectedBeforeConnection();
  });

  it.each(["NODE_ENV", "DATABASE_ENVIRONMENT"])("rejects the original %s Production classification", async (name) => {
    vi.stubEnv(name, "production");
    await rejectedBeforeConnection();
  });

  it.each(RAILWAY_ENV_NAMES)("rejects the original Railway marker %s", async (name) => {
    vi.stubEnv(name, "synthetic-present-marker");
    await rejectedBeforeConnection();
  });

  it("does not erase Production markers when selecting the fallback", async () => {
    vi.stubEnv("TEST_DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_URL", canonical);
    vi.stubEnv("RAILWAY_PROJECT_ID", "synthetic-present-marker");
    await rejectedBeforeConnection();
  });

  it("rejects connection overrides in the fallback before constructing a client", async () => {
    vi.stubEnv("TEST_DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_URL", `${canonical}&host=remote.invalid`);
    await rejectedBeforeConnection();
  });
});
