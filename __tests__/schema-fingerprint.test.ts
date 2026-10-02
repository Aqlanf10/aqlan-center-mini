import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FINGERPRINT_FIELDS,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_BUCKET_COUNT,
  fingerprint,
  fingerprintBucketResponse,
  fingerprintCatalog,
  fingerprintIdentity,
  type FingerprintSection,
} from "../lib/schema-fingerprint";
import type { DetailedCatalogEntry, DetailedSchemaCatalog } from "../lib/schema-manifest";
import disclosure from "../schema/preflight-disclosure.pg18.json";

// Source-known PostgreSQL 18 objects from the committed schema. These fixtures
// deliberately have no dependency on a live database or generated local files.
const column: DetailedCatalogEntry = {
  key: "patients.id",
  table: "patients",
  name: "id",
  value: JSON.stringify({
    ordinal: 1, formatType: "integer", internalType: "int4", baseType: "integer",
    typeModifier: -1, characterMaximumLength: null, numericPrecision: 32,
    numericScale: 0, datetimePrecision: null, nullable: false,
    default: "nextval('public.patients_id_seq'::regclass)", identity: "", generated: "", collation: null,
  }),
};

const constraint: DetailedCatalogEntry = {
  key: "patients:patients_pkey",
  table: "patients",
  name: "patients_pkey",
  value: JSON.stringify({
    type: "p", definition: "PRIMARY KEY (id)", columns: "id", referencedSchema: "",
    referencedTable: "", referencedColumns: "", updateAction: " ", deleteAction: " ", matchType: " ",
    validated: true, deferrable: false, initiallyDeferred: false, local: true,
    inheritedCount: 0, noInherit: true,
  }),
};

const internalTrigger: DetailedCatalogEntry = {
  key: "appointment_services:appointments_service_id_fkey:pg_catalog.RI_FKey_noaction_upd():17",
  table: "appointment_services",
  name: "$INTERNAL_TRIGGER",
  value: JSON.stringify({
    definition: 'CREATE CONSTRAINT TRIGGER "$INTERNAL_TRIGGER" AFTER UPDATE ON public.appointment_services FROM public.appointments NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION "RI_FKey_noaction_upd"()',
    enabled: "O", internal: true, constraint: "appointments_service_id_fkey",
    function: "pg_catalog.RI_FKey_noaction_upd()",
  }),
};

const fixtures: Record<FingerprintSection, DetailedCatalogEntry> = {
  columns: column, constraints: constraint, internalTriggers: internalTrigger,
};

function catalog(overrides: Partial<DetailedSchemaCatalog> = {}): DetailedSchemaCatalog {
  return {
    format: "aqlan-schema-ownership-catalog", formatVersion: 1, postgresMajor: 18, postgresVersion: "18.3",
    ownership: { databaseOwner: "$CURRENT_USER", schemaOwner: "$CURRENT_USER", schemaAcl: "" },
    tables: [], columns: [], constraints: [], indexes: [], triggers: [], internalTriggers: [],
    functions: [], sequences: [], extensions: [], extensionMembers: [], mutableSequenceState: [],
    registry: { present: false, rows: [] },
    ...overrides,
  };
}

function withProperties(entry: DetailedCatalogEntry, properties: Record<string, unknown>): DetailedCatalogEntry {
  return { ...entry, value: JSON.stringify({ ...JSON.parse(entry.value), ...properties }) };
}

function evidence(section: FingerprintSection, entry: DetailedCatalogEntry) {
  return fingerprintCatalog(catalog({ [section]: [entry] }), 180003).sections[section].entries[0]!;
}

function plainSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("privacy-preserving schema fingerprint drilldown", () => {
  it("restricts disclosure to exactly the three explicitly supported sections", () => {
    const privateValue = "PRIVATE_UNSUPPORTED_SECTION_CANARY";
    const privateEntry = { key: privateValue, name: privateValue, value: JSON.stringify({ body: privateValue }) };
    const result = fingerprintCatalog(catalog({
      tables: [privateEntry], indexes: [privateEntry], triggers: [privateEntry], functions: [privateEntry],
      sequences: [privateEntry], extensionMembers: [privateEntry],
      ownership: { databaseOwner: privateValue, schemaOwner: privateValue, schemaAcl: privateValue },
      extensions: [{ name: privateValue, version: privateValue, schema: privateValue }],
      mutableSequenceState: [{ key: privateValue, lastValue: privateValue, isCalled: true }],
      registry: { present: true, rows: [{ version: privateValue, name: privateValue, checksum: privateValue, adopted: true }] },
    }), 180003);

    expect(FINGERPRINT_SECTIONS).toEqual(["columns", "constraints", "internalTriggers"]);
    expect(Object.keys(result.sections)).toEqual(FINGERPRINT_SECTIONS);
    expect(result).toMatchObject({ formatVersion: 1, postgresVersionNum: 180003 });
    expect(result.disclosurePolicySha256).toBe(fingerprint("disclosure-policy", disclosure));
    expect(JSON.stringify(result)).not.toContain(privateValue);
    for (const section of FINGERPRINT_SECTIONS) {
      expect(result.sections[section]).toEqual({ count: 0, withheldIdentityCount: 0, entries: [] });
    }
  });

  it("pins deterministic identity and property hashes with a domain-separated encoding", () => {
    expect(fingerprintIdentity("columns", column)).toBe("c2cfa4c4700d104d0977dc3164ace38ed0ed1656bf4fa3b6175e46990f1dbb2e");
    expect(fingerprint("property", "columns", "ordinal", 1)).toBe("5b3b7e324af04abfbcdc3c3b527b11e13c27af2f73c22b0aa9a3fbdef5879652");
    const result = evidence("columns", column);
    expect(result.properties.default).toBe("a7b0cd424180ec49405bafed1a72f722b3702f8b0f0bc37ee7ea066a270960b3");
    expect(result.entrySha256).toBe("6cb20d296a45a1f140937d1a650341be3b055d2996bca979b2420d8a5434f90b");
    expect(fingerprint("property", "columns", "ordinal", 1)).not.toBe(fingerprint("property", "columns", "numericScale", 1));
    expect(fingerprint("property", "columns", "ordinal", 1)).not.toBe(fingerprint("property", "constraints", "ordinal", 1));
  });

  it.each(FINGERPRINT_SECTIONS)("emits all safe properties for a source-known %s object", (section) => {
    const entry = fixtures[section];
    const result = evidence(section, entry);
    expect(disclosure.sections[section].identities).toContain(fingerprintIdentity(section, entry));
    expect(result).toMatchObject({
      identitySha256: fingerprintIdentity(section, entry),
      entrySha256: fingerprint("entry", section, entry),
      withheldPropertyCount: 0,
    });
    expect(Object.keys(result.properties)).toEqual(Object.keys(FINGERPRINT_FIELDS[section]).sort());
    for (const [field, value] of Object.entries(JSON.parse(entry.value))) {
      expect(result.properties[field]).toBe(fingerprint("property", section, field, value));
    }
    expect(JSON.stringify(result)).not.toContain(entry.key);
    expect(JSON.stringify(result)).not.toContain(entry.value);
  });

  it.each(FINGERPRINT_SECTIONS)("reports unknown %s identities only as counts", (section) => {
    const canary = `PRIVATE_IDENTITY_${section}_CANARY`;
    const entry = { ...fixtures[section], key: canary, table: canary, name: canary };
    const result = fingerprintCatalog(catalog({ [section]: [entry, entry] }), 180003);
    const encoded = JSON.stringify(result);
    expect(result.sections[section]).toEqual({ count: 2, withheldIdentityCount: 2, entries: [] });
    for (const forbidden of [canary, plainSha256(canary), fingerprintIdentity(section, entry), fingerprint("entry", section, entry)]) {
      expect(encoded).not.toContain(forbidden);
    }
    for (const [field, value] of Object.entries(JSON.parse(entry.value))) {
      expect(encoded).not.toContain(fingerprint("property", section, field, value));
    }
  });

  it.each(["key", "table", "name"] as const)("requires the complete known identity, including %s", (field) => {
    const renamed = { ...column, [field]: "PRIVATE_RENAMED_IDENTITY_CANARY" };
    const before = fingerprintCatalog(catalog({ columns: [column] }), 180003);
    const after = fingerprintCatalog(catalog({ columns: [renamed] }), 180003);
    expect(after.sections.columns).toEqual({ count: 1, withheldIdentityCount: 1, entries: [] });
    expect(after).not.toEqual(before);
    expect(JSON.stringify(after)).not.toContain(fingerprintIdentity("columns", renamed));
  });

  const textFields = FINGERPRINT_SECTIONS.flatMap((section) =>
    Object.entries(FINGERPRINT_FIELDS[section]).filter(([, type]) => type === "text")
      .map(([field]) => ({ section, field })),
  );

  it.each(textFields)("withholds unknown text in $section.$field and suppresses the entry hash", ({ section, field }) => {
    const canary = `PRIVATE_TEXT_${section}_${field}_CANARY`;
    const entry = withProperties(fixtures[section], { [field]: canary });
    const result = evidence(section, entry);
    expect(result.properties[field]).toBe("WITHHELD");
    expect(result.withheldPropertyCount).toBe(1);
    expect(result.entrySha256).toBeNull();
    const encoded = JSON.stringify(result);
    for (const forbidden of [canary, plainSha256(canary), fingerprint("property", section, field, canary), fingerprint("entry", section, entry)]) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  it("does not normalize an unknown SQL default into a disclosed source value", () => {
    const entry = withProperties(column, { default: " nextval('public.patients_id_seq'::regclass) " });
    expect(evidence("columns", entry)).toMatchObject({
      entrySha256: null, properties: { default: "WITHHELD" }, withheldPropertyCount: 1,
    });
  });

  it("reports unknown property names and values only as a count, including inherited-looking keys", () => {
    const extra = JSON.parse('{"PRIVATE_FIELD_CANARY":"PRIVATE_VALUE_CANARY","__proto__":{"private":"PRIVATE_NESTED_CANARY"},"constructor":true,"toString":42}') as Record<string, unknown>;
    const entry = withProperties(column, extra);
    const result = evidence("columns", entry);
    expect(result.withheldPropertyCount).toBe(4);
    expect(result.entrySha256).toBeNull();
    expect(Object.keys(result.properties)).toEqual(Object.keys(FINGERPRINT_FIELDS.columns).sort());
    const encoded = JSON.stringify(result);
    for (const [field, value] of Object.entries(extra)) {
      expect(encoded).not.toContain(field);
      if (typeof value === "string") expect(encoded).not.toContain(value);
      expect(Object.values(result.properties)).not.toContain(value);
      expect(encoded).not.toContain(fingerprint("property", "columns", field, value));
    }
    expect(encoded).not.toContain("PRIVATE_");
    expect(encoded).not.toContain(fingerprint("entry", "columns", entry));
  });

  it("withholds unknown entry-wrapper fields instead of including private data in the entry hash", () => {
    const entry = { ...column, PRIVATE_WRAPPER_FIELD_CANARY: "PRIVATE_WRAPPER_VALUE_CANARY" };
    const result = evidence("columns", entry);
    expect(result).toMatchObject({ entrySha256: null, withheldPropertyCount: 1 });
    expect(result.properties).toEqual(evidence("columns", column).properties);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("PRIVATE_WRAPPER_");
    expect(encoded).not.toContain(fingerprint("entry", "columns", entry));
    expect(encoded).not.toContain(plainSha256(entry.PRIVATE_WRAPPER_FIELD_CANARY));
  });

  it.each([
    ["ordinal", "7"], ["nullable", "true"], ["ordinal", { private: "PRIVATE_TYPED_FIELD_CANARY" }],
    ["nullable", [false]], ["formatType", 42], ["definition", ["PRIVATE_ARRAY_CANARY"]],
  ] as const)("fails closed for a disallowed value type in %s", (field, value) => {
    const section = field === "definition" ? "constraints" : "columns";
    const entry = withProperties(fixtures[section], { [field]: value });
    const result = evidence(section, entry);
    expect(result).toMatchObject({ entrySha256: null, properties: { [field]: "WITHHELD" }, withheldPropertyCount: 1 });
    expect(JSON.stringify(result)).not.toContain(fingerprint("property", section, field, value));
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("retains safe numeric and boolean structural drift without disclosing values", () => {
    const before = evidence("columns", column);
    const changed = withProperties(column, { ordinal: 777, nullable: true, numericPrecision: null });
    const after = evidence("columns", changed);
    expect(after.identitySha256).toBe(before.identitySha256);
    expect(after.entrySha256).not.toBe(before.entrySha256);
    expect(after.withheldPropertyCount).toBe(0);
    for (const [field, value] of Object.entries({ ordinal: 777, nullable: true, numericPrecision: null })) {
      expect(after.properties[field]).toBe(fingerprint("property", "columns", field, value));
      expect(after.properties[field]).not.toBe(before.properties[field]);
    }
    expect(after.properties.default).toBe(before.properties.default);
  });

  it.each(["1e400", "-1e400"])("withholds a non-finite numeric projection (%s)", (number) => {
    const entry = { ...column, value: column.value.replace('"ordinal":1,', `"ordinal":${number},`) };
    expect(evidence("columns", entry)).toMatchObject({
      entrySha256: null, properties: { ordinal: "WITHHELD" }, withheldPropertyCount: 1,
    });
  });

  it("distinguishes an absent property from null and from withheld text", () => {
    const values = JSON.parse(column.value) as Record<string, unknown>;
    delete values.default;
    const missing = evidence("columns", { ...column, value: JSON.stringify(values) });
    const nullValue = evidence("columns", withProperties(column, { default: null }));
    const withheld = evidence("columns", withProperties(column, { default: "PRIVATE_DEFAULT_CANARY" }));
    expect(missing.properties.default).toBe("MISSING");
    expect(missing.withheldPropertyCount).toBe(0);
    expect(missing.entrySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(nullValue.properties.default).toBe(fingerprint("property", "columns", "default", null));
    expect(withheld.properties.default).toBe("WITHHELD");
    expect(new Set([missing.entrySha256, nullValue.entrySha256, withheld.entrySha256]).size).toBe(3);
  });

  it.each(FINGERPRINT_SECTIONS)("retains duplicate %s identities and differing duplicate values", (section) => {
    const original = fixtures[section];
    const drift = withProperties(original, section === "columns" ? { ordinal: 777 }
      : section === "constraints" ? { validated: false } : { internal: false });
    const input = catalog({ [section]: [original, drift, original] });
    const result = fingerprintCatalog(input, 180003);
    expect(result.sections[section]).toMatchObject({ count: 3, withheldIdentityCount: 0 });
    expect(result.sections[section].entries).toHaveLength(3);
    expect(result.sections[section].entries.filter((entry) => entry.entrySha256 === fingerprint("entry", section, original))).toHaveLength(2);
    expect(result.sections[section].entries.filter((entry) => entry.entrySha256 === fingerprint("entry", section, drift))).toHaveLength(1);
    expect(fingerprintCatalog(catalog({ [section]: [drift, original, original] }), 180003)).toEqual(result);
    expect(fingerprintCatalog(catalog({ [section]: [original, drift] }), 180003)).not.toEqual(result);
  });

  it("does not mutate catalog ordering, values, or inputs used by aggregate hashes", () => {
    const input = catalog({ columns: [withProperties(column, { ordinal: 777 }), column, column], constraints: [constraint] });
    const before = JSON.stringify(input);
    const aggregateBefore = plainSha256(JSON.stringify(input.columns));
    const first = fingerprintCatalog(input, 180003);
    expect(fingerprintCatalog(input, 180003)).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
    expect(plainSha256(JSON.stringify(input.columns))).toBe(aggregateBefore);
  });

  it.each(["null", "[]", "true", "42", '"PRIVATE_PRIMITIVE_CANARY"'])("rejects non-object projection JSON %s", (value) => {
    expect(() => evidence("columns", { ...column, value })).toThrow(expect.objectContaining({ code: "FINGERPRINT_PROJECTION_INVALID" }));
  });

  it("sanitizes malformed known-object JSON errors so parser excerpts cannot expose private text", () => {
    const value = "PRIVATE_MALFORMED_JSON_CANARY";
    let thrown: unknown;
    try { evidence("columns", { ...column, value }); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "FINGERPRINT_PROJECTION_INVALID" });
    expect(String(thrown)).not.toContain("PRIVATE_");
    expect(JSON.stringify(thrown)).not.toContain(value);
  });

  it("does not parse withheld identities or expose their malformed private JSON", () => {
    const entry = { ...column, key: "PRIVATE_UNKNOWN_CANARY", value: "PRIVATE_MALFORMED_JSON_CANARY" };
    expect(fingerprintCatalog(catalog({ columns: [entry] }), 180003).sections.columns)
      .toEqual({ count: 1, withheldIdentityCount: 1, entries: [] });
  });

  it.each(FINGERPRINT_SECTIONS)("rejects more than 5,000 %s entries, even if identities are withheld", (section) => {
    const entry = { ...fixtures[section], key: "PRIVATE_BOUND_CANARY" };
    expect(() => fingerprintCatalog(catalog({ [section]: Array(5_001).fill(entry) }), 180003))
      .toThrow(expect.objectContaining({ code: "FINGERPRINT_LIMIT_EXCEEDED" }));
  });

  it("accepts 5,000 withheld identities without emitting individual fingerprints", () => {
    const entry = { ...column, key: "PRIVATE_BOUND_CANARY" };
    expect(fingerprintCatalog(catalog({ columns: Array(5_000).fill(entry) }), 180003).sections.columns)
      .toEqual({ count: 5_000, withheldIdentityCount: 5_000, entries: [] });
  });

  it("bounds serialized evidence independently of the per-section entry cap", () => {
    const belowBound = fingerprintCatalog(catalog({ columns: Array(2_000).fill(column) }), 180003);
    expect(belowBound.sections.columns.entries).toHaveLength(2_000);
    expect(Buffer.byteLength(JSON.stringify(belowBound), "utf8")).toBeLessThan(4 * 1024 * 1024);
    expect(() => fingerprintCatalog(catalog({ columns: Array(4_000).fill(column) }), 180003))
      .toThrow(expect.objectContaining({ code: "FINGERPRINT_LIMIT_EXCEEDED" }));
  });
});

describe("bounded fingerprint bucket evidence", () => {
  function summary(input: DetailedSchemaCatalog) {
    const result = fingerprintBucketResponse(fingerprintCatalog(input, 180003));
    if (result.mode !== "buckets") throw new Error("Expected bucket summary.");
    return result;
  }

  function detail(input: DetailedSchemaCatalog, section: FingerprintSection, bucket: string) {
    const result = fingerprintBucketResponse(fingerprintCatalog(input, 180003), { section, bucket });
    if (result.mode !== "bucket") throw new Error("Expected bucket detail.");
    return result;
  }

  function bucketFor(section: FingerprintSection, entry: DetailedCatalogEntry): string {
    return (Number.parseInt(fingerprintIdentity(section, entry).slice(0, 2), 16) % 64)
      .toString(16).padStart(2, "0");
  }

  it("emits exactly 64 ordered fixed buckets per section, including empty buckets", () => {
    const result = summary(catalog({ columns: [column] }));
    const labels = Array.from({ length: 64 }, (_, index) => index.toString(16).padStart(2, "0"));
    expect(FINGERPRINT_BUCKET_COUNT).toBe(64);
    expect(result).toMatchObject({ formatVersion: 1, postgresVersionNum: 180003, bucketCount: 64, mode: "buckets" });
    expect(result.disclosurePolicySha256).toBe(fingerprint("disclosure-policy", disclosure));
    expect(Object.keys(result.sections)).toEqual(FINGERPRINT_SECTIONS);
    expect(result).not.toHaveProperty("detail");
    for (const section of FINGERPRINT_SECTIONS) {
      expect(result.sections[section].buckets.map(({ bucket }) => bucket)).toEqual(labels);
      expect(result.sections[section].buckets.reduce((sum, bucket) => sum + bucket.count, 0))
        .toBe(result.sections[section].knownEntryCount);
      for (const bucket of result.sections[section].buckets) {
        if (bucket.count === 0) expect(bucket.sha256).toBe(fingerprint("bucket", section, bucket.bucket, []));
        expect(bucket).not.toHaveProperty("entries");
      }
    }
    // patients.id starts with c2: first byte 194 modulo 64 is bucket 02.
    expect(result.sections.columns.buckets.filter(({ count }) => count > 0)).toEqual([
      expect.objectContaining({ bucket: "02", count: 1 }),
    ]);
    expect(result.sections.columns).toMatchObject({ count: 1, knownEntryCount: 1, withheldIdentityCount: 0, withheldPropertyCount: 0 });
  });

  it.each(FINGERPRINT_SECTIONS)("keeps every %s bucket summary consistent with explicit filtered details", (section) => {
    const original = fixtures[section];
    const input = catalog({ [section]: [original, original] });
    const projected = fingerprintCatalog(input, 180003);
    const result = summary(input);
    for (const bucket of result.sections[section].buckets) {
      const selected = detail(input, section, bucket.bucket);
      expect(selected).toMatchObject({
        formatVersion: 1, postgresVersionNum: 180003, disclosurePolicySha256: result.disclosurePolicySha256,
        mode: "bucket", bucketCount: 64,
        detail: { section, bucket: bucket.bucket, count: bucket.count, sha256: bucket.sha256 },
      });
      expect(selected.detail.entries).toHaveLength(bucket.count);
      expect(selected.detail.sha256).toBe(fingerprint("bucket", section, bucket.bucket, selected.detail.entries));
      expect(selected.detail.entries).toEqual(projected.sections[section].entries.filter((entry) =>
        (Number.parseInt(entry.identitySha256.slice(0, 2), 16) % 64).toString(16).padStart(2, "0") === bucket.bucket));
      for (const sourceSection of FINGERPRINT_SECTIONS) {
        const { buckets: _buckets, ...counts } = result.sections[sourceSection];
        expect(selected.sections[sourceSection]).toEqual(counts);
        expect(selected.sections[sourceSection]).not.toHaveProperty("buckets");
      }
    }
  });

  it("is deterministic across raw input ordering and preserves duplicate and structural-drift entries", () => {
    const changed = withProperties(column, { ordinal: 777 });
    const first = catalog({ columns: [column, changed, column], constraints: [constraint] });
    const reordered = catalog({ columns: [changed, column, column], constraints: [constraint] });
    expect(summary(first)).toEqual(summary(reordered));
    const selected = detail(first, "columns", "02");
    expect(selected).toEqual(detail(reordered, "columns", "02"));
    expect(selected.detail.entries).toHaveLength(3);
    expect(selected.detail.entries.filter((entry) => entry.entrySha256 === fingerprint("entry", "columns", column))).toHaveLength(2);
    expect(selected.detail.entries.filter((entry) => entry.entrySha256 === fingerprint("entry", "columns", changed))).toHaveLength(1);
    const withoutDuplicate = detail(catalog({ columns: [column, changed] }), "columns", "02");
    expect(withoutDuplicate.detail.sha256).not.toBe(selected.detail.sha256);
    expect(withoutDuplicate.detail.count).toBe(2);
    expect(selected.detail.entries.map((entry) => JSON.stringify(entry))).toEqual(
      selected.detail.entries.map((entry) => JSON.stringify(entry)).sort(),
    );
  });

  it.each(FINGERPRINT_SECTIONS)("keeps unknown %s identities out of bucket membership, counts, and digests", (section) => {
    const original = fixtures[section];
    const unknown = { ...original, key: "PRIVATE_BUCKET_IDENTITY_CANARY", value: "PRIVATE_BUCKET_VALUE_CANARY" };
    const safeInput = catalog({ [section]: [original] });
    const mixedInput = catalog({ [section]: [original, unknown, unknown] });
    const before = summary(safeInput);
    const after = summary(mixedInput);
    expect(after.sections[section]).toMatchObject({ count: 3, knownEntryCount: 1, withheldIdentityCount: 2, withheldPropertyCount: 0 });
    expect(after.sections[section].buckets).toEqual(before.sections[section].buckets);
    const selected = detail(mixedInput, section, bucketFor(section, original));
    expect(selected.detail).toEqual(detail(safeInput, section, bucketFor(section, original)).detail);
    expect(selected.sections[section]).toMatchObject({ count: 3, knownEntryCount: 1, withheldIdentityCount: 2 });
    const encoded = JSON.stringify([after, selected]);
    for (const forbidden of [unknown.key, unknown.value, plainSha256(unknown.key),
      fingerprintIdentity(section, unknown), fingerprint("entry", section, unknown)]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(summary(catalog({ [section]: [original, { ...unknown, key: "PRIVATE_RENAMED_BUCKET_CANARY" }, unknown] }))).toEqual(after);
  });

  it.each(FINGERPRINT_SECTIONS)("cannot distinguish changed withheld %s text through bucket hashes", (section) => {
    const field = section === "columns" ? "default" : section === "constraints" ? "definition" : "function";
    const left = withProperties(fixtures[section], { [field]: "PRIVATE_BUCKET_LEFT_CANARY" });
    const right = withProperties(fixtures[section], { [field]: "PRIVATE_BUCKET_RIGHT_CANARY" });
    const leftInput = catalog({ [section]: [left, left] });
    const rightInput = catalog({ [section]: [right, right] });
    const result = summary(leftInput);
    expect(result).toEqual(summary(rightInput));
    expect(result.sections[section]).toMatchObject({ count: 2, knownEntryCount: 2, withheldIdentityCount: 0, withheldPropertyCount: 2 });
    const selected = detail(leftInput, section, bucketFor(section, left));
    expect(selected).toEqual(detail(rightInput, section, bucketFor(section, right)));
    expect(selected.detail.entries).toHaveLength(2);
    for (const entry of selected.detail.entries) {
      expect(entry).toMatchObject({ entrySha256: null, properties: { [field]: "WITHHELD" }, withheldPropertyCount: 1 });
    }
    // Existing whole-section aggregate hashes remain a separate contract and
    // continue to distinguish raw drift without giving it a per-object digest.
    expect(plainSha256(JSON.stringify(leftInput[section]))).not.toBe(plainSha256(JSON.stringify(rightInput[section])));
    const encoded = JSON.stringify([result, selected]);
    expect(encoded).not.toContain("PRIVATE_BUCKET_");
    for (const entry of [left, right]) {
      const value = JSON.parse(entry.value)[field];
      expect(encoded).not.toContain(fingerprint("property", section, field, value));
      expect(encoded).not.toContain(fingerprint("entry", section, entry));
      expect(encoded).not.toContain(fingerprint("bucket", section, bucketFor(section, entry), [entry, entry]));
    }
  });

  it("does not mutate filtered evidence while producing summary or detail", () => {
    const projected = fingerprintCatalog(catalog({ columns: [column, withProperties(column, { ordinal: 777 }), column] }), 180003);
    const before = JSON.stringify(projected);
    fingerprintBucketResponse(projected);
    fingerprintBucketResponse(projected, { section: "columns", bucket: "02" });
    expect(JSON.stringify(projected)).toBe(before);
  });

  it.each(["", "tables", "functions", "Columns", "internaltriggers", "__proto__", "PRIVATE_SECTION_CANARY"])(
    "rejects unsupported section %s with a stable sanitized error", (section) => {
      expect(() => fingerprintBucketResponse(fingerprintCatalog(catalog(), 180003), {
        section: section as FingerprintSection, bucket: "00",
      })).toThrow(expect.objectContaining({ code: "CLI_ARGUMENTS_INVALID", message: "Invalid fingerprint selection." }));
    },
  );

  it.each(["", "0", "000", "3F", "40", "ff", "-1", "0x02", "02 ", " 02", "02\n", "02\r\n", "*", "columns:02", "PRIVATE_BUCKET_CANARY"])(
    "rejects non-canonical bucket %j with a stable sanitized error", (bucket) => {
      expect(() => fingerprintBucketResponse(fingerprintCatalog(catalog(), 180003), {
        section: "columns", bucket,
      })).toThrow(expect.objectContaining({ code: "CLI_ARGUMENTS_INVALID", message: "Invalid fingerprint selection." }));
    },
  );
});
