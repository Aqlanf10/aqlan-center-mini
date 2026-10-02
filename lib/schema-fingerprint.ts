import { createHash } from "node:crypto";
import disclosure from "../schema/preflight-disclosure.pg18.json";
import type { DetailedCatalogEntry, DetailedSchemaCatalog } from "./schema-manifest";

export const FINGERPRINT_SECTIONS = ["columns", "constraints", "internalTriggers"] as const;
export type FingerprintSection = typeof FINGERPRINT_SECTIONS[number];

// Explicit disclosure policy. New projector fields fail closed; never infer a
// field's safety from its name or from a live value. Text must already be known
// from the isolated source-generated schemas, even for a known object identity.
export const FINGERPRINT_FIELDS = {
  columns: {
    ordinal: "number", typeModifier: "number", characterMaximumLength: "number",
    numericPrecision: "number", numericScale: "number", datetimePrecision: "number",
    nullable: "boolean", formatType: "text", internalType: "text", baseType: "text",
    default: "text", identity: "text", generated: "text", collation: "text",
  },
  constraints: {
    inheritedCount: "number", validated: "boolean", deferrable: "boolean",
    initiallyDeferred: "boolean", local: "boolean", noInherit: "boolean",
    type: "text", definition: "text", columns: "text", referencedSchema: "text",
    referencedTable: "text", referencedColumns: "text", updateAction: "text",
    deleteAction: "text", matchType: "text",
  },
  internalTriggers: {
    internal: "boolean", definition: "text", enabled: "text", constraint: "text", function: "text",
  },
} as const;

export function fingerprint(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(["aqlan-schema-drilldown-v1", ...parts]), "utf8").digest("hex");
}

export function fingerprintIdentity(section: FingerprintSection, entry: DetailedCatalogEntry): string {
  return fingerprint("identity", section, entry.key, entry.table ?? null, entry.name ?? null);
}

export interface FingerprintDisclosurePolicy {
  format: "aqlan-preflight-disclosure";
  formatVersion: 1;
  sections: Record<FingerprintSection, { identities: string[]; textValues: Record<string, string[]> }>;
}

export interface SchemaFingerprintDrilldown {
  formatVersion: 1;
  postgresVersionNum: number;
  disclosurePolicySha256: string;
  sections: Record<FingerprintSection, {
    count: number;
    withheldIdentityCount: number;
    entries: Array<{
      identitySha256: string;
      entrySha256: string | null;
      properties: Record<string, string | "WITHHELD" | "MISSING">;
      withheldPropertyCount: number;
    }>;
  }>;
}

/** Pure projection of the existing snapshot; no SQL or schema normalization. */
export function fingerprintCatalog(catalog: DetailedSchemaCatalog, postgresVersionNum: number): SchemaFingerprintDrilldown {
  const policy: FingerprintDisclosurePolicy = disclosure as FingerprintDisclosurePolicy;
  const sections = {} as SchemaFingerprintDrilldown["sections"];
  // Bound optional diagnostic output independently of default summary behavior.
  if (FINGERPRINT_SECTIONS.some((section) => catalog[section].length > 5_000)) {
    throw Object.assign(new Error("Fingerprint evidence exceeds its bound."), { code: "FINGERPRINT_LIMIT_EXCEEDED" });
  }
  for (const section of FINGERPRINT_SECTIONS) {
    const known = new Set(policy.sections[section].identities);
    const allowedText = new Map(Object.entries(policy.sections[section].textValues).map(([field, values]) => [field, new Set(values)]));
    const fields: Record<string, string> = FINGERPRINT_FIELDS[section];
    const output: SchemaFingerprintDrilldown["sections"][FingerprintSection] = {
      count: catalog[section].length, withheldIdentityCount: 0, entries: [],
    };
    for (const entry of catalog[section]) {
      const identitySha256 = fingerprintIdentity(section, entry);
      if (!known.has(identitySha256)) { output.withheldIdentityCount++; continue; }
      let values: unknown;
      try { values = JSON.parse(entry.value); }
      catch { throw Object.assign(new Error("Invalid fingerprint projection."), { code: "FINGERPRINT_PROJECTION_INVALID" }); }
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw Object.assign(new Error("Invalid fingerprint projection."), { code: "FINGERPRINT_PROJECTION_INVALID" });
      }
      const object = values as Record<string, unknown>;
      let withheldPropertyCount = Object.keys(object).filter((field) => !Object.hasOwn(fields, field)).length
        + Object.keys(entry).filter((field) => !["key", "table", "name", "value"].includes(field)).length;
      const properties: Record<string, string> = {};
      for (const field of Object.keys(fields).sort()) {
        if (!Object.hasOwn(object, field)) { properties[field] = "MISSING"; continue; }
        const value = object[field];
        const hash = fingerprint("property", section, field, value);
        const safe = fields[field] === "text"
          ? allowedText.get(field)?.has(hash)
          : value === null || (typeof value === fields[field] && (typeof value !== "number" || Number.isFinite(value)));
        if (safe) properties[field] = hash;
        else { properties[field] = "WITHHELD"; withheldPropertyCount++; }
      }
      output.entries.push({ identitySha256,
        entrySha256: withheldPropertyCount ? null : fingerprint("entry", section, entry),
        properties, withheldPropertyCount });
    }
    // Arrays, never maps: duplicate identities and values keep multiplicity.
    output.entries.sort((a, b) => { const left = JSON.stringify(a); const right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; });
    sections[section] = output;
  }
  const result: SchemaFingerprintDrilldown = { formatVersion: 1, postgresVersionNum,
    disclosurePolicySha256: fingerprint("disclosure-policy", policy), sections };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 4 * 1024 * 1024) {
    throw Object.assign(new Error("Fingerprint evidence exceeds its bound."), { code: "FINGERPRINT_LIMIT_EXCEEDED" });
  }
  return result;
}

export const FINGERPRINT_BUCKET_COUNT = 64;
export interface FingerprintBucketSelection { section: FingerprintSection; bucket: string }

/** Only already-filtered projections enter buckets; unknown identities do not. */
export function fingerprintBucketResponse(drilldown: SchemaFingerprintDrilldown, selection?: FingerprintBucketSelection) {
  if (selection && (!FINGERPRINT_SECTIONS.includes(selection.section) || !/^[0-3][0-9a-f]$/.test(selection.bucket))) {
    throw Object.assign(new Error("Invalid fingerprint selection."), { code: "CLI_ARGUMENTS_INVALID" });
  }
  const sections = {} as Record<FingerprintSection, {
    count: number; knownEntryCount: number; withheldIdentityCount: number; withheldPropertyCount: number;
    buckets: { bucket: string; count: number; sha256: string }[];
  }>;
  let detail: { section: FingerprintSection; bucket: string; count: number; sha256: string;
    entries: SchemaFingerprintDrilldown["sections"][FingerprintSection]["entries"] } | undefined;
  for (const section of FINGERPRINT_SECTIONS) {
    const source = drilldown.sections[section];
    const entries = Array.from({ length: FINGERPRINT_BUCKET_COUNT }, () => [] as typeof source.entries);
    for (const entry of source.entries) entries[Number.parseInt(entry.identitySha256.slice(0, 2), 16) % FINGERPRINT_BUCKET_COUNT].push(entry);
    const buckets = entries.map((values, index) => {
      const bucket = index.toString(16).padStart(2, "0");
      return { bucket, count: values.length, sha256: fingerprint("bucket", section, bucket, values) };
    });
    sections[section] = { count: source.count, knownEntryCount: source.entries.length,
      withheldIdentityCount: source.withheldIdentityCount,
      withheldPropertyCount: source.entries.reduce((total, entry) => total + entry.withheldPropertyCount, 0), buckets };
    if (selection?.section === section) {
      const index = Number.parseInt(selection.bucket, 16);
      detail = { section, ...buckets[index], entries: entries[index] };
    }
  }
  const metadata = { formatVersion: 1 as const, postgresVersionNum: drilldown.postgresVersionNum,
    disclosurePolicySha256: drilldown.disclosurePolicySha256, bucketCount: FINGERPRINT_BUCKET_COUNT };
  // Details retain global count-only disclosure evidence without repeating the
  // complete bucket inventory. Original catalog/provenance accompanies either.
  return detail
    ? { ...metadata, mode: "bucket" as const, sections: Object.fromEntries(Object.entries(sections).map(([name, { buckets: _buckets, ...counts }]) => [name, counts])), detail }
    : { ...metadata, mode: "buckets" as const, sections };
}
