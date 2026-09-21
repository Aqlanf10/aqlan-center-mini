import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compareDetailedSchemaCatalogs,
  type DetailedSchemaCatalog,
  type DetailedCatalogEntry,
} from "../lib/schema-manifest";
import {
  artifactContainsSensitiveText,
  migrationProvenance,
  validateGeneratedDatabaseName,
  validateOwnershipHarnessEnvironment,
} from "../scripts/verify-schema-ownership";

function catalog(overrides: Partial<DetailedSchemaCatalog> = {}): DetailedSchemaCatalog {
  return {
    format: "aqlan-schema-ownership-catalog",
    formatVersion: 1,
    postgresMajor: 18,
    postgresVersion: "18.x",
    ownership: { databaseOwner: "$CURRENT_USER", schemaOwner: "$CURRENT_USER" },
    tables: [],
    columns: [],
    constraints: [],
    indexes: [],
    triggers: [],
    functions: [],
    sequences: [],
    extensions: [],
    registry: { present: false, rows: [] },
    ...overrides,
  };
}

function entry(key: string, value: Record<string, unknown>, table?: string): DetailedCatalogEntry {
  return { key, name: key, table, value: JSON.stringify(value) };
}

describe("schema ownership detailed comparator", () => {
  it("is deterministic and detects differences in both directions", () => {
    const left = catalog({
      tables: [
        entry("patients", { owner: "$CURRENT_USER" }, "patients"),
        entry("left_only", { owner: "$CURRENT_USER" }, "left_only"),
      ],
    });
    const right = catalog({
      tables: [
        entry("patients", { owner: "$CURRENT_USER" }, "patients"),
        entry("right_only", { owner: "$CURRENT_USER" }, "right_only"),
      ],
    });
    const diff = compareDetailedSchemaCatalogs(left, right);
    expect(diff.ok).toBe(false);
    expect(diff.unexpectedDifferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "tables", key: "left_only", kind: "missing_right" }),
      expect.objectContaining({ section: "tables", key: "right_only", kind: "missing_left" }),
    ]));
  });

  it("reports registry objects separately instead of application drift", () => {
    const migration = catalog({
      tables: [entry("schema_migrations", { owner: "$CURRENT_USER" }, "schema_migrations")],
      indexes: [entry("schema_migrations:schema_migrations_pkey", { unique: true }, "schema_migrations")],
      registry: {
        present: true,
        rows: [{ version: "0001", name: "baseline_schema", checksum: "abc", adopted: false }],
      },
    });
    const runtime = catalog();
    expect(compareDetailedSchemaCatalogs(migration, runtime)).toMatchObject({
      ok: true,
      unexpectedDifferences: [],
    });
  });

  it("accepts only the exact known financial guard message difference", () => {
    const migrationPhrase = "وأي purge قانوني/GDPR مستقبلًا workflow منفصل مصرَّح ومدقَّق";
    const runtimePhrase = "وأي purge قانوني workflow منفصل مصرَّح ومدقَّق";
    const makeFunction = (phrase: string) => entry(
      "aqlan_financial_delete_guard()",
      {
        resultType: "trigger",
        language: "plpgsql",
        volatility: "v",
        strict: false,
        securityDefiner: false,
        parallelSafety: "u",
        configuration: "",
        body: `BEGIN RAISE EXCEPTION 'x ${phrase}'; END;`,
        definition: `CREATE FUNCTION aqlan_financial_delete_guard() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'x ${phrase}'; END; $$ LANGUAGE plpgsql`,
      },
    );
    const accepted = compareDetailedSchemaCatalogs(
      catalog({ functions: [makeFunction(migrationPhrase)] }),
      catalog({ functions: [makeFunction(runtimePhrase)] }),
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.knownDifferences).toHaveLength(1);

    const changed = compareDetailedSchemaCatalogs(
      catalog({ functions: [makeFunction(migrationPhrase)] }),
      catalog({ functions: [makeFunction(runtimePhrase + " CHANGED")] }),
    );
    expect(changed.ok).toBe(false);
    expect(changed.unexpectedDifferences).toHaveLength(1);
  });

  it("detects a semantic definition mismatch without normalizing it away", () => {
    const left = catalog({
      columns: [entry("payments.amount_minor", { default: "0", formatType: "bigint" }, "payments")],
    });
    const right = catalog({
      columns: [entry("payments.amount_minor", { default: "1", formatType: "bigint" }, "payments")],
    });
    const diff = compareDetailedSchemaCatalogs(left, right);
    expect(diff.ok).toBe(false);
    expect(diff.unexpectedDifferences[0]).toMatchObject({
      section: "columns",
      key: "payments.amount_minor",
      kind: "definition_mismatch",
    });
  });
});

describe("schema ownership harness safety", () => {
  const safe = {
    TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:5432/aqlan_p1_test?sslmode=disable",
    NODE_ENV: "test",
    DATABASE_ENVIRONMENT: "test",
  } as NodeJS.ProcessEnv;

  it("accepts only the documented loopback disposable test database", () => {
    const result = validateOwnershipHarnessEnvironment(safe);
    expect(result.testUrl.hostname).toBe("127.0.0.1");
    expect(result.maintenanceUrl.pathname).toBe("/postgres");
  });

  it.each([
    ["remote", { ...safe, TEST_DATABASE_URL: "postgresql://ci:ci@db.example.com:5432/aqlan_p1_test" }],
    ["railway", { ...safe, TEST_DATABASE_URL: "postgresql://ci:ci@postgres.railway.internal:5432/aqlan_p1_test" }],
    ["production", { ...safe, NODE_ENV: "production" }],
    ["wrong-db", { ...safe, TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:5432/postgres" }],
    ["railway-runtime", { ...safe, RAILWAY_PROJECT_ID: "prod" }],
  ])("rejects unsafe target: %s", (_label, env) => {
    expect(() => validateOwnershipHarnessEnvironment(env as NodeJS.ProcessEnv)).toThrow(/SCHEMA_OWNERSHIP_UNSAFE_TARGET/);
  });

  it("accepts only generated cleanup names", () => {
    expect(() => validateGeneratedDatabaseName("aqlan_schema_ownership_runtime_123")).not.toThrow();
    expect(() => validateGeneratedDatabaseName("aqlan_p1_test")).toThrow(/UNSAFE_DATABASE_NAME/);
    expect(() => validateGeneratedDatabaseName("aqlan_schema_ownership_x;DROP DATABASE postgres")).toThrow(/UNSAFE_DATABASE_NAME/);
  });

  it("redaction scanner catches URLs and environment labels", () => {
    expect(artifactContainsSensitiveText('{"x":"postgresql://u:p@localhost/db"}')).toBe(true);
    expect(artifactContainsSensitiveText('{"x":"DATABASE_URL"}')).toBe(true);
    expect(artifactContainsSensitiveText('{"format":"safe","owner":"$CURRENT_USER"}')).toBe(false);
  });

  it("migration provenance is byte-sensitive", () => {
    const sql = "SELECT 1;\n";
    const files = [{
      version: "0001",
      name: "baseline",
      filename: "0001_baseline.sql",
      sql,
      checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
    }] as any;
    const first = migrationProvenance(files)[0];
    expect(first.utf8Bytes).toBe(Buffer.byteLength(sql, "utf8"));
    const changed = sql.replace("\n", "\r\n");
    expect(createHash("sha256").update(changed, "utf8").digest("hex")).not.toBe(first.checksum);
  });
});
