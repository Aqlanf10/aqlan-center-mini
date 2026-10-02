import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadStaffAuthoritySnapshot, reviewLegacyStaffAuthoritySnapshot, summarizeStaffAuthoritySnapshot,
  type StaffAuthorityReadOnlyQuery, type StaffAuthoritySnapshot } from "../lib/staff-authority-snapshot";
import { STAFF_CAPABILITIES } from "../lib/staff-capability-catalogue";
import { hasStaffCapability, type ResolvedStaffAccess } from "../lib/staff-capabilities";
import { ROLES } from "../lib/roles";

const secret = "synthetic-credential-source-never-in-dto";
const canonical = JSON.stringify({ schemaVersion: 1, revision: 7, patientScope: "all", appointmentScope: "all",
  grants: Object.fromEntries(STAFF_CAPABILITIES.map((key) => [key, true])) });
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 71, role: "doctor", is_active: true, permissions: null, password_hash: secret, party_id: null,
    linked_party_id: null, linked_party_kind: null, linked_party_active: null, ...overrides };
}
function source(rows: readonly unknown[] = [row()]) {
  return { query: vi.fn<StaffAuthorityReadOnlyQuery["query"]>().mockResolvedValue({ rows }) };
}
async function loaded(overrides: Record<string, unknown> = {}) {
  const db = source([row(overrides)]);
  const result = await loadStaffAuthoritySnapshot(db, 71);
  if (!result.ok) throw new Error(result.reason);
  const summary = summarizeStaffAuthoritySnapshot(result.snapshot);
  if (!summary) throw new Error("Missing snapshot summary");
  return { db, snapshot: result.snapshot, summary };
}

describe("SELECT-only inert authority snapshot adapter", () => {
  it("uses exactly one immutable-ID SELECT, includes inactive targets and never prepares schema", async () => {
    const { db, summary } = await loaded({ is_active: false });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, values] = db.query.mock.calls[0];
    expect(values).toEqual([71]);
    expect(sql.trim()).toMatch(/^SELECT\b/i);
    expect(sql).toContain("WHERE u.id = $1");
    expect(sql).toContain("LEFT JOIN parties AS p ON p.id = u.party_id");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|BEGIN|COMMIT|FOR UPDATE)\b/i);
    expect(sql).not.toMatch(/username|display_name|ensureSchema|\*|;/i);
    expect(sql.split("WHERE")[1]).not.toMatch(/is_active/);
    expect(summary.state).toBe("denied");
    expect(summary.reason).toBe("inactive-subject");
  });

  it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "71", "owner", {}, []])(
    "rejects a non-immutable numeric ID before querying %#", async (id) => {
      const db = source();
      expect(await loadStaffAuthoritySnapshot(db, id)).toEqual({ ok: false, reason: "invalid-user-id" });
      expect(db.query).not.toHaveBeenCalled();
    },
  );

  it("fails closed and redacts lookup errors, absent users and impossible duplicate rows", async () => {
    const db = source(); db.query.mockRejectedValue(new Error(secret));
    expect(await loadStaffAuthoritySnapshot(db, 71)).toEqual({ ok: false, reason: "authority-unreadable" });
    expect(await loadStaffAuthoritySnapshot(source([]), 71)).toEqual({ ok: false, reason: "user-not-found" });
    expect(await loadStaffAuthoritySnapshot(source([row(), row()]), 71)).toEqual({ ok: false, reason: "invalid-authority-row" });
    expect(await loadStaffAuthoritySnapshot(source(null as never), 71)).toEqual({ ok: false, reason: "invalid-authority-row" });
  });

  it.each([
    { id: 72 }, { id: "71" }, { is_active: "true" }, { is_active: 1 }, { password_hash: null },
    { password_hash: "" }, { permissions: {} }, { permissions: [] }, { permissions: undefined },
  ])("rejects malformed raw authority rows %#", async (overrides) => {
    expect(await loadStaffAuthoritySnapshot(source([row(overrides)]), 71)).toEqual({ ok: false, reason: "invalid-authority-row" });
  });

  it("requires all selected columns and rejects inherited/accessor rows", async () => {
    for (const key of Object.keys(row())) {
      const incomplete: Record<string, unknown> = row(); delete incomplete[key];
      expect(await loadStaffAuthoritySnapshot(source([incomplete]), 71)).toEqual({ ok: false, reason: "invalid-authority-row" });
    }
    const accessor = Object.defineProperty(row(), "permissions", { get() { throw new Error(secret); } });
    for (const invalid of [null, [], Object.create(row()), accessor]) {
      expect(await loadStaffAuthoritySnapshot(source([invalid]), 71)).toEqual({ ok: false, reason: "invalid-authority-row" });
    }
  });

  it.each(ROLES)("all canonical nominal roles stay explicitly quarantined, including %s with all grants", async (role) => {
    const { snapshot, summary } = await loaded({ role, permissions: canonical });
    expect(summary).toMatchObject({ role, permissionKind: "canonical", state: "canonical-quarantined", reason: "canonical-not-activated" });
    expect(reviewLegacyStaffAuthoritySnapshot(snapshot)).toEqual({ ok: false, reason: "canonical-not-activated" });
    for (const capability of STAFF_CAPABILITIES) {
      expect(hasStaffCapability(snapshot as unknown as ResolvedStaffAccess, capability)).toBe(false);
    }
  });

  it.each(["{", "false", "[]", " ", '{"schemaVersion":2}', '{"grants":{}}', '{"revision":null,"canAddPatient":true}'])(
    "never grants legacy admin defaults to malformed/versioned data %#", async (permissions) => {
      const { snapshot, summary } = await loaded({ role: "admin", permissions });
      expect(summary).toMatchObject({ permissionKind: "invalid", state: "denied", reason: "invalid-permission-envelope" });
      expect(reviewLegacyStaffAuthoritySnapshot(snapshot).ok).toBe(false);
    },
  );

  it.each(["owner", "manager", "ADMIN", "", null, 1])("records unknown roles as denied without inferring an owner %#", async (role) => {
    const { snapshot, summary } = await loaded({ role });
    expect(summary).toMatchObject({ role: null, state: "denied", reason: "unknown-role" });
    expect(reviewLegacyStaffAuthoritySnapshot(snapshot)).toEqual({ ok: false, reason: "unknown-role" });
  });

  it.each([null, "", "null", "{}"])("preserves legacy empty storage, without authenticating it %#", async (permissions) => {
    for (const role of ROLES) {
      const { snapshot, summary } = await loaded({ role, permissions });
      expect(summary).toMatchObject({ permissionKind: "legacy", state: "legacy-unverified", reason: null });
      const review = reviewLegacyStaffAuthoritySnapshot(snapshot);
      expect(review.ok).toBe(true);
      if (review.ok) expect(review.value).toMatchObject({ kind: "legacy-review", owner: false, requiresMigrationReview: true });
    }
  });

  it.each([
    [{}, "unlinked", null, null],
    [{ party_id: 9 }, "missing-party", 9, null],
    [{ party_id: 9, linked_party_id: 9, linked_party_kind: "supplier", linked_party_active: true }, "not-doctor", 9, null],
    [{ party_id: 9, linked_party_id: 9, linked_party_kind: "doctor", linked_party_active: false }, "inactive-party", 9, null],
    [{ party_id: 9, linked_party_id: 9, linked_party_kind: "doctor", linked_party_active: true }, "active-doctor", 9, 9],
    [{ party_id: 0 }, "invalid-link", null, null],
    [{ party_id: "9" }, "invalid-link", null, null],
    [{ linked_party_id: 9, linked_party_kind: "doctor", linked_party_active: true }, "invalid-link", null, null],
    [{ party_id: 9, linked_party_id: 10, linked_party_kind: "doctor", linked_party_active: true }, "invalid-link", 9, null],
    [{ party_id: 9, linked_party_id: 9, linked_party_kind: "doctor", linked_party_active: "true" }, "invalid-link", 9, null],
    [{ party_id: 9, linked_party_id: 9, linked_party_kind: null, linked_party_active: true }, "invalid-link", 9, null],
  ])("separates stored clinical identity from validated effective identity %#", async (overrides, clinicianLinkState, storedPartyId, clinicianPartyId) => {
    const { summary } = await loaded(overrides as Record<string, unknown>);
    expect(summary).toMatchObject({ clinicianLinkState, storedPartyId, clinicianPartyId });
    if (clinicianLinkState === "invalid-link") expect(summary).toMatchObject({ state: "denied", reason: "invalid-clinician-link" });
  });

  it("does not infer/name-link clinical identity from a doctor role or administrative grants", async () => {
    const unlinked = await loaded({ permissions: canonical });
    expect(unlinked.summary.clinicianPartyId).toBeNull();
    const linked = await loaded({ permissions: canonical, party_id: 9, linked_party_id: 9, linked_party_kind: "doctor", linked_party_active: true });
    expect(linked.summary).toMatchObject({ role: "doctor", storedPartyId: 9, clinicianPartyId: 9, state: "canonical-quarantined" });
  });

  it("returns only immutable allowlisted diagnostics and never exposes credentials/raw profiles", async () => {
    const { snapshot, summary } = await loaded({ permissions: canonical, username: "owner", display_name: "Real owner", commission_config: secret });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.keys(snapshot)).toEqual([]);
    expect(JSON.stringify(snapshot)).toBe("{}");
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.keys(summary).sort()).toEqual([
      "userId", "role", "isActive", "permissionKind", "storedPartyId", "clinicianPartyId", "clinicianLinkState", "state", "reason",
    ].sort());
    expect(JSON.stringify(summary)).not.toMatch(/password|credential|grants|schemaVersion|commission|username|display_name/);
    expect(JSON.stringify(summary)).not.toContain(secret);
    expect(JSON.stringify(summary)).not.toContain(canonical);
    const forged = JSON.parse(JSON.stringify(snapshot)) as StaffAuthoritySnapshot;
    expect(summarizeStaffAuthoritySnapshot(forged)).toBeNull();
    expect(reviewLegacyStaffAuthoritySnapshot(forged)).toEqual({ ok: false, reason: "unknown-snapshot" });
  });

  it("loads afresh each time and detaches returned state from mutable query rows", async () => {
    const original = row({ permissions: '{"canAddPatient":false}', party_id: 9, linked_party_id: 9, linked_party_kind: "doctor", linked_party_active: true });
    const db = source([original]);
    const first = await loadStaffAuthoritySnapshot(db, 71);
    if (!first.ok) throw new Error(first.reason);
    original.permissions = canonical;
    original.role = "admin";
    original.linked_party_active = false;
    const second = await loadStaffAuthoritySnapshot(db, 71);
    if (!second.ok) throw new Error(second.reason);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(summarizeStaffAuthoritySnapshot(first.snapshot)).toMatchObject({ role: "doctor", permissionKind: "legacy", clinicianPartyId: 9 });
    expect(summarizeStaffAuthoritySnapshot(second.snapshot)).toMatchObject({ role: "admin", permissionKind: "canonical", clinicianPartyId: null });
    const firstReview = reviewLegacyStaffAuthoritySnapshot(first.snapshot);
    expect(firstReview.ok && firstReview.value.observedCapabilities["patients.create"]).toBeUndefined();
  });
});
