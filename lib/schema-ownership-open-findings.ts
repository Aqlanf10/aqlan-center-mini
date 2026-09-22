import { createHash } from "node:crypto";
import type { DetailedSchemaComparison, DetailedSchemaDifference } from "./schema-manifest";

export interface OpenFindingFingerprint {
  id: string;
  section: DetailedSchemaDifference["section"];
  key: string;
  kind: DetailedSchemaDifference["kind"];
  leftFingerprint: string;
  rightFingerprint: string;
  reason: "column_ordinal_drift" | "function_definition_drift" | "catalog_drift";
}

export interface OpenFindingsManifest {
  format: "aqlan-schema-ownership-open-findings";
  formatVersion: 1;
  postgresMajor: 18;
  applicationSchemaEqual: false;
  findings: OpenFindingFingerprint[];
}

export function catalogValueFingerprint(value: string | undefined): string {
  // The present value is the complete canonical detailed-catalog JSON string.
  const bytes = value === undefined ? "\0missing" : value;
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

function identity(section: string, key: string): string {
  return `${section}:${key}`;
}

const APPLICATION_SECTIONS = new Set([
  "tables", "columns", "constraints", "indexes", "triggers", "internalTriggers", "functions", "sequences",
]);

function isOrdinalOnly(difference: DetailedSchemaDifference): boolean {
  if (difference.section !== "columns" || !difference.left || !difference.right) return false;
  try {
    const { ordinal: leftOrdinal, ...leftRest } = JSON.parse(difference.left) as Record<string, unknown>;
    const { ordinal: rightOrdinal, ...rightRest } = JSON.parse(difference.right) as Record<string, unknown>;
    return leftOrdinal !== rightOrdinal && JSON.stringify(leftRest) === JSON.stringify(rightRest);
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === keys.slice().sort().join("\0");
}

export function candidateOpenFindingsManifest(raw: DetailedSchemaComparison): OpenFindingsManifest {
  const findings = raw.rawDifferences.map((difference): OpenFindingFingerprint => {
    if (!APPLICATION_SECTIONS.has(difference.section)) {
      throw new Error(`OPEN_FINDING_CANDIDATE_REVIEW_REQUIRED: unsupported section ${difference.section}.`);
    }
    return {
      id: identity(difference.section, difference.key),
      section: difference.section,
      key: difference.key,
      kind: difference.kind,
      leftFingerprint: catalogValueFingerprint(difference.left),
      rightFingerprint: catalogValueFingerprint(difference.right),
      reason: isOrdinalOnly(difference) ? "column_ordinal_drift"
        : difference.section === "functions" ? "function_definition_drift" : "catalog_drift",
    };
  });
  return {
    format: "aqlan-schema-ownership-open-findings",
    formatVersion: 1,
    postgresMajor: 18,
    applicationSchemaEqual: false,
    findings: findings.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function parseOpenFindingsManifest(value: unknown): OpenFindingsManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OPEN_FINDINGS_MANIFEST_INVALID: object required.");
  const manifest = value as Record<string, unknown>;
  if (!exactKeys(manifest, ["format", "formatVersion", "postgresMajor", "applicationSchemaEqual", "findings"])
    || manifest.format !== "aqlan-schema-ownership-open-findings"
    || manifest.formatVersion !== 1
    || manifest.postgresMajor !== 18
    || manifest.applicationSchemaEqual !== false
    || !Array.isArray(manifest.findings)) {
    throw new Error("OPEN_FINDINGS_MANIFEST_INVALID: header or PostgreSQL major mismatch.");
  }
  const ids = new Set<string>();
  const identities = new Set<string>();
  const sha = /^[0-9a-f]{64}$/;
  for (const item of manifest.findings) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("OPEN_FINDINGS_MANIFEST_INVALID: finding object required.");
    const finding = item as Record<string, unknown>;
    const validSection = APPLICATION_SECTIONS.has(String(finding.section));
    const validReason = finding.reason === "column_ordinal_drift"
      ? finding.section === "columns"
      : finding.reason === "function_definition_drift"
        ? finding.section === "functions"
        : finding.reason === "catalog_drift";
    if (!exactKeys(finding, ["id", "section", "key", "kind", "leftFingerprint", "rightFingerprint", "reason"])
      || !validSection || typeof finding.key !== "string" || !finding.key
      || typeof finding.id !== "string" || finding.id !== identity(finding.section as string, finding.key)
      || !["definition_mismatch", "missing_left", "missing_right"].includes(String(finding.kind))
      || !sha.test(String(finding.leftFingerprint)) || !sha.test(String(finding.rightFingerprint))
      || !validReason) {
      throw new Error("OPEN_FINDINGS_MANIFEST_INVALID: malformed finding.");
    }
    if (ids.has(finding.id) || identities.has(identity(finding.section as string, finding.key))) {
      throw new Error("OPEN_FINDINGS_MANIFEST_INVALID: duplicate finding identity.");
    }
    ids.add(finding.id);
    identities.add(identity(finding.section as string, finding.key));
  }
  return manifest as unknown as OpenFindingsManifest;
}

export function classifyOpenFindings(
  raw: DetailedSchemaComparison,
  manifest: OpenFindingsManifest,
): DetailedSchemaComparison {
  const validated = parseOpenFindingsManifest(manifest);
  const expected = new Map(validated.findings.map((finding) => [identity(finding.section, finding.key), finding]));
  const seen = new Set<string>();
  const openConvergenceFindings: DetailedSchemaDifference[] = [];
  const unexpectedDifferences: DetailedSchemaDifference[] = [];
  for (const difference of raw.rawDifferences) {
    const id = identity(difference.section, difference.key);
    const finding = expected.get(id);
    seen.add(id);
    if (finding && finding.kind === difference.kind
      && finding.leftFingerprint === catalogValueFingerprint(difference.left)
      && finding.rightFingerprint === catalogValueFingerprint(difference.right)) {
      openConvergenceFindings.push({ ...difference, classification: "OPEN_CONVERGENCE_FINDING", openFindingId: id });
    } else {
      unexpectedDifferences.push({ ...difference, classification: "UNEXPECTED_DIFFERENCE" });
    }
  }
  for (const finding of validated.findings) {
    if (!seen.has(finding.id)) {
      unexpectedDifferences.push({
        section: "openFindings", key: finding.id, kind: "missing_right",
        classification: "UNEXPECTED_DIFFERENCE", openFindingId: finding.id,
      });
    }
  }
  const openFindingsManifestMatch = unexpectedDifferences.length === 0
    && openConvergenceFindings.length === validated.findings.length;
  const characterizationOk = openFindingsManifestMatch && raw.ownershipEqual && raw.extensionProvenanceEqual;
  return {
    ...raw,
    ok: characterizationOk,
    characterizationOk,
    openFindingSetMatches: openFindingsManifestMatch,
    openFindingsManifestMatch,
    knownDifferences: [],
    openConvergenceFindings,
    unexpectedDifferences,
  };
}
