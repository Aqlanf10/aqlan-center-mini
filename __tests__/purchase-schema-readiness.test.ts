import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import expected from "../schema/purchase-receipts-readiness.pg18.json";
import { inspectPurchaseSchemaReadiness, PURCHASE_READINESS_SECTIONS } from "../lib/purchase-schema-readiness";
import { checksumOf } from "../lib/migration-files";
import type { DetailedSchemaCatalog } from "../lib/schema-manifest";
const files = [{ version: "0065", name: expected.migrationName, checksum: expected.migrationSha256 }];
function fixture(complete = true): DetailedSchemaCatalog {
  return { format: "aqlan-schema-ownership-catalog", formatVersion: 1, postgresMajor: 18, postgresVersion: "18",
    ownership: { databaseOwner: "", schemaOwner: "", schemaAcl: "" },
    tables: [], columns: [], constraints: [], indexes: [], triggers: [], functions: [], internalTriggers: [],
    sequences: [], extensions: [], extensionMembers: [], mutableSequenceState: [],
    ...(complete ? JSON.parse(JSON.stringify(expected.sections)) : {}),
    registry: { present: complete, rows: complete ? [{ ...files[0], adopted: false }] : [] } };
}
describe("bounded 0065 source shape diagnostic", () => {
  it("pins expected shape to exact source bytes and includes every source-created object class", async () => {
    expect(checksumOf(await readFile("migrations/0065_inventory_purchase_receipts.sql", "utf8"))).toBe(expected.migrationSha256);
    expect(expected.sections.tables).toHaveLength(1); expect(expected.sections.columns).toHaveLength(9);
    expect(expected.sections.constraints.length).toBeGreaterThanOrEqual(9);
    expect(expected.sections.indexes).toHaveLength(2); expect(expected.sections.triggers).toHaveLength(2);
    expect(expected.sections.functions).toHaveLength(1); expect(expected.sections.internalTriggers).toHaveLength(8);
  });
  it("reports all absent without claiming readiness or mutating the snapshot", () => {
    const catalog = fixture(false); const before = JSON.stringify(catalog);
    const report = inspectPurchaseSchemaReadiness(catalog, files, catalog.tables.length ? ["r"] : []);
    expect(report.catalogShape).toBe("ABSENT"); expect(report.registry).toBe("ABSENT");
    expect(report.registrationAndShapeMatch).toBe(false); expect(JSON.stringify(catalog)).toBe(before);
  });
  it("reports exact catalog and registration but never runtime availability", () => {
    const catalog = fixture(); const before = JSON.stringify(catalog);
    expect(inspectPurchaseSchemaReadiness(catalog, files, catalog.tables.length ? ["r"] : [])).toMatchObject({ catalogShape: "COMPATIBLE", registry: "MATCH",
      registrationAndShapeMatch: true, operationalAvailability: "NOT_VERIFIED", adoptionAssessment: "NOT_PERFORMED" });
    expect(JSON.stringify(catalog)).toBe(before);
  });
  it("separates complete unregistered schema from safely registered availability", () => {
    const catalog = fixture(); catalog.registry.rows = [];
    expect(inspectPurchaseSchemaReadiness(catalog, files, catalog.tables.length ? ["r"] : [])).toMatchObject({ catalogShape: "COMPATIBLE", registry: "ABSENT", registrationAndShapeMatch: false });
  });
  it.each(PURCHASE_READINESS_SECTIONS)("detects partial %s", section => {
    const catalog = fixture(); catalog[section].pop();
    expect(inspectPurchaseSchemaReadiness(catalog, files, catalog.tables.length ? ["r"] : []).catalogShape).toBe("PARTIAL_OR_CONFLICTING");
  });
  it.each(PURCHASE_READINESS_SECTIONS)("withholds conflicting %s values and unknown identities", section => {
    const catalog = fixture(); const first = catalog[section][0];
    first.value = JSON.stringify({ secret: "synthetic-secret-canary" });
    catalog[section].push({ ...first, ...(section === "internalTriggers" ? { table: "inventory_purchase_receipts" } : {}), key: "synthetic-secret-identity", name: section === "functions" ? first.name : "synthetic-secret-identity" });
    const report = inspectPurchaseSchemaReadiness(catalog, files, catalog.tables.length ? ["r"] : []);
    expect(report.catalogShape).toBe("PARTIAL_OR_CONFLICTING"); expect(report.unexpectedObjectCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain("synthetic-secret");
  });
  it("fails closed on duplicate identities, drifted registration, and changed source provenance", () => {
    const catalog = fixture(); catalog.triggers.push({ ...catalog.triggers[0] });
    expect(inspectPurchaseSchemaReadiness(catalog, files, catalog.tables.length ? ["r"] : []).catalogShape).toBe("PARTIAL_OR_CONFLICTING");
    catalog.registry.rows[0].checksum = "0".repeat(64);
    expect(inspectPurchaseSchemaReadiness(catalog, files, catalog.tables.length ? ["r"] : []).registry).toBe("CONFLICT");
    expect(() => inspectPurchaseSchemaReadiness(fixture(), [{ ...files[0], checksum: "0".repeat(64) }], ["r"])).toThrow();
  });
  it("recognizes conflicting non-table names even when the projector omits them", () => {
    expect(inspectPurchaseSchemaReadiness(fixture(false), files, ["v"])).toMatchObject({ relation: "CONFLICT", catalogShape: "PARTIAL_OR_CONFLICTING" });
  });
  it("ignores unrelated objects without disclosure", () => {
    const catalog = fixture(); catalog.functions.push({ key: "private-secret()", name: "private-secret", value: "unknown private body" });
    expect(JSON.stringify(inspectPurchaseSchemaReadiness(catalog, files, catalog.tables.length ? ["r"] : []))).not.toContain("private-secret");
    expect(inspectPurchaseSchemaReadiness(catalog, files, catalog.tables.length ? ["r"] : []).catalogShape).toBe("COMPATIBLE");
  });
});
