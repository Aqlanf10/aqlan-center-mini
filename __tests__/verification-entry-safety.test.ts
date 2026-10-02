import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID,
  databaseUrlForProject,
} from "../lib/database-scope";
import { checkDatabaseUrlForGates, GATE_DATABASE_URL_ENV_NAMES } from "../lib/env-contract";
import { successfulCephJourney } from "./fixtures/ceph-journey-success";

/**
 * Exercise the direct CLI boundary, not only a helper. Everything that could
 * load credentials, open a database, import runtime bootstrap, or launch an
 * operational child is replaced before evaluating either entry point.
 */
const boundary = vi.hoisted(() => ({
  client: vi.fn(),
  connect: vi.fn(async () => undefined),
  query: vi.fn(async (_sql: string) => ({ rows: [] })),
  end: vi.fn(async () => undefined),
  runtimeImport: vi.fn(),
  runtimeEnd: vi.fn(async () => undefined),
  spawn: vi.fn(),
}));

vi.mock("../scripts/load-env.mjs", () => ({}));
vi.mock("pg", () => ({
  Client: class {
    constructor(options: unknown) { boundary.client(options); }
    connect = boundary.connect;
    query = boundary.query;
    end = boundary.end;
  },
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: boundary.spawn,
}));

const LOCAL_MAINTENANCE = "postgresql://fixture:synthetic-only@127.0.0.1:54329/postgres?sslmode=disable";
const LOCAL_TEST = "postgresql://fixture:synthetic-only@127.0.0.1:54329/aqlan_p1_test?sslmode=disable";
const RAILWAY_REMOTE = "postgresql://fixture:synthetic-only@production.railway.internal/railway";
const ENTRY_POINTS = ["verify-ceph.mjs", "verify-ci.mjs"] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];
const originalArgv = process.argv;
let runtimeFixture: ReturnType<typeof successfulCephJourney> | undefined;

// Assert all existing runtime identities. Unrelated Railway CLI credential
// variables are not runtime identities and must not expand this contract.
// The test owns the matrix so removing a production marker from implementation
// cannot silently remove its regression coverage.
const RAILWAY_MARKERS = [
  "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID",
  "RAILWAY_DEPLOYMENT_ID", "RAILWAY_PUBLIC_DOMAIN", "RAILWAY_PRIVATE_DOMAIN",
  "RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_VOLUME_MOUNT_PATH",
  "RAILWAY_GIT_COMMIT_SHA", "RAILWAY_DB_TUNNEL_PORT", "RAILWAY_MOUNTS",
  "RAILWAY_MOUNTS_TMPFS_DATA",
];

const UNSAFE_QUERIES = [
  "host=production.railway.internal",
  "hostaddr=203.0.113.10",
  "port=5433",
  "database=aqlan_center_mini_v2",
  "user=another-user",
  "password=another-synthetic-value",
  "sslcert=%2Fsynthetic%2Fcertificate.pem",
  "sslkey=%2Fsynthetic%2Fprivate-key.pem",
  "sslrootcert=%2Fsynthetic%2Froot.pem",
  "%68ost=production.railway.internal",
  "host=127.0.0.1&host=production.railway.internal",
  "sslmode=disable&host=production.railway.internal",
  "sslmode=disable&sslmode=disable",
  "sslmode=disable&%73slmode=require",
  "SSLMode=disable",
  "sslmode=require",
  "application_name=unexpected-option",
];

class CliExit extends Error {
  constructor(readonly code: number) { super(`mocked CLI exit ${code}`); }
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  boundary.connect.mockResolvedValue(undefined);
  boundary.query.mockResolvedValue({ rows: [] });
  boundary.end.mockResolvedValue(undefined);
  boundary.runtimeEnd.mockResolvedValue(undefined);
  runtimeFixture = undefined;
  for (const name of [
    ...GATE_DATABASE_URL_ENV_NAMES, ...RAILWAY_MARKERS,
    ...Object.keys(process.env).filter((name) => name.startsWith("RAILWAY_")),
    "NODE_ENV", "DATABASE_ENVIRONMENT", "CI", "USE_LOCAL_DB",
  ]) vi.stubEnv(name, undefined);
  vi.stubEnv("DATABASE_URL", LOCAL_MAINTENANCE);
  vi.stubEnv("TEST_DATABASE_URL", LOCAL_TEST);
  vi.stubEnv("CI", "true");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new CliExit(Number(code ?? 0));
  });
  boundary.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  // A factory per evaluation records actual dynamic import, while preventing
  // loading lib/db.ts, schema bootstrap, PGlite, or any patient fixtures.
  vi.doMock("../lib/db.ts", () => {
    boundary.runtimeImport();
    if (runtimeFixture) return runtimeFixture.db;
    throw new Error("STOP_BEFORE_MOCKED_RUNTIME_BOOTSTRAP");
  });
  vi.doMock("../lib/ceph.ts", () => {
    if (runtimeFixture) return runtimeFixture.ceph;
    throw new Error("UNEXPECTED_CEPH_RUNTIME_IMPORT");
  });
});

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("../lib/db.ts");
  vi.doUnmock("../lib/ceph.ts");
});

async function invokeDirect(entry: EntryPoint): Promise<unknown> {
  const path = fileURLToPath(new URL(`../scripts/${entry}`, import.meta.url));
  process.argv = [process.execPath, path];
  try {
    // A variable import deliberately evaluates the actual executable module.
    await import(/* @vite-ignore */ `../scripts/${entry}`);
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectNoEffects() {
  expect({
    clients: boundary.client.mock.calls.length,
    connects: boundary.connect.mock.calls.length,
    queries: boundary.query.mock.calls.length,
    runtimeImports: boundary.runtimeImport.mock.calls.length,
    children: boundary.spawn.mock.calls.length,
  }).toEqual({ clients: 0, connects: 0, queries: 0, runtimeImports: 0, children: 0 });
}

async function expectRefused(entry: EntryPoint) {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSourceUrl = process.env.SOURCE_DATABASE_URL;
  const originalClassification = process.env.DATABASE_ENVIRONMENT;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalMarkers = Object.fromEntries(RAILWAY_MARKERS.map((name) => [name, process.env[name]]));
  const error = await invokeDirect(entry);
  expectNoEffects();
  expect(error).toBeInstanceOf(Error);
  if (error instanceof CliExit) expect(error.code).not.toBe(0);
  expect(process.env.DATABASE_URL).toBe(originalDatabaseUrl);
  expect(process.env.SOURCE_DATABASE_URL).toBe(originalSourceUrl);
  expect(process.env.DATABASE_ENVIRONMENT).toBe(originalClassification);
  expect(process.env.NODE_ENV).toBe(originalNodeEnv);
  for (const [name, value] of Object.entries(originalMarkers)) expect(process.env[name]).toBe(value);
  const diagnostics = [String(error), ...vi.mocked(console.error).mock.calls.flat()].join(" ");
  expect(diagnostics).toMatch(/VERIFICATION_UNSAFE_TARGET|POSTGRES_TEST_UNSAFE_QUERY/);
  expect(diagnostics).not.toContain("synthetic-only");
  expect(diagnostics).not.toContain("postgresql://");
}

describe.each(ENTRY_POINTS)("direct %s rejects before all operational boundaries", (entry) => {
  it.each(["NODE_ENV", "DATABASE_ENVIRONMENT"])("rejects original %s=production", async (name) => {
    vi.stubEnv(name, "production");
    await expectRefused(entry);
  });

  it.each(["Production", "PRODUCTION", " production "])("rejects normalized explicit production classification %j", async (classification) => {
    vi.stubEnv("DATABASE_ENVIRONMENT", classification);
    await expectRefused(entry);
  });

  it.each(RAILWAY_MARKERS)("rejects original %s even with loopback URLs", async (name) => {
    vi.stubEnv(name, "synthetic-runtime-marker");
    await expectRefused(entry);
  });

  it("rejects the recognized Railway project before a temporary name could be rewritten", async () => {
    vi.stubEnv("RAILWAY_PROJECT_ID", AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID);
    await expectRefused(entry);
  });

  it.each(GATE_DATABASE_URL_ENV_NAMES)("rejects an unsafe original %s alias", async (name) => {
    vi.stubEnv(name, RAILWAY_REMOTE);
    await expectRefused(entry);
  });

  it.each(GATE_DATABASE_URL_ENV_NAMES)("rejects encoded connection-query overrides in %s", async (name) => {
    const base = name === "TEST_DATABASE_URL" ? LOCAL_TEST : LOCAL_MAINTENANCE;
    vi.stubEnv(name, `${base.split("?")[0]}?%68ost=production.railway.internal`);
    await expectRefused(entry);
  });

  it.each(GATE_DATABASE_URL_ENV_NAMES.flatMap((name) => [
    [name, "leading-space"], [name, "trailing-space"], [name, "leading-newline"],
  ]))("rejects raw %s %s before pg can parse a different target", async (name, shape) => {
    const base = name === "TEST_DATABASE_URL" ? LOCAL_TEST : LOCAL_MAINTENANCE;
    const raw = shape === "leading-space" ? ` ${base}` : shape === "trailing-space" ? `${base} ` : `\n${base}`;
    vi.stubEnv(name, raw);
    await expectRefused(entry);
  });

  it.each(GATE_DATABASE_URL_ENV_NAMES)("rejects embedded URL control characters in %s", async (name) => {
    const database = name === "TEST_DATABASE_URL" ? "aqlan_p1_test" : "postgres";
    vi.stubEnv(name, `postgre\nsql://fixture:synthetic only@127.0.0.1:54329/${database}`);
    await expectRefused(entry);
  });

  it.each(GATE_DATABASE_URL_ENV_NAMES.flatMap((name) => [
    [name, "synthetic value"], [name, "synthetic%ZZ"],
  ]))("rejects pg preprocessing ambiguity in %s credential %j", async (name, credential) => {
    const database = name === "TEST_DATABASE_URL" ? "aqlan_p1_test" : "postgr%C3%A9s";
    vi.stubEnv(name, `postgresql://fixture:${credential}@127.0.0.1:54329/${database}`);
    await expectRefused(entry);
  });

  it.each(["\u0000", "\u0001", "\u001f", "\t", "\r", "\u007f"])("rejects raw ASCII control %j without driver fallback", async (control) => {
    vi.stubEnv("SOURCE_DATABASE_URL", `postgresql:${control}//fixture:synthetic only@127.0.0.1:54329/postgres`);
    await expectRefused(entry);
  });

  it("rejects unsafe SOURCE_DATABASE_URL despite safe DATABASE_URL and TEST_DATABASE_URL", async () => {
    vi.stubEnv("SOURCE_DATABASE_URL", RAILWAY_REMOTE);
    await expectRefused(entry);
  });

  it.each(["", "   ", "not-a-postgres-url"])("does not fall back from an explicitly invalid source (%j)", async (source) => {
    vi.stubEnv("SOURCE_DATABASE_URL", source);
    await expectRefused(entry);
  });

  it.each(UNSAFE_QUERIES)("rejects source query overrides before pg construction: %s", async (query) => {
    vi.stubEnv("SOURCE_DATABASE_URL", `${LOCAL_MAINTENANCE.split("?")[0]}?${query}`);
    await expectRefused(entry);
  });

  it("rejects an unclassified non-Railway remote source", async () => {
    vi.stubEnv("SOURCE_DATABASE_URL", "postgresql://fixture:synthetic-only@db.example.invalid/postgres");
    await expectRefused(entry);
  });

  it.each(["test", "development", "staging"])("rejects a classified remote %s target outside CI", async (classification) => {
    vi.stubEnv("CI", "false");
    vi.stubEnv("DATABASE_ENVIRONMENT", classification);
    vi.stubEnv("SOURCE_DATABASE_URL", "postgresql://fixture:synthetic-only@db.example.invalid/postgres");
    await expectRefused(entry);
  });

  it.each(["postgresql://fixture:synthetic-only@127.0.0.1:54329", "postgresql://fixture:synthetic-only@127.0.0.1:54329/"])(
    "rejects a maintenance source without an explicit database name: %s", async (source) => {
      vi.stubEnv("SOURCE_DATABASE_URL", source);
      await expectRefused(entry);
    },
  );
});

describe("valid direct-entry maintenance contract", () => {
  it("ceph refuses USE_LOCAL_DB=true before any PostgreSQL or runtime effects", async () => {
    vi.stubEnv("USE_LOCAL_DB", "true");
    await expectRefused("verify-ceph.mjs");
  });

  it.each(["TRUE", " true ", "false"])("ceph matches the application's exact local-backend flag for %j", async (flag) => {
    vi.stubEnv("USE_LOCAL_DB", flag);
    await invokeDirect("verify-ceph.mjs");
    expect(boundary.client).toHaveBeenCalledOnce();
    expect(boundary.runtimeImport).toHaveBeenCalledOnce();
  });

  it("direct CI keeps its existing local-fixture and PostgreSQL SKIP contract", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("TEST_DATABASE_URL", undefined);
    vi.stubEnv("USE_LOCAL_DB", "true");
    const error = await invokeDirect("verify-ci.mjs");
    expect(error).toBeInstanceOf(CliExit);
    expect((error as CliExit).code).toBe(1);
    expect(boundary.spawn).toHaveBeenCalled();
    expect(boundary.spawn.mock.calls.some(([, args]) => args.includes("scripts/verify-ceph.mjs"))).toBe(false);
    expect(boundary.client).not.toHaveBeenCalled();
  });

  it.each([
    "postgresql://fixture:synthetic-only@localhost:54329/postgres",
    "postgresql://fixture:synthetic-only@127.0.0.1:54329/postgres?sslmode=disable",
    "postgresql://fixture:synthetic-only@[::1]:54329/postgres?sslmode=disable",
  ])("ceph accepts local maintenance independently of the integration database: %s", async (source) => {
    vi.stubEnv("DATABASE_URL", source);
    await invokeDirect("verify-ceph.mjs");
    expect(boundary.client).toHaveBeenCalledWith(expect.objectContaining({ connectionString: source }));
    expect(boundary.connect).toHaveBeenCalledOnce();
    expect(boundary.runtimeImport).toHaveBeenCalledOnce();
    const runtimeUrl = process.env.DATABASE_URL!;
    expect(new URL(runtimeUrl).pathname).toMatch(/^\/ceph_check_[a-z0-9_]+$/);
    expect(databaseUrlForProject(runtimeUrl, process.env)).toBe(runtimeUrl);
    expect(process.env.TEST_DATABASE_URL).toBe(LOCAL_TEST);
    expect(boundary.spawn).not.toHaveBeenCalled();
  });

  it("ceph preserves the selected SOURCE_DATABASE_URL ahead of DATABASE_URL", async () => {
    const source = "postgresql://fixture:synthetic-only@localhost:54330/postgres?sslmode=disable";
    vi.stubEnv("SOURCE_DATABASE_URL", source);
    await invokeDirect("verify-ceph.mjs");
    expect(boundary.client).toHaveBeenCalledWith(expect.objectContaining({ connectionString: source }));
    expect(new URL(process.env.DATABASE_URL!).port).toBe("54330");
    expect(process.env.SOURCE_DATABASE_URL).toBe(source);
  });

  it("ceph passes its selected validated URL serialization to pg without rewriting original SOURCE", async () => {
    const source = "POSTGRESQL://fixture:synthetic%20only@localhost:54330/local%20maintenance?sslmode=disable";
    vi.stubEnv("SOURCE_DATABASE_URL", source);
    await invokeDirect("verify-ceph.mjs");
    expect(boundary.client).toHaveBeenCalledWith(expect.objectContaining({ connectionString: new URL(source).toString() }));
    expect(process.env.SOURCE_DATABASE_URL).toBe(source);
  });

  it("standalone ceph accepts SOURCE maintenance without DATABASE_URL or TEST_DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("TEST_DATABASE_URL", undefined);
    vi.stubEnv("SOURCE_DATABASE_URL", LOCAL_MAINTENANCE);
    await invokeDirect("verify-ceph.mjs");
    expect(boundary.client).toHaveBeenCalledWith(expect.objectContaining({ connectionString: LOCAL_MAINTENANCE }));
    expect(boundary.runtimeImport).toHaveBeenCalledOnce();
  });

  it.each(["aqlan_p1_test", "local_maintenance"])("ceph accepts an explicit local %s maintenance database", async (name) => {
    const source = LOCAL_MAINTENANCE.replace("/postgres?", `/${name}?`);
    vi.stubEnv("SOURCE_DATABASE_URL", source);
    await invokeDirect("verify-ceph.mjs");
    expect(boundary.client).toHaveBeenCalledWith(expect.objectContaining({ connectionString: source }));
    expect(new URL(process.env.DATABASE_URL!).pathname).toMatch(/^\/ceph_check_[a-z0-9_]+$/);
  });

  it("does not mistake an unrelated local Railway CLI variable for runtime identity", async () => {
    vi.stubEnv("RAILWAY_TOKEN", "synthetic-unused-cli-context");
    await invokeDirect("verify-ceph.mjs");
    expect(boundary.client).toHaveBeenCalledOnce();
    expect(boundary.runtimeImport).toHaveBeenCalledOnce();
  });

  it.each(["aqlan_p1_test", "local_maintenance"])("direct CI accepts an explicit local %s maintenance database", async (name) => {
    const source = LOCAL_MAINTENANCE.replace("/postgres?", `/${name}?`);
    vi.stubEnv("DATABASE_URL", source);
    const error = await invokeDirect("verify-ci.mjs");
    expect(error).toBeInstanceOf(CliExit);
    expect((error as CliExit).code).toBe(0);
    expect(boundary.spawn).toHaveBeenCalled();
    expect(process.env.DATABASE_URL).toBe(source);
  });

  it("direct CI launches mocked journeys for the documented /postgres and /aqlan_p1_test pair", async () => {
    const error = await invokeDirect("verify-ci.mjs");
    expect(error).toBeInstanceOf(CliExit);
    expect((error as CliExit).code).toBe(0);
    expect(boundary.spawn).toHaveBeenCalled();
    expect(boundary.spawn).toHaveBeenCalledWith("npx", ["tsx", "scripts/verify-ceph.mjs"], expect.objectContaining({
      env: expect.objectContaining({ DATABASE_URL: LOCAL_MAINTENANCE, TEST_DATABASE_URL: LOCAL_TEST }),
    }));
    expect(boundary.client).not.toHaveBeenCalled();
    expect(boundary.runtimeImport).not.toHaveBeenCalled();
  });
});

describe("the broader static environment diagnostic contract stays unchanged", () => {
  it.each(["test", "development", "staging"])("still classifies a remote %s URL outside CI without executing it", (classification) => {
    vi.stubEnv("CI", "false");
    vi.stubEnv("DATABASE_ENVIRONMENT", classification);
    const remote = "postgresql://fixture:synthetic-only@db.example.invalid/postgres";
    expect(checkDatabaseUrlForGates(remote, "SOURCE_DATABASE_URL", { ci: false })).toBeNull();
    expectNoEffects();
  });
});

describe("ceph owns only successfully created temporary databases", () => {
  function successfulRuntime() {
    // Set data for the single per-test factory instead of registering competing
    // doMock factories whose asynchronous resolution can race each other.
    runtimeFixture = successfulCephJourney(boundary.runtimeEnd);
  }

  function sqlCalls() {
    return boundary.query.mock.calls.map(([sql]) => sql);
  }

  function expectFailedRun(error: unknown) {
    expect(error).toBeInstanceOf(Error);
    if (error instanceof CliExit) expect(error.code).not.toBe(0);
    expect(vi.mocked(console.log).mock.calls.flat().join(" "))
      .not.toContain("النتيجة: التحليل السيفالومتري سجلٌّ يُعتمد عليه.");
  }

  it("does not query or drop a database when the admin connection fails", async () => {
    boundary.connect.mockRejectedValueOnce(new Error("MOCK_CONNECT_FAILURE"));
    const error = await invokeDirect("verify-ceph.mjs");
    expectFailedRun(error);
    expect(boundary.query).not.toHaveBeenCalled();
    expect(boundary.runtimeImport).not.toHaveBeenCalled();
    expect(boundary.end).toHaveBeenCalledOnce();
  });

  it("never drops an existing database when CREATE fails, including a name collision", async () => {
    boundary.query.mockImplementation(async (sql) => {
      if (/^CREATE DATABASE /i.test(sql)) throw new Error("MOCK_DATABASE_ALREADY_EXISTS");
      return { rows: [] };
    });
    const error = await invokeDirect("verify-ceph.mjs");
    expectFailedRun(error);
    expect(sqlCalls().filter((sql) => /^CREATE DATABASE /i.test(sql))).toHaveLength(1);
    expect(sqlCalls().some((sql) => /^DROP DATABASE /i.test(sql))).toBe(false);
    expect(boundary.runtimeImport).not.toHaveBeenCalled();
    expect(boundary.end).toHaveBeenCalledOnce();
  });

  it("still removes its own successfully created database if the runtime journey fails", async () => {
    const error = await invokeDirect("verify-ceph.mjs");
    expectFailedRun(error);
    const created = sqlCalls().find((sql) => /^CREATE DATABASE /i.test(sql))!;
    const dropped = sqlCalls().find((sql) => /^DROP DATABASE /i.test(sql))!;
    expect(created).toBeDefined();
    expect(dropped).toContain(new URL(process.env.DATABASE_URL!).pathname.slice(1));
    expect(boundary.end).toHaveBeenCalledOnce();
  });

  it("gives simultaneous invocations distinct owned names even at the same timestamp", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
    await invokeDirect("verify-ceph.mjs");
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", LOCAL_MAINTENANCE);
    await invokeDirect("verify-ceph.mjs");
    const names = sqlCalls().filter((sql) => /^CREATE DATABASE /i.test(sql))
      .map((sql) => /ceph_check_[a-z0-9_]+/.exec(sql)?.[0]);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name).toBeDefined();
      expect(name!.length).toBeLessThanOrEqual(63);
    }
  });

  it("passes a completely mocked successful journey and drops only its own database", async () => {
    successfulRuntime();
    const error = await invokeDirect("verify-ceph.mjs");
    expect(error).toBeUndefined();
    expect(sqlCalls().filter((sql) => /^DROP DATABASE /i.test(sql))).toHaveLength(1);
    expect(sqlCalls().find((sql) => /^DROP DATABASE /i.test(sql)))
      .toContain(new URL(process.env.DATABASE_URL!).pathname.slice(1));
    expect(boundary.end).toHaveBeenCalledOnce();
  });

  it("closes the runtime pool before dropping its owned database and ending admin", async () => {
    successfulRuntime();
    const events: string[] = [];
    boundary.query.mockImplementation(async (sql) => {
      if (/^CREATE DATABASE /i.test(sql)) events.push("create");
      if (/^DROP DATABASE /i.test(sql)) events.push("drop");
      return { rows: [] };
    });
    boundary.runtimeEnd.mockImplementation(async () => { events.push("runtime-end"); });
    boundary.end.mockImplementation(async () => { events.push("admin-end"); });
    const error = await invokeDirect("verify-ceph.mjs");
    expect(error, vi.mocked(console.error).mock.calls.flat().join(" ")).toBeUndefined();
    expect(events).toEqual(["create", "runtime-end", "drop", "admin-end"]);
  });

  it("cannot report success after DROP fails and still ends admin", async () => {
    successfulRuntime();
    boundary.query.mockImplementation(async (sql) => {
      if (/^DROP DATABASE /i.test(sql)) throw new Error("MOCK_DROP_FAILURE");
      return { rows: [] };
    });
    const error = await invokeDirect("verify-ceph.mjs");
    expectFailedRun(error);
    expect(boundary.runtimeEnd).toHaveBeenCalledOnce();
    expect(boundary.end).toHaveBeenCalledOnce();
  });

  it("cannot report success after runtime pool shutdown fails and still ends admin", async () => {
    successfulRuntime();
    boundary.runtimeEnd.mockRejectedValueOnce(new Error("MOCK_RUNTIME_END_FAILURE"));
    const error = await invokeDirect("verify-ceph.mjs");
    expectFailedRun(error);
    expect(boundary.end).toHaveBeenCalledOnce();
  });

  it("cannot report success after admin cleanup fails", async () => {
    successfulRuntime();
    boundary.end.mockRejectedValueOnce(new Error("MOCK_ADMIN_END_FAILURE"));
    expectFailedRun(await invokeDirect("verify-ceph.mjs"));
  });
});

describe("plain Node CLI compatibility without a TypeScript loader", () => {
  function runPlainNode(environment: Record<string, string>) {
    const fixture = fileURLToPath(new URL("./fixtures/direct-verification-node.mjs", import.meta.url));
    return JSON.parse(execFileSync(process.execPath, [fixture, JSON.stringify(environment)], {
      encoding: "utf8",
      env: {},
      timeout: 10_000,
    })) as { children: number; exit: number | null; error: string | null };
  }

  it("accepts the documented direct verify-ci command without importing a TS harness", () => {
    const result = runPlainNode({ DATABASE_URL: LOCAL_MAINTENANCE, TEST_DATABASE_URL: LOCAL_TEST, CI: "true" });
    expect(result.error).toBeNull();
    expect(result.exit).toBe(0);
    expect(result.children).toBeGreaterThan(0);
  });

  it("rejects a production-marked direct verify-ci before even one mocked child", () => {
    const result = runPlainNode({ DATABASE_URL: LOCAL_MAINTENANCE, TEST_DATABASE_URL: LOCAL_TEST, NODE_ENV: "production" });
    expect(result.children).toBe(0);
    expect(result.exit !== 0 || result.error !== null).toBe(true);
  });
});
