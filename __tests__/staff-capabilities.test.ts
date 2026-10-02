import { describe, expect, it } from "vitest";
import {
  appointmentCapabilityConstraint, canPerformOwnerOperation, hasStaffCapability,
  ownerContextFromTrustedBinding, parseStaffCapabilityDocument, patientCapabilityConstraint,
  resolveStaffCapabilities, staffAuthorizationFingerprint, validateStaffCapabilityChange,
  validateStaffMaintenance, type ResolvedStaffAccess, type StaffSubject, type TrustedOwnerContext,
} from "../lib/staff-capabilities";
import { STAFF_CAPABILITIES, OWNER_ONLY_OPERATIONS, type StaffCapabilityDocument } from "../lib/staff-capability-catalogue";
import { reviewLegacyStaffCapabilities } from "../lib/staff-capabilities-legacy";

const document = (overrides: Partial<StaffCapabilityDocument> = {}): StaffCapabilityDocument => ({
  schemaVersion: 1, revision: 1, patientScope: "none", appointmentScope: "none", grants: {}, ...overrides,
});
const subject = (overrides: Partial<StaffSubject> = {}): StaffSubject => ({
  userId: 10, role: "admin", isActive: true, clinicianPartyId: null, ...overrides,
});
const resolve = (profile: unknown = document(), identity = subject(), owner: TrustedOwnerContext | null = null) =>
  resolveStaffCapabilities({ subject: identity, permissionDocument: profile }, owner);

describe("strict, inert scoped staff capability documents", () => {
  it("denies every missing or unknown capability, including legacy admin", () => {
    const access = resolve();
    expect(access.status).toBe("allowed");
    for (const capability of STAFF_CAPABILITIES) expect(hasStaffCapability(access, capability)).toBe(false);
    for (const capability of ["*", "owner", "toString", "admin", "__proto__", "future.ai", null, 1]) {
      expect(hasStaffCapability(access, capability)).toBe(false);
    }
    for (const operation of OWNER_ONLY_OPERATIONS) expect(canPerformOwnerOperation(access, operation)).toBe(false);
    expect(patientCapabilityConstraint(access)).toEqual({ kind: "none" });
  });

  it.each([
    null, undefined, false, 1, [], "{", "null", "[]", {},
    { ...document(), schemaVersion: 0 }, { ...document(), schemaVersion: 2 }, { ...document(), schemaVersion: "1" },
    { ...document(), revision: 0 }, { ...document(), revision: -1 }, { ...document(), revision: 1.5 },
    { ...document(), revision: Number.MAX_SAFE_INTEGER + 1 }, { ...document(), revision: "1" },
    { ...document(), patientScope: "everyone" }, { ...document(), appointmentScope: "today" },
    { ...document(), grants: [] }, { ...document(), grants: { "finance.payments.collect": 1 } },
    { ...document(), grants: { "finance.payments.collect": "false" } },
    { ...document(), grants: { unknown: false } }, { ...document(), grants: { "*": true } },
    { ...document(), owner: true }, { ...document(), role: "owner" }, { ...document(), ownerUserId: 10 },
    { ...document(), grants: { "staff.credentials.reset": true } },
    { ...document(), grants: { "finance.payments.refund": true } },
    { ...document(), grants: { "staff.permissions.edit": true } },
  ])("fails closed without any admin fallback for malformed input %#", (raw) => {
    const access = resolveStaffCapabilities({ subject: subject(), permissionDocument: raw });
    expect(access.status).toBe("denied");
    for (const capability of STAFF_CAPABILITIES) expect(hasStaffCapability(access, capability)).toBe(false);
    expect(staffAuthorizationFingerprint(access)).toBeNull();
  });

  it("rejects missing fields, inherited grants, accessors, hidden and symbol keys", () => {
    for (const key of ["schemaVersion", "revision", "patientScope", "appointmentScope", "grants"]) {
      const raw = { ...document() } as Record<string, unknown>;
      delete raw[key];
      expect(parseStaffCapabilityDocument(raw).ok).toBe(false);
    }
    const getter = Object.defineProperty({}, "staff.view", { enumerable: true, get() { throw new Error("must not run"); } });
    const hidden = Object.defineProperty({}, "staff.view", { value: true });
    for (const grants of [Object.create({ "staff.view": true }), getter, hidden, { [Symbol("owner")]: true }]) {
      expect(parseStaffCapabilityDocument({ ...document(), grants }).ok).toBe(false);
    }
    expect(parseStaffCapabilityDocument(" ".repeat(16_385)).ok).toBe(false);
    expect(parseStaffCapabilityDocument(JSON.parse('{"schemaVersion":1,"revision":1,"patientScope":"none","appointmentScope":"none","grants":{"__proto__":true}}')).ok).toBe(false);
  });

  it("detaches and freezes parsed grants; explicit false and absence both deny", () => {
    const raw = document({ grants: { "staff.view": true, "audit.view": false } });
    const access = resolve(raw);
    (raw.grants as Record<string, boolean>)["audit.view"] = true;
    expect(hasStaffCapability(access, "audit.view")).toBe(false);
    const parsed = parseStaffCapabilityDocument(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.isFrozen(parsed.value.grants)).toBe(true);
    expect(hasStaffCapability(JSON.parse(JSON.stringify(access)), "staff.view")).toBe(false);
  });

  it.each(["owner", "manager", "ADMIN", "", "unknown"])("unknown persisted role %s denies even an otherwise valid profile", (role) => {
    expect(resolve(document({ grants: { "staff.view": true } }), subject({ role })).status).toBe("denied");
  });
  it.each([
    { userId: 0 }, { userId: NaN }, { userId: 1.1 }, { isActive: false }, { clinicianPartyId: -1 }, { clinicianPartyId: 0 },
  ])("invalid/inactive authoritative identity fails closed %#", (identity) => {
    expect(resolve(document(), subject(identity)).status).toBe("denied");
  });

  it("operational settings and export flags never confer finance/security or source reads", () => {
    const access = resolve(document({ grants: { "settings.view": true, "settings.operational.edit": true, "reports.export": true } }));
    expect(hasStaffCapability(access, "settings.finance.edit")).toBe(false);
    expect(canPerformOwnerOperation(access, "settings.security.change")).toBe(false);
    expect(canPerformOwnerOperation(access, "settings.integrations.change")).toBe(false);
    expect(hasStaffCapability(access, "reports.financial.view")).toBe(false);
  });
  it("requires separate read/write, refund/cancel, report/export, price and rate grants", () => {
    const access = resolve(document({ grants: {
      "finance.payments.view": true, "finance.payments.collect": true, "finance.invoices.view": true,
      "finance.service-prices.view": true, "finance.commissions.view-all": true, "reports.financial.view": true,
    } }));
    for (const capability of ["finance.payments.refund", "finance.payments.void", "finance.invoices.cancel",
      "finance.invoices.mark-paid", "finance.service-prices.edit", "finance.discounts.apply",
      "finance.commissions.manage-rates", "reports.export", "finance.export"]) {
      expect(hasStaffCapability(access, capability)).toBe(false);
    }
  });
});

describe("trusted owner identity and clinician separation", () => {
  const owner = ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "test-binding-1" });
  it("no admin, JSON, username, first user or structural context spoof becomes owner", () => {
    for (const userId of [1, 10]) expect(resolve(document(), subject({ userId }), owner).isOwner).toBe(false);
    expect(resolve(document(), subject({ userId: 99 }), {} as TrustedOwnerContext).status).toBe("denied");
    expect(resolve({ ...document(), username: "owner" }, subject({ userId: 99 }), owner).status).toBe("denied");
    expect(resolve(document(), subject({ userId: 99 })).isOwner).toBe(false);
    const forged = { status: "allowed", userId: 99, isOwner: true } as ResolvedStaffAccess;
    expect(canPerformOwnerOperation(forged, "staff.role.change")).toBe(false);
    expect(staffAuthorizationFingerprint(forged)).toBeNull();
  });
  it("copies trusted binding and subject snapshots so later mutation cannot alter authority", () => {
    const binding = { ownerUserId: 99, bindingVersion: "original" };
    const context = ownerContextFromTrustedBinding(binding);
    binding.ownerUserId = 10;
    const identity = { ...subject({ userId: 99, clinicianPartyId: 7 }) };
    const access = resolve(document(), identity, context);
    const fingerprint = staffAuthorizationFingerprint(access);
    identity.userId = 10;
    identity.clinicianPartyId = 12;
    expect(access.isOwner).toBe(true);
    expect(access.userId).toBe(99);
    expect(access.clinicianPartyId).toBe(7);
    expect(staffAuthorizationFingerprint(access)).toBe(fingerprint);
    expect(resolve(document(), subject({ userId: 10 }), context).isOwner).toBe(false);
    expect(() => ownerContextFromTrustedBinding({ ownerUserId: 0, bindingVersion: "bad" })).toThrow();
    expect(() => ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "" })).toThrow();
  });
  it("recognizes only the externally bound immutable ID and known owner-only operations", () => {
    const access = resolve(document(), subject({ userId: 99, role: "reception" }), owner);
    expect(access.isOwner).toBe(true);
    expect(canPerformOwnerOperation(access, "staff.role.change")).toBe(true);
    expect(canPerformOwnerOperation(access, "owner.transfer")).toBe(false);
    expect(hasStaffCapability(access, "staff.permissions.edit")).toBe(true);
    expect(resolve({ ...document(), schemaVersion: 2 }, subject({ userId: 99 }), owner).status).toBe("denied");
    expect(resolve(document(), subject({ userId: 99, role: "owner" }), owner).status).toBe("denied");
    expect(resolve(document(), subject({ userId: 99, isActive: false }), owner).status).toBe("denied");
  });
  it("administrative grants never infer, overwrite or erase users.party_id", () => {
    const profile = document({ patientScope: "own", appointmentScope: "own", grants: {
      "staff.view": true, "staff.profile.edit": true, "finance.commissions.view-own": true, "patients.edit": true,
    } });
    const unlinked = resolve(profile, subject({ role: "doctor" }));
    expect(unlinked.clinicianPartyId).toBeNull();
    expect(patientCapabilityConstraint(unlinked)).toEqual({ kind: "none" });
    expect(appointmentCapabilityConstraint(unlinked)).toEqual({ kind: "none" });
    expect(hasStaffCapability(unlinked, "finance.commissions.view-own")).toBe(false);
    const linked = resolve(profile, subject({ role: "doctor", clinicianPartyId: 7 }));
    expect(linked.clinicianPartyId).toBe(7);
    expect(patientCapabilityConstraint(linked, "edit")).toEqual({ kind: "own", clinicianPartyId: 7 });
    expect(hasStaffCapability(linked, "staff.profile.edit")).toBe(true);
    expect(hasStaffCapability(linked, "finance.commissions.view-own")).toBe(true);
    const ownerAccess = resolve(document(), subject({ userId: 99 }), owner);
    expect(ownerAccess.clinicianPartyId).toBeNull();
    expect(hasStaffCapability(ownerAccess, "finance.commissions.view-own")).toBe(false);
  });
  it("an action grant cannot turn a none record scope into access", () => {
    const access = resolve(document({ grants: { "patients.edit": true, "patients.delete": true, "appointments.edit": true } }));
    expect(patientCapabilityConstraint(access, "edit")).toEqual({ kind: "none" });
    expect(patientCapabilityConstraint(access, "delete")).toEqual({ kind: "none" });
    expect(appointmentCapabilityConstraint(access, "edit")).toEqual({ kind: "none" });
  });
  it("all-patient/appointment viewing does not imply edit/delete/booking", () => {
    const access = resolve(document({ patientScope: "all", appointmentScope: "all" }));
    expect(patientCapabilityConstraint(access)).toEqual({ kind: "all" });
    expect(patientCapabilityConstraint(access, "edit")).toEqual({ kind: "none" });
    expect(patientCapabilityConstraint(access, "delete")).toEqual({ kind: "none" });
    expect(appointmentCapabilityConstraint(access, "create")).toEqual({ kind: "none" });
  });
});

describe("safe scoped delegation and maintenance preflight", () => {
  const ownerContext = ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "test-1" });
  const owner = resolve(document(), subject({ userId: 99 }), ownerContext);
  const managerDocument = document({ grants: {
    "staff.view": true, "staff.permissions.edit": true, "staff.profile.edit": true, "staff.accounts.disable": true,
    "finance.payments.view": true,
  } });
  const manager = resolve(managerDocument, subject({ userId: 10 }), ownerContext);
  const target = resolve(document(), subject({ userId: 20, role: "reception" }), ownerContext);
  const validate = (nextDocument: unknown, actor = manager, recipient = target, expectedRevision = 1) =>
    validateStaffCapabilityChange({ actor, target: recipient, expectedRevision, nextDocument });

  it("allows only bounded subset delegation with the exact next revision", () => {
    expect(validate(document({ revision: 2, grants: { "finance.payments.view": true } }))).toEqual({ ok: true });
    expect(validate(document({ revision: 2, grants: { "finance.payments.collect": true } }))).toEqual({ ok: false, reason: "outside-delegable-authority" });
    expect(validate(document({ revision: 2, grants: { "staff.view": true, "staff.permissions.edit": true } }))).toEqual({ ok: false, reason: "outside-delegable-authority" });
    expect(validate(document({ revision: 2 }), manager, target, 0)).toEqual({ ok: false, reason: "stale-revision" });
    for (const revision of [1, 3]) expect(validate(document({ revision })).ok).toBe(false);
  });
  it("denies self-escalation, owner edits, higher-authority targets and mixed owner contexts", () => {
    expect(validate(document({ revision: 2 }), manager, manager)).toEqual({ ok: false, reason: "self-permission-change" });
    expect(validate(document({ revision: 2 }), owner, owner).ok).toBe(false);
    expect(validate(document({ revision: 2 }), manager, owner)).toEqual({ ok: false, reason: "protected-owner" });
    const stronger = resolve(document({ grants: { "finance.payments.collect": true } }), subject({ userId: 30 }), ownerContext);
    expect(validate(document({ revision: 2 }), manager, stronger).ok).toBe(false);
    expect(validate(document({ revision: 2 }), manager, resolve(document(), subject({ userId: 20 })))).toEqual({ ok: false, reason: "owner-context-missing" });
  });
  it.each([
    ["both missing", null, null, "owner-context-missing"],
    ["actor missing", null, ownerContext, "owner-context-missing"],
    ["target missing", ownerContext, null, "owner-context-missing"],
    ["different owner ID", ownerContext, ownerContextFromTrustedBinding({ ownerUserId: 100, bindingVersion: "test-1" }), "owner-context-mismatch"],
    ["different binding version", ownerContext, ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "test-2" }), "owner-context-mismatch"],
  ] as const)("denies all staff mutation preflights when trusted binding is %s", (_label, actorBinding, targetBinding, reason) => {
    const actor = resolve(managerDocument, subject({ userId: 10 }), actorBinding);
    const recipient = resolve(document(), subject({ userId: 20 }), targetBinding);
    expect(validate(document({ revision: 2 }), actor, recipient)).toEqual({ ok: false, reason });
    expect(validateStaffMaintenance(actor, recipient, "accounts.disable")).toEqual({ ok: false, reason });
    expect(validateStaffMaintenance(actor, recipient, "profile.edit")).toEqual({ ok: false, reason });
  });
  it("cannot mutate the actual owner user 99 by omitting both trusted contexts", () => {
    const actor = resolve(managerDocument, subject({ userId: 10 }));
    const unrecognizedOwner = resolve(document(), subject({ userId: 99 }));
    expect(unrecognizedOwner.isOwner).toBe(false);
    expect(resolve(document(), subject({ userId: 99 }), ownerContext).isOwner).toBe(true);
    expect(validate(document({ revision: 2 }), actor, unrecognizedOwner)).toEqual({ ok: false, reason: "owner-context-missing" });
    expect(validateStaffMaintenance(actor, unrecognizedOwner, "accounts.disable")).toEqual({ ok: false, reason: "owner-context-missing" });
    expect(validateStaffMaintenance(actor, unrecognizedOwner, "profile.edit")).toEqual({ ok: false, reason: "owner-context-missing" });
  });
  it("allows ordinary read resolution without a binding, but not staff mutation authority", () => {
    const reader = resolve(document({ grants: { "audit.view": true } }));
    expect(reader.status).toBe("allowed");
    expect(hasStaffCapability(reader, "audit.view")).toBe(true);
    expect(reader.isOwner).toBe(false);
  });
  it("accepts separately constructed trusted snapshots of the same immutable binding", () => {
    const sameBinding = ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "test-1" });
    const sameTarget = resolve(document(), subject({ userId: 20 }), sameBinding);
    expect(validate(document({ revision: 2 }), manager, sameTarget)).toEqual({ ok: true });
    expect(validateStaffMaintenance(manager, sameTarget, "accounts.disable")).toEqual({ ok: true });
    expect(validateStaffMaintenance(manager, sameTarget, "profile.edit")).toEqual({ ok: true });
  });
  it("owner may grant delegation, but a manager cannot treat another clinician's own scope as a subset", () => {
    expect(validate(document({ revision: 2, grants: { "staff.view": true, "staff.permissions.edit": true } }), owner)).toEqual({ ok: true });
    const ownManager = resolve({ ...managerDocument, patientScope: "own", appointmentScope: "own" }, subject({ clinicianPartyId: 7 }), ownerContext);
    expect(validate(document({ revision: 2, patientScope: "own" }), ownManager).ok).toBe(false);
    expect(validate(document({ revision: 2, appointmentScope: "own" }), ownManager).ok).toBe(false);
    const allManager = resolve({ ...managerDocument, patientScope: "all", appointmentScope: "all" }, subject(), ownerContext);
    expect(validate(document({ revision: 2, patientScope: "own", appointmentScope: "own" }), allManager).ok).toBe(true);
  });
  it("basic staff maintenance grants do not confer permission/credential/role/identity authority", () => {
    expect(validateStaffMaintenance(manager, target, "profile.edit")).toEqual({ ok: true });
    expect(validateStaffMaintenance(manager, target, "accounts.disable")).toEqual({ ok: true });
    expect(validateStaffMaintenance(manager, owner, "accounts.disable").ok).toBe(false);
    expect(validateStaffMaintenance(manager, manager, "profile.edit").ok).toBe(false);
    expect(validateStaffMaintenance(manager, target, "credentials.reset" as "profile.edit").ok).toBe(false);
    expect(canPerformOwnerOperation(manager, "staff.credentials.reset")).toBe(false);
    const basic = resolve(document({ grants: { "staff.view": true, "staff.profile.edit": true } }), subject(), ownerContext);
    expect(validate(document({ revision: 2 }), basic).ok).toBe(false);
  });
});

describe("future revocation fingerprint", () => {
  const fp = (profile: unknown = document(), identity = subject(), owner: TrustedOwnerContext | null = null) => staffAuthorizationFingerprint(resolve(profile, identity, owner));
  it("is canonical across JSON key order/explicit false, but changes for every authority dimension", () => {
    expect(fp(document({ grants: { "audit.view": false, "staff.view": true } })))
      .toBe(fp(JSON.stringify({ grants: { "staff.view": true }, appointmentScope: "none", patientScope: "none", revision: 1, schemaVersion: 1 })));
    const original = fp();
    expect(original).toMatch(/^staff-v1:[a-f0-9]{64}$/);
    for (const updated of [document({ revision: 2 }), document({ patientScope: "all" }), document({ appointmentScope: "all" }), document({ grants: { "audit.view": true } })]) {
      expect(fp(updated)).not.toBe(original);
    }
    for (const identity of [subject({ userId: 11 }), subject({ role: "doctor" }), subject({ clinicianPartyId: 7 })]) expect(fp(document(), identity)).not.toBe(original);
    expect(fp(document(), subject({ isActive: false }))).toBeNull();
    const owner1 = ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "v1" });
    const owner2 = ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "v2" });
    const owner3 = ownerContextFromTrustedBinding({ ownerUserId: 100, bindingVersion: "v1" });
    expect(fp(document(), subject(), owner1)).not.toBe(original);
    expect(fp(document(), subject(), owner1)).not.toBe(fp(document(), subject(), owner2));
    expect(fp(document(), subject(), owner1)).not.toBe(fp(document(), subject(), owner3));
  });
});

describe("explicit legacy review adapter, never an authorization fallback", () => {
  it("rejects unknown roles, malformed legacy and every versioned attempt", () => {
    for (const role of ["owner", "manager", "unknown", undefined]) expect(reviewLegacyStaffCapabilities(role, null).ok).toBe(false);
    for (const raw of ["{", [], document(), { schemaVersion: 999 }, { schemaVersion: null }, { grants: {} }]) {
      expect(reviewLegacyStaffCapabilities("admin", raw).ok).toBe(false);
    }
  });
  it("reports actual admin/reception bypasses without inventing owner identity", () => {
    for (const role of ["admin", "reception"] as const) {
      const result = reviewLegacyStaffCapabilities(role, { canAddPatient: false, canEditPatient: false, canViewAllPatients: false });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.owner).toBe(false);
      expect(result.value.patientRead).toBe("all");
      expect(result.value.observedCapabilities["patients.edit"]).toBe(true);
      expect(result.value.requiresMigrationReview).toBe(true);
      expect(resolve(result.value).status).toBe("denied");
    }
  });
  it("labels legacy profit flags separately from PR191 composite response authorization", () => {
    const result = reviewLegacyStaffCapabilities("doctor", { canViewClinicProfits: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.observedCapabilities["finance.profits.view"]).toBe(true);
    expect(result.value.observedCapabilities["finance.revenue.view"]).toBeUndefined();
    expect(result.value.observedCapabilities["finance.expenses.view"]).toBeUndefined();
    expect(result.value.blockers.some((entry) => entry.includes("revenue + expenses + profit"))).toBe(true);
  });
  it("preserves restricted finance-role boundaries despite malicious legacy toggles", () => {
    const cashier = reviewLegacyStaffCapabilities("cashier", { financeAccess: { collectPayments: false, viewReports: true, viewCommissions: true } });
    const accountant = reviewLegacyStaffCapabilities("accountant", { financeAccess: { collectPayments: true, createExpenses: true, operateShift: true } });
    expect(cashier.ok && cashier.value.observedCapabilities["finance.payments.collect"]).toBeUndefined();
    expect(cashier.ok && cashier.value.observedCapabilities["reports.financial.view"]).toBeUndefined();
    expect(cashier.ok && cashier.value.observedCapabilities["finance.service-prices.view"]).toBeUndefined();
    expect(accountant.ok && accountant.value.observedCapabilities["finance.payments.collect"]).toBeUndefined();
    expect(accountant.ok && accountant.value.patientRead).toBe("none");
  });
  it("reports doctor all-read/own-edit, admin-only deletion and assistant today-only limitations", () => {
    const doctor = reviewLegacyStaffCapabilities("doctor", { canViewAllPatients: true, canDeletePatient: true, canManageUsers: true, canManageRates: true });
    expect(doctor.ok).toBe(true);
    if (doctor.ok) {
      expect(doctor.value.patientRead).toBe("all");
      expect(doctor.value.patientEdit).toBe("own");
      expect(doctor.value.patientDelete).toBe("none");
      expect(doctor.value.observedCapabilities["staff.permissions.edit"]).toBeUndefined();
      expect(doctor.value.observedCapabilities["finance.commissions.manage-rates"]).toBeUndefined();
    }
    const assistant = reviewLegacyStaffCapabilities("assistant", null);
    expect(assistant.ok && assistant.value.patientRead).toBe("today");
  });
});
