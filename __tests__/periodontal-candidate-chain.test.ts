import { describe, expect, it } from "vitest";
import { periodontalCandidateMigrationVersion } from "./postgres/_periodontal-fixture";
import { checksumOf, loadMigrationFiles } from "../lib/migration-files";
import { assertReviewedMigrationChain, expectedMigrationRegistry, LATEST_REVIEWED_MIGRATION_VERSION,
  migrationFilesThrough, REVIEWED_MIGRATION_FILENAMES } from "./postgres/_reviewed-migration-chain";

const baseline = () => REVIEWED_MIGRATION_FILENAMES.slice(0, 40).map(filename => ({
  version: filename.slice(0, 4), filename,
}));
const invoice = { version: "0041", filename: "0041_invoice_clinical_linkage.sql" };
const legacy = { version: "0042", filename: "0042_legacy_treatment_agreements.sql" };

const coverage = { version: "0043", filename: "0043_legacy_treatment_coverage.sql" };
const ceph = { version: "0047", filename: "0047_ceph_correction_lineage.sql" };
const strategy = { version: "0051", filename: "0051_ortho_treatment_strategy.sql" };
const reviewed = () => [...baseline(), invoice, legacy, coverage, ceph, strategy];

describe("inactive periodontal candidate uses a reviewed collision-free test-only version", () => {
  it("keeps the pre-invoice baseline at test-only 0041", () => {
    expect(periodontalCandidateMigrationVersion(baseline())).toBe("0041");
  });
  it("preserves invoice 0041 and proposes test-only 0042", () => {
    expect(periodontalCandidateMigrationVersion([...baseline(), invoice])).toBe("0042");
  });
  it("preserves legacy 0042 when present and proposes test-only 0043", () => {
    expect(periodontalCandidateMigrationVersion([...baseline(), invoice, legacy])).toBe("0043");
  });
  it("preserves immutable coverage0043 and selects only test-only0044", () => {
    expect(periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, coverage])).toBe("0044");
  });
  it("preserves both reserved-number gaps, keeps exact Ceph 0047 and places the test-only candidate after 0051", () => {
    expect(periodontalCandidateMigrationVersion(reviewed())).toBe("0052");
    expect(reviewed()).toHaveLength(45);
    expect(reviewed().slice(40).map(file => file.version)).toEqual(["0041", "0042", "0043", "0047", "0051"]);
  });
  it("does not weaken gap, ordering, suffix or future-baseline guards", () => {
    expect(() => periodontalCandidateMigrationVersion(baseline().slice(1))).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, coverage])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, legacy])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, { ...coverage, filename: "0043_unreviewed.sql" }])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, coverage, { version: "0044", filename: "0044_future.sql" }])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline().slice(0, 39), invoice])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), legacy])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), { ...invoice, filename: "0041_unreviewed.sql" }])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, { version: "0043", filename: "0043_future.sql" }])).toThrow();
  });
  it("requires every reviewed filename and version without accepting renamed historical files", () => {
    for (let index = 0; index < reviewed().length; index += 1) {
      const files = reviewed();
      for (const patch of [{ filename: `${files[index].version}_unreviewed.sql` }, { version: "9999" }]) {
        const renamed = [...files]; renamed[index] = { ...renamed[index], ...patch };
        expect(() => periodontalCandidateMigrationVersion(renamed)).toThrow();
      }
    }
  });
  it("rejects every missing, duplicated or reordered entry in the required latest chain", () => {
    for (let index = 0; index < reviewed().length; index += 1) {
      const missing = reviewed(); missing.splice(index, 1);
      expect(() => assertReviewedMigrationChain(missing, LATEST_REVIEWED_MIGRATION_VERSION)).toThrow();
      const duplicate = reviewed(); duplicate.splice(index, 0, duplicate[index]);
      expect(() => assertReviewedMigrationChain(duplicate, LATEST_REVIEWED_MIGRATION_VERSION)).toThrow();
      if (index > 0) {
        const reordered = reviewed();
        [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
        expect(() => assertReviewedMigrationChain(reordered, LATEST_REVIEWED_MIGRATION_VERSION)).toThrow();
      }
    }
  });
  it("rejects invented 0044–0046/0048–0050 files and unreviewed or renamed later migrations", () => {
    for (const version of [44, 45, 46, 48, 49, 50]) {
      const identity = String(version).padStart(4, "0");
      const files = reviewed();
      files.splice(version < 47 ? 43 : 44, 0, { version: identity, filename: `${identity}_unreviewed.sql` });
      expect(() => periodontalCandidateMigrationVersion(files)).toThrow();
    }
    expect(() => periodontalCandidateMigrationVersion([...reviewed().slice(0, 44), { version: "0048", filename: "0048_future.sql" }])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...reviewed(), { version: "0052", filename: "0052_future.sql" }])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...reviewed().slice(0, 43), { ...ceph, filename: "0047_unreviewed.sql" }, strategy])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...reviewed().slice(0, 44), { ...strategy, filename: "0051_unreviewed.sql" }])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...reviewed().slice(0, 43), strategy])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...reviewed().slice(0, 42), ceph, strategy])).toThrow();
  });
  it("selects historical boundaries without dropping validation of the complete input", () => {
    const files = reviewed();
    expect(migrationFilesThrough(files, "0042")).toEqual(files.slice(0, 42));
    expect(migrationFilesThrough(files, "0043")).toEqual(files.slice(0, 43));
    expect(migrationFilesThrough(files, "0047")).toEqual(files.slice(0, 44));
    expect(migrationFilesThrough(files, "0051")).toEqual(files);
    expect(() => migrationFilesThrough(files.slice(0, 42), "0043")).toThrow();
    expect(() => migrationFilesThrough(files, "0050")).toThrow();
    expect(() => migrationFilesThrough([...files, { version: "0052", filename: "0052_unreviewed.sql" }], "0043")).toThrow();
    expect(files).toEqual(reviewed());
  });
  it("keeps registry names and SQL checksums exact instead of checking only row count", () => {
    const files = reviewed().map(file => {
      const sql = `-- synthetic provenance for ${file.filename}\n`;
      return { ...file, name: file.filename.slice(5, -4), sql, checksum: checksumOf(sql) };
    });
    expect(expectedMigrationRegistry(files)).toEqual(files.map(file => ({
      version: file.version, name: file.name, checksum: file.checksum, adopted: false,
    })));
    for (const patch of [{ checksum: "0".repeat(64) }, { sql: "-- changed bytes\n" }, { name: "unreviewed" }]) {
      expect(() => expectedMigrationRegistry([{ ...files[0], ...patch }, ...files.slice(1)])).toThrow();
    }
  });
  it("covers every actual current migration, including 0047 and 0051, with unchanged loaded SQL provenance", async () => {
    const files = await loadMigrationFiles();
    assertReviewedMigrationChain(files, LATEST_REVIEWED_MIGRATION_VERSION);
    expect(files.map(file => file.filename)).toEqual(REVIEWED_MIGRATION_FILENAMES);
    expect(expectedMigrationRegistry(files).map(row => row.version)).toEqual(files.map(file => file.version));
    expect(periodontalCandidateMigrationVersion(files)).toBe("0052");
  });
});
