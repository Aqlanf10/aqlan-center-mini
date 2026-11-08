import { createHmac } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionToken, SESSION_COOKIE, sessionCredentialVersion, sessionPermissionVersion,
} from "../lib/auth";
import { financeAccessFor } from "../lib/finance-permissions";
import { restrictedRouteAllowed } from "../lib/role-routes";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(), headers: vi.fn(), user: vi.fn(), party: vi.fn(), statement: vi.fn(), settings: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies, headers: mocks.headers }));
vi.mock("@/lib/db", () => ({
  findUserByUsername: mocks.user, getParty: mocks.party,
  partyStatement: mocks.statement, getSettingsSafe: mocks.settings,
}));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));

import PartyPrint from "../app/print/party/[id]/page";
import { proxy } from "../proxy";

const path = "/print/party/7";
type Transport = "cookie" | "bearer";
function signIn(role: string, transport: Transport, viewSuppliers?: boolean, signedViewSuppliers = viewSuppliers) {
  const access = viewSuppliers === undefined ? undefined : { viewSuppliers };
  const token = createSessionToken({
    userId: 31, username: "synthetic-ortho-supplier-reader-20261109", role, expiresAt: Date.now() + 60_000,
    credentialVersion: sessionCredentialVersion("synthetic-ortho-supplier-hash-20261109"),
    permissionVersion: sessionPermissionVersion(role, access),
    ...(signedViewSuppliers === undefined ? {} : { financeAccess: financeAccessFor(role, { viewSuppliers: signedViewSuppliers }) }),
  });
  mocks.user.mockResolvedValue({
    id: 31, username: "synthetic-ortho-supplier-reader-20261109", role, isActive: true, partyId: null,
    passwordHash: "synthetic-ortho-supplier-hash-20261109", permissions: { financeAccess: access },
  });
  const requestHeaders: Record<string, string> = transport === "cookie"
    ? { cookie: `${SESSION_COOKIE}=${token}` }
    : { authorization: `Bearer ${token}` };
  mocks.cookies.mockResolvedValue({ get: (name: string) => name === SESSION_COOKIE && transport === "cookie" ? { value: token } : undefined });
  mocks.headers.mockResolvedValue(new Headers(requestHeaders));
  return requestHeaders;
}
function print(id = "7") { return PartyPrint({ params: Promise.resolve({ id }) }); }
function expectNoReads() {
  expect(mocks.party).not.toHaveBeenCalled();
  expect(mocks.statement).not.toHaveBeenCalled();
  expect(mocks.settings).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SESSION_SECRET", "synthetic-ortho-supplier-test-secret-20261109");
  mocks.cookies.mockResolvedValue({ get: () => undefined });
  mocks.headers.mockResolvedValue(new Headers());
  mocks.party.mockResolvedValue({ id: 7, name: "SYNTHETIC-ORTHO-SUPPLIER-7", kind: "supplier" });
  mocks.settings.mockResolvedValue({});
  mocks.statement.mockResolvedValue({ payables: [], expenses: [], totals: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe.each(["cookie", "bearer"] as const)("party print authorization using signed %s sessions", (transport) => {
  it("denies a disabled accountant consistently at the API/print gates and before server reads", async () => {
    const headers = signIn("accountant", transport, false);
    const api = await proxy(new NextRequest("https://clinic.test/api/parties", { headers }));
    expect(api.status).toBe(403);
    const response = await proxy(new NextRequest(`https://clinic.test${path}`, { headers }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://clinic.test/finance");
    // Invoke the server page independently: proxy denial is not the data guard.
    await expect(print()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expectNoReads();
  });

  it("uses current account permissions even when the signed finance projection is more permissive", async () => {
    signIn("accountant", transport, false, true);
    await expect(print()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expectNoReads();
  });

  it("revokes an older permitted session after supplier access is withdrawn", async () => {
    signIn("accountant", transport, true);
    const user = await mocks.user();
    mocks.user.mockResolvedValue({ ...user, permissions: { financeAccess: { viewSuppliers: false } } });
    await expect(print()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expectNoReads();
  });

  it.each(["cashier", "doctor", "assistant"])("denies %s before reading the party or statement", async (role) => {
    signIn(role, transport, true);
    await expect(print()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expectNoReads();
  });

  it.each([
    ["admin", undefined], ["reception", undefined], ["accountant", true], ["accountant", undefined],
  ] as const)("preserves authorized %s access (supplier flag %s)", async (role, viewSuppliers) => {
    const headers = signIn(role, transport, viewSuppliers);
    const response = await proxy(new NextRequest(`https://clinic.test${path}`, { headers }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    const html = renderToStaticMarkup(await print());
    expect(html).toContain("SYNTHETIC-ORTHO-SUPPLIER-7");
    expect(mocks.party).toHaveBeenCalledWith(7);
    expect(mocks.statement).toHaveBeenCalledWith(7);
    expect(mocks.settings).toHaveBeenCalledOnce();
  });
});

it("fails closed without an authenticated session before reading data", async () => {
  await expect(print()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  expectNoReads();
});

it.each(["0", "-1", "1.5", "invalid"])("rejects invalid party id %s before reading data", async (id) => {
  signIn("accountant", "cookie", true);
  await expect(print(id)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  expectNoReads();
});

it.each(["GET", "HEAD"])("keeps the %s party print and supplier API permission gates aligned", (method) => {
  for (const route of [path, `${path}/`, "/api/parties", "/api/payables"]) {
    expect(restrictedRouteAllowed("accountant", route, method, { viewSuppliers: false })).toBe(false);
    expect(restrictedRouteAllowed("accountant", route, method, { viewSuppliers: true })).toBe(true);
  }
  expect(restrictedRouteAllowed("cashier", path, method, { viewSuppliers: true })).toBe(false);
});

it.each(["POST", "PUT", "PATCH", "DELETE"])("does not add %s access to supplier printing", (method) => {
  expect(restrictedRouteAllowed("accountant", path, method, { viewSuppliers: true })).toBe(false);
});

function signEnvelope(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", process.env.SESSION_SECRET!).update(body).digest("base64url")}`;
}
it.each(["authority", "durableIdentity"])("rejects signed %s cookies without falling back to a permitted legacy Bearer", async (marker) => {
  const headers = signIn("accountant", "bearer", true);
  const token = signEnvelope({ userId: 31, username: "synthetic-ortho-supplier-reader-20261109", role: "admin", expiresAt: Date.now() + 60_000, [marker]: {} });
  mocks.cookies.mockResolvedValue({ get: (name: string) => name === SESSION_COOKIE ? { value: token } : undefined });
  mocks.headers.mockResolvedValue(new Headers(headers));
  await expect(print()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  expect(mocks.user).not.toHaveBeenCalled();
  expectNoReads();
});
it.each(["cookie", "bearer"] as const)("rejects a revoked account through %s before any statement read", async (transport) => {
  signIn("accountant", transport, true);
  const user = await mocks.user();
  mocks.user.mockResolvedValue({ ...user, isActive: false });
  await expect(print()).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  expectNoReads();
});
