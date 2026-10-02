/** Browser-safe document boundary. No role defaults, owner binding or authorization evaluation. */
import {
  STAFF_CAPABILITIES, STAFF_CAPABILITY_PREREQUISITES, STAFF_CAPABILITY_SCHEMA_VERSION,
  STAFF_RECORD_SCOPES, isStaffCapability, type StaffCapability, type StaffCapabilityDocument,
  type StaffRecordScope,
} from "./staff-capability-catalogue";

export type CapabilityParseResult =
  | { readonly ok: true; readonly value: StaffCapabilityDocument }
  | { readonly ok: false; readonly reason: string };

/** Reject non-JSON records, inherited grants, accessors and hidden/symbol fields. */
export function isPlainCapabilityRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && descriptor?.enumerable === true && "value" in descriptor;
  });
}

export const STAFF_PERMISSION_ENVELOPE_FIELDS = Object.freeze(["schemaVersion", "revision", "patientScope", "appointmentScope", "grants"] as const);
const fields = STAFF_PERMISSION_ENVELOPE_FIELDS;
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const validScope = (value: unknown): value is StaffRecordScope =>
  typeof value === "string" && (STAFF_RECORD_SCOPES as readonly string[]).includes(value);

/** Strict future document only. NEVER invokes the permissive legacy parser. */
export function parseStaffCapabilityDocument(raw: unknown): CapabilityParseResult {
  try {
    if (typeof raw === "string") {
      if (raw.length > 16_384) return { ok: false, reason: "document-too-large" };
      raw = JSON.parse(raw);
    }
    if (!isPlainCapabilityRecord(raw)) return { ok: false, reason: "invalid-document" };
    const record = raw;
    if (Object.keys(record).length !== fields.length || fields.some((key) => !Object.hasOwn(record, key))) {
      return { ok: false, reason: "unknown-or-missing-field" };
    }
    if (raw.schemaVersion !== STAFF_CAPABILITY_SCHEMA_VERSION) return { ok: false, reason: "unsupported-schema" };
    if (!validId(raw.revision)) return { ok: false, reason: "invalid-revision" };
    if (!validScope(raw.patientScope) || !validScope(raw.appointmentScope)) return { ok: false, reason: "invalid-scope" };
    if (!isPlainCapabilityRecord(raw.grants)) return { ok: false, reason: "invalid-grants" };
    const grants: Partial<Record<StaffCapability, true>> = {};
    for (const [key, value] of Object.entries(raw.grants)) {
      if (!isStaffCapability(key) || typeof value !== "boolean") return { ok: false, reason: "unknown-or-invalid-grant" };
      if (value) grants[key] = true;
    }
    for (const key of STAFF_CAPABILITIES) {
      if (grants[key] && STAFF_CAPABILITY_PREREQUISITES[key]?.some((required) => !grants[required])) {
        return { ok: false, reason: "missing-prerequisite" };
      }
    }
    return { ok: true, value: Object.freeze({
      schemaVersion: STAFF_CAPABILITY_SCHEMA_VERSION, revision: raw.revision,
      patientScope: raw.patientScope, appointmentScope: raw.appointmentScope,
      grants: Object.freeze(grants),
    }) };
  } catch { return { ok: false, reason: "invalid-document" }; }
}

type LegacyJsonValue = null | boolean | number | string | readonly LegacyJsonValue[] | LegacyPermissionRecord;
interface LegacyPermissionRecord { readonly [key: string]: LegacyJsonValue }
export type StaffPermissionEnvelope =
  | { readonly kind: "legacy"; readonly value: LegacyPermissionRecord | null }
  | { readonly kind: "canonical"; readonly value: StaffCapabilityDocument }
  | { readonly kind: "invalid"; readonly reason: string };

/** Copy JSON data without invoking accessors/toJSON or retaining mutable caller objects. */
function copyLegacyJson(value: unknown, depth = 0): LegacyJsonValue {
  if (depth > 32) throw new Error("Nested legacy document");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    // JSON arrays must be dense data, not a container for hidden/accessor properties.
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
      throw new Error("Invalid legacy array");
    }
    const copy: LegacyJsonValue[] = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Invalid legacy array item");
      copy.push(copyLegacyJson(descriptor.value, depth + 1));
    }
    return Object.freeze(copy);
  }
  if (!isPlainCapabilityRecord(value)) throw new Error("Invalid legacy record");
  const copy: Record<string, LegacyJsonValue> = Object.create(null);
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error("Prototype key");
    copy[key] = copyLegacyJson(Object.getOwnPropertyDescriptor(value, key)!.value, depth + 1);
  }
  return Object.freeze(copy);
}

/**
 * Inert, strict raw envelope classification, BEFORE any legacy role defaults.
 * SQL NULL, absent storage, the empty string and JSON null mean legacy defaults.
 * Other scalars/malformed JSON fail closed. Every reserved top-level marker selects
 * the existing canonical parser; partial, mixed and future documents cannot fall back.
 * Legacy flag semantics remain exclusively in parseDoctorPermissions/financeAccessFor.
 */
export function classifyStaffPermissionEnvelope(raw: unknown): StaffPermissionEnvelope {
  try {
    if (raw === null || raw === undefined || raw === "") return Object.freeze({ kind: "legacy", value: null });
    if (typeof raw === "string") {
      if (raw.length > 16_384) return Object.freeze({ kind: "invalid", reason: "document-too-large" });
      raw = JSON.parse(raw);
      if (raw === null) return Object.freeze({ kind: "legacy", value: null });
    }
    if (!isPlainCapabilityRecord(raw)) return Object.freeze({ kind: "invalid", reason: "invalid-document" });
    const record = raw;
    if (STAFF_PERMISSION_ENVELOPE_FIELDS.some((key) => Object.hasOwn(record, key))) {
      const parsed = parseStaffCapabilityDocument(raw);
      return Object.freeze(parsed.ok
        ? { kind: "canonical", value: parsed.value }
        : { kind: "invalid", reason: parsed.reason });
    }
    const value = copyLegacyJson(raw) as LegacyPermissionRecord;
    if (JSON.stringify(value).length > 16_384) return Object.freeze({ kind: "invalid", reason: "document-too-large" });
    return Object.freeze({ kind: "legacy", value });
  } catch { return Object.freeze({ kind: "invalid", reason: "invalid-document" }); }
}
