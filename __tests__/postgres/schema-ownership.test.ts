import { Client, Pool } from "pg";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminClient,
  assertRealPostgresUrl,
  createIsolatedDatabase,
  stubPostgresEnv,
} from "./_setup";
import {
  initializeGeneratedRuntimeSchema,
  OPEN_FINDINGS_MANIFEST_PATH,
  runSchemaOwnershipCharacterization,
  validateOwnershipHarnessEnvironment,
  withGeneratedDatabasePair,
} from "../../scripts/verify-schema-ownership";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { candidateOpenFindingsManifest } from "../../lib/schema-ownership-open-findings";

async function dropIsolatedDatabase(name: string): Promise<void> {
  const admin = adminClient("postgres");
  await admin.connect();
  try {
    await admin.query("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)");
  } finally {
    await admin.end();
  }
}

async function resetPublic(url: string): Promise<void> {
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
}

async function migrateThrough(url: string, count: number): Promise<void> {
  const files = await loadMigrationFiles();
  const pool = new Pool({ connectionString: url, ssl: false });
  try {
    await migrate(pool as any, { apply: true, files: files.slice(0, count) });
  } finally {
    await pool.end();
  }
}

async function businessSequenceState(url: string): Promise<Record<string, number>> {
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    const names = [
      "patient_number_seq",
      "invoice_number_seq",
      "receipt_number_seq",
      "voucher_number_seq",
    ];
    const state: Record<string, number> = {};
    for (const name of names) {
      const { rows } = await client.query<{ last_value: string }>(
        "SELECT last_value::text FROM " + name,
      );
      state[name] = Number(rows[0]?.last_value ?? 0);
    }
    return state;
  } finally {
    await client.end();
  }
}

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
      "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014", "0015", "0016", "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024", "0025",
    ]);
    expect(report.migrationRegistry.present).toBe(true);
    expect(report.migrationRegistry.rows).toHaveLength(25);
    expect(report.migrationRegistry.rows.every((row) => row.adopted === false)).toBe(true);

    const migrationApplicationTables = report.migrationCatalog.tables
      .filter((entry) => entry.table !== "schema_migrations");
    const runtimeApplicationTables = report.runtimeCatalog.tables
      .filter((entry) => entry.table !== "schema_migrations");

    expect(migrationApplicationTables).toHaveLength(71);
    expect(runtimeApplicationTables).toHaveLength(71);
    expect(report.runtimeCatalog.registry.present).toBe(false);

    expect(report.comparison.characterizationOk).toBe(true);
    expect(report.comparison.applicationSchemaEqual).toBe(false);
    expect(report.comparison.openFindingsManifestMatch).toBe(true);
    expect(report.comparison.unexpectedDifferences).toEqual([]);
    expect(report.comparison.knownDifferences).toEqual([]);
    expect(report.comparison.openConvergenceFindings).toHaveLength(16);
    expect(candidateOpenFindingsManifest(report.comparison)).toEqual(
      JSON.parse(readFileSync(OPEN_FINDINGS_MANIFEST_PATH, "utf8")),
    );
    expect(report.comparison.openConvergenceFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "columns", key: "appointments.doctor_id", classification: "OPEN_CONVERGENCE_FINDING" }),
      expect.objectContaining({ section: "functions", key: "aqlan_payments_append_only_guard()", classification: "OPEN_CONVERGENCE_FINDING" }),
      expect.objectContaining({ section: "functions", key: "aqlan_financial_delete_guard()", classification: "OPEN_CONVERGENCE_FINDING" }),
    ]));
    expect(report.summary).toEqual({
      applicationSchemaEqual: false,
      characterizationOk: true,
      knownDifferences: 0,
      openConvergenceFindings: 16,
      unexpectedDifferences: 0,
      openFindingsManifestMatch: true,
    });

    expect(report.assertions).toEqual({
      TD08A_COMPLETE: "NO",
      TD01A_COMPLETE: "NO",
      PRODUCTION_WRITES_ALLOWED: "NO",
    });
    expect(report.populatedStateCharacterization).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding: "material-rate-0004-backfill", status: "PROVEN_BEHAVIOR" }),
      expect.objectContaining({ finding: "preferred-period-to-shift-conversion", status: "PROVEN_BEHAVIOR" }),
      expect.objectContaining({ finding: "business-number-sequence-state", status: "PROVEN_BEHAVIOR" }),
      expect.objectContaining({ finding: "waiting-list-obsolete-uniqueness-ordering", status: "PROVEN_HAZARD" }),
    ]));
  }, 180_000);

  it("cleans both generated databases after an induced primary failure", async () => {
    const names = {
      migrations: "aqlan_schema_ownership_migrations_failure_fixture",
      runtime: "aqlan_schema_ownership_runtime_failure_fixture",
    };
    const admin = adminClient("postgres");
    await expect(withGeneratedDatabasePair(
      admin,
      names,
      async () => ({ major: 18, version: "18 fixture" }),
      async () => { throw new Error("induced-operation-failure"); },
    )).rejects.toThrow("induced-operation-failure");

    const verify = adminClient("postgres");
    await verify.connect();
    try {
      const { rows } = await verify.query(
        "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
        [[names.migrations, names.runtime]],
      );
      expect(rows).toEqual([]);
    } finally {
      await verify.end();
    }
  }, 120_000);

  it("characterizes migration 0004 repair and history backfill on populated synthetic data", async () => {
    const name = "aqlan_schema_ownership_material";
    const url = await createIsolatedDatabase(name);
    try {
      await migrateThrough(url, 3);
      const client = new Client({ connectionString: url, ssl: false });
      await client.connect();
      try {
        await client.query(
          "INSERT INTO material_rates (category, rate_bp, updated_by) VALUES ('fixture-ortho', 1750, 'fixture')",
        );
      } finally {
        await client.end();
      }

      await migrateThrough(url, 4);
      const verify = new Client({ connectionString: url, ssl: false });
      await verify.connect();
      try {
        const { rows } = await verify.query<{
          history_count: string;
          data_type: string;
          column_default: string | null;
        }>(
          "SELECT " +
          "(SELECT COUNT(*)::text FROM material_rate_history WHERE category = 'fixture-ortho') AS history_count, " +
          "c.data_type, c.column_default " +
          "FROM information_schema.columns c " +
          "WHERE c.table_schema='public' AND c.table_name='material_rate_history' AND c.column_name='effective_from'",
        );
        expect(rows[0]?.history_count).toBe("1");
        expect(rows[0]?.data_type).toBe("timestamp with time zone");
        expect(String(rows[0]?.column_default ?? "").toLowerCase()).toContain("now()");
      } finally {
        await verify.end();
      }
    } finally {
      await dropIsolatedDatabase(name);
    }
  }, 120_000);

  it("characterizes migration 0010 preferred-period to shift conversion", async () => {
    const name = "aqlan_schema_ownership_waitshift";
    const url = await createIsolatedDatabase(name);
    try {
      await migrateThrough(url, 9);
      const client = new Client({ connectionString: url, ssl: false });
      await client.connect();
      try {
        const { rows } = await client.query<{ id: number }>(
          "INSERT INTO patients (patient_number, full_name) VALUES ('FIX-WAIT-1', 'Synthetic waiting fixture') RETURNING id",
        );
        await client.query(
          "INSERT INTO waiting_list (patient_id, preferred_period) VALUES ($1, 'morning')",
          [rows[0]?.id],
        );
      } finally {
        await client.end();
      }

      await migrateThrough(url, 10);
      const verify = new Client({ connectionString: url, ssl: false });
      await verify.connect();
      try {
        const { rows } = await verify.query<{ preferred_period: string; preferred_shift: string }>(
          "SELECT preferred_period, preferred_shift FROM waiting_list ORDER BY id LIMIT 1",
        );
        expect(rows[0]).toEqual({ preferred_period: "morning", preferred_shift: "shift1" });
      } finally {
        await verify.end();
      }
    } finally {
      await dropIsolatedDatabase(name);
    }
  }, 120_000);

  it("proves all four business-number sequences lag imported prefixed rows until runtime initialization synchronizes them", async () => {
    const name = "aqlan_schema_ownership_sequences";
    const url = await createIsolatedDatabase(name);
    try {
      await migrateThrough(url, 11);
      const client = new Client({ connectionString: url, ssl: false });
      await client.connect();
      try {
        const { rows: patients } = await client.query<{ id: number }>(
          "INSERT INTO patients (patient_number, full_name) VALUES ('P-000123', 'Synthetic sequence fixture') RETURNING id",
        );
        const { rows: shifts } = await client.query<{ id: number }>(
          "INSERT INTO cashier_shifts (opened_by) VALUES ('fixture') RETURNING id",
        );
        await client.query(
          "INSERT INTO invoices (invoice_number, patient_id) VALUES ('INV-000456', $1)",
          [patients[0]?.id],
        );
        await client.query(
          "INSERT INTO payments (receipt_number, patient_id, shift_id, amount_minor, currency, base_amount_minor) " +
          "VALUES ('REC-000789', $1, $2, 100, 'YER', 100)",
          [patients[0]?.id, shifts[0]?.id],
        );
        await client.query(
          "INSERT INTO expenses (voucher_number, category, shift_id, amount_minor, currency, base_amount_minor) " +
          "VALUES ('VOU-000321', 'fixture', $1, 100, 'YER', 100)",
          [shifts[0]?.id],
        );
      } finally {
        await client.end();
      }

      const before = await businessSequenceState(url);
      expect(before.patient_number_seq).toBeLessThan(123);
      expect(before.invoice_number_seq).toBeLessThan(456);
      expect(before.receipt_number_seq).toBeLessThan(789);
      expect(before.voucher_number_seq).toBeLessThan(321);

      await initializeGeneratedRuntimeSchema(validateOwnershipHarnessEnvironment(process.env), name, process.env);
      expect(await businessSequenceState(url)).toEqual({
        patient_number_seq: 123,
        invoice_number_seq: 456,
        receipt_number_seq: 789,
        voucher_number_seq: 321,
      });
    } finally {
      await dropIsolatedDatabase(name);
    }
  }, 120_000);

  it("reproduces the obsolete waiting-list uniqueness cold-start hazard without changing runtime code", async () => {
    const name = "aqlan_schema_ownership_waitcold";
    const url = await createIsolatedDatabase(name);
    try {
      await initializeGeneratedRuntimeSchema(validateOwnershipHarnessEnvironment(process.env), name, process.env);
      const client = new Client({ connectionString: url, ssl: false });
      await client.connect();
      try {
        const { rows: patients } = await client.query<{ id: number }>(
          "INSERT INTO patients (patient_number, full_name) VALUES ('FIX-COLD-1', 'Synthetic cold-start fixture') RETURNING id",
        );
        const { rows: services } = await client.query<{ id: number }>(
          "INSERT INTO appointment_services (code, name_ar) " +
          "VALUES ('fixture-a', 'Fixture A'), ('fixture-b', 'Fixture B') RETURNING id",
        );
        await client.query(
          "INSERT INTO waiting_list (patient_id, service_id) VALUES ($1, $2), ($1, $3)",
          [patients[0]?.id, services[0]?.id, services[1]?.id],
        );
      } finally {
        await client.end();
      }

      await expect(initializeGeneratedRuntimeSchema(validateOwnershipHarnessEnvironment(process.env), name, process.env)).rejects.toThrow(
        /waiting_list_one_open_per_patient_idx|could not create unique index|duplicate key/i,
      );
    } finally {
      await dropIsolatedDatabase(name);
    }
  }, 120_000);
});
