import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("../lib/db", () => ({ findUserByUsername: mocks.user }));
import { sessionCredentialVersion, sessionPermissionVersion, type SessionPayload } from "../lib/auth";
import type { DbClient } from "../lib/db";
import { revalidateSessionInTransaction } from "../lib/session";

const client = { query: vi.fn() } as unknown as DbClient;
const admitted = (): SessionPayload => ({ userId: 7, username: "admitted-owner", role: "admin", partyId: 1,
  expiresAt: Date.now() + 60_000, credentialVersion: sessionCredentialVersion("original-hash") });
const liveUser = () => ({ id: 7, isActive: true, passwordHash: "original-hash", role: "admin", partyId: 42, permissions: null });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("SESSION_SECRET", "invoice-transaction-isolated-secret-0123456789"); mocks.user.mockResolvedValue(liveUser()); });
afterEach(() => vi.unstubAllEnvs());

describe("invoice transaction session revalidation", () => {
  it("uses the admitted payload and held transaction client without rereading request credentials", async () => {
    expect(await revalidateSessionInTransaction(admitted(), client)).toMatchObject({ userId: 7, role: "admin", partyId: 42 });
    expect(mocks.user).toHaveBeenCalledExactlyOnceWith("admitted-owner", client);
    expect(mocks.cookies).not.toHaveBeenCalled(); expect(mocks.headers).not.toHaveBeenCalled();
  });
  it.each([
    ["disabled", { isActive: false }], ["role revoked", { role: "doctor" }],
    ["credential rotated", { passwordHash: "new-hash" }], ["identity changed", { id: 8 }],
  ])("refuses %s while waiting for the transaction", async (_name, change) => {
    mocks.user.mockResolvedValue({ ...liveUser(), ...change });
    expect(await revalidateSessionInTransaction(admitted(), client)).toBeNull();
  });
  it("refuses a deleted account", async () => {
    mocks.user.mockResolvedValue(null);
    expect(await revalidateSessionInTransaction(admitted(), client)).toBeNull();
  });
  it("refuses expiry during the wait and missing revocation identity", async () => {
    expect(await revalidateSessionInTransaction({ ...admitted(), expiresAt: Date.now() - 1 }, client)).toBeNull();
    expect(await revalidateSessionInTransaction({ ...admitted(), credentialVersion: undefined }, client)).toBeNull();
  });
  it.each(["cashier", "accountant"] as const)("refuses changed %s financial permissions", async (role) => {
    const oldAccess = { viewPatientLedger: true };
    const payload = { ...admitted(), role, permissionVersion: sessionPermissionVersion(role, oldAccess) };
    mocks.user.mockResolvedValue({ ...liveUser(), role, permissions: { financeAccess: { viewPatientLedger: false } } });
    expect(await revalidateSessionInTransaction(payload, client)).toBeNull();
  });
  it("propagates database failure to the caller's transaction rollback, never returns an admitted session", async () => {
    mocks.user.mockRejectedValue(new Error("transaction unavailable"));
    await expect(revalidateSessionInTransaction(admitted(), client)).rejects.toThrow("transaction unavailable");
  });
});
