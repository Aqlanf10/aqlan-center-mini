import "server-only";
import { isRole, type Role } from "./roles";
import { reviewLegacyStaffCapabilities, type LegacyStaffAdapterResult } from "./staff-capabilities-legacy";
import { classifyStaffPermissionEnvelope, isPlainCapabilityRecord, type StaffPermissionEnvelope } from "./staff-permission-envelope";

/**
 * Preparatory observation adapter, NOT authentication or a capability evaluator.
 * The caller supplies a read-only query connection; this module owns no connection,
 * cache, schema repair, transaction, write, session or owner-binding lookup.
 */
export interface StaffAuthorityReadOnlyQuery {
  query(sql: string, values: [number]): Promise<{ rows: readonly unknown[] }>;
}

const selectAuthority = `SELECT u.id, u.role, u.is_active, u.permissions, u.password_hash, u.party_id,
       p.id AS linked_party_id, p.kind AS linked_party_kind, p.is_active AS linked_party_active
  FROM users AS u
  LEFT JOIN parties AS p ON p.id = u.party_id
 WHERE u.id = $1`;

export type StaffClinicianLinkState = "unlinked" | "active-doctor" | "missing-party" | "not-doctor" | "inactive-party" | "invalid-link";
export interface StaffAuthoritySnapshotSummary {
  readonly userId: number;
  readonly role: Role | null;
  readonly isActive: boolean;
  readonly permissionKind: StaffPermissionEnvelope["kind"];
  readonly storedPartyId: number | null;
  readonly clinicianPartyId: number | null;
  readonly clinicianLinkState: StaffClinicianLinkState;
  /** Legacy still needs normal authentication; canonical is never admitted here. */
  readonly state: "legacy-unverified" | "canonical-quarantined" | "denied";
  readonly reason: string | null;
}

declare const snapshotBrand: unique symbol;
export interface StaffAuthoritySnapshot { readonly [snapshotBrand]: true }
interface SnapshotState {
  readonly summary: StaffAuthoritySnapshotSummary;
  // Server-private material. Never spread a row, expose a raw getter, or return this
  // state from a route/RSC. Future entry-point wiring must be reviewed separately.
  readonly rawPermissions: string | null;
  readonly credentialVersionSource: string;
  readonly envelope: StaffPermissionEnvelope;
}
const snapshots = new WeakMap<StaffAuthoritySnapshot, Readonly<SnapshotState>>();
const validId = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0;

export type StaffAuthoritySnapshotResult =
  | { readonly ok: true; readonly snapshot: StaffAuthoritySnapshot }
  | { readonly ok: false; readonly reason: "invalid-user-id" | "authority-unreadable" | "user-not-found" | "invalid-authority-row" };

function clinicianLink(row: Record<string, unknown>): {
  storedPartyId: number | null; clinicianPartyId: number | null; clinicianLinkState: StaffClinicianLinkState;
} {
  const storedPartyId = validId(row.party_id) ? row.party_id : null;
  const result = (clinicianLinkState: StaffClinicianLinkState, clinicianPartyId: number | null = null) =>
    ({ storedPartyId, clinicianPartyId, clinicianLinkState });
  const absent = row.linked_party_id === null && row.linked_party_kind === null && row.linked_party_active === null;
  if (row.party_id === null) return result(absent ? "unlinked" : "invalid-link");
  if (storedPartyId === null) return result("invalid-link");
  if (absent) return result("missing-party");
  if (row.linked_party_id !== storedPartyId || typeof row.linked_party_kind !== "string"
    || typeof row.linked_party_active !== "boolean") return result("invalid-link");
  if (row.linked_party_kind !== "doctor") return result("not-doctor");
  if (!row.linked_party_active) return result("inactive-party");
  return result("active-doctor", storedPartyId);
}

/**
 * One parameterized SELECT by immutable users.id, including inactive targets.
 * The ID must come from an authenticated server identity or an authorized target
 * lookup; accepting an ID is not proof of either. Failures are redacted and closed.
 * Snapshots are per-call observations, never a transaction/freshness guarantee.
 */
export async function loadStaffAuthoritySnapshot(
  source: StaffAuthorityReadOnlyQuery, userId: unknown,
): Promise<StaffAuthoritySnapshotResult> {
  if (!validId(userId)) return { ok: false, reason: "invalid-user-id" };
  try {
    const { rows } = await source.query(selectAuthority, [userId]);
    if (!Array.isArray(rows)) return { ok: false, reason: "invalid-authority-row" };
    if (rows.length === 0) return { ok: false, reason: "user-not-found" };
    if (rows.length !== 1) return { ok: false, reason: "invalid-authority-row" };
    const row = rows[0];
    const fields = ["id", "role", "is_active", "permissions", "password_hash", "party_id",
      "linked_party_id", "linked_party_kind", "linked_party_active"];
    if (!isPlainCapabilityRecord(row) || fields.some((key) => !Object.hasOwn(row, key))
      || row.id !== userId || typeof row.is_active !== "boolean"
      || typeof row.password_hash !== "string" || row.password_hash.length === 0
      || (row.permissions !== null && typeof row.permissions !== "string")) {
      return { ok: false, reason: "invalid-authority-row" };
    }
    const role = isRole(row.role) ? row.role : null;
    const envelope = classifyStaffPermissionEnvelope(row.permissions);
    const link = clinicianLink(row);
    const reason = role === null ? "unknown-role"
      : !row.is_active ? "inactive-subject"
      : envelope.kind === "invalid" ? "invalid-permission-envelope"
      : link.clinicianLinkState === "invalid-link" ? "invalid-clinician-link"
      : envelope.kind === "canonical" ? "canonical-not-activated" : null;
    const state = reason === null ? "legacy-unverified"
      : reason === "canonical-not-activated" ? "canonical-quarantined" : "denied";
    const summary: StaffAuthoritySnapshotSummary = Object.freeze({
      userId, role, isActive: row.is_active, permissionKind: envelope.kind, ...link, state, reason,
    });
    // An empty opaque handle cannot serialize credentials/profiles, and copies do
    // not carry the process-local authority association.
    const snapshot = Object.freeze({}) as StaffAuthoritySnapshot;
    snapshots.set(snapshot, Object.freeze({
      summary, rawPermissions: row.permissions, credentialVersionSource: row.password_hash, envelope,
    }));
    return { ok: true, snapshot };
  } catch { return { ok: false, reason: "authority-unreadable" }; }
}

/** Explicit allowlisted diagnostic DTO. No credentials, raw profiles or grants. */
export function summarizeStaffAuthoritySnapshot(snapshot: StaffAuthoritySnapshot): StaffAuthoritySnapshotSummary | null {
  return snapshots.get(snapshot)?.summary ?? null;
}

/** Reuses legacy review machinery only; this report never authenticates a subject. */
export function reviewLegacyStaffAuthoritySnapshot(snapshot: StaffAuthoritySnapshot): LegacyStaffAdapterResult {
  const saved = snapshots.get(snapshot);
  if (!saved) return { ok: false, reason: "unknown-snapshot" };
  if (saved.summary.state !== "legacy-unverified" || saved.envelope.kind !== "legacy") {
    return { ok: false, reason: saved.summary.reason ?? "not-legacy" };
  }
  return reviewLegacyStaffCapabilities(saved.summary.role, saved.envelope.value);
}
