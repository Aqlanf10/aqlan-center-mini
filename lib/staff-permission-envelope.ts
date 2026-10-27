/** Browser-safe document boundary. No role defaults, owner binding or authorization evaluation. */
import {
  STAFF_CAPABILITIES, STAFF_CAPABILITY_PREREQUISITES, STAFF_CAPABILITY_SCHEMA_VERSION,
  STAFF_RECORD_SCOPES, isStaffCapability, type StaffCapability, type StaffCapabilityDocument,
  type StaffRecordScope,
} from "./staff-capability-catalogue";

export type CapabilityParseResult =
  | { readonly ok: true; readonly value: StaffCapabilityDocument }
  | { readonly ok: false; readonly reason: string };

import { isPlainCapabilityRecord, inspectStaffPermissionEnvelope } from "./staff-permission-envelope-core.mjs";
export { isPlainCapabilityRecord } from "./staff-permission-envelope-core.mjs";
import { STAFF_PERMISSION_ENVELOPE_FIELDS } from "./staff-permission-markers.mjs";
export { STAFF_PERMISSION_ENVELOPE_FIELDS } from "./staff-permission-markers.mjs";
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

/** Shared raw boundary; full canonical validation stays here. */
export function classifyStaffPermissionEnvelope(raw: unknown): StaffPermissionEnvelope {
  const envelope = inspectStaffPermissionEnvelope(raw);
  if (envelope.kind === "canonical-candidate") {
    const parsed = parseStaffCapabilityDocument(envelope.value);
    return Object.freeze(parsed.ok ? {kind:"canonical",value:parsed.value} : {kind:"invalid",reason:parsed.reason});
  }
  return envelope;
}
