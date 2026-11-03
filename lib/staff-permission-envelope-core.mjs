/** Inert shared raw boundary, identical for application and plain Node maintenance. */
import { STAFF_PERMISSION_ENVELOPE_FIELDS } from "./staff-permission-markers.mjs";
export function isPlainCapabilityRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    return Reflect.ownKeys(value).every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return typeof key === "string" && descriptor?.enumerable === true && "value" in descriptor;
    });
}
function copyLegacyJson(value, depth = 0) {
    if (depth > 32)
        throw new Error("Nested legacy document");
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (Array.isArray(value)) {
        // JSON arrays must be dense data, not a container for hidden/accessor properties.
        if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
            throw new Error("Invalid legacy array");
        }
        const copy = [];
        for (let i = 0; i < value.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
            if (!descriptor?.enumerable || !("value" in descriptor))
                throw new Error("Invalid legacy array item");
            copy.push(copyLegacyJson(descriptor.value, depth + 1));
        }
        return Object.freeze(copy);
    }
    if (!isPlainCapabilityRecord(value))
        throw new Error("Invalid legacy record");
    const copy = Object.create(null);
    for (const key of Object.keys(value)) {
        if (key === "__proto__" || key === "prototype" || key === "constructor")
            throw new Error("Prototype key");
        copy[key] = copyLegacyJson(Object.getOwnPropertyDescriptor(value, key).value, depth + 1);
    }
    return Object.freeze(copy);
}
export function inspectStaffPermissionEnvelope(raw) {
    try {
        if (raw === null || raw === undefined || raw === "")
            return Object.freeze({ kind: "legacy", value: null });
        if (typeof raw === "string") {
            if (raw.length > 16_384)
                return Object.freeze({ kind: "invalid", reason: "document-too-large" });
            raw = JSON.parse(raw);
            if (raw === null)
                return Object.freeze({ kind: "legacy", value: null });
        }
        if (!isPlainCapabilityRecord(raw))
            return Object.freeze({ kind: "invalid", reason: "invalid-document" });
        const record = raw;
        if (STAFF_PERMISSION_ENVELOPE_FIELDS.some((key) => Object.hasOwn(record, key))) {
            return Object.freeze({ kind: "canonical-candidate", value: raw });
        }
        const value = copyLegacyJson(raw);
        if (JSON.stringify(value).length > 16_384)
            return Object.freeze({ kind: "invalid", reason: "document-too-large" });
        return Object.freeze({ kind: "legacy", value });
    }
    catch {
        return Object.freeze({ kind: "invalid", reason: "invalid-document" });
    }
}
