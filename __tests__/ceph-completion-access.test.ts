import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import type { DbClient } from "../lib/db";
const m = vi.hoisted(() => ({ user: vi.fn(), owns: vi.fn(), query: vi.fn() }));
vi.mock("../lib/db", () => ({ findUserByUsername: m.user, doctorOwnsPatient: m.owns, patientHasVisitToday: vi.fn() }));
import { sessionCredentialVersion } from "../lib/auth";
import { authorizeCephCompletion } from "../lib/ceph-completion-access";
const client = { query: m.query } as unknown as DbClient;
let session: SessionPayload;
let account: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.SESSION_SECRET = "synthetic-ceph-completion-test-secret-only";
  session = { userId: 18, username: "synthetic-doctor", role: "doctor", expiresAt: Date.now() + 60_000,
    credentialVersion: sessionCredentialVersion("synthetic-password-hash") };
  account = { id: 18, username: session.username, role: "doctor", isActive: true, partyId: 77,
    passwordHash: "synthetic-password-hash", permissions: { canUploadXrays: true, canViewAllPatients: false } };
  m.user.mockImplementation(async () => account);
  m.owns.mockResolvedValue(true); m.query.mockResolvedValue({ rows: [{ id: 11 }] });
});
describe("transaction-bound ceph completion authority", () => {
  it("locks patient first, uses the same transaction for current user and ownership, and returns stable user ID", async () => {
    expect(await authorizeCephCompletion(client, session, 11, session.username)).toBe(18);
    expect(m.query).toHaveBeenCalledWith("SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE", [11]);
    expect(m.user).toHaveBeenCalledWith(session.username, client);
    expect(m.owns).toHaveBeenCalledWith(77, 11, client);
    expect(m.query.mock.invocationCallOrder[0]).toBeLessThan(m.user.mock.invocationCallOrder[0]);
    expect(m.user.mock.invocationCallOrder[0]).toBeLessThan(m.owns.mock.invocationCallOrder[0]);
  });
  it.each([
    ["inactive", { isActive: false }], ["role revoked", { role: "reception" }],
    ["credentials changed", { passwordHash: "replacement-hash" }], ["same name different user", { id: 19 }],
    ["imaging scope revoked", { permissions: { canUploadXrays: false, canViewAllPatients: true } }],
    ["doctor association removed", { partyId: null }],
  ])("denies %s", async (_name, patch) => {
    Object.assign(account, patch);
    expect(await authorizeCephCompletion(client, session, 11, session.username)).toBeNull();
  });
  it("denies a removed ownership witness", async () => {
    m.owns.mockResolvedValue(false);
    expect(await authorizeCephCompletion(client, session, 11, session.username)).toBeNull();
  });
  it("denies a missing patient even to an administrator", async () => {
    account.role = session.role = "admin"; m.query.mockResolvedValue({ rows: [] });
    expect(await authorizeCephCompletion(client, session, 11, session.username)).toBeNull();
  });
  it("allows an active current administrator without doctor ownership", async () => {
    account.role = session.role = "admin";
    expect(await authorizeCephCompletion(client, session, 11, session.username)).toBe(18);
    expect(m.owns).not.toHaveBeenCalled();
  });
  it("rejects reception even though generic patient access allows it", async () => {
    account.role = session.role = "reception";
    expect(await authorizeCephCompletion(client, session, 11, session.username)).toBeNull();
  });
  it("denies expiry while awaiting ownership", async () => {
    // Canonical revalidation copies the session. Advance time instead of relying
    // on mutation of the input to model expiry of that admitted copy.
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    m.owns.mockImplementation(async () => { clock.mockReturnValue(now + 120_000); return true; });
    try { expect(await authorizeCephCompletion(client, session, 11, session.username)).toBeNull(); }
    finally { clock.mockRestore(); }
  });
  it("rejects actor-name substitution and malformed authority without reading", async () => {
    expect(await authorizeCephCompletion(client, session, 11, "someone-else")).toBeNull();
    expect(await authorizeCephCompletion(client, { ...session, expiresAt: NaN }, 11, session.username)).toBeNull();
    expect(await authorizeCephCompletion(client, session, -1, session.username)).toBeNull();
    expect(m.query).not.toHaveBeenCalled();
  });
});
