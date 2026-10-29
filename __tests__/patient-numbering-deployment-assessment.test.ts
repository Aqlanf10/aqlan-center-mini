import { describe, expect, it } from "vitest";
import { numberingDeploymentAssessment } from "../scripts/db-preflight";
import type { SchemaPreflightReport } from "../lib/schema-preflight";

function report(): Pick<SchemaPreflightReport, "registry" | "patientNumberingReadiness" | "schemaEquivalence"> {
  return {
    registry: { present: true, registeredCount: 67, adoptedVersions: [], missingVersions: [],
      unknownVersions: [], checksumMismatches: [], nameMismatches: [], matchesFiles: true },
    patientNumberingReadiness: { ready: true, ambiguousAliasGroups: 0 },
    schemaEquivalence: "NOT_ASSESSED",
  };
}

describe("numbering deployment evidence is separate from alias readiness", () => {
  it("does not authorize deployment from alias-ready and matching-registry observations", () => {
    const result = numberingDeploymentAssessment(report());
    expect(result.status).toBe("HOLD");
    expect(result.deploymentAuthorized).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.schemaEquivalence).toBe("NOT_ASSESSED");
    expect(result.requiredEvidence).toEqual([
      "EXACT_TARGET_SCHEMA_COMPATIBILITY_REVIEW", "PROTECTED_BACKUP_AND_ISOLATED_RESTORE_PROOF",
      "NUMBERING_COMPATIBLE_ROLLBACK_ARTIFACT", "EXACT_CANDIDATE_CI_AND_STAGING_OWNER_ACCEPTANCE",
    ]);
  });

  it("holds unknown 0090 history without adopting it or hiding alias readiness", () => {
    const input = report();
    input.registry.unknownVersions = ["0090"];
    input.registry.matchesFiles = false;
    const before = structuredClone(input);
    const result = numberingDeploymentAssessment(input);
    expect(result.blockers).toEqual(["UNKNOWN_APPLIED_MIGRATIONS"]);
    expect(result.deploymentAuthorized).toBe(false);
    expect(input).toEqual(before);
    expect(input.patientNumberingReadiness?.ready).toBe(true);
    expect(input.registry.unknownVersions).toEqual(["0090"]);
  });

  it("requires explicit review of missing runtime registrations, not blanket corruption or adoption", () => {
    const input = report();
    input.registry.missingVersions = ["0001", "0080"];
    input.registry.matchesFiles = false;
    const result = numberingDeploymentAssessment(input);
    expect(result.blockers).toEqual([]);
    expect(result.requiredEvidence).toContain("MISSING_REGISTRATIONS_TARGET_HISTORY_REVIEW");
    expect(result.status).toBe("HOLD");
    expect(input.registry.missingVersions).toEqual(["0001", "0080"]);
  });

  it("lists alias and registry integrity failures independently", () => {
    const input = report();
    input.patientNumberingReadiness = { ready: false, ambiguousAliasGroups: 2 };
    input.registry.present = false;
    input.registry.checksumMismatches = ["0080"];
    input.registry.nameMismatches = ["0089"];
    expect(numberingDeploymentAssessment(input).blockers).toEqual([
      "ALIAS_READINESS_NOT_PASSED", "MIGRATION_REGISTRY_ABSENT",
      "MIGRATION_CHECKSUM_MISMATCH", "MIGRATION_NAME_MISMATCH",
    ]);
  });

  it("fails closed when the optional alias assessment is missing", () => {
    const input = report();
    delete input.patientNumberingReadiness;
    expect(numberingDeploymentAssessment(input).blockers).toContain("ALIAS_READINESS_NOT_PASSED");
  });
});
