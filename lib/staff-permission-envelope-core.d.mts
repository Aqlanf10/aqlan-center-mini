type LegacyJsonValue = null | boolean | number | string | readonly LegacyJsonValue[] | LegacyPermissionRecord;
interface LegacyPermissionRecord { readonly [key: string]: LegacyJsonValue }
export function isPlainCapabilityRecord(value: unknown): value is Record<string, unknown>;
export function inspectStaffPermissionEnvelope(raw: unknown):
 | {readonly kind:"legacy";readonly value:LegacyPermissionRecord|null}
 | {readonly kind:"canonical-candidate";readonly value:unknown}
 | {readonly kind:"invalid";readonly reason:string};
