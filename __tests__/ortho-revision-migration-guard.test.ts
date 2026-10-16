import { describe, expect, it, vi } from "vitest";
import { guardOrthoRevisionMigration, validateOrthoRevisionRegistry } from "../lib/ortho-revision-migration-guard";
import contracts from "../lib/ortho-assessment-runtime.generated.json";
import type { DbClient } from "../lib/db";

describe("Ortho migration registration witnesses", () => {
  it.each(contracts)("refuses unregistered old objects before executing $filename", async file => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: file.version === "0051" ? "ortho_strategy_revisions" : "ortho_assessment_revisions" }] });
    await expect(guardOrthoRevisionMigration({ query, release: vi.fn() } as DbClient, file)).rejects.toThrow("ORTHO_UNREGISTERED_OBJECT_COLLISION");
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).not.toMatch(/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/);
  });
  it.each(contracts)("rejects an inconsistent registry despite identical SQL for $version", file => {
    const exact = { name: file.name, checksum: file.checksum, adopted: false };
    expect(() => validateOrthoRevisionRegistry(file, exact)).not.toThrow();
    for (const row of [{ ...exact, name: "different" }, { ...exact, checksum: "a".repeat(64) }, { ...exact, adopted: true }]) {
      expect(() => validateOrthoRevisionRegistry(file, row)).toThrow("ORTHO_MIGRATION_REGISTRY_MISMATCH");
    }
    expect(() => validateOrthoRevisionRegistry({ ...file, sql: file.sql + "\n" })).toThrow("ORTHO_MIGRATION_SOURCE_MISMATCH");
  });
  it("does not change another migration's registration contract", async () => {
    const query = vi.fn();
    await guardOrthoRevisionMigration({ query, release: vi.fn() } as DbClient, { ...contracts[0], version: "0058" });
    expect(query).not.toHaveBeenCalled();
  });
});
