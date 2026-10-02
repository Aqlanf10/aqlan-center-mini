import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookie: vi.fn(), header: vi.fn(), user: vi.fn(), update: vi.fn(), audit: vi.fn(),
  limit: vi.fn(), sharedLimit: vi.fn(), clearLimits: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookie }),
  headers: async () => ({ get: mocks.header }),
}));
vi.mock("@/lib/db", () => ({
  findUserByUsername: mocks.user, updateUser: mocks.update, recordAudit: mocks.audit,
  consumeStaffLoginAttempt: mocks.limit, consumeLoginAttempt: mocks.sharedLimit,
  clearAccountLoginAttempts: mocks.clearLimits,
}));

import { POST as login } from "../app/api/auth/login/route";
import { POST as changePassword } from "../app/api/auth/password/route";
import {
  SESSION_COOKIE, SESSION_DURATION_MS, hashPassword, readSessionToken,
  sessionCredentialVersion, sessionPermissionVersion, verifyPassword,
} from "../lib/auth";
import type { StaffUser } from "../lib/db";
import { parseDoctorPermissions } from "../lib/doctor-permissions";
import { type FinanceAccess, financeAccessFor } from "../lib/finance-permissions";
import { verifiedSessionAccess } from "../lib/proxy-role";
import { restrictedRouteAllowed } from "../lib/role-routes";
import { requireSession } from "../lib/session";

const OLD_PASSWORD = "Synthetic-old-password-123";
const NEW_PASSWORD = "Synthetic-new-password-456";
const NO_FINANCE: FinanceAccess = {
  operateShift: false, collectPayments: false, createExpenses: false, viewPatientLedger: false,
  viewReports: false, viewSuppliers: false, viewCommissions: false, viewReconciliation: false,
};
const ALL_FINANCE = Object.fromEntries(Object.keys(NO_FINANCE).map((key) => [key, true]));
const MIXED_FINANCE: FinanceAccess = {
  ...NO_FINANCE, operateShift: true, createExpenses: true, viewReports: true, viewCommissions: true,
};
let originalHash: string;
let user: StaffUser;

beforeAll(async () => { originalHash = await hashPassword(OLD_PASSWORD); });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SESSION_SECRET", "self-password-session-test-secret-at-least-32-characters");
  vi.stubEnv("NODE_ENV", "production");
  mocks.limit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.sharedLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.clearLimits.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
  mocks.user.mockImplementation(async () => user);
  mocks.update.mockImplementation(async (_id: number, update: { passwordHash: string }) => {
    user = { ...user, ...update };
    return user;
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

function setUser(role: string, financeAccess?: unknown) {
  user = {
    id: 71, username: "synthetic-staff", displayName: "Synthetic Staff", isActive: true,
    role, partyId: role === "doctor" ? 42 : null, passwordHash: originalHash,
    permissions: parseDoctorPermissions({ financeAccess }, role),
  };
}

function request(path: string, body: unknown) {
  return new Request(`https://clinic.example.test/api/auth/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Host: "clinic.example.test" },
    body: JSON.stringify(body),
  });
}
function useToken(token: string) {
  mocks.cookie.mockImplementation((name: string) => name === SESSION_COOKIE ? { value: token } : undefined);
}
async function loginToken(password = OLD_PASSWORD) {
  const response = await login(request("login", { username: user.username, password }));
  expect(response.status).toBe(200);
  const token = response.cookies.get(SESSION_COOKIE)?.value;
  expect(token).toBeTruthy();
  return token!;
}
async function renew() {
  return changePassword(request("password", { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }));
}

describe("self-password session renewal", () => {
  it.each([
    { name: "admin", role: "admin" },
    { name: "doctor with linked party", role: "doctor" },
    { name: "reception", role: "reception" },
    { name: "assistant", role: "assistant" },
    { name: "accountant defaults", role: "accountant" },
    { name: "cashier defaults", role: "cashier" },
    { name: "accountant per-user restrictions", role: "accountant", access: NO_FINANCE },
    { name: "cashier per-user restrictions", role: "cashier", access: NO_FINANCE },
    { name: "accountant mixed permissions", role: "accountant", access: MIXED_FINANCE },
    { name: "cashier mixed permissions", role: "cashier", access: MIXED_FINANCE },
    { name: "accountant fixed role ceiling", role: "accountant", access: ALL_FINANCE },
    { name: "cashier fixed role ceiling", role: "cashier", access: ALL_FINANCE },
  ])("keeps $name signed in with the same permissions and revokes the old token", async ({ role, access }) => {
    setUser(role, access);
    const oldToken = await loginToken();
    useToken(oldToken);
    expect(await requireSession()).not.toBeNull();

    const before = Date.now();
    const response = await renew();
    expect(response.status).toBe(200);
    const token = response.cookies.get(SESSION_COOKIE)?.value;
    expect(token).toBeTruthy();
    const payload = readSessionToken(token)!;
    expect(payload).toMatchObject({ userId: user.id, username: user.username, role, partyId: user.partyId });
    expect(payload.expiresAt).toBeGreaterThanOrEqual(before + SESSION_DURATION_MS);
    expect(payload.expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_DURATION_MS);
    expect(payload.credentialVersion).toBe(sessionCredentialVersion(user.passwordHash));
    expect(payload.credentialVersion).not.toBe(sessionCredentialVersion(originalHash));
    expect(await verifyPassword(NEW_PASSWORD, user.passwordHash)).toBe(true);
    expect(await verifyPassword(OLD_PASSWORD, user.passwordHash)).toBe(false);
    expect(mocks.update).toHaveBeenCalledWith(user.id, { passwordHash: user.passwordHash });

    const restricted = role === "accountant" || role === "cashier";
    const expectedAccess = restricted ? financeAccessFor(role, access) : undefined;
    expect(payload.financeAccess).toEqual(expectedAccess);
    expect(payload.permissionVersion).toBe(restricted ? sessionPermissionVersion(role, expectedAccess) : undefined);
    const proxy = await verifiedSessionAccess(token);
    expect(proxy).toEqual({ role, financeAccess: expectedAccess });
    if (restricted) {
      // Exercise the same per-user limits and fixed role ceilings the proxy uses.
      for (const [path, method] of [
        ["/api/shifts", "POST"], ["/api/payments", "POST"], ["/api/expenses", "POST"],
        ["/api/patients/42/ledger", "GET"], ["/api/reports", "GET"], ["/api/parties", "GET"],
        ["/api/finance/commissions", "GET"], ["/api/finance/reconciliation", "GET"],
      ]) {
        expect(restrictedRouteAllowed(role, path, method, proxy?.financeAccess), `${method} ${path}`)
          .toBe(restrictedRouteAllowed(role, path, method, expectedAccess));
      }
    }

    expect(await requireSession()).toBeNull(); // Old cookie now fails the database fingerprint check.
    useToken(token!);
    expect(await requireSession()).toMatchObject({ role, partyId: user.partyId, financeAccess: expectedAccess });
    const freshLogin = readSessionToken(await loginToken(NEW_PASSWORD))!;
    expect(freshLogin.financeAccess).toEqual(payload.financeAccess);
    expect(freshLogin.permissionVersion).toBe(payload.permissionVersion);

    expect(response.cookies.get(SESSION_COOKIE)).toMatchObject({
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_DURATION_MS / 1000,
    });
    const body = await response.json();
    expect(body).toMatchObject({ ok: true });
    expect(JSON.stringify(body)).not.toMatch(/credentialVersion|permissionVersion|passwordHash|token/);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "user.update", entityId: user.id, actor: user.username, actorRole: role,
    }));
  });

  it.each(["accountant", "cashier"])("uses current %s limits returned by the password update", async (role) => {
    setUser(role);
    useToken(await loginToken());
    mocks.update.mockImplementationOnce(async (_id: number, update: { passwordHash: string }) => {
      user = { ...user, ...update, permissions: parseDoctorPermissions({ financeAccess: NO_FINANCE }, role) };
      return user;
    });
    const response = await renew();
    expect(response.status).toBe(200);
    const token = response.cookies.get(SESSION_COOKIE)?.value;
    expect(readSessionToken(token)?.financeAccess).toEqual(NO_FINANCE);
    useToken(token!);
    expect(await requireSession()).toMatchObject({ financeAccess: NO_FINANCE });

    // A later administrator permission edit still revokes the renewed token.
    user = { ...user, permissions: parseDoctorPermissions(undefined, role) };
    expect(await requireSession()).toBeNull();
  });

  it.each([
    { role: "doctor", partyId: 99 },
    { role: "cashier", partyId: null },
  ])("uses the saved role and party when the account becomes $role / $partyId", async ({ role, partyId }) => {
    setUser("doctor");
    useToken(await loginToken());
    mocks.update.mockImplementationOnce(async (_id: number, update: { passwordHash: string }) => {
      user = { ...user, ...update, role, partyId, permissions: parseDoctorPermissions(undefined, role) };
      return user;
    });
    const response = await renew();
    expect(response.status).toBe(200);
    const token = response.cookies.get(SESSION_COOKIE)?.value;
    expect(readSessionToken(token)).toMatchObject({ role, partyId });
    useToken(token!);
    expect(await requireSession()).toMatchObject({ role, partyId });
  });

  it("does not rotate credentials or issue a cookie for a wrong current password", async () => {
    setUser("cashier");
    useToken(await loginToken());
    const response = await changePassword(request("password", { currentPassword: "wrong-password", newPassword: NEW_PASSWORD }));
    expect(response.status).toBe(403);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(await requireSession()).not.toBeNull();
  });

  it("does not renew a revoked session even when its old password is supplied", async () => {
    setUser("accountant");
    useToken(await loginToken());
    user = { ...user, passwordHash: await hashPassword("Other-synthetic-password-789") };
    const response = await renew();
    expect(response.status).toBe(401);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.limit).toHaveBeenCalledTimes(1); // The initial login only.
  });

  it("a concurrent deactivation cannot leave a usable renewed session", async () => {
    setUser("cashier");
    useToken(await loginToken());
    mocks.update.mockImplementationOnce(async (_id: number, update: { passwordHash: string }) => {
      user = { ...user, ...update, isActive: false };
      return user;
    });
    const response = await renew();
    expect(response.status).toBe(200);
    const token = response.cookies.get(SESSION_COOKIE)?.value;
    expect(readSessionToken(token)).not.toBeNull();
    useToken(token!);
    expect(await requireSession()).toBeNull();
  });

  it("a later competing password update revokes the renewal before its first use", async () => {
    setUser("accountant");
    useToken(await loginToken());
    const competingHash = await hashPassword("Other-synthetic-password-789");
    // The audit runs after our UPDATE and before the renewal cookie is issued.
    mocks.audit.mockImplementationOnce(async () => {
      user = { ...user, passwordHash: competingHash };
    });
    const response = await renew();
    expect(response.status).toBe(200);
    const token = response.cookies.get(SESSION_COOKIE)?.value;
    const payload = readSessionToken(token)!;
    expect(payload.credentialVersion).toBe(sessionCredentialVersion(mocks.update.mock.calls[0][1].passwordHash));
    expect(payload.credentialVersion).not.toBe(sessionCredentialVersion(competingHash));
    useToken(token!);
    expect(await requireSession()).toBeNull();
  });

  it("does not issue a renewal token if the user disappears during the update", async () => {
    setUser("doctor");
    useToken(await loginToken());
    mocks.update.mockResolvedValueOnce(null);
    const response = await renew();
    expect(response.status).toBe(401);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
