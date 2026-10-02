import { createHash } from "node:crypto";
import { isRole, type Role } from "./roles";
import {
  OWNER_ONLY_OPERATIONS, STAFF_AUTHORIZATION_POLICY_VERSION, STAFF_CAPABILITIES,
  STAFF_CAPABILITY_PREREQUISITES, STAFF_CAPABILITY_SCHEMA_VERSION, STAFF_RECORD_SCOPES,
  isStaffCapability, type OwnerOnlyOperation, type StaffCapability, type StaffCapabilityDocument,
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

const fields = ["schemaVersion", "revision", "patientScope", "appointmentScope", "grants"];
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

export interface StaffSubject {
  /** Immutable users.id from an authenticated, freshly loaded server row. */
  readonly userId: number;
  readonly role: string;
  readonly isActive: boolean;
  /** Existing users.party_id, validated separately against an active doctor party. */
  readonly clinicianPartyId: number | null;
}

// Opaque process-local context: copied/serialized JSON is never accepted as trusted authority.
declare const ownerContextBrand: unique symbol;
export interface TrustedOwnerContext { readonly [ownerContextBrand]: true }
interface OwnerBinding { readonly ownerUserId: number; readonly bindingVersion: string }
const ownerBindings = new WeakMap<TrustedOwnerContext, Readonly<OwnerBinding>>();

/**
 * Trust boundary for a FUTURE server bootstrap only. No env/DB/settings lookup, default,
 * first-admin inference, activation or persistence exists here. The caller must source
 * this immutable ID binding outside staff-editable data, under separate authorization.
 */
export function ownerContextFromTrustedBinding(binding: Readonly<OwnerBinding>): TrustedOwnerContext {
  if (!validId(binding.ownerUserId) || typeof binding.bindingVersion !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(binding.bindingVersion)) throw new Error("Invalid trusted owner binding");
  const context = Object.freeze({}) as TrustedOwnerContext;
  ownerBindings.set(context, Object.freeze({ ownerUserId: binding.ownerUserId, bindingVersion: binding.bindingVersion }));
  return context;
}

export interface StaffAccessInput {
  readonly subject: StaffSubject;
  readonly permissionDocument: unknown;
}
export interface ResolvedStaffAccess {
  readonly status: "allowed" | "denied";
  readonly reason: string | null;
  readonly userId: number | null;
  readonly clinicianPartyId: number | null;
  readonly isOwner: boolean;
}
interface AccessState {
  readonly subject: StaffSubject & { readonly role: Role };
  readonly document: StaffCapabilityDocument;
  readonly owner: Readonly<OwnerBinding> | null;
}
const accessStates = new WeakMap<ResolvedStaffAccess, AccessState>();
const deny = (reason: string): ResolvedStaffAccess => Object.freeze({
  status: "denied", reason, userId: null, clinicianPartyId: null, isOwner: false,
});

/** Explicit canonical resolver; an admin role never supplies missing grants or owner identity. */
export function resolveStaffCapabilities(input: StaffAccessInput, ownerContext: TrustedOwnerContext | null = null): ResolvedStaffAccess {
  const subject = input.subject;
  if (!subject || !validId(subject.userId) || subject.isActive !== true || !isRole(subject.role)
    || (subject.clinicianPartyId !== null && !validId(subject.clinicianPartyId))) return deny("invalid-or-inactive-subject");
  const owner = ownerContext === null ? null : ownerBindings.get(ownerContext);
  if (owner === undefined) return deny("untrusted-owner-context");
  const parsed = parseStaffCapabilityDocument(input.permissionDocument);
  if (!parsed.ok) return deny(parsed.reason);
  const access = Object.freeze({
    status: "allowed" as const, reason: null, userId: subject.userId,
    clinicianPartyId: subject.clinicianPartyId, isOwner: owner?.ownerUserId === subject.userId,
  });
  accessStates.set(access, {
    subject: Object.freeze({ userId: subject.userId, role: subject.role, isActive: true, clinicianPartyId: subject.clinicianPartyId }),
    document: parsed.value, owner,
  });
  return access;
}

/** Capability presence is only one gate; resource scopes/projections and business rules remain mandatory. */
export function hasStaffCapability(access: ResolvedStaffAccess, capability: unknown): boolean {
  const state = accessStates.get(access);
  if (!state || !isStaffCapability(capability)) return false;
  // Administrative authority never manufactures a clinical identity.
  if (capability === "finance.commissions.view-own" && state.subject.clinicianPartyId === null) return false;
  return access.isOwner || state.document.grants[capability] === true;
}

export function canPerformOwnerOperation(access: ResolvedStaffAccess, operation: OwnerOnlyOperation | string): boolean {
  return accessStates.has(access) && access.isOwner && (OWNER_ONLY_OPERATIONS as readonly string[]).includes(operation);
}

export type StaffRecordConstraint = Readonly<{ kind: "none" } | { kind: "all" } | { kind: "own"; clinicianPartyId: number }>;
function scopeConstraint(access: ResolvedStaffAccess, kind: "patientScope" | "appointmentScope"): StaffRecordConstraint {
  const state = accessStates.get(access);
  if (!state) return Object.freeze({ kind: "none" });
  const scope = access.isOwner ? "all" : state.document[kind];
  if (scope === "all") return Object.freeze({ kind: "all" });
  if (scope === "own" && state.subject.clinicianPartyId !== null) {
    return Object.freeze({ kind: "own", clinicianPartyId: state.subject.clinicianPartyId });
  }
  return Object.freeze({ kind: "none" });
}
export function patientCapabilityConstraint(access: ResolvedStaffAccess, action: "view" | "edit" | "delete" | "export" = "view"): StaffRecordConstraint {
  if (action !== "view" && !hasStaffCapability(access, `patients.${action}`)) return Object.freeze({ kind: "none" });
  return scopeConstraint(access, "patientScope");
}
export function appointmentCapabilityConstraint(access: ResolvedStaffAccess, action: "view" | "create" | "edit" | "cancel" = "view"): StaffRecordConstraint {
  if (action !== "view" && !hasStaffCapability(access, `appointments.${action}`)) return Object.freeze({ kind: "none" });
  return scopeConstraint(access, "appointmentScope");
}

/**
 * Deterministic revocation material, NOT a signed token or authentication credential.
 * A future server must sign a claim and compare it with a fresh authoritative snapshot
 * on every protected request (including proxy, print/export and mutations).
 */
export function staffAuthorizationFingerprint(access: ResolvedStaffAccess): string | null {
  const state = accessStates.get(access);
  if (!state) return null;
  const { subject, document, owner } = state;
  const material = [STAFF_AUTHORIZATION_POLICY_VERSION, subject.userId, subject.role, subject.isActive,
    subject.clinicianPartyId, owner?.ownerUserId ?? null, owner?.bindingVersion ?? null,
    document.schemaVersion, document.revision, document.patientScope, document.appointmentScope,
    STAFF_CAPABILITIES.filter((key) => document.grants[key] === true)];
  return `staff-v1:${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;
}

export type StaffChangeDecision = { readonly ok: true } | { readonly ok: false; readonly reason: string };
const refused = (reason: string): StaffChangeDecision => ({ ok: false, reason });

/** No delegated administrator may create another delegator or manage a delegator peer. */
function withinDelegableAuthority(actor: ResolvedStaffAccess, candidate: StaffCapabilityDocument): boolean {
  const state = accessStates.get(actor);
  if (!state) return false;
  if (actor.isOwner) return true;
  if (candidate.grants["staff.permissions.edit"]) return false;
  // "Own" refers to each target's patients, not the actor's. It is not a portable subset.
  if (candidate.patientScope !== "none" && state.document.patientScope !== "all") return false;
  if (candidate.appointmentScope !== "none" && state.document.appointmentScope !== "all") return false;
  return STAFF_CAPABILITIES.every((key) => !candidate.grants[key]
    || (key === "finance.commissions.view-own"
      ? hasStaffCapability(actor, "finance.commissions.view-all")
      : hasStaffCapability(actor, key)));
}

/** Missing owner bindings cannot establish that a mutation target is not the owner. */
function validateStaffMutationOwnerContext(actor: AccessState, target: AccessState): StaffChangeDecision {
  if (!actor.owner || !target.owner) return refused("owner-context-missing");
  if (actor.owner.ownerUserId !== target.owner.ownerUserId
    || actor.owner.bindingVersion !== target.owner.bindingVersion) return refused("owner-context-mismatch");
  return { ok: true };
}

/**
 * Pure preflight, not a transaction authorization substitute. Actor/target snapshots
 * must be freshly loaded and rechecked under transaction locks before a future write.
 */
export function validateStaffCapabilityChange(input: {
  readonly actor: ResolvedStaffAccess;
  readonly target: ResolvedStaffAccess;
  readonly expectedRevision: number;
  readonly nextDocument: unknown;
}): StaffChangeDecision {
  const actor = accessStates.get(input.actor);
  const target = accessStates.get(input.target);
  if (!actor || !target) return refused("invalid-access");
  const ownerContext = validateStaffMutationOwnerContext(actor, target);
  if (!ownerContext.ok) return ownerContext;
  if (input.actor.userId === input.target.userId) return refused("self-permission-change");
  if (input.target.isOwner || actor.owner?.ownerUserId === input.target.userId) return refused("protected-owner");
  if (!hasStaffCapability(input.actor, "staff.permissions.edit")) return refused("permission-management-denied");
  if (input.expectedRevision !== target.document.revision) return refused("stale-revision");
  const next = parseStaffCapabilityDocument(input.nextDocument);
  if (!next.ok) return refused(next.reason);
  if (next.value.revision !== target.document.revision + 1) return refused("revision-must-increment");
  if (!withinDelegableAuthority(input.actor, target.document) || !withinDelegableAuthority(input.actor, next.value)) {
    return refused("outside-delegable-authority");
  }
  return { ok: true };
}

/** Delegated basic maintenance is separate from credentials, role/identity links and permission changes. */
export function validateStaffMaintenance(actor: ResolvedStaffAccess, target: ResolvedStaffAccess, operation: "profile.edit" | "accounts.disable"): StaffChangeDecision {
  const actorState = accessStates.get(actor);
  const targetState = accessStates.get(target);
  if (!actorState || !targetState) return refused("invalid-access");
  const ownerContext = validateStaffMutationOwnerContext(actorState, targetState);
  if (!ownerContext.ok) return ownerContext;
  if (operation !== "profile.edit" && operation !== "accounts.disable") return refused("unknown-maintenance-operation");
  if (actor.userId === target.userId) return refused("self-staff-maintenance");
  if (target.isOwner || actorState.owner?.ownerUserId === target.userId) return refused("protected-owner");
  if (!hasStaffCapability(actor, `staff.${operation}`)) return refused("maintenance-denied");
  if (!withinDelegableAuthority(actor, targetState.document)) return refused("outside-delegable-authority");
  return { ok: true };
}
