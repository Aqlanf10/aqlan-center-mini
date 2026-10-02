import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { classifyStaffPermissionEnvelope, parseStaffCapabilityDocument, STAFF_PERMISSION_ENVELOPE_FIELDS } from "../lib/staff-permission-envelope";
import { parseStaffCapabilityDocument as foundationParser } from "../lib/staff-capabilities";
import { reviewLegacyStaffCapabilities } from "../lib/staff-capabilities-legacy";
import { parseDoctorPermissions } from "../lib/doctor-permissions";
import { ROLES } from "../lib/roles";
import { STAFF_CAPABILITIES, type StaffCapabilityDocument } from "../lib/staff-capability-catalogue";

const profile = (overrides: Partial<StaffCapabilityDocument> = {}): StaffCapabilityDocument => ({
  schemaVersion: 1, revision: 1, patientScope: "none", appointmentScope: "none", grants: {}, ...overrides,
});

describe("raw staff permission envelope classification (inert)", () => {
  it("re-exports the same canonical parser and bundles without server modules", () => {
    expect(foundationParser).toBe(parseStaffCapabilityDocument);
    expect(() => buildSync({
      entryPoints: ["lib/staff-permission-envelope.ts"], bundle: true, write: false, platform: "browser",
    })).not.toThrow();
  });

  it.each([undefined, null, "", "null", " null \n", {}, "{}", Object.create(null)])(
    "preserves the documented empty legacy form %# for every existing role", (raw) => {
      const result = classifyStaffPermissionEnvelope(raw);
      expect(result.kind).toBe("legacy");
      if (result.kind !== "legacy") return;
      for (const role of ROLES) {
        expect(parseDoctorPermissions(result.value, role)).toEqual(parseDoctorPermissions(raw, role));
        expect(reviewLegacyStaffCapabilities(role, raw).ok).toBe(true);
      }
      expect(Object.isFrozen(result)).toBe(true);
    },
  );

  it.each([
    { canAddPatient: false, canEditPlans: true, canViewClinicFinance: true },
    { financialScope: "clinic_and_own", canViewClinicRevenue: false },
    { financeAccess: { collectPayments: false, viewReports: true, viewCommissions: false } },
    { canEditPatient: "ignored", canViewExpenses: 1, harmlessOldMetadata: ["ignored", null, false, 2] },
  ])("retains legacy parser semantics rather than inventing a second flag evaluator %#", (raw) => {
    for (const input of [raw, JSON.stringify(raw)]) {
      const result = classifyStaffPermissionEnvelope(input);
      expect(result.kind).toBe("legacy");
      if (result.kind !== "legacy") continue;
      for (const role of ROLES) expect(parseDoctorPermissions(result.value, role)).toEqual(parseDoctorPermissions(input, role));
    }
  });

  it("detaches and freezes nested legacy data without changing the caller", () => {
    const raw = { financeAccess: { collectPayments: false }, oldMetadata: ["safe"] };
    const result = classifyStaffPermissionEnvelope(raw);
    expect(result.kind).toBe("legacy");
    raw.financeAccess.collectPayments = true;
    raw.oldMetadata.push("later");
    if (result.kind !== "legacy" || result.value === null) return;
    expect(result.value.financeAccess).toEqual({ collectPayments: false });
    expect(result.value.oldMetadata).toEqual(["safe"]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.financeAccess)).toBe(true);
    expect(Object.isFrozen(result.value.oldMetadata)).toBe(true);
    expect(Object.isFrozen(raw)).toBe(false);
  });

  it.each([false, true, 0, 1, NaN, Infinity, 1n, [], ["x"], "false", "0", '""', '"text"', "[]", "{", " ", "undefined"])(
    "does not reinterpret malformed/scalar input as legacy defaults %#", (raw) => {
      expect(classifyStaffPermissionEnvelope(raw).kind).toBe("invalid");
      for (const role of ROLES) expect(reviewLegacyStaffCapabilities(role, raw).ok).toBe(false);
    },
  );

  it("reserves every canonical marker even if null, false or mixed with legacy flags", () => {
    for (const key of STAFF_PERMISSION_ENVELOPE_FIELDS) {
      for (const value of [null, false, undefined, 1, {}]) {
        const mixed = { [key]: value, canAddPatient: true };
        expect(classifyStaffPermissionEnvelope(mixed).kind).toBe("invalid");
        // JSON may omit undefined, so that transport is a genuinely different legacy document.
        if (value !== undefined) expect(classifyStaffPermissionEnvelope(JSON.stringify(mixed)).kind).toBe("invalid");
      }
    }
  });

  it("accepts canonical only through the strict parser and never the legacy review", () => {
    const raw = profile({ grants: Object.fromEntries(STAFF_CAPABILITIES.map((key) => [key, true])) });
    for (const input of [raw, JSON.stringify(raw)]) {
      const result = classifyStaffPermissionEnvelope(input);
      expect(result.kind).toBe("canonical");
      if (result.kind === "canonical") expect(result.value).toEqual(parseStaffCapabilityDocument(input).ok && raw);
      for (const role of ROLES) expect(reviewLegacyStaffCapabilities(role, input).ok).toBe(false);
    }
    const result = classifyStaffPermissionEnvelope(profile({ grants: { "staff.view": true, "audit.view": false } }));
    if (result.kind !== "canonical") throw new Error("Expected canonical classification");
    expect(result.value.grants).toEqual({ "staff.view": true });
    expect(Object.isFrozen(result.value.grants)).toBe(true);
  });

  it.each([
    profile({ schemaVersion: 2 as 1 }), { ...profile(), canAddPatient: true },
    { ...profile(), isOwner: true }, profile({ revision: 0 }), profile({ revision: 1.5 }),
    profile({ revision: Number.MAX_SAFE_INTEGER + 1 }), profile({ patientScope: "today" as "none" }),
    profile({ grants: { "staff.permissions.edit": true } }), profile({ grants: { unknown: true } as never }),
    { ...profile(), grants: { "staff.view": "true" } },
  ])("keeps malformed, mixed and unsupported canonical profiles invalid %#", (raw) => {
    expect(classifyStaffPermissionEnvelope(raw).kind).toBe("invalid");
    expect(classifyStaffPermissionEnvelope(JSON.stringify(raw)).kind).toBe("invalid");
  });

  it("rejects each missing canonical field", () => {
    for (const field of STAFF_PERMISSION_ENVELOPE_FIELDS) {
      const raw: Record<string, unknown> = { ...profile() };
      delete raw[field];
      expect(classifyStaffPermissionEnvelope(raw).kind).toBe("invalid");
    }
  });

  it("rejects prototype/accessor/hidden/symbol payloads at every consumed level", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "canAddPatient", { enumerable: true, get() { getterCalls++; return true; } });
    const hidden = Object.defineProperty({}, "canAddPatient", { value: true });
    const symbol = { [Symbol("grant")]: true };
    const inherited = Object.create({ canAddPatient: true });
    const custom = new (class { canAddPatient = true; })();
    const toJson = { toJSON() { getterCalls++; return {}; } };
    const cyclic: Record<string, unknown> = {}; cyclic.loop = cyclic;
    for (const invalid of [accessor, hidden, symbol, inherited, custom, toJson, cyclic, new Date(), /x/, new Map(), new Set()]) {
      for (const raw of [invalid, { financeAccess: invalid }, { oldMetadata: [invalid] }, profile({ grants: invalid })]) {
        expect(classifyStaffPermissionEnvelope(raw).kind).toBe("invalid");
      }
    }
    expect(getterCalls).toBe(0);
    for (const key of ["__proto__", "constructor", "prototype"]) {
      for (const raw of [JSON.parse(`{"${key}":{}}`), { financeAccess: JSON.parse(`{"${key}":{}}`) }]) {
        expect(classifyStaffPermissionEnvelope(raw).kind).toBe("invalid");
      }
    }
    expect(Object.hasOwn({}, "canAddPatient")).toBe(false);
  });

  it("rejects non-JSON nested values and non-data arrays", () => {
    const sparse = Array(1);
    const getter = Object.defineProperty([false], "0", { get() { throw new Error("do not run"); } });
    const extra = Object.assign([], { grants: true });
    const hidden = Object.defineProperty([], "secret", { value: true });
    const inherited: unknown[] = []; Object.setPrototypeOf(inherited, { grants: true });
    for (const value of [undefined, NaN, Infinity, 1n, Symbol("x"), () => true, sparse, getter, extra, hidden, inherited]) {
      expect(classifyStaffPermissionEnvelope({ financeAccess: value }).kind).toBe("invalid");
    }
  });

  it("bounds text/object size and handles hostile/revoked objects without throwing", () => {
    expect(classifyStaffPermissionEnvelope(" ".repeat(16_385))).toEqual({ kind: "invalid", reason: "document-too-large" });
    expect(classifyStaffPermissionEnvelope({ oldMetadata: "x".repeat(16_385) })).toEqual({ kind: "invalid", reason: "document-too-large" });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const throwing = new Proxy({}, { ownKeys() { throw new Error("do not expose"); } });
    for (const raw of [revoked.proxy, throwing]) expect(classifyStaffPermissionEnvelope(raw)).toEqual({ kind: "invalid", reason: "invalid-document" });
  });
});
