import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { runSchemaOwnershipCharacterization } from "../../scripts/verify-schema-ownership";

describe("PG18 schema ownership characterization", () => {
  beforeAll(() => {
    assertRealPostgresUrl();
    stubPostgresEnv();
  });

  afterAll(async () => {
    const admin = adminClient("postgres");
    await admin.connect();
    try {
      const { rows } = await admin.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname LIKE 'aqlan_schema_ownership_%' ORDER BY datname",
      );
      expect(rows).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it("builds migrations and ensureSchema independently, compares them, and leaves no generated databases", async () => {
    const report = await runSchemaOwnershipCharacterization(process.env);

    expect(report.postgres.major).toBe(18);
    expect(report.migrationProvenance.map((item) => item.version)).toEqual([
      "0001", "0002", "0003", "0004", "0005", "0006",
      "0007", "0008", "0009", "0010", "0011",
    ]);
    expect(report.migrationRegistry.present).toBe(true);
    expect(report.migrationRegistry.rows).toHaveLength(11);
    expect(report.migrationRegistry.rows.every((row) => row.adopted === false)).toBe(true);

    const migrationApplicationTables = report.migrationCatalog.tables
      .filter((entry) => entry.table !== "schema_migrations");
    const runtimeApplicationTables = report.runtimeCatalog.tables
      .filter((entry) => entry.table !== "schema_migrations");

    expect(migrationApplicationTables).toHaveLength(61);
    expect(runtimeApplicationTables).toHaveLength(61);
    expect(report.runtimeCatalog.registry.present).toBe(false);

    expect(report.comparison.unexpectedDifferences).toEqual([]);
    expect(report.comparison.knownDifferences).toHaveLength(16);
    expect(report.comparison.knownDifferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        section: "functions",
        key: "aqlan_financial_delete_guard()",
        kind: "definition_mismatch",
        knownReason: "financial_guard_message",
      }),
      expect.objectContaining({
        section: "columns",
        key: "appointments.doctor_id",
        knownReason: "appointment_column_ordinal",
      }),
      expect.objectContaining({
        section: "functions",
        key: "aqlan_payments_append_only_guard()",
        knownReason: "function_formatting",
      }),
    ]));

    expect(report.assertions).toEqual({
      TD08A_COMPLETE: "NO",
      TD01A_COMPLETE: "NO",
      PRODUCTION_WRITES_ALLOWED: "NO",
    });
    expect(report.populatedStateCharacterization.every((item) => item.status === "UNRESOLVED_FINDING")).toBe(true);
  }, 180_000);
});
