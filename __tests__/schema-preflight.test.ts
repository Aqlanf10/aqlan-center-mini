import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbPool, QueryResult } from "../lib/db";
import {
  logSchemaRegistrationPreflightOnce,
  readSchemaRegistrationPreflight,
} from "../lib/schema-preflight";

function fakePool(responses: QueryResult[]): { pool: DbPool; sql: string[] } {
  const sql: string[] = [];
  let index = 0;
  const query = vi.fn(async (statement: string) => {
    sql.push(statement);
    const response = responses[index++] ?? { rows: [] };
    return response;
  });
  return {
    sql,
    pool: {
      query,
      connect: async () => ({ query, release: () => {} }),
    },
  };
}

afterEach(() => {
  delete process.env.SCHEMA_PREFLIGHT_LOG_ONCE;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production schema registration preflight", () => {
  it("is SELECT-only and does not create schema_migrations when registry is absent", async () => {
    const { pool, sql } = fakePool([{ rows: [{ exists: false }] }]);
    const result = await readSchemaRegistrationPreflight(pool);

    expect(result).toEqual({ registryExists: false, versions: [], adoptedVersions: [] });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^SELECT /i);
    expect(sql.join("\n")).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
  });

  it("reads only registered versions and adoption flags when registry exists", async () => {
    const { pool, sql } = fakePool([
      { rows: [{ exists: true }] },
      { rows: [
        { version: "0001", adopted: true },
        { version: "0002", adopted: false },
      ] },
    ]);
    const result = await readSchemaRegistrationPreflight(pool);

    expect(result).toEqual({
      registryExists: true,
      versions: ["0001", "0002"],
      adoptedVersions: ["0001"],
    });
    expect(sql).toHaveLength(2);
    expect(sql.every((statement) => /^SELECT /i.test(statement.trim()))).toBe(true);
    expect(sql.join("\n")).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
  });

  it("does not run or log unless explicitly enabled in a production context", async () => {
    const { pool, sql } = fakePool([{ rows: [{ exists: false }] }]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    vi.stubEnv("NODE_ENV", "production");
    await logSchemaRegistrationPreflightOnce(pool);

    expect(sql).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();
  });
});
