import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareDetailedSchemaCatalogs,
  type DetailedSchemaCatalog,
  type DetailedCatalogEntry,
} from "../lib/schema-manifest";
import {
  candidateOpenFindingsManifest,
  classifyOpenFindings,
  parseOpenFindingsManifest,
} from "../lib/schema-ownership-open-findings";
import {
  artifactContainsSensitiveText,
  assertPostgres18VersionNum,
  initializeGeneratedRuntimeSchema,
  migrationProvenance,
  OPEN_FINDINGS_MANIFEST_PATH,
  parseOwnershipCliArgs,
  RAILWAY_ENV_NAMES,
  validateGeneratedDatabaseName,
  validateOwnershipHarnessEnvironment,
  withGeneratedDatabasePair,
} from "../scripts/verify-schema-ownership";

function catalog(overrides: Partial<DetailedSchemaCatalog> = {}): DetailedSchemaCatalog {
  return {
    format: "aqlan-schema-ownership-catalog",
    formatVersion: 1,
    postgresMajor: 18,
    postgresVersion: "18.x",
    ownership: { databaseOwner: "$CURRENT_USER", schemaOwner: "$CURRENT_USER", schemaAcl: "$ACL_SHA256:same" },
    tables: [],
    columns: [],
    constraints: [],
    indexes: [],
    triggers: [],
    internalTriggers: [],
    functions: [],
    sequences: [],
    extensions: [],
    extensionMembers: [],
    mutableSequenceState: [],
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

  it("detects the complete financial guard difference as raw drift, then fingerprints it as open", () => {
    const left = catalog({ functions: [entry("aqlan_financial_delete_guard()", { body: "BEGIN RAISE 'قانوني/GDPR'; END;", definition: "migration" })] });
    const right = catalog({ functions: [entry("aqlan_financial_delete_guard()", { body: "  BEGIN RAISE 'قانوني'; END;", definition: "runtime" })] });
    const raw = compareDetailedSchemaCatalogs(left, right);
    expect(raw.applicationSchemaEqual).toBe(false);
    expect(raw.knownDifferences).toEqual([]);
    expect(raw.rawDifferences).toHaveLength(1);
    const manifest = candidateOpenFindingsManifest(raw);
    const classified = classifyOpenFindings(raw, manifest);
    expect(classified).toMatchObject({ applicationSchemaEqual: false, characterizationOk: true, openFindingsManifestMatch: true });
    expect(classified.openConvergenceFindings).toHaveLength(1);
    expect(classified.unexpectedDifferences).toEqual([]);

    const changed = compareDetailedSchemaCatalogs(left, catalog({ functions: [entry("aqlan_financial_delete_guard()", { body: "  BEGIN RETURN NEW; END;", definition: "runtime" })] }));
    expect(classifyOpenFindings(changed, manifest).unexpectedDifferences).toHaveLength(1);
  });

  it("detects appointment ordinal drift raw and classifies only exact full-value fingerprints", () => {
    const left = catalog({
      columns: [entry(
        "appointments.doctor_id",
        { ordinal: 14, formatType: "integer", nullable: true, default: null },
        "appointments",
      )],
    });
    const right = catalog({
      columns: [entry(
        "appointments.doctor_id",
        { ordinal: 23, formatType: "integer", nullable: true, default: null },
        "appointments",
      )],
    });
    const comparison = compareDetailedSchemaCatalogs(left, right);
    expect(comparison.applicationSchemaEqual).toBe(false);
    expect(comparison.knownDifferences).toEqual([]);
    expect(comparison.rawDifferences).toHaveLength(1);
    const manifest = candidateOpenFindingsManifest(comparison);
    expect(classifyOpenFindings(comparison, manifest).openConvergenceFindings[0]?.openFindingId).toBe("columns:appointments.doctor_id");

    const semanticChange = catalog({
      columns: [entry(
        "appointments.doctor_id",
        { ordinal: 23, formatType: "bigint", nullable: true, default: null },
        "appointments",
      )],
    });
    expect(classifyOpenFindings(compareDetailedSchemaCatalogs(left, semanticChange), manifest).unexpectedDifferences).toHaveLength(1);
  });

  it("fails closed for changed, added, removed, or reversed manifest findings", () => {
    const left = catalog({ columns: [entry("appointments.doctor_id", { ordinal: 14, type: "integer" })] });
    const right = catalog({ columns: [entry("appointments.doctor_id", { ordinal: 23, type: "integer" })] });
    const raw = compareDetailedSchemaCatalogs(left, right);
    const manifest = candidateOpenFindingsManifest(raw);
    expect(classifyOpenFindings(raw, manifest).characterizationOk).toBe(true);

    const reversed = structuredClone(manifest);
    [reversed.findings[0]!.leftFingerprint, reversed.findings[0]!.rightFingerprint] =
      [reversed.findings[0]!.rightFingerprint, reversed.findings[0]!.leftFingerprint];
    expect(classifyOpenFindings(raw, reversed).characterizationOk).toBe(false);

    const removed = { ...manifest, findings: [] };
    expect(classifyOpenFindings(raw, removed).unexpectedDifferences).toHaveLength(1);

    const extra = structuredClone(manifest);
    extra.findings.push({ ...extra.findings[0]!, id: "columns:appointments.other", key: "appointments.other" });
    expect(classifyOpenFindings(raw, extra).unexpectedDifferences).toEqual([
      expect.objectContaining({ section: "openFindings", key: "columns:appointments.other" }),
    ]);

    expect(classifyOpenFindings(compareDetailedSchemaCatalogs(left, left), manifest).unexpectedDifferences).toEqual([
      expect.objectContaining({ section: "openFindings", key: "columns:appointments.doctor_id" }),
    ]);
    const changedProperty = catalog({ columns: [entry("appointments.doctor_id", { ordinal: 23, type: "bigint" })] });
    expect(classifyOpenFindings(compareDetailedSchemaCatalogs(left, changedProperty), manifest).unexpectedDifferences).toHaveLength(1);
  });

  it("rejects malformed, wrong-major, and duplicate open-finding manifests", () => {
    const raw = compareDetailedSchemaCatalogs(
      catalog({ functions: [entry("f()", { body: "old" })] }),
      catalog({ functions: [entry("f()", { body: "new" })] }),
    );
    const manifest = candidateOpenFindingsManifest(raw);
    expect(parseOpenFindingsManifest(manifest)).toEqual(manifest);
    expect(() => parseOpenFindingsManifest({ ...manifest, postgresMajor: 16 })).toThrow(/OPEN_FINDINGS_MANIFEST_INVALID/);
    expect(() => parseOpenFindingsManifest({ ...manifest, findings: [{}] })).toThrow(/OPEN_FINDINGS_MANIFEST_INVALID/);
    expect(() => parseOpenFindingsManifest({ ...manifest, username: "unexpected" })).toThrow(/OPEN_FINDINGS_MANIFEST_INVALID/);
    expect(() => parseOpenFindingsManifest({ ...manifest, findings: [manifest.findings[0], manifest.findings[0]] })).toThrow(/duplicate/);
    expect(() => parseOpenFindingsManifest({ ...manifest, findings: [{ ...manifest.findings[0], id: "other" }] })).toThrow(/malformed/);
  });

  it("keeps the committed PG18 contract to exactly 12 columns and four complete function fingerprints", () => {
    const manifest = parseOpenFindingsManifest(JSON.parse(readFileSync(OPEN_FINDINGS_MANIFEST_PATH, "utf8")));
    expect(manifest.findings).toHaveLength(16);
    expect(manifest.findings.filter((finding) => finding.section === "columns")).toHaveLength(12);
    expect(manifest.findings.filter((finding) => finding.section === "functions")).toHaveLength(4);
    expect(manifest.findings.map((finding) => finding.key)).toContain("aqlan_financial_delete_guard()");
  });

  it("does not classify append-only function formatting as known", () => {
    const key = "aqlan_payments_append_only_guard()";
    const leftFunction = entry(key, {
      body: "\nBEGIN\n  RETURN NEW;\nEND;\n",
      definition: "CREATE FUNCTION x()\nRETURNS trigger\nAS $\nBEGIN\n  RETURN NEW;\nEND;\n$",
      language: "plpgsql",
    });
    const rightFunction = entry(key, {
      body: "\n      BEGIN\n        RETURN NEW;\n      END;\n",
      definition: "CREATE FUNCTION x()\nRETURNS trigger\nAS $\n      BEGIN\n        RETURN NEW;\n      END;\n$",
      language: "plpgsql",
    });
    const comparison = compareDetailedSchemaCatalogs(
      catalog({ functions: [leftFunction] }),
      catalog({ functions: [rightFunction] }),
    );
    expect(comparison.ok).toBe(false);
    expect(comparison.knownDifferences).toEqual([]);
    expect(comparison.unexpectedDifferences).toHaveLength(1);

    const changedFunction = entry(key, {
      body: "\nBEGIN\n  RETURN OLD;\nEND;\n",
      definition: "CREATE FUNCTION x()\nRETURNS trigger\nAS $\nBEGIN\n  RETURN OLD;\nEND;\n$",
      language: "plpgsql",
    });
    expect(compareDetailedSchemaCatalogs(
      catalog({ functions: [leftFunction] }),
      catalog({ functions: [changedFunction] }),
    ).ok).toBe(false);
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

  it.each([
    ["ownership", catalog({ ownership: { databaseOwner: "$ROLE_SHA256:x", schemaOwner: "$CURRENT_USER", schemaAcl: "$ACL_SHA256:same" } })],
    ["extensions", catalog({ extensions: [{ name: "plpgsql", version: "9.0", schema: "public" }] })],
    ["extensionMembers", catalog({ extensionMembers: [entry("plpgsql:function x", { extension: "plpgsql" })] })],
    ["sequences", catalog({ sequences: [entry("patient_number_seq", { acl: "$ACL_SHA256:x", dependencyType: "a" })] })],
    ["triggers", catalog({ triggers: [entry("patients:t", { enabled: "D", functionSchema: "public" })] })],
    ["constraints", catalog({ constraints: [entry("visits:fk", { referencedSchema: "other" })] })],
  ])("compares %s evidence", (section, changed) => {
    const result = compareDetailedSchemaCatalogs(catalog(), changed);
    expect(result.ok).toBe(false);
    expect(result.unexpectedDifferences.some((difference) => difference.section === section)).toBe(true);
  });

  it("reports mutable sequence state without using it as schema identity", () => {
    const result = compareDetailedSchemaCatalogs(
      catalog({ mutableSequenceState: [{ key: "x", lastValue: "1", isCalled: false }] }),
      catalog({ mutableSequenceState: [{ key: "x", lastValue: "99", isCalled: true }] }),
    );
    expect(result.ok).toBe(true);
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

  it.each(RAILWAY_ENV_NAMES)("rejects Railway marker %s", (name) => {
    expect(() => validateOwnershipHarnessEnvironment({ ...safe, [name]: "present" })).toThrow(/Railway runtime/);
  });

  it("accepts only generated cleanup names", () => {
    expect(() => validateGeneratedDatabaseName("aqlan_schema_ownership_runtime_123")).not.toThrow();
    expect(() => validateGeneratedDatabaseName("aqlan_p1_test")).toThrow(/UNSAFE_DATABASE_NAME/);
    expect(() => validateGeneratedDatabaseName("aqlan_schema_ownership_x;DROP DATABASE postgres")).toThrow(/UNSAFE_DATABASE_NAME/);
  });

  it("redaction scanner catches URLs and environment labels", () => {
    expect(artifactContainsSensitiveText('{"x":"postgresql://u:p@localhost/db"}')).toBe(true);
    expect(artifactContainsSensitiveText('{"x":"DATABASE_URL"}')).toBe(true);
    expect(artifactContainsSensitiveText('{"username":"ci"}')).toBe(true);
    expect(artifactContainsSensitiveText('{"x":"127.0.0.1:5432"}')).toBe(true);
    expect(artifactContainsSensitiveText('{"x":"RAILWAY_SERVICE_ID"}')).toBe(true);
    expect(artifactContainsSensitiveText('{"x":"INSERT INTO patients"}')).toBe(true);
    expect(artifactContainsSensitiveText('{"format":"safe","owner":"$CURRENT_USER"}')).toBe(false);
  });

  it("rejects every CLI shape except no args or one output pair", () => {
    expect(parseOwnershipCliArgs([])).toContain("aqlan-schema-ownership-report.json");
    expect(parseOwnershipCliArgs(["--output", "report.json"])).toMatch(/report\.json$/);
    for (const args of [
      ["--allow-remote"], ["--database-url", "x"], ["--maintenance-db", "x"],
      ["--target", "x"], ["--production"], ["--force"], ["--output"],
      ["--output", "a", "--output", "b"],
    ]) expect(() => parseOwnershipCliArgs(args)).toThrow(/SCHEMA_OWNERSHIP_CLI/);
  });

  it("prevents arbitrary runtime URLs and revalidates target provenance", async () => {
    const target = validateOwnershipHarnessEnvironment(safe);
    await expect(initializeGeneratedRuntimeSchema(
      { ...target, testUrl: new URL("postgresql://x:x@127.0.0.1:5432/aqlan_p1_test") },
      "aqlan_schema_ownership_runtime_test",
      safe,
    )).rejects.toThrow(/target was not derived/);
    await expect(initializeGeneratedRuntimeSchema(target, "production", safe)).rejects.toThrow(/UNSAFE_DATABASE_NAME/);
  });

  it("checks PG18 before creating databases", async () => {
    const calls: string[] = [];
    const client = {
      async connect() { calls.push("connect"); },
      async query(sql: string) { calls.push(sql); },
      async end() { calls.push("end"); },
    };
    await expect(withGeneratedDatabasePair(
      client,
      { migrations: "aqlan_schema_ownership_migrations_test", runtime: "aqlan_schema_ownership_runtime_test" },
      async () => { calls.push("verify"); assertPostgres18VersionNum("170000"); return { major: 17, version: "17" }; },
      async () => { calls.push("operation"); },
    )).rejects.toThrow(/POSTGRES_MAJOR/);
    expect(calls.filter((call) => call.startsWith("CREATE DATABASE"))).toEqual([]);
    expect(calls.filter((call) => call.startsWith("DROP DATABASE"))).toHaveLength(2);
  });

  it("attempts both drops and fails loudly while preserving a primary failure", async () => {
    const calls: string[] = [];
    const primary = new Error("primary");
    const client = {
      async connect() {},
      async query(sql: string) {
        calls.push(sql);
        if (sql.startsWith("DROP DATABASE")) throw new Error(`cleanup:${sql}`);
      },
      async end() { calls.push("end"); },
    };
    let caught: unknown;
    try {
      await withGeneratedDatabasePair(
        client,
        { migrations: "aqlan_schema_ownership_migrations_test", runtime: "aqlan_schema_ownership_runtime_test" },
        async () => ({ major: 18, version: "18" }),
        async () => { throw primary; },
      );
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).message).toMatch(/CLEANUP_FAILED/);
    expect((caught as AggregateError).errors[0]).toBe(primary);
    expect(calls.filter((call) => call.startsWith("DROP DATABASE"))).toHaveLength(2);
    expect(calls.at(-1)).toBe("end");
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
