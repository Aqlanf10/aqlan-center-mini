import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preflightConnection, runPreflightCli, preflightErrorCode } from "../scripts/db-preflight";
import { loadMigrationFiles } from "../lib/migration-files";
import { inspectSchemaReadOnly, SchemaPreflightError } from "../lib/schema-preflight";
import type { ReadOnlyCatalogClient } from "../lib/schema-manifest";

afterEach(() => vi.restoreAllMocks());

describe("read-only preflight connection contract", () => {
  it("requires an explicit PostgreSQL database and rejects ambiguous remote targets", () => {
    for (const DATABASE_URL of ["", "broken", "https://example.com/db", "postgresql://localhost/"]) {
      expect(() => preflightConnection({ NODE_ENV: "test", DATABASE_URL })).toThrow();
    }
    expect(() => preflightConnection({ NODE_ENV: "test", DATABASE_URL: "postgresql://db.example.test/app" })).toThrow(/DATABASE_ENVIRONMENT/);
    expect(() => preflightConnection({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/app", USE_LOCAL_DB: "true" })).toThrow();
    expect(() => preflightConnection({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/app", DATABASE_ENVIRONMENT: "typo" })).toThrow();
  });

  it("rejects URL options that could change the intended host or read-only session", () => {
    for (const query of ["host=remote.example.test", "dbname=other", "options=-c%20default_transaction_read_only%3Doff", "ssl=false"]) {
      expect(() => preflightConnection({ NODE_ENV: "test", DATABASE_URL: `postgresql://localhost/app?${query}` })).toThrow();
    }
  });

  it("retains authoritative TLS decisions without URL overrides", () => {
    expect(() => preflightConnection({ NODE_ENV: "test",
      DATABASE_URL: "postgresql://db.example.test/app?sslmode=disable", DATABASE_ENVIRONMENT: "production",
    })).toThrow();
    const connection = preflightConnection({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/app?sslmode=disable" });
    expect(connection.ssl).toBe(false);
    expect(connection.connectionString).not.toContain("sslmode");
    expect(connection.environment).toBe("local");
  });

  it("help needs neither a configured database nor a connection; unsupported flags fail", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runPreflightCli(["--help"], { NODE_ENV: "test" })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no writes"));
    await expect(runPreflightCli(["--apply"], { NODE_ENV: "test" })).rejects.toThrow("Unsupported arguments");
  });

  it("uses the immutable filesystem loader without importing the runtime/probe graph", async () => {
    const files = await loadMigrationFiles();
    expect(files[0].version).toBe("0001");
    expect(files).toHaveLength(39);
    for (const file of ["lib/migration-files.ts", "lib/schema-preflight.ts", "lib/schema-manifest.ts", "scripts/db-preflight.ts"]) {
      const source = await readFile(file, "utf8");
      const imports = source.split("\n").filter((line) => /^import\b/.test(line)).join("\n");
      expect(imports).not.toMatch(/["'](?:\.\.\/|\.\/)(?:lib\/)?(?:db|migrations|baseline-probe)["']/);
    }
  });

  it.each([
    [{ version: 170000, read_only: "on", isolation: "repeatable read" }, "PG_VERSION_UNSUPPORTED"],
    [{ version: 180000, read_only: "off", isolation: "repeatable read" }, "READ_ONLY_NOT_ENFORCED"],
  ])("reports a stable safety error before catalog reads", async (metadata, code) => {
    const statements: string[] = [];
    const client: ReadOnlyCatalogClient = { query: async <T>(sql: string) => {
      statements.push(sql);
      return { rows: (sql.includes("AS read_only") ? [metadata] : []) as T[] };
    } };
    await expect(inspectSchemaReadOnly(client, [{ version: "0001", name: "baseline_schema", checksum: "0".repeat(64) }]))
      .rejects.toMatchObject({ code });
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.join("\n")).not.toContain("FROM pg_catalog.pg_class");
  });

  it("retains stable validation/SQLSTATE codes while discarding arbitrary error detail", () => {
    expect(preflightErrorCode(new SchemaPreflightError("REGISTRY_ROWS_INVALID", "private detail"))).toBe("REGISTRY_ROWS_INVALID");
    expect(preflightErrorCode({ code: "42501", message: "private detail" })).toBe("42501");
    expect(preflightErrorCode({ code: "private detail", message: "secret URL" })).toBe("PREFLIGHT_FAILED");
  });
});
