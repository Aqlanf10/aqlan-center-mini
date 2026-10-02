import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeGeneratedRuntimeSchema,
  RAILWAY_ENV_NAMES,
  runSchemaOwnershipCharacterization,
  validateOwnershipHarnessEnvironment,
} from "../scripts/verify-schema-ownership";
import { generatePreflightDisclosure } from "../scripts/generate-preflight-disclosure";

const state = vi.hoisted(() => ({
  construct: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn(), pool: vi.fn(),
  runtimeInitialize: vi.fn(), runtimeReset: vi.fn(),
}));
// The client is completely mocked. No unsafe input can trigger a network
// connection or certificate-file read, even if a guard regression is introduced.
vi.mock("pg", () => ({
  Client: class {
    constructor(options: unknown) { state.construct(options); }
    connect = state.connect;
    query = state.query;
    end = state.end;
  },
  Pool: class {
    constructor(options: unknown) { state.pool(options); }
  },
}));
vi.mock("../lib/db", () => ({
  ensureSchema: state.runtimeInitialize,
  resetPoolForTesting: state.runtimeReset,
}));

const canonical = "postgresql://synthetic@127.0.0.1:54329/aqlan_p1_test?sslmode=disable";
const connectionSentinel = new Error("Mock connection boundary; no database work is allowed.");
const standaloneEntrypoints = [
  ["ownership characterization", () => runSchemaOwnershipCharacterization()],
  ["ownership manifest candidate", () => runSchemaOwnershipCharacterization(process.env, { candidateOnly: true })],
  ["offline disclosure generator", () => generatePreflightDisclosure()],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TEST_DATABASE_URL", canonical);
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_ENVIRONMENT", "test");
  for (const name of RAILWAY_ENV_NAMES) vi.stubEnv(name, undefined);
  state.connect.mockRejectedValue(connectionSentinel);
  state.end.mockResolvedValue(undefined);
  state.runtimeInitialize.mockRejectedValue(new Error("Mock runtime boundary; no schema work is allowed."));
  state.runtimeReset.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function rejectedBeforeClient(error: string) {
  for (const [, run] of standaloneEntrypoints) {
    await expect.soft(run()).rejects.toThrow(error);
  }
  expect.soft(state.construct).not.toHaveBeenCalled();
  expect.soft(state.connect).not.toHaveBeenCalled();
  expect.soft(state.query).not.toHaveBeenCalled();
  expect.soft(state.pool).not.toHaveBeenCalled();
}

describe("standalone schema harness target guard", () => {
  it.each([
    canonical,
    "postgresql://synthetic@127.0.0.1:54329/aqlan_p1_test",
    "postgres://synthetic@localhost:5432/aqlan_p1_test?sslmode=disable",
    "postgresql://synthetic@[::1]:5432/aqlan_p1_test?sslmode=disable",
    "postgresql://synthetic@localhost:5432/aqlan%5Fp1%5Ftest?sslmode=disable",
    "postgresql://synthetic:literal space@localhost:5432/aqlan%5Fp1_test?sslmode=disable",
  ])("preserves the canonical test and maintenance targets: %s", (url) => {
    const target = validateOwnershipHarnessEnvironment({ TEST_DATABASE_URL: url, NODE_ENV: "test" });
    const maintenanceUrl = new URL(url);
    maintenanceUrl.pathname = "/postgres";
    expect(target.testUrl.toString()).toBe(new URL(url).toString());
    expect(target.maintenanceUrl.toString()).toBe(maintenanceUrl.toString());
  });

  it.each(standaloneEntrypoints)("%s passes the validated maintenance URL to pg", async (_name, run) => {
    await expect(run()).rejects.toBe(connectionSentinel);
    expect(state.construct).toHaveBeenCalledExactlyOnceWith({
      connectionString: canonical.replace("/aqlan_p1_test", "/postgres"), ssl: false,
    });
    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(state.query).not.toHaveBeenCalled();
    expect(state.pool).not.toHaveBeenCalled();
    expect(state.end).toHaveBeenCalledTimes(1);
  });

  it.each([
    "host=remote.invalid",
    "host=remote.invalid&sslmode=disable",
    "sslmode=disable&host=remote.invalid",
    "%68ost=remote.invalid",
    "hostaddr=203.0.113.1",
    "port=6543",
    "database=postgres",
    "dbname=postgres",
    "user=another_user",
    "password=synthetic",
    "options=-c%20search_path%3Dother",
    "application_name=unexpected",
    "sslmode=disable&sslmode=disable",
    "sslmode=disable&%73slmode=disable",
    "sslmode=disable&sslmode=require",
    "sslmode=require&sslmode=disable",
    "sslmode=require",
    "sslmode=prefer",
    "sslmode=no-verify",
    "%73slmode=require",
    "sslmode=",
    "SSLMode=disable",
    "ssl=true",
    "ssl=0",
    "sslcert=%2Fsynthetic%2Fcertificate.pem",
    "sslkey=%2Fsynthetic%2Fkey.pem",
    "sslrootcert=%2Fsynthetic%2Froot.pem",
    "sslnegotiation=direct",
    "uselibpqcompat=true",
  ])("rejects unsafe query options before any standalone client: %s", async (query) => {
    vi.stubEnv("TEST_DATABASE_URL", `${canonical.split("?")[0]}?${query}`);
    // Keep the test infrastructure's existing error contract after moving its
    // one allowlist into the canonical validator used by every harness caller.
    expect.soft(() => validateOwnershipHarnessEnvironment()).toThrow("POSTGRES_TEST_UNSAFE_QUERY");
    await rejectedBeforeClient("POSTGRES_TEST_UNSAFE_QUERY");
  });

  it.each([
    undefined,
    "",
    "not-a-url",
    "https://127.0.0.1/aqlan_p1_test",
    "postgresql://remote.invalid/aqlan_p1_test",
    "postgresql://postgres.railway.internal/aqlan_p1_test",
    "postgresql://127.0.0.1/postgres",
    "postgresql://127.0.0.1//aqlan_p1_test",
    "postgresql://127.0.0.1/%2Faqlan_p1_test",
    "postgresql://127.0.0.1/aqlan_p1_test%3F",
    "postgresql://127.0.0.1/aqlan_p1_test%23",
    "postgresql://synthetic:%ZZ@127.0.0.1/aqlan%5Fp1_test",
    "postgresql://synthetic:%2@127.0.0.1/aqlan%5Fp1_test",
    "postgresql://synthetic:%@127.0.0.1/aqlan%5Fp1_test",
    "postgresql://synthetic:%FF@127.0.0.1/aqlan_p1_test",
    "postgresql://%FF:synthetic@127.0.0.1/aqlan_p1_test",
    "postgresql://synthetic@127.0.0.1/aqlan%5Fp1_test#%ZZ",
  ])("retains the standalone canonical-target requirement: %j", async (url) => {
    vi.stubEnv("TEST_DATABASE_URL", url);
    vi.stubEnv("DATABASE_URL", canonical);
    await rejectedBeforeClient("SCHEMA_OWNERSHIP_UNSAFE_TARGET");
  });

  it.each(["NODE_ENV", "DATABASE_ENVIRONMENT"])("retains the %s Production guard", async (name) => {
    vi.stubEnv(name, "production");
    await rejectedBeforeClient("SCHEMA_OWNERSHIP_UNSAFE_TARGET");
  });

  it.each(RAILWAY_ENV_NAMES)("retains the Railway guard for %s", async (name) => {
    vi.stubEnv(name, "synthetic-present-marker");
    await rejectedBeforeClient("SCHEMA_OWNERSHIP_UNSAFE_TARGET");
  });

  it("rejects unsafe query options even when runtime target provenance matches", async () => {
    const target = validateOwnershipHarnessEnvironment();
    target.testUrl.searchParams.set("host", "remote.invalid");
    target.maintenanceUrl.searchParams.set("host", "remote.invalid");
    vi.stubEnv("TEST_DATABASE_URL", target.testUrl.toString());
    await expect(initializeGeneratedRuntimeSchema(
      target, "aqlan_schema_ownership_runtime_guard_test",
    )).rejects.toThrow("POSTGRES_TEST_UNSAFE_QUERY");
    expect(state.construct).not.toHaveBeenCalled();
    expect(state.pool).not.toHaveBeenCalled();
    expect(state.runtimeInitialize).not.toHaveBeenCalled();
    expect(state.runtimeReset).not.toHaveBeenCalled();
  });
});
